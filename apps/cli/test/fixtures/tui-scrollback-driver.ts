import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ptyDeadline, spawnTuiPTY } from './tui-pty';

const [root, executable, fixture, repository] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
// Observe the real private kernel identity without expanding the CLI workspace or public API.
const { readProcessStartIdentity } = (await import(
  pathToFileURL(join(repository, 'apps/service/src/daemon/process-identity.ts')).href
)) as { readProcessStartIdentity(pid: number): string | undefined };
type Ack = { token: number; storedMessages: number; mutationCalls: number };
type Event =
  | { kind: 'data'; hex: string }
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'mark'; name: string; ack: Ack | null };
const events: Event[] = [];
const started = performance.now();
const abort = new AbortController();
const interrupt = () => abort.abort(Error('scrollback_driver_interrupted'));
process.once('SIGTERM', interrupt);
process.once('SIGINT', interrupt);
process.on('message', (message) => {
  if (message === 'scrollback-driver-stop') interrupt();
});
let active: ReturnType<typeof spawnTuiPTY> | undefined;
let start: string | undefined;
let token = 0;
let code: number | null = null;
let normal = false;
let forcedCleanup = false;
let failure: unknown;
const cleanupErrors: unknown[] = [];
const pump = async (ms = 50) => {
  abort.signal.throwIfAborted();
  await Bun.sleep(ms);
  await active!.drain();
  abort.signal.throwIfAborted();
};
const waitAck = async (expected: number): Promise<Ack> => {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    await pump();
    let ack: Ack | undefined;
    try {
      ack = JSON.parse(readFileSync(join(root, 'ack.json'), 'utf8')) as Ack;
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error;
    }
    if (ack?.token === expected) {
      await pump(150);
      return ack;
    }
    if (active!.ended) throw Error(`owned host exited before ack ${expected}`);
  }
  throw Error(`owned host ack timeout ${expected}`);
};
const control = async (action: string) => {
  token++;
  const path = join(root, 'control.json');
  writeFileSync(`${path}.new`, JSON.stringify({ token, action }));
  renameSync(`${path}.new`, path);
  return waitAck(token);
};
const mark = (name: string, ack: Ack | null = null) => events.push({ kind: 'mark', name, ack });
const key = (value: string) => {
  abort.signal.throwIfAborted();
  active!.host.terminal!.write(value);
};
const line = (prefix: string, number: number) => `${prefix}_${String(number).padStart(2, '0')}`;

try {
  active = spawnTuiPTY({
    cmd: [executable, fixture, root],
    cwd: repository,
    env: { TERM: 'xterm-256color', FORCE_COLOR: '3' },
    onData: (bytes) => events.push({ kind: 'data', hex: Buffer.from(bytes).toString('hex') }),
  });
  start = readProcessStartIdentity(active.host.pid);
  if (!start) throw Error('scrollback_fixture_birth_unknown');
  const identity = { kind: 'scrollback-fixture', pid: active.host.pid, start };
  writeFileSync(join(root, 'fixture-identity.json'), JSON.stringify(identity));
  process.send?.(identity);
  mark('round1', await waitAck(0));
  mark('round2', await control('round2'));
  mark('round3', await control('round3'));
  mark('status', await control('status'));
  key('editing-safe');
  await pump(400);
  mark('edited');
  key('\x7f'.repeat('editing-safe'.length));
  await pump(200);
  for (const [cols, name] of [
    [40, 'narrow'],
    [80, 'restored'],
  ] as const) {
    events.push({ kind: 'resize', cols, rows: 24 });
    active.host.terminal!.resize(cols, 24);
    await pump(400);
    mark(name);
  }
  mark('body-replaced', await control('changed'));
  mark('cleared', await control('clear'));
  mark('refreshed', await control('refresh'));
  mark('changed', await control('changed'));
  mark('session-b', await control('session-b'));
  mark('session-a', await control('session-a'));
  mark('active', await control('active'));
  mark('active-status', await control('status'));
  key('editing-safe');
  await pump(400);
  mark('active-edited');
  key('\x7f'.repeat('editing-safe'.length));
  await pump(200);
  mark('pending', await control('pending'));
  mark('pending-status', await control('status'));
  key('editing-safe');
  await pump(400);
  mark('pending-edited');
  key('\x7f'.repeat('editing-safe'.length));
  await pump(200);
  key(
    `\x1b[200~${Array.from({ length: 12 }, (_, i) => line('ANSWER_LINE', i + 1)).join('\n')}\x1b[201~`,
  );
  await pump(400);
  mark('pending-pasted');
  key('\x7f');
  await pump(200);
  for (let number = 1; number <= 12; number++) {
    if (number > 1) {
      key('\x1b[13;2u');
      await pump(40);
    }
    key(line('ANSWER_LINE', number));
    await pump(40);
  }
  await pump(300);
  mark('pending-long-input');
  key('\x7f'.repeat(179));
  await pump(200);
  key('a'.repeat(150));
  await pump(200);
  for (const value of ['\x1b[H', '\x1b[A', '\x1b[A', '\x1b[F']) {
    key(value);
    await pump(80);
  }
  mark('pending-visible-end');
  key('\x1b[C\x1b[D');
  await pump(200);
  mark('pending-wrap-next');
  mark('pending-choices', await control('pending-choices'));
  mark('choices-status', await control('status'));
  key('\x1b[B\x1b[B');
  await pump(400);
  mark('choices-selected');
  mark('json', await control('json'));
  const jsonDraft = JSON.stringify(
    Array.from({ length: 30 }, (_, i) => `${line('JSON_DRAFT_LINE', i + 1)} 原文 / @ café é 🧭`),
    null,
    2,
  );
  key(`\x1b[200~${jsonDraft}\x1b[201~`);
  await pump(400);
  mark('json-pasted');
  mark('json-status', await control('status'));
  key(' ');
  await pump(300);
  mark('json-edited');
  key('\x7f\x7f');
  await pump(200);
  key('[');
  await pump(40);
  for (let number = 1; number <= 12; number++) {
    key('\x1b[13;2u');
    await pump(40);
    key(`  "${line('JSON_TYPED', number)} 原文"${number < 12 ? ',' : ''}`);
    await pump(40);
  }
  key('\x1b[13;2u');
  await pump(40);
  key(']');
  await pump(300);
  mark('json-long-input');
  await control('stop');
  await pump(100);
  [code] = await ptyDeadline(
    Promise.all([active.host.exited, active.eof]),
    3000,
    'scrollback_original_three_second_join',
  );
  normal = code === 0;
} catch (error) {
  failure = error;
} finally {
  if (active && !active.ended) {
    forcedCleanup = true;
    try {
      active.host.kill('SIGTERM');
      [code] = await ptyDeadline(
        Promise.all([active.host.exited, active.eof]),
        3000,
        'scrollback_original_term_cleanup_timeout',
      );
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'scrollback_original_term_cleanup_timeout')
        cleanupErrors.push(error);
      try {
        active.host.kill('SIGKILL');
        [code] = await ptyDeadline(
          Promise.all([active.host.exited, active.eof]),
          3000,
          'scrollback_original_kill_cleanup_timeout',
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (active) {
    if (active.ended) code ??= await active.host.exited;
    try {
      await active.drain();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      active.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  writeFileSync(
    join(root, 'events.json'),
    JSON.stringify({
      pid: active?.host.pid ?? null,
      start: start ?? null,
      exitCode: code,
      signalCode: active?.host.signalCode ?? null,
      normalComplete: normal,
      forcedCleanup,
      failure: failure ? String(failure) : null,
      cleanupErrors: cleanupErrors.map(String),
      elapsedSeconds: (performance.now() - started) / 1000,
      transport: process.platform === 'win32' ? 'Bun ConPTY' : 'Bun POSIX PTY',
      events,
    }),
  );
  if (process.connected) process.disconnect?.();
}
if (cleanupErrors.length)
  throw new AggregateError(
    failure ? [failure, ...cleanupErrors] : cleanupErrors,
    'scrollback_cleanup_unknown',
  );
if (failure) throw failure;
process.exitCode = normal ? 0 : 1;
