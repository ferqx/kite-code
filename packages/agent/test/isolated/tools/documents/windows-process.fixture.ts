import assert from 'node:assert/strict';
import type childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const mode = process.argv[2]!;
const originalTimeout = globalThis.setTimeout;
// Only the isolated test process accelerates the production 5s close grace.
if (mode === 'unknown')
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    originalTimeout(fn, delay === 5000 ? 25 : delay, ...args)) as typeof setTimeout;
let kills = 0;
let spawned = 0;
const controller = new AbortController();
const fakeSpawn = (
  _exe: string,
  _args: string[],
  options: { stdio: number[]; detached: boolean; windowsHide: boolean },
) => {
  assert.equal(options.detached, false);
  assert.equal(options.windowsHide, true);
  assert.ok(options.stdio.every(Number.isInteger));
  if (mode === 'spawn-failure') throw Error('probe_spawn_failed');
  spawned++;
  const child = new EventEmitter() as EventEmitter & { kill(): boolean };
  child.kill = () => {
    kills++;
    if (mode !== 'unknown') originalTimeout(() => child.emit('close', null), 1);
    return true;
  };
  originalTimeout(() => {
    if (mode === 'abort') {
      controller.abort(Error('probe_aborted'));
      return;
    }
    if (mode === 'timeout' || mode === 'unknown') return;
    if (mode === 'event-error') {
      child.emit('error', Error('probe_event_error'));
      return;
    }
    if (mode === 'stdout-limit' || mode === 'stderr-limit') {
      writeSync(options.stdio[mode === 'stdout-limit' ? 1 : 2]!, Buffer.alloc(2 * 1024 * 1024 + 1));
      return;
    }
    if (mode === 'replace') {
      const root = readdirSync(process.env.TEMP!).find((name) =>
        name.startsWith('kite-office-process-'),
      )!;
      const path = join(process.env.TEMP!, root, 'stdout');
      renameSync(path, `${path}-retained`);
      writeFileSync(path, 'replacement', { flag: 'wx' });
    } else if (mode === 'cleanup-failure') {
      const root = readdirSync(process.env.TEMP!).find((name) =>
        name.startsWith('kite-office-process-'),
      )!;
      writeFileSync(join(process.env.TEMP!, root, 'unowned'), 'must survive', { flag: 'wx' });
    } else {
      writeSync(options.stdio[1]!, Buffer.from('测试 output'));
      writeSync(options.stdio[2]!, Buffer.from('diagnostic'));
    }
    child.emit('close', mode === 'nonzero' ? 7 : 0);
    if (mode === 'close-abort') controller.abort(Error('probe_aborted'));
  }, 1);
  return child as ReturnType<typeof childProcess.spawn>;
};
// Compile an isolated copy with only spawn replaced; production has no injectable process hook.
(globalThis as unknown as Record<string, unknown>).__officeTestSpawn = fakeSpawn;
const sourcePath = join(import.meta.dir, '../../../../src/tools/documents/windows-process.ts');
const source = readFileSync(sourcePath, 'utf8')
  .replace(
    "import { spawn } from 'node:child_process';",
    'const spawn = globalThis.__officeTestSpawn;',
  )
  .replace(
    "'../../platform/windows-path-security'",
    JSON.stringify(
      pathToFileURL(join(import.meta.dir, '../../../../src/platform/windows-path-security.ts'))
        .href,
    ),
  );
const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
const { runWindowsOfficeProcess } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);
let result: Awaited<ReturnType<typeof runWindowsOfficeProcess>> | undefined;
let error: unknown;
try {
  result = await runWindowsOfficeProcess('fixture.exe', [], {
    env: process.env,
    signal: controller.signal,
    timeoutMs: ['timeout', 'unknown'].includes(mode) ? 15 : 1000,
  });
} catch (caught) {
  error = caught;
}
const expected: Record<string, string> = {
  'spawn-failure': 'probe_spawn_failed',
  'event-error': 'probe_event_error',
  'stdout-limit': 'office_diagnostic_limit',
  'stderr-limit': 'office_diagnostic_limit',
  abort: 'probe_aborted',
  'close-abort': 'probe_aborted',
  timeout: 'office_timeout',
  unknown: 'office_process_exit_unconfirmed',
  replace: 'office_process_cleanup_unconfirmed',
  'cleanup-failure': 'office_process_cleanup_unconfirmed',
};
if (expected[mode]) assert.ok(String(error).includes(expected[mode]!), String(error));
else {
  assert.equal(error, undefined);
  assert.deepEqual(result, {
    code: mode === 'nonzero' ? 7 : 0,
    stdout: '测试 output',
    stderr: 'diagnostic',
  });
}
const entries = readdirSync(process.env.TEMP!);
if (['unknown', 'replace', 'cleanup-failure'].includes(mode)) assert.equal(entries.length, 1);
else assert.deepEqual(entries, []);
if (['abort', 'timeout', 'unknown', 'stdout-limit', 'stderr-limit', 'event-error'].includes(mode))
  assert.equal(kills, 1);
if (mode === 'spawn-failure') assert.equal(spawned, 0);
console.log(JSON.stringify({ mode, passed: true, spawned, kills, retained: entries.length }));
