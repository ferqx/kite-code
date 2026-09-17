import { afterEach, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  observeLegacyKiteStoreProcesses,
  readKiteSourceClientParentIdentity,
  readLegacyKiteProcessIdentity,
} from '../../src/service/legacy-store-processes';

const children: Array<{ kill(signal?: NodeJS.Signals | number): void; exited: Promise<number> }> =
  [];
const directories: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGTERM');
    await child.exited;
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(entrypoint: 'service' | 'cli', args: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'kite-legacy-process-'));
  directories.push(root);
  const folder = join(root, 'scripts', 'release', 'entrypoints');
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${entrypoint}.ts`);
  writeFileSync(path, "process.stdout.write('ready\\n'); setInterval(() => undefined, 1000);\n");
  const child = Bun.spawn([process.execPath, path, ...args], { stdout: 'pipe', stderr: 'pipe' });
  children.push(child);
  return child;
}

async function ready(child: ReturnType<typeof fixture>): Promise<void> {
  const reader = child.stdout.getReader();
  const result = await reader.read();
  expect(new TextDecoder().decode(result.value)).toContain('ready');
  reader.releaseLock();
}

test('Darwin observes a real legacy Service child and requires exact start token to exclude it', async () => {
  if (process.platform !== 'darwin') return;
  const child = fixture('service', ['app-server', 'run-stdio']);
  await ready(child);
  const observation = observeLegacyKiteStoreProcesses();
  expect(observation.status).toBe('busy');
  if (observation.status !== 'busy') return;
  const match = observation.matches.find((value) => value.pid === child.pid);
  expect(match?.kind).toBe('service');
  if (!match) throw new Error('Fixture Service was not observed.');
  expect(match.startIdentity).toMatch(/^darwin:\d+:\d+$/u);
  expect(readLegacyKiteProcessIdentity(child.pid)).toEqual({
    pid: child.pid,
    startIdentity: match.startIdentity,
  });
  const wrongToken = observeLegacyKiteStoreProcesses({
    exclude: [{ pid: child.pid, startIdentity: 'darwin:0:0' }],
  });
  expect(wrongToken.status).toBe('busy');
  if (wrongToken.status === 'busy')
    expect(wrongToken.matches.some((value) => value.pid === child.pid)).toBe(true);
  const excluded = observeLegacyKiteStoreProcesses({
    exclude: [{ pid: child.pid, startIdentity: match!.startIdentity }],
  });
  if (excluded.status === 'busy')
    expect(excluded.matches.some((value) => value.pid === child.pid)).toBe(false);
  else expect(excluded.status).toBe('complete');
  child.kill('SIGTERM');
  await child.exited;
  expect(readLegacyKiteProcessIdentity(child.pid)).toBeUndefined();
  const afterExit = observeLegacyKiteStoreProcesses();
  if (afterExit.status === 'busy')
    expect(afterExit.matches.some((value) => value.pid === child.pid)).toBe(false);
  else expect(afterExit.status).toBe('complete');
});

test('Darwin observes source CLI parent and unsupported platforms do not claim completion', async () => {
  expect(observeLegacyKiteStoreProcesses({ platform: 'linux' }).status).toBe('unsupported');
  if (process.platform !== 'darwin') return;
  const child = fixture('cli', []);
  await ready(child);
  const fixtureRoot = directories.at(-1)!;
  expect(readKiteSourceClientParentIdentity(child.pid, fixtureRoot)?.pid).toBe(child.pid);
  expect(readKiteSourceClientParentIdentity(child.pid, tmpdir())).toBeUndefined();
  const observation = observeLegacyKiteStoreProcesses();
  expect(observation.status).toBe('busy');
  if (observation.status === 'busy') {
    expect(observation.matches.find((value) => value.pid === child.pid)?.kind).toBe(
      'source_client',
    );
  }
});

test('Darwin blocks live installed writers under an unlisted custom prefix', async () => {
  if (process.platform !== 'darwin') return;
  const root = mkdtempSync(join(tmpdir(), 'kite-unlisted-managed-process-'));
  directories.push(root);
  const bin = join(root, 'managed', 'releases', 'a'.repeat(24), 'bin');
  mkdirSync(bin, { recursive: true });
  const script = join(root, 'keepalive.ts');
  writeFileSync(script, "process.stdout.write('ready\\n'); setInterval(() => undefined, 1000);\n");
  for (const [name, args, kind] of [
    ['kite-service', ['app-server', 'run-stdio'], 'service'],
    ['kite-tui', [], 'launcher'],
  ] as const) {
    const executable = join(bin, name);
    copyFileSync(process.execPath, executable);
    chmodSync(executable, 0o755);
    const child = Bun.spawn([executable, script, ...args], { stdout: 'pipe', stderr: 'pipe' });
    children.push(child);
    await ready(child);
    const observed = observeLegacyKiteStoreProcesses();
    expect(observed.status).toBe('busy');
    if (observed.status !== 'busy') continue;
    expect(observed.matches.find((value) => value.pid === child.pid)?.kind).toBe(kind);
  }
});
