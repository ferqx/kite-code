import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { build as bundle } from '../../../../scripts/tooling/bun-build';
import { spawnSync, which } from '../../../../scripts/tooling/process';
import { runtimeBuildOptions } from '../../scripts/runtime-build-options';
import { ripgrepAsset } from './ripgrep';

const destination = resolve(process.argv[2] ?? 'dist', 'platform/process');
mkdirSync(destination, { recursive: true });
const result = await bundle({
  entrypoints: [resolve(import.meta.dirname, '../platform/process/shell-supervisor.ts')],
  outdir: destination,
  ...runtimeBuildOptions(destination),
  naming: 'shell-supervisor.js',
});
if (!result.success) throw new Error('shell_supervisor_build_failed');
// Install real executables in the package's immutable tool directory.
const searchDirectory = resolve(destination, 'tools');
mkdirSync(searchDirectory, { recursive: true });
const sourceRg = ripgrepAsset();
copyFileSync(sourceRg, join(searchDirectory, basename(sourceRg)));
copyFileSync(
  join(dirname(dirname(sourceRg)), 'LICENSE'),
  join(searchDirectory, 'LICENSE.vscode-ripgrep'),
);
for (const name of ['LICENSE-MIT.txt', 'LICENSE-PCRE2.txt', 'LICENSE-SLJIT.txt'])
  copyFileSync(resolve(import.meta.dirname, 'ripgrep-licenses', name), join(searchDirectory, name));
writeFileSync(
  join(searchDirectory, 'manifest.json'),
  `${JSON.stringify({ platform: process.platform, arch: process.arch, rg: { version: '15.0.0', package: '@vscode/ripgrep', packageVersion: '1.18.0', sha256: createHash('sha256').update(readFileSync(sourceRg)).digest('hex') } }, null, 2)}\n`,
);

if (process.platform === 'win32') {
  if (process.arch !== 'x64') throw Error('windows_shell_arch_unsupported');
  const root = resolve(import.meta.dirname, '../../../..');
  const compiled = spawnSync(
    [
      process.execPath,
      '--import',
      resolve(root, 'scripts/tooling/register.mjs'),
      resolve(root, 'scripts/release/build-windows-runner.ts'),
    ],
    { cwd: root, stdout: 'inherit', stderr: 'inherit' },
  );
  if (compiled.exitCode !== 0) throw Error('windows_shell_runner_build_failed');
  const output = resolve(destination, 'windows-shell');
  mkdirSync(output, { recursive: true });
  const files: Record<string, string> = {};
  for (const [name, source] of [
    [
      'kite-windows-runner.exe',
      resolve(root, 'native/windows-sandbox-runner/target/release/kite-windows-runner.exe'),
    ],
    ['ktipc.dll', resolve(root, 'native/windows-msys-compat/target/release/ktipc.dll')],
  ] as const) {
    copyFileSync(source, resolve(output, name));
    files[name] = createHash('sha256').update(readFileSync(source)).digest('hex');
  }
  writeFileSync(
    resolve(output, 'manifest.json'),
    `${JSON.stringify({ protocol: 7, runtime: 'windows-restricted-token', files }, null, 2)}\n`,
  );
}

// This is a build-time dependency. Installed Jobs use this exact sealed ELF,
// never a compiler or a source fallback on the user's machine.
if (process.platform === 'linux') {
  if (!['x64', 'arm64'].includes(process.arch)) throw Error('linux_shell_arch_unsupported');
  const compiler = which(process.env.CC ?? 'cc');
  if (!compiler) throw Error('linux_shell_compiler_unavailable');
  const output = resolve(destination, 'linux-shell-init');
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
      resolve(import.meta.dirname, '../../native/linux-shell-init.c'),
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
