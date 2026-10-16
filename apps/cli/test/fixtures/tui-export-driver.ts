import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
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
  bodyText: string;
  bodyRepeats: number;
  databasePath: string;
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
let originalToolExecutionId: string | undefined;
const decoder = new StringDecoder('utf8');
const normalize = (text: string) => text.replace(/\s+/g, '');
const expectedBody = normalize(input.bodyText.repeat(input.bodyRepeats) + input.tail);
let bodyPosition = 0,
  bodyVerified = false,
  currentBodyVerified = false;
let nativeTail = '',
  actionTail = '',
  originalToolMaterial = '',
  readingOriginalTool = false;
let ansiState: 'text' | 'escape' | 'csi' | 'osc' | 'osc_escape' = 'text';
let csi = '';
let synchronizedOutput = false,
  actionFrameReady = false,
  nativeFrameReady = false;
const composerPainted = () =>
  actionTail.includes('NewRun>') &&
  actionTail.includes(normalize('fixture ·')) &&
  actionTail.includes(normalize('· [Request approval]')) &&
  actionTail.includes(normalize('Shift+Tab: plan · /help'));
const markers = [
  'New Run',
  '9000025 bytes, complete',
  'New Run > /export',
  'Exported loaded conversation:',
  'Result collapsed',
  'Empty Enter expands the current tail result',
  'Empty Enter collapses the current tail result',
  'ACTUAL_LOADED_REASON_TAIL',
].map(normalize);
const actionMarkers = new Set<string>();
const clearAction = () => {
  actionTail = '';
  actionFrameReady = false;
  actionMarkers.clear();
  originalToolMaterial = '';
  readingOriginalTool = false;
  reasonSeen = false;
  clearSeen = false;
};
const printable = (value: string) => {
  const text = normalize(value);
  if (!text) return;
  // Consume every exact original character once. Neither API/export text nor a
  // short matching tail can stand in for the three-million-character PTY body.
  for (let i = 0; i < text.length; i++) {
    const character = text[i]!;
    bodyPosition =
      character === expectedBody[bodyPosition]
        ? bodyPosition + 1
        : character === expectedBody[0]
          ? 1
          : 0;
    if (bodyPosition === expectedBody.length) {
      bodyVerified = true;
      currentBodyVerified = true;
      bodyPosition = 0;
    }
  }
  const material = actionTail + text;
  for (const marker of markers) if (material.includes(marker)) actionMarkers.add(marker);
  reasonSeen ||= material.includes('ACTUAL_LOADED_REASON_TAIL');
  const header = `files.read[${originalToolExecutionId}]`;
  if (readingOriginalTool)
    originalToolMaterial += text.slice(0, Math.max(0, 65536 - originalToolMaterial.length));
  else if (originalToolExecutionId && material.includes(header)) {
    readingOriginalTool = true;
    originalToolMaterial = material.slice(
      material.lastIndexOf(header) + header.length,
      material.lastIndexOf(header) + header.length + 65536,
    );
  }
  actionTail = material.slice(-4096);
  nativeTail = (nativeTail + text).slice(-4096);
  if (!synchronizedOutput && currentBodyVerified && composerPainted()) {
    actionFrameReady = true;
    nativeFrameReady = true;
  }
};
const scan = (bytes: Uint8Array) => {
  const decoded = decoder.write(Buffer.from(bytes));
  let start = 0;
  for (let i = 0; i < decoded.length; i++) {
    const character = decoded[i]!;
    if (ansiState === 'text') {
      if (character !== '\x1b') continue;
      printable(decoded.slice(start, i));
      ansiState = 'escape';
    } else if (ansiState === 'escape') {
      ansiState = character === '[' ? 'csi' : character === ']' ? 'osc' : 'text';
      csi = '';
    } else if (ansiState === 'csi') {
      csi += character;
      if (character >= '@' && character <= '~') {
        if (csi === '?2026h') {
          synchronizedOutput = true;
          actionFrameReady = false;
          nativeFrameReady = false;
        }
        if (csi === '?2026l' && currentBodyVerified && composerPainted()) {
          actionFrameReady = true;
          nativeFrameReady = true;
        }
        if (csi === '3J') {
          clearAction();
          clearSeen = true;
          nativeTail = '';
          currentBodyVerified = false;
          nativeFrameReady = false;
          bodyPosition = 0;
        }
        ansiState = 'text';
      }
    } else if (ansiState === 'osc') {
      if (character === '\x07') ansiState = 'text';
      else if (character === '\x1b') ansiState = 'osc_escape';
    } else if (ansiState === 'osc_escape') ansiState = character === '\\' ? 'text' : 'osc';
    start = i + 1;
  }
  if (ansiState === 'text') printable(decoded.slice(start));
};
const pty = spawnTuiPTY({
  cmd: [
    input.executable,
    join(import.meta.dir, 'tui-diagnostics-entry.ts'),
    input.entrypoint,
    '--workspace',
    input.workspace,
    '--thread',
    'a',
    '--data-root',
    input.dataRoot,
  ],
  cwd: input.root,
  observation: 'stream',
  onData(bytes) {
    dataRevision++;
    raw.push(bytes.slice());
    scan(bytes);
    buffer = Buffer.concat([buffer, bytes]).subarray(-131072);
  },
});
const reset = () => {
  buffer = Buffer.alloc(0);
  clearAction();
};
const key = async (value: string) => {
  abort.signal.throwIfAborted();
  actionRevision = dataRevision;
  clearAction();
  await pty.key(value);
};
const wait = async (text: string) => {
  const end = Date.now() + 30000;
  for (;;) {
    abort.signal.throwIfAborted();
    const observed =
      text === 'ACTUAL_LOADED_REASON_TAIL'
        ? reasonSeen
        : actionMarkers.has(normalize(text)) || actionTail.includes(normalize(text));
    if (dataRevision > actionRevision && observed) return;
    if (pty.ended || Date.now() > end)
      throw Error(`expected ${text} tail=${buffer.subarray(-2000).toString('utf8')}`);
    await Bun.sleep(100);
  }
};
// Static output remains original native terminal material until an actual 3J.
// This stream observation proves printed bytes and clear boundaries, not cursor geometry.
const waitNative = async (text: string) => {
  const end = Date.now() + 30000;
  for (;;) {
    abort.signal.throwIfAborted();
    if (text === input.tail ? currentBodyVerified : nativeTail.includes(normalize(text)))
      return text;
    if (pty.ended || Date.now() > end)
      throw Error(`expected native printed history ${text} tail=${nativeTail.slice(-2000)}`);
    await Bun.sleep(100);
  }
};
// The prompt follows the giant Static body. Wait for its actual completed
// output frame before sending the next semantic key; an early Tool hint alone
// does not prove that the previous frame has handed input back.
const waitCompletePaint = async (currentAction: boolean) => {
  const end = Date.now() + 30000;
  while (!currentBodyVerified || !(currentAction ? actionFrameReady : nativeFrameReady)) {
    abort.signal.throwIfAborted();
    if (pty.ended || Date.now() > end) throw Error('original body/composer paint did not complete');
    await Bun.sleep(100);
  }
};
const toolResult = () => {
  assert(
    originalToolExecutionId && readingOriginalTool,
    `missing original current-action tool header ${actionTail.slice(-2000)}`,
  );
  return originalToolMaterial;
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
  const database = new Database(input.databasePath, { readonly: true });
  try {
    const originals = database
      .query(
        "SELECT id FROM execution WHERE session_id='a' AND adapter_id='files.read' AND state='succeeded'",
      )
      .all() as { id: string }[];
    assert.equal(originals.length, 1, 'exact original Files execution');
    originalToolExecutionId = originals[0]!.id;
  } finally {
    database.close();
  }

  await key('/export');
  await wait('New Run > /export');
  await key('\r');
  await wait('Exported loaded conversation:');
  let exported = files();
  assert.equal(exported.length, 1, 'first export paths');
  const preview = readFileSync(exported[0]!, 'utf8');
  const firstExportPath = exported[0]!;
  // The writer freezes its actual loaded-output map. Automatic verified reading
  // may finish before this explicit export; never relabel that full snapshot a preview.
  if (preview.includes('Loaded preview only')) {
    assert(!preview.includes(input.tail), 'unread full tail unexpectedly exported');
    assert(
      !preview.includes('ACTUAL_LOADED_REASON_TAIL'),
      'unread reasoning unexpectedly exported',
    );
    console.log('FIRST_EXPORT_FROZEN_PREVIEW');
  } else {
    assert(
      preview.includes(input.bodyText.repeat(input.bodyRepeats) + input.tail),
      'first complete export lost original body',
    );
    assert(
      preview.includes('> ACTUAL_LOADED_REASON_TAIL'),
      'first complete export lost loaded reasoning',
    );
    await waitNative(input.tail);
    assert(bodyVerified, 'first full export without original native painted body');
    console.log('FIRST_EXPORT_FROZEN_VERIFIED_FULL');
  }
  reset();
  await Bun.sleep(100);
  await key('\x0f');
  await Bun.sleep(400);
  await Bun.sleep(1000);
  await waitNative(input.tail);
  assert(bodyVerified, 'complete original Model body was not painted to native terminal history');
  await waitNative('New Run >');
  await waitCompletePaint(false);
  reset();
  await key('\r');
  await wait('Result collapsed');
  await wait('Empty Enter expands the current tail result');
  assert(
    clearSeen && !reasonSeen && (await waitNative(input.tail)).includes(input.tail),
    'collapse original content',
  );
  assert(
    toolResult().includes('Resultcollapsed') && !toolResult().includes('"artifactRefs"'),
    'collapsed result',
  );
  await waitCompletePaint(true);
  reset();
  await key('\r');
  await waitNative(input.tail);
  await wait('Empty Enter collapses the current tail result');
  assert(
    clearSeen && !reasonSeen && (await waitNative(input.tail)).includes(input.tail),
    'expand original content',
  );
  assert(
    toolResult().includes('"artifactRefs"') && !toolResult().includes('Resultcollapsed'),
    'expanded result',
  );
  await waitCompletePaint(true);
  console.log('TAIL_RESULT_COLLAPSE_EXPAND_ORIGINAL_ARTIFACT_REFS');
  // Ctrl+O loads one verified Model output body, including its reasoning.
  // Reasoning export is independent of any screen-only display shortcut.
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
  assert.equal(
    readFileSync(firstExportPath, 'utf8'),
    preview,
    'later original-body reading mutated the frozen first export',
  );
  for (const path of exported) {
    // Preserve exact POSIX 0600. Windows checks the same physical files' native
    // private ACL and identity; mode bits cannot prove the Windows contract.
    if (process.platform === 'win32') defaultWindowsPathSecurity()!.verifyFile(path);
    else assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  console.log('LOADED_REASON_EXPORTED_WITHOUT_SCREEN_TOGGLE');
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
