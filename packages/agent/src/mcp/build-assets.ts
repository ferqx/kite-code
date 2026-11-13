import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build as bundle } from '../../../../scripts/tooling/bun-build';
import { spawnSync, which } from '../../../../scripts/tooling/process';
import { runtimeBuildOptions } from '../../scripts/runtime-build-options';

const destination = resolve(process.argv[2] ?? 'dist', 'mcp');
mkdirSync(destination, { recursive: true });
const result = await bundle({
  entrypoints: [
    resolve(import.meta.dirname, 'schema-worker.ts'),
    resolve(import.meta.dirname, 'stdio-guardian.ts'),
    resolve(import.meta.dirname, 'windows-stdio-guardian.ts'),
  ],
  outdir: destination,
  ...runtimeBuildOptions(destination),
  naming: '[name].js',
});
if (!result.success) throw new Error('mcp_stdio_guardian_build_failed');
const schemaHash = createHash('sha256')
  .update(readFileSync(resolve(destination, 'schema-worker.js')))
  .digest('hex');
writeFileSync(resolve(destination, 'schema-worker.sha256'), `${schemaHash}\n`);

if (process.platform === 'linux') {
  if (!['x64', 'arm64'].includes(process.arch)) throw Error('linux_stdio_arch_unsupported');
  const compiler = which(process.env.CC ?? 'cc');
  if (!compiler) throw Error('linux_stdio_compiler_unavailable');
  const output = resolve(destination, 'linux-stdio-init');
  const compiled = spawnSync(
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
      resolve(import.meta.dirname, '../../native/linux-stdio-init.c'),
      '-o',
      output,
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  try {
    if (compiled.exitCode !== 0) throw Error('linux_stdio_init_build_failed');
    const bytes = readFileSync(output);
    if (
      bytes.length < 64 ||
      !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      bytes[4] !== 2 ||
      bytes[5] !== 1 ||
      ![2, 3].includes(bytes.readUInt16LE(16)) ||
      bytes.readUInt16LE(18) !== (process.arch === 'x64' ? 62 : 183)
    )
      throw Error('linux_stdio_init_invalid_elf');
    chmodSync(output, 0o755);
  } catch (error) {
    rmSync(output, { force: true });
    throw error;
  }
}
