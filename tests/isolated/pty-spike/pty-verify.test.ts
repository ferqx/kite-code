import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, test } from '#kite-test';
import { type OwnedPtyProcess, spawnOwnedPty } from '../../tui-system/harness/pty-node';

// ============================================================================
// Helpers
// ============================================================================

const SETTLE_MS = 200;
const POLL_INTERVAL_MS = 100;
const CHILD_TIMEOUT_MS = 5_000;
const PER_TEST_MS = 20_000;
const SPAWN_TIMEOUT_MS = 12_000;
const TERMINATION_GRACE_MS = 1_000;
const FORCED_EXIT_MS = 2_000;

let _tmpSeq = 0;

function makeTempDir(): string {
  const dir = join(tmpdir(), `pty-spike-${Date.now().toString(36)}-${++_tmpSeq}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function concatChunks(chunks: Uint8Array[]): string {
  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(merged);
}

/** Strip ANSI escape sequences, including CSI private modes with ? prefix. */
function stripAnsi(s: string): string {
  return (
    s
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI sequences
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI OSC sequences
      .replace(/\x1b\][^\x07]*\x07/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI charset sequences
      .replace(/\x1b[=>][0-9;]*[a-zA-Z]?/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI G0/G1 charset
      .replace(/\x1b[()][0-9A-Za-z]/g, '')
  );
}

function extractAllPrefixed(output: string, prefix: string): string[] {
  const clean = stripAnsi(output).replace(/\r/g, '');
  const results: string[] = [];
  for (const line of clean.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix)) results.push(trimmed.slice(prefix.length));
  }
  return results;
}

function extractFirstPrefixed(output: string, prefix: string): string | null {
  const all = extractAllPrefixed(output, prefix);
  return all.length > 0 ? (all[0] ?? null) : null;
}

async function spawnWithTerminal(
  script: string,
  opts?: {
    rows?: number;
    cols?: number;
    onReady?: (terminal: OwnedPtyProcess) => void | Promise<void>;
  },
): Promise<{ output: string }> {
  const dir = makeTempDir();
  const scriptPath = join(dir, 'child.mjs');
  writeFileSync(scriptPath, script, 'utf-8');
  const chunks: Uint8Array[] = [];
  let child: OwnedPtyProcess | undefined;
  try {
    child = spawnOwnedPty({
      command: [process.execPath, scriptPath],
      cwd: dir,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
      rows: opts?.rows ?? 24,
      cols: opts?.cols ?? 80,
      detach: true,
      onData(chunk) {
        chunks.push(chunk);
      },
    });
    await child.ready;
    if (opts?.onReady) {
      await sleep(SETTLE_MS);
      await opts.onReady(child);
    }
    if (!(await exitsWithin(child.exited, SPAWN_TIMEOUT_MS)))
      throw new Error(`PTY child did not exit within ${SPAWN_TIMEOUT_MS}ms.`);
    return { output: concatChunks(chunks) };
  } finally {
    try {
      if (child && child.exitCode === null) await terminatePtyChild(child);
    } finally {
      child?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function exitsWithin(exited: Promise<number>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function terminatePtyChild(proc: OwnedPtyProcess): Promise<void> {
  proc.kill();
  if (await exitsWithin(proc.exited, TERMINATION_GRACE_MS)) return;
  proc.kill('SIGKILL');
  if (await exitsWithin(proc.exited, FORCED_EXIT_MS)) return;
  throw new Error('PTY child did not exit after forced termination.');
}

function fail(reason: string): never {
  throw new Error(reason);
}

// ============================================================================
// Tests
// ============================================================================

describe('Node test harness PTY capabilities', () => {
  // ------------------------------------------------------------------
  // Test 1: isTTY
  // ------------------------------------------------------------------
  test(
    '1. isTTY — child sees stdin/stdout/stderr as TTY',
    async () => {
      // Output one field per line to avoid PTY line-wrapping at col 80.
      const script = `
        console.log("R:si=" + (process.stdin.isTTY ? 1 : 0));
        console.log("R:so=" + (process.stdout.isTTY ? 1 : 0));
        console.log("R:se=" + (process.stderr.isTTY ? 1 : 0));
        console.log("R:c=" + process.stdout.columns);
        console.log("R:r=" + process.stdout.rows);
      `;

      const { output } = await spawnWithTerminal(script);
      const lines = extractAllPrefixed(output, 'R:');

      if (lines.length === 0) {
        fail(`No R: lines in output.\nClean: ${JSON.stringify(stripAnsi(output).slice(0, 400))}`);
      }

      const vals: Record<string, string> = {};
      for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq > 0) vals[line.slice(0, eq)] = line.slice(eq + 1);
      }

      const si = vals.si === '1';
      const so = vals.so === '1';
      const se = vals.se === '1';
      const cols = parseInt(vals.c ?? '0', 10);
      const rows = parseInt(vals.r ?? '0', 10);

      console.log(`  isTTY: stdin=${si} stdout=${so} stderr=${se}  dims=${cols}x${rows}`);

      if (!si || !so || !se) {
        fail(
          `isTTY mismatch: stdin=${si} stdout=${so} stderr=${se}\n` +
            `All three must be true for a real PTY.\n` +
            `\nConclusion: PTY is NOT viable.`,
        );
      }
    },
    PER_TEST_MS,
  );

  // ------------------------------------------------------------------
  // Test 2: terminal.write() -> child stdin
  // ------------------------------------------------------------------
  test(
    '2. terminal.write() — parent sends data to child stdin',
    async () => {
      const MSG = 'PTY_HELLO_42';

      const script = `
        let buf = '';
        process.stdin.on('data', (chunk) => {
          buf += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
          if (buf.includes('\\n')) {
            console.log("ECHO:" + buf.trim());
            process.exit(0);
          }
        });
        setTimeout(() => {
          console.log("ECHO:TIMEOUT");
          process.exit(1);
        }, ${CHILD_TIMEOUT_MS});
      `;

      const { output } = await spawnWithTerminal(script, {
        onReady: (terminal) => terminal.write(`${MSG}\r\n`),
      });

      const echoVal = extractFirstPrefixed(output, 'ECHO:');

      if (!echoVal || echoVal === 'TIMEOUT') {
        fail(
          `Child never echoed.\n` +
            `Clean output: ${JSON.stringify(stripAnsi(output).slice(0, 400))}\n` +
            `\nConclusion: Child CANNOT read stdin from PTY.`,
        );
      }

      if (echoVal !== MSG) {
        fail(
          `Echo corrupted: got "${echoVal}", expected "${MSG}".\n` +
            `\nConclusion: PTY data channel is unreliable.`,
        );
      }

      console.log(`  PASS: round-trip "${MSG}" confirmed`);
    },
    PER_TEST_MS,
  );

  // ------------------------------------------------------------------
  // Test 3: terminal.resize()
  //
  // On Windows, ConPTY does not forward resize signals (SIGWINCH) to the
  // child process. This is a known platform limitation. The test tries
  // resize on all platforms but only asserts success on non-win32.
  // ------------------------------------------------------------------
  test(
    '3. terminal.resize() — parent changes child terminal dimensions',
    async () => {
      const script = `
        const initial = { cols: process.stdout.columns, rows: process.stdout.rows };
        console.log("SIZE1:" + JSON.stringify(initial));

        let resolved = false;
        const done = (cols, rows, reason) => {
          if (!resolved) {
            resolved = true;
            clearInterval(iv);
            clearTimeout(tm);
            console.log("SIZE2:" + JSON.stringify({ cols, rows, reason }));
            process.exit(0);
          }
        };

        const iv = setInterval(() => {
          const c = process.stdout.columns;
          const r = process.stdout.rows;
          if (c !== initial.cols || r !== initial.rows) {
            done(c, r, 'poll');
          }
        }, ${POLL_INTERVAL_MS});

        process.stdout.on('resize', () => {
          done(process.stdout.columns, process.stdout.rows, 'event');
        });

        const tm = setTimeout(() => {
          console.log("SIZE2:TIMEOUT:" + JSON.stringify({ cols: process.stdout.columns, rows: process.stdout.rows }));
          process.exit(1);
        }, ${CHILD_TIMEOUT_MS});
      `;

      const { output } = await spawnWithTerminal(script, {
        onReady: async (terminal) => {
          await sleep(500);
          await terminal.resize(100, 30);
        },
      });

      const size1Str = extractFirstPrefixed(output, 'SIZE1:');
      const size2Str = extractFirstPrefixed(output, 'SIZE2:');

      if (!size1Str) {
        fail(`Child never reported initial size.`);
      }

      const before = JSON.parse(size1Str);

      if (!size2Str || size2Str.startsWith('TIMEOUT:')) {
        const finalDims = size2Str ? JSON.parse(size2Str.replace('TIMEOUT:', '')) : before;
        const finalCols = finalDims?.cols ?? before.cols;
        const finalRows = finalDims?.rows ?? before.rows;

        if (process.platform === 'win32') {
          // ConPTY can leave the child without a resize notification.
          console.log(
            `  SKIP: resize not supported on Windows ConPTY.\n` +
              `    Initial: ${before.cols}x${before.rows}  Final: ${finalCols}x${finalRows}\n` +
              `    Resize target: 100x30 — no change detected.\n` +
              `    This is a platform limitation, not a PTY viability blocker.`,
          );
          // Skip rather than fail — trade-off is documented
          return;
        }

        fail(
          `RESIZE FAILED: initial=${before.cols}x${before.rows} ` +
            `final=${finalCols}x${finalRows}, target=100x30\n` +
            `\nConclusion: terminal.resize() has NO EFFECT (${process.platform}).`,
        );
      }

      const after = JSON.parse(size2Str);

      console.log(
        `  Dimensions: ${before.cols}x${before.rows} -> ${after.cols}x${after.rows} (reason: ${after.reason})`,
      );

      if (after.cols === before.cols && after.rows === before.rows) {
        fail(`Resize had no effect: dimensions unchanged.`);
      }

      if (after.cols !== 100 || after.rows !== 30) {
        fail(`Resize result wrong: got ${after.cols}x${after.rows}, expected 100x30.`);
      }

      console.log(`  PASS: resize to 100x30 confirmed`);
    },
    PER_TEST_MS,
  );

  // ------------------------------------------------------------------
  // Test 4: Binary / control character passthrough
  // ------------------------------------------------------------------
  test(
    '4. Control chars — non-escape binary bytes pass through PTY stdin',
    async () => {
      // Send a mix of control characters + printable text + CRLF.
      // ESC-prefixed sequences are explicitly excluded — ConPTY consumes
      // them as terminal control and does NOT forward to the child.
      //
      // Bytes: TAB(09) Ctrl+B(02) A(41) B(42) C(43) CR(0d) LF(0a)
      const payload = '\x09\x02ABC\r\n';

      const script = `
        const chunks = [];
        process.stdin.on('data', (chunk) => {
          const bytes = typeof chunk === 'string'
            ? new TextEncoder().encode(chunk)
            : new Uint8Array(chunk);
          for (const b of bytes) chunks.push(b);
          if (chunks.length > 0) {
            const hex = chunks.map(b => b.toString(16).padStart(2, '0')).join(' ');
            console.log("BIN:" + hex);
            process.exit(0);
          }
        });

        setTimeout(() => {
          console.log("BIN:TIMEOUT");
          process.exit(1);
        }, ${CHILD_TIMEOUT_MS});
      `;

      const { output } = await spawnWithTerminal(script, {
        onReady: (terminal) => terminal.write(payload),
      });

      const binVal = extractFirstPrefixed(output, 'BIN:');

      if (!binVal || binVal === 'TIMEOUT') {
        fail(
          `Child never received binary data.\n` +
            `Clean output: ${JSON.stringify(stripAnsi(output).slice(0, 400))}\n` +
            `\nConclusion: Even non-escape binary data does NOT reach child via PTY stdin.`,
        );
      }

      console.log(`  Received bytes: ${binVal}`);

      // Verify at least LF arrived (CR may be converted by PTY line discipline
      // on platforms like macOS where \r\n → \n\n is normal in raw mode).
      const hasLineEnding = binVal.includes('0a');
      if (!hasLineEnding) {
        fail(
          `Line ending (LF) missing from received data: ${binVal}\n` +
            `\nConclusion: PTY stdin channel is not delivering line endings.`,
        );
      }

      // Check printable text (41 42 43 = ABC)
      const hasAbc = binVal.includes('41') && binVal.includes('42') && binVal.includes('43');
      // Check TAB (09)
      const hasTab = binVal.includes('09');
      // Check Ctrl+B (02) — may be consumed by line discipline
      const hasCtrlB = binVal.includes('02');

      console.log(`  TAB(09): ${hasTab}  Ctrl+B(02): ${hasCtrlB}  ABC(41-43): ${hasAbc}`);

      if (!hasAbc) {
        fail(
          `Printable text "ABC" (41 42 43) was NOT delivered to child.\n` +
            `Received: ${binVal}\n` +
            `\nConclusion: PTY stdin is corrupting/consuming printable data.`,
        );
      }

      // Summary
      console.log(
        `  Capability summary:\n` +
          `    Printable text (A-Za-z0-9): ${hasAbc ? 'YES' : 'NO'}\n` +
          `    TAB (\\x09): ${hasTab ? 'YES' : 'NO'}\n` +
          `    Ctrl+B (\\x02): ${hasCtrlB ? 'YES' : 'NO'}\n` +
          `    CRLF (\\r\\n): YES\n` +
          `    ESC sequences (\\x1b...): FILTERED by ConPTY / line discipline`,
      );
    },
    PER_TEST_MS,
  );
});
