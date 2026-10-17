import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesNativeAbi } from '../src/files-native-binding';

export async function buildNativeFiles(outdir: string) {
  const crate = fileURLToPath(new URL('../native/files/', import.meta.url));
  const cargo = Bun.which('cargo');
  if (!cargo) throw Error('files_native_compiler_unavailable');
  const target = (
    {
      'win32-x64': 'x86_64-pc-windows-msvc',
      'linux-x64': 'x86_64-unknown-linux-gnu',
      'linux-arm64': 'aarch64-unknown-linux-gnu',
      'darwin-x64': 'x86_64-apple-darwin',
      'darwin-arm64': 'aarch64-apple-darwin',
    } as Record<string, string>
  )[`${process.platform}-${process.arch}`];
  if (!target) throw Error('files_native_build_platform_unsupported');
  const buildEnvironment = { ...process.env };
  for (const key of [
    'RUSTUP_TOOLCHAIN',
    'RUSTFLAGS',
    'CARGO_ENCODED_RUSTFLAGS',
    'CARGO_TARGET_DIR',
    'CARGO_BUILD_TARGET',
    'RUSTC',
    'RUSTC_WRAPPER',
    'RUSTC_WORKSPACE_WRAPPER',
  ])
    delete buildEnvironment[key];
  const run = async (args: string[]) => {
    const child = Bun.spawn([cargo, ...args], {
      cwd: crate,
      env: buildEnvironment,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill(), 180000);
    try {
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exit !== 0) throw Error(`files_native_build_failed:${exit}\n${stderr}`);
      return stdout;
    } finally {
      clearTimeout(timer);
    }
  };
  await run(['build', '--release', '--locked', '--target', target]);
  const binary = join(
    crate,
    'target',
    target,
    'release',
    process.platform === 'win32'
      ? 'kite_files_native.dll'
      : process.platform === 'darwin'
        ? 'libkite_files_native.dylib'
        : 'libkite_files_native.so',
  );
  const destination = resolve(outdir, 'native/files');
  mkdirSync(destination, { recursive: true });
  const asset = join(destination, 'files.node');
  const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
  const binaryHash = sha(readFileSync(binary));
  if (!existsSync(asset) || sha(readFileSync(asset)) !== binaryHash) copyFileSync(binary, asset);
  const sources = [
    'Cargo.toml',
    'Cargo.lock',
    'rust-toolchain.toml',
    '.cargo/config.toml',
    'build.rs',
    ...readdirSync(join(crate, 'src'))
      .filter((name) => name.endsWith('.rs'))
      .sort()
      .map((name) => `src/${name}`),
  ];
  writeFileSync(
    join(destination, 'manifest.json'),
    JSON.stringify({
      abi: filesNativeAbi,
      platform: process.platform,
      arch: process.arch,
      sha256: binaryHash,
      sources: sources.map((path) => ({ path, sha256: sha(readFileSync(join(crate, path))) })),
    }),
  );
  copyFileSync(join(crate, 'Cargo.lock'), join(destination, 'Cargo.lock'));
  const metadata = JSON.parse(await run(['metadata', '--locked', '--format-version=1']));
  const notices: string[] = [];
  for (const item of metadata.packages) {
    const root = dirname(item.manifest_path);
    const names = readdirSync(root).filter((name) =>
      /^(?:LICENSE|COPYING)(?:[-_.].*)?$/i.test(name),
    );
    notices.push(`${item.name} ${item.version}\n${item.license ?? ''}\n${item.repository ?? ''}`);
    for (const name of names) notices.push(readFileSync(join(root, name), 'utf8'));
  }
  writeFileSync(join(destination, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n'));
}
if (import.meta.main) await buildNativeFiles(resolve(process.argv[2] ?? 'dist'));
