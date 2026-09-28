import { afterEach, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyKiteProcess,
  observeLegacyKiteStoreProcesses,
  readKiteSourceClientParentIdentity,
  readLegacyKiteProcessIdentity,
} from '../../src/service/legacy-store-processes';

test('Desktop observation recognizes main processes without treating launchers or renderers as writers', () => {
  const electron = '/checkout/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';
  const renderer =
    '/checkout/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)';
  expect(classifyKiteProcess(electron, ['/checkout/apps/kite-desktop'], [])).toBe('desktop');
  expect(classifyKiteProcess('/Applications/kite.app/Contents/MacOS/kite', [], [])).toBe('desktop');
  expect(
    classifyKiteProcess('/Applications/kite.app/Contents/MacOS/helper', [], []),
  ).toBeUndefined();
  expect(
    classifyKiteProcess(
      '/usr/local/bin/bun',
      ['bun', 'run', '--cwd', 'apps/kite-desktop', 'dev'],
      [],
    ),
  ).toBeUndefined();
  expect(
    classifyKiteProcess(
      renderer,
      ['--type=renderer', '--app-path=/checkout/apps/kite-desktop'],
      [],
    ),
  ).toBeUndefined();
});

test('executable-only Kite patterns remain identifiable without arguments', () => {
  expect(classifyKiteProcess('/some/prefix/bin/kite-service', [], [])).toBe('launcher');
  expect(classifyKiteProcess('/Applications/kite.app/Contents/MacOS/kite', [], [])).toBe('desktop');
  expect(classifyKiteProcess('/usr/bin/git', [], [])).toBeUndefined();
  expect(
    classifyKiteProcess('/Applications/Other.app/Contents/MacOS/Other', [], []),
  ).toBeUndefined();
});

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

function fixture(entrypoint: 'service' | 'cli', args: string[], env?: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'kite-legacy-process-'));
  directories.push(root);
  const folder = join(root, 'scripts', 'release', 'entrypoints');
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${entrypoint}.ts`);
  writeFileSync(path, "process.stdout.write('ready\\n'); setInterval(() => undefined, 1000);\n");
  const child = Bun.spawn([process.execPath, path, ...args], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.push(child);
  return child;
}

test('Darwin scopes live Services by Store and refuses an unknown candidate home', async () => {
  if (process.platform !== 'darwin') return;
  const root = mkdtempSync(join(tmpdir(), 'kite-scoped-observation-'));
  directories.push(root);
  const home = join(root, 'home');
  const otherHome = join(root, 'other-home');
  mkdirSync(home);
  mkdirSync(otherHome);
  const child = fixture('service', ['app-server', 'run-stdio'], {
    KITE_CODE_CONFIG_HOME: home,
    KITE_CODE_HOME: home,
  });
  await ready(child);
  const same = observeLegacyKiteStoreProcesses({ canonicalKiteHome: home });
  expect(same.status).toBe('busy');
  if (same.status === 'busy')
    expect(same.matches.some((entry) => entry.pid === child.pid)).toBe(true);
  const other = observeLegacyKiteStoreProcesses({ canonicalKiteHome: otherHome });
  expect(other.status).toBe('complete');
  child.kill('SIGTERM');
  await child.exited;
  const unknown = fixture('service', ['app-server', 'run-stdio'], {
    KITE_CODE_CONFIG_HOME: 'relative-home',
    KITE_CODE_HOME: 'relative-home',
  });
  await ready(unknown);
  expect(observeLegacyKiteStoreProcesses({ canonicalKiteHome: home })).toEqual({
    status: 'incomplete',
    reason: 'process_identity',
  });
});

test('Darwin scopes a different client by that process HOME', async () => {
  if (process.platform !== 'darwin') return;
  const root = mkdtempSync(join(tmpdir(), 'kite-process-home-scope-'));
  directories.push(root);
  const observerHome = join(root, 'observer');
  const clientHome = join(root, 'client');
  mkdirSync(observerHome);
  mkdirSync(clientHome);
  const client = fixture('cli', [], { HOME: clientHome });
  await ready(client);

  const script = join(root, 'observe.ts');
  const source = new URL('../../src/service/legacy-store-processes.ts', import.meta.url).pathname;
  writeFileSync(
    script,
    `import { observeLegacyKiteStoreProcesses } from ${JSON.stringify(source)};
process.stdout.write(JSON.stringify(observeLegacyKiteStoreProcesses({ canonicalKiteHome: ${JSON.stringify(join(observerHome, '.kite-code'))} })));`,
  );
  const observer = Bun.spawn([process.execPath, script], {
    env: { ...process.env, HOME: observerHome },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, exitCode] = await Promise.all([
    new Response(observer.stdout).text(),
    observer.exited,
  ]);
  expect(exitCode).toBe(0);
  const result = JSON.parse(output) as ReturnType<typeof observeLegacyKiteStoreProcesses>;
  if (result.status === 'busy')
    expect(result.matches.some((match) => match.pid === client.pid)).toBe(false);
  else expect(result.status).toBe('complete');
});

test('Darwin ignores a verified zombie even while its PID still exists', async () => {
  if (process.platform !== 'darwin') return;
  const python = Bun.which('python3');
  if (!python) throw new Error('Python is required for the macOS zombie process fixture.');
  const root = mkdtempSync(join(tmpdir(), 'kite-zombie-observation-'));
  directories.push(root);
  const home = join(root, 'home');
  mkdirSync(home);
  const script = [
    'import ctypes, os, sys',
    'pid = os.fork()',
    'if pid == 0: os._exit(0)',
    'info = ctypes.create_string_buffer(128)',
    'libc = ctypes.CDLL(None, use_errno=True)',
    'if libc.waitid(os.P_PID, pid, info, os.WEXITED | os.WNOWAIT) != 0: os._exit(2)',
    'print(pid, flush=True)',
    'sys.stdin.read(1)',
    'os.waitpid(pid, 0)',
  ].join('\n');
  const parent = Bun.spawn([python, '-c', script], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    const reader = parent.stdout.getReader();
    const line = await reader.read();
    reader.releaseLock();
    const pid = Number(new TextDecoder().decode(line.value).trim());
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(observeLegacyKiteStoreProcesses({ canonicalKiteHome: home })).toEqual({
      status: 'complete',
      matches: [],
    });
  } finally {
    parent.stdin.write('x');
    parent.stdin.end();
    await parent.exited;
  }
});

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
