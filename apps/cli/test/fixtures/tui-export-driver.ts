import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { defaultWindowsPathSecurity } from '@kite-ai/agent/windows-path-security';
import { ptyDeadline, spawnTuiPTY, terminateTuiTree } from './tui-pty';

const input = JSON.parse(process.argv[2]!) as {
  executable: string;
  entrypoint: string;
  root: string;
  workspace: string;
  dataRoot: string;
  profilePath: string;
  evidence: string;
  tail: string;
};
const abort = new AbortController();
const interrupted = () => abort.abort(Error('original_export_interrupted'));
const stop = (message: unknown) => {
  if (message === 'export-driver-stop') interrupted();
};
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
if (process.platform === 'win32') process.on('message', stop);
let buffer = Buffer.alloc(0),
  reasonSeen = false,
  clearSeen = false;
const raw: Uint8Array[] = [];
let dataRevision = 0;
let actionRevision = -1;
const pty = spawnTuiPTY({
  cmd: [
    input.executable,
    input.entrypoint,
    '--test-ui-diagnostics',
    '--workspace',
    input.workspace,
    '--thread',
    'a',
    '--data-root',
    input.dataRoot,
  ],
  cwd: input.root,
  onData(bytes) {
    dataRevision++;
    raw.push(bytes.slice());
    const window = Buffer.concat([buffer.subarray(-64), bytes]);
    reasonSeen ||= window.includes('ACTUAL_LOADED_REASON_TAIL');
    clearSeen ||= window.includes('\x1b[3J');
    buffer = Buffer.concat([buffer, bytes]).subarray(-131072);
  },
});
const compact = () =>
  buffer
    .toString('utf8')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip actual original ANSI transport bytes.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\s+/g, '');
const reset = () => {
  buffer = Buffer.alloc(0);
  reasonSeen = false;
  clearSeen = false;
};
const key = async (value: string) => {
  abort.signal.throwIfAborted();
  // The original large-output observer reads raw chunks while they arrive;
  // waiting for full headless parsing loses reasoning at the front of a redraw.
  actionRevision = dataRevision;
  pty.host.terminal!.write(value);
};
const wait = async (text: string) => {
  const end = Date.now() + 30000;
  for (;;) {
    abort.signal.throwIfAborted();
    const observed =
      text === 'ACTUAL_LOADED_REASON_TAIL'
        ? reasonSeen
        : compact().includes(text.replace(/\s+/g, ''));
    if (dataRevision > actionRevision && observed) return;
    if (pty.ended || Date.now() > end)
      throw Error(`expected ${text} tail=${buffer.subarray(-2000).toString('utf8')}`);
    await Bun.sleep(100);
  }
};
const toolResult = () => {
  const text = compact();
  assert(text.includes('files.read['), `missing original tool header ${text.slice(-2000)}`);
  return text
    .slice(text.lastIndexOf('files.read[') + 'files.read['.length)
    .split('Ctrl+Bpendingcards')[0]!;
};
const files = () =>
  readdirSync(input.profilePath)
    .filter((name) => name.startsWith('session-') && name.endsWith('.md'))
    .map((name) => join(input.profilePath, name));
let owned: number[] = [],
  normal = false,
  failure: unknown;
try {
  await wait('New Run');
  const listing =
    process.platform === 'win32'
      ? Bun.spawnSync(
          [
            'powershell.exe',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${pty.host.pid}" | Select-Object -ExpandProperty ProcessId`,
          ],
          { stdout: 'pipe', stderr: 'pipe' },
        )
      : Bun.spawnSync(['ps', '-axo', 'pid,ppid'], { stdout: 'pipe', stderr: 'pipe' });
  assert.equal(listing.exitCode, 0, Buffer.from(listing.stderr).toString());
  owned = Buffer.from(listing.stdout)
    .toString()
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((row) =>
      process.platform === 'win32'
        ? Number.isSafeInteger(row[0]) && row[0]! > 0
        : row[1] === pty.host.pid,
    )
    .map((row) => row[0]!);
  assert(owned.length > 0, 'original paired Service child required');
  for (const pid of owned) process.kill(pid, 0);
  await key('owned task');
  await Bun.sleep(100);
  await key('\r');
  await wait('9000025 bytes, complete');
  await key('/export');
  await wait('New Run > /export');
  await key('\r');
  await wait('Exported loaded conversation:');
  let exported = files();
  assert.equal(exported.length, 1, 'first export paths');
  const preview = readFileSync(exported[0]!, 'utf8');
  assert(preview.includes('Loaded preview only'), 'missing preview marker');
  assert(!preview.includes(input.tail), 'unread full tail unexpectedly exported');
  assert(!preview.includes('ACTUAL_LOADED_REASON_TAIL'), 'unread reasoning unexpectedly exported');
  reset();
  await Bun.sleep(100);
  await key('\x0f');
  await Bun.sleep(400);
  await Bun.sleep(1000);
  await wait(input.tail);
  await wait('New Run >');
  reset();
  await key('\r');
  await wait('Result collapsed');
  await wait('Empty Enter expands the current tail result');
  assert(clearSeen && !reasonSeen && compact().includes(input.tail), 'collapse original content');
  assert(
    toolResult().includes('Resultcollapsed') && !toolResult().includes('"artifactRefs"'),
    'collapsed result',
  );
  reset();
  await key('\r');
  await wait(input.tail);
  await wait('Empty Enter collapses the current tail result');
  assert(clearSeen && !reasonSeen && compact().includes(input.tail), 'expand original content');
  assert(
    toolResult().includes('"artifactRefs"') && !toolResult().includes('Resultcollapsed'),
    'expanded result',
  );
  console.log('TAIL_RESULT_COLLAPSE_EXPAND_ORIGINAL_ARTIFACT_REFS');
  reset();
  await key('\x14');
  await wait('ACTUAL_LOADED_REASON_TAIL');
  await wait(input.tail);
  await wait('Ctrl+T hides recorded reasoning');
  assert(clearSeen && reasonSeen, 'show original reasoning');
  reset();
  await key('\x14');
  await wait(input.tail);
  await wait('Ctrl+T shows recorded reasoning');
  assert(
    clearSeen && !reasonSeen && toolResult().includes('"artifactRefs"'),
    'hide only reasoning',
  );
  console.log('RECORDED_REASON_SHOW_HIDE_ORIGINAL_CONTENT');
  reset();
  await key('/export');
  await wait('New Run > /export');
  reset();
  await key('\r');
  const exportDeadline = Date.now() + 30000;
  while (files().length < 2) {
    abort.signal.throwIfAborted();
    if (Date.now() > exportDeadline)
      throw Error(`second export missing tail=${buffer.subarray(-2000).toString('utf8')}`);
    await Bun.sleep(100);
  }
  exported = files();
  assert.equal(exported.length, 2, 'second export paths');
  const newest = exported.reduce((a, b) => (statSync(a).mtimeMs >= statSync(b).mtimeMs ? a : b));
  await wait(basename(newest));
  const full = exported
    .map((path) => readFileSync(path, 'utf8'))
    .reduce((a, b) => (a.length >= b.length ? a : b));
  assert(
    Buffer.byteLength(full) > 8 * 1024 * 1024 &&
      full.includes(input.tail) &&
      full.includes('> ACTUAL_LOADED_REASON_TAIL'),
  );
  for (const path of exported) {
    // Preserve exact POSIX 0600. Windows checks the same physical files' native
    // private ACL and identity; mode bits cannot prove the Windows contract.
    if (process.platform === 'win32') defaultWindowsPathSecurity()!.verifyFile(path);
    else assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  console.log('EXPORT_FULL_TAIL_REASON_0600');
  await key('\x11');
  const exitDeadline = Date.now() + 6000;
  while (!pty.ended && Date.now() < exitDeadline) {
    abort.signal.throwIfAborted();
    await Bun.sleep(100);
  }
  const code = await ptyDeadline(
    Promise.all([pty.host.exited, pty.eof]),
    3000,
    'original host exit timeout',
  );
  assert.equal(code[0], 0, 'original host exit');
  for (const pid of owned) {
    assert.throws(
      () => process.kill(pid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
      'owned Service process remains',
    );
  }
  normal = true;
  console.log('OWNED_SERVICE_STOPPED');
  console.log('HOST_EXIT 0');
  console.log('FULL_TAIL_OBSERVED True');
} catch (error) {
  failure = error;
  throw error;
} finally {
  try {
    if (!pty.ended) await terminateTuiTree(pty, { exitTimeoutMs: 3000 });
  } finally {
    await pty.drain();
    pty.close();
    writeFileSync(join(input.evidence, 'terminal.bin'), Buffer.concat(raw));
    writeFileSync(
      join(input.evidence, 'pty-exit.json'),
      JSON.stringify(
        {
          pid: pty.host.pid,
          owned,
          normal,
          code: pty.host.exitCode,
          failure: failure instanceof Error ? failure.message : (failure ?? null),
          filePrivacy:
            process.platform === 'win32' ? 'native_verify_same_two_files' : 'exact_posix_0600',
        },
        null,
        2,
      ),
    );
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    if (process.platform === 'win32') {
      process.removeListener('message', stop);
      process.disconnect?.();
    }
  }
}
