import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const cargoHome = resolve(process.env.CARGO_HOME ?? join(homedir(), '.cargo'));
const targetDirFlag = process.argv.indexOf('--target-dir');

if (process.platform !== 'win32') {
  console.error('build-windows-runner: the canonical runner build requires Windows.');
  process.exit(1);
}

const cargoArgs = [
  'build',
  '--release',
  '--manifest-path',
  'native/windows-sandbox-runner/Cargo.toml',
];
if (targetDirFlag !== -1) {
  const targetDir = process.argv[targetDirFlag + 1];
  if (!targetDir || targetDir.startsWith('--')) {
    console.error('build-windows-runner: --target-dir requires a path.');
    process.exit(1);
  }
  cargoArgs.push('--target-dir', isAbsolute(targetDir) ? targetDir : resolve(targetDir));
}

const rustFlags = [
  `--remap-path-prefix=${cargoHome}=C:\\kite-cargo`,
  `--remap-path-prefix=${projectRoot}=C:\\kite-source`,
  '-C',
  'linker=rust-lld',
  '-C',
  'link-arg=--no-insert-timestamp',
];
const build = Bun.spawn(['cargo', ...cargoArgs], {
  cwd: projectRoot,
  env: {
    ...process.env,
    CARGO_ENCODED_RUSTFLAGS: rustFlags.join('\x1f'),
  },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

process.exit(await build.exited);
