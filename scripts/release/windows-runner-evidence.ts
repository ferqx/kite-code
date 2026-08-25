import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  parseWindowsSandboxRunnerManifest,
  WINDOWS_SANDBOX_PROTOCOL_VERSION,
} from '@kite-ai/builtin-runtime/sandbox';

/**
 * Produce the release-pinned Windows runner manifest. The digest is computed
 * from the actual built artifact — never hand-written. In CI the runner is
 * built by the workflow before this script runs; locally it can be built with:
 *
 *   bun run scripts/release/build-windows-runner.ts
 *
 * The manifest anchors the runner binary and the vendored Shell runtime
 * digest. A stale digest fails closed (backend resolves to `none`).
 */

const RUNNER_RELEASE_PATH = 'release/windows-shell-runner/kite-windows-runner.exe';
const RUNNER_DEV_PATH = 'native/windows-sandbox-runner/target/release/kite-windows-runner.exe';
const SHELL_RUNTIME_PATH = 'vendor/isksh';
const SHELL_RUNTIME = 'isksh' as const;
const MANIFEST_PATH = 'release/platform-capabilities/windows-runner.json';

function resolveProjectRoot(): string {
  return resolve(import.meta.dirname, '..', '..');
}

function sha256File(path: string): string | null {
  try {
    return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  } catch {
    return null;
  }
}

function findRunner(): { path: string; digest: string } | null {
  const root = resolveProjectRoot();
  for (const relative of [RUNNER_RELEASE_PATH, RUNNER_DEV_PATH]) {
    const path = join(root, relative);
    if (!existsSync(path)) continue;
    const digest = sha256File(path);
    if (digest) return { path: relative.replaceAll('\\', '/'), digest };
  }
  return null;
}

const runner = findRunner();
if (!runner) {
  console.error('windows-runner-evidence: runner binary not found; build it first.');
  process.exit(1);
}

const root = resolveProjectRoot();
const shellRuntimePath = join(root, SHELL_RUNTIME_PATH, 'isksh.exe');
const shellRuntimeDigest = sha256File(shellRuntimePath);
if (!shellRuntimeDigest) {
  console.error('windows-runner-evidence: vendored isksh.exe not found.');
  process.exit(1);
}
const coreutilsDigest = sha256File(join(root, SHELL_RUNTIME_PATH, 'coreutils.exe'));
if (!coreutilsDigest) {
  console.error('windows-runner-evidence: vendored coreutils.exe not found.');
  process.exit(1);
}

const manifest = {
  version: 1,
  protocolVersion: WINDOWS_SANDBOX_PROTOCOL_VERSION,
  runnerVersion: '0.8.3',
  minimumWindowsVersion: '10.0.19045',
  runnerDigest: runner.digest,
  runnerPath: runner.path,
  shellRuntime: SHELL_RUNTIME,
  shellRuntimeDigest,
  shellRuntimePath: SHELL_RUNTIME_PATH,
  coreutilsDigest,
};

if (!parseWindowsSandboxRunnerManifest(manifest)) {
  console.error('windows-runner-evidence: produced manifest is not a valid V1 pin.');
  process.exit(1);
}

const manifestPath = join(root, MANIFEST_PATH);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      status: 'written',
      manifestPath,
      runnerPath: runner.path,
      runnerDigest: runner.digest,
      shellRuntimeDigest,
      minimumWindowsVersion: manifest.minimumWindowsVersion,
      coreutilsDigest,
    },
    null,
    2,
  ),
);
