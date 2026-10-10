import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const destination = resolve(process.argv[2] ?? 'dist', 'platform/process');
mkdirSync(destination, { recursive: true });
const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, '../platform/process/shell-supervisor.ts')],
  outdir: destination,
  target: 'bun',
  naming: 'shell-supervisor.js',
});
if (!result.success) throw new Error('shell_supervisor_build_failed');

// This is a build-time dependency. Installed Jobs use this exact sealed ELF,
// never a compiler or a source fallback on the user's machine.
if (process.platform === 'linux') {
  if (!['x64', 'arm64'].includes(process.arch)) throw Error('linux_shell_arch_unsupported');
  const compiler = Bun.which(process.env.CC ?? 'cc');
  if (!compiler) throw Error('linux_shell_compiler_unavailable');
  const output = resolve(destination, 'linux-shell-init');
  const compiled = Bun.spawnSync(
    [
      compiler,
      '-std=c11',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-fstack-protector-strong',
      '-D_FORTIFY_SOURCE=2',
      '-fPIE',
      '-pie',
      '-Wl,-z,relro,-z,now',
      resolve(import.meta.dir, '../../native/linux-shell-init.c'),
      '-o',
      output,
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  try {
    if (compiled.exitCode !== 0) throw Error('linux_shell_init_build_failed');
    const bytes = readFileSync(output);
    if (
      bytes.length < 64 ||
      !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      bytes[4] !== 2 ||
      bytes[5] !== 1 ||
      ![2, 3].includes(bytes.readUInt16LE(16)) ||
      bytes.readUInt16LE(18) !== (process.arch === 'x64' ? 62 : 183)
    )
      throw Error('linux_shell_init_invalid_elf');
    chmodSync(output, 0o755);
  } catch (error) {
    rmSync(output, { force: true });
    throw error;
  }
}
