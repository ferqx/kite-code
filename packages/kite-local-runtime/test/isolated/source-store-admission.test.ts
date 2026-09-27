import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { reviewSourceKiteStoreAdmission } from '../../src/service/source-store-admission';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runSourceFixture(
  options: {
    buildId?: string;
    managedPrefix?: boolean;
    pathCandidate?: boolean;
    pathMissing?: boolean;
    runtimeRoot?: 'separate' | 'historical';
    peerHome?: 'same' | 'other' | 'invalid';
    peerRuntimeHome?: 'same';
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'kite-source-admission-'));
  roots.push(root);
  const repositoryRoot = join(root, 'repo');
  const homePath = join(root, 'home', '.kite-code');
  const scripts = join(repositoryRoot, 'scripts/release/entrypoints');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(homePath, { recursive: true });
  const home = realpathSync.native(homePath);
  const runtimePath =
    options.runtimeRoot === 'separate'
      ? join(root, 'separate-runtime')
      : options.runtimeRoot === 'historical'
        ? join(home, 'source-profiles', 'a'.repeat(32))
        : home;
  mkdirSync(runtimePath, { recursive: true });
  const runtimeRoot = realpathSync.native(runtimePath);
  const pathBin = join(root, 'path-bin');
  if (options.pathCandidate) {
    mkdirSync(pathBin);
    writeFileSync(join(pathBin, 'kite'), 'fixture');
  }
  const fixturePath = options.pathCandidate
    ? `${pathBin}:/usr/bin:/bin`
    : options.pathMissing
      ? `${join(root, 'does-not-exist')}:/usr/bin:/bin`
      : '/usr/bin:/bin';
  const managedPrefix = join(root, 'managed-install');
  if (options.managedPrefix) mkdirSync(managedPrefix);
  let peer: ReturnType<typeof Bun.spawn> | undefined;
  if (options.peerHome) {
    const peerRoot = join(root, 'peer');
    const peerEntry = join(peerRoot, 'scripts/release/entrypoints/service.ts');
    mkdirSync(join(peerRoot, 'scripts/release/entrypoints'), { recursive: true });
    writeFileSync(
      peerEntry,
      "process.stdout.write('ready\\n'); setInterval(() => undefined, 1000);\n",
    );
    const peerConfigHome =
      options.peerHome === 'same'
        ? home
        : options.peerHome === 'other'
          ? join(root, 'other-home')
          : 'relative-home';
    if (options.peerHome === 'other') mkdirSync(peerConfigHome);
    const started = Bun.spawn([process.execPath, peerEntry, 'app-server', 'run-stdio'], {
      env: {
        ...process.env,
        KITE_CODE_CONFIG_HOME: peerConfigHome,
        KITE_CODE_HOME: options.peerRuntimeHome === 'same' ? home : peerConfigHome,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    peer = started;
    const reader = started.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain('ready');
    reader.releaseLock();
  }
  const servicePath = join(scripts, 'service.ts');
  const cliPath = join(scripts, 'cli.ts');
  const modulePath = resolve(import.meta.dir, '../../src/service/source-store-admission.ts');
  writeFileSync(
    servicePath,
    `const { reviewSourceKiteStoreAdmission } = await import(${JSON.stringify(modulePath)});\n` +
      `const result = reviewSourceKiteStoreAdmission({repositoryRoot:${JSON.stringify(repositoryRoot)},canonicalKiteHome:${JSON.stringify(home)},runtimeRoot:${JSON.stringify(runtimeRoot)},expectedSourceBuildId:'dev:fixture',knownManagedPrefixes:[${JSON.stringify(managedPrefix)}]});\n` +
      `process.stdout.write(JSON.stringify(result));\n`,
  );
  writeFileSync(
    cliPath,
    `const child = Bun.spawn([process.execPath, ${JSON.stringify(servicePath)}, 'app-server', 'run-stdio'],{cwd:${JSON.stringify(repositoryRoot)},env:{...process.env,KITE_CODE_HOME:${JSON.stringify(runtimeRoot)},KITE_CODE_CONFIG_HOME:${JSON.stringify(home)},KITE_APP_SERVER_BUILD_ID:${JSON.stringify(options.buildId ?? 'dev:fixture')},PATH:${JSON.stringify(fixturePath)}},stdout:'pipe',stderr:'pipe'});\n` +
      `process.stdout.write(await new Response(child.stdout).text()); await child.exited;\n`,
  );
  try {
    const parent = Bun.spawn([process.execPath, cliPath], {
      cwd: repositoryRoot,
      env: { ...process.env, PATH: fixturePath },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = await new Response(parent.stdout).text();
    const code = await parent.exited;
    expect(code).toBe(0);
    return JSON.parse(output) as ReturnType<typeof reviewSourceKiteStoreAdmission>;
  } finally {
    peer?.kill('SIGTERM');
    if (peer) await peer.exited;
  }
}

test('source CLI parent and current Service admit with verified process evidence', async () => {
  if (process.platform !== 'darwin') {
    expect(
      reviewSourceKiteStoreAdmission({
        repositoryRoot: '/missing',
        canonicalKiteHome: '/missing',
        runtimeRoot: '/missing',
        expectedSourceBuildId: 'dev:test',
      }),
    ).toEqual({ admitted: false, reason: 'unsupported_platform' });
    return;
  }
  const result = await runSourceFixture({ pathMissing: true });
  expect(result.admitted).toBe(true);
  if (result.admitted) expect(result.evidence.scope).toBe('current_source_cli_tui');
});

test('source build drift and historical runtime aliases refuse admission', async () => {
  if (process.platform !== 'darwin') return;
  expect(await runSourceFixture({ buildId: 'dev:stale' })).toEqual({
    admitted: false,
    reason: 'source_build_mismatch',
  });
  expect(await runSourceFixture({ runtimeRoot: 'historical' })).toEqual({
    admitted: false,
    reason: 'source_identity_mismatch',
  });
  expect((await runSourceFixture({ runtimeRoot: 'separate' })).admitted).toBe(true);
});

test('source migration admits a separate home and blocks an active same-home writer', async () => {
  if (process.platform !== 'darwin') return;
  expect(
    (
      await runSourceFixture({
        managedPrefix: true,
        pathCandidate: true,
        peerHome: 'other',
      })
    ).admitted,
  ).toBe(true);
  expect(await runSourceFixture({ peerHome: 'same' })).toEqual({
    admitted: false,
    reason: 'legacy_process_busy',
  });
  expect(await runSourceFixture({ peerHome: 'other', peerRuntimeHome: 'same' })).toEqual({
    admitted: false,
    reason: 'legacy_process_busy',
  });
  expect(await runSourceFixture({ peerHome: 'invalid' })).toEqual({
    admitted: false,
    reason: 'legacy_process_inspection_incomplete',
  });
});

test('source admission ignores static installed and PATH entries', async () => {
  if (process.platform !== 'darwin') return;
  const result = await runSourceFixture({
    managedPrefix: true,
    pathCandidate: true,
  });
  expect(result.admitted).toBe(true);
});
