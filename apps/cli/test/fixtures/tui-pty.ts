import assert from 'node:assert/strict';
import { setTimeout as testSleep } from 'node:timers/promises';
import xterm from '@xterm/headless';
import stringWidth from 'string-width';
import { spawnOwnedPty } from '../../../../tests/tui-system/harness/pty-node';

const { Terminal } = xterm;
type Terminal = InstanceType<typeof Terminal>;

/** ConPTY serializes its own cells, including spacing combining marks. */
export function configureConPTYCellWidths(screen: Terminal): void {
  const widths = new Map<number, 0 | 1 | 2>();
  screen.unicode.register({
    version: 'conpty-cells',
    wcwidth(codepoint) {
      const known = widths.get(codepoint);
      if (known !== undefined) return known;
      const character = String.fromCodePoint(codepoint);
      const width = /\p{Mark}/u.test(character) ? 1 : (stringWidth(character) as 0 | 1 | 2);
      widths.set(codepoint, width);
      return width;
    },
    charProperties(codepoint, preceding) {
      let width = this.wcwidth(codepoint);
      let join = width === 0 && preceding !== 0;
      if (join) {
        const previousWidth = (preceding >> 1) & 3;
        if (previousWidth === 0) join = false;
        else width = previousWidth as 0 | 1 | 2;
      }
      // xterm 6's public Unicode provider packs width in bits 1–2 and joining in bit 0.
      return (width << 1) | Number(join);
    },
  });
  screen.unicode.activeVersion = 'conpty-cells';
}

export function readTuiRender(screen: Terminal): string {
  return Array.from(
    { length: screen.buffer.active.length },
    (_, row) => screen.buffer.active.getLine(row)?.translateToString(true) ?? '',
  ).join('\n');
}

export async function ptyDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function spawnTuiPTY(input: {
  cmd: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onData?: (bytes: Uint8Array) => void;
  /** Explicit raw-material consumer; provides no cursor or screen projection. */
  observation?: 'screen' | 'stream';
  /** Explicit observation of Windows console cells, qualified by the native Unicode probe. */
  conptyCellWidths?: boolean;
  scrollback?: number;
}) {
  const screen =
    input.observation === 'stream'
      ? undefined
      : new Terminal({
          cols: 80,
          rows: 24,
          scrollback: input.scrollback ?? 1000,
          allowProposedApi: true,
        });
  if (screen && input.conptyCellWidths) configureConPTYCellWidths(screen);
  const requireScreen = () => {
    if (!screen) throw Error('stream_observation_has_no_screen');
    return screen;
  };
  const output: Uint8Array[] = [];
  let parsed = Promise.resolve();
  let revision = 0;
  let renderedRevision = -1;
  let renderedText = '';
  let actionRevision = -1;
  let actionOffset = 0;
  let byteLength = 0;
  let ended = false;
  let closed = false;
  const host = spawnOwnedPty({
    command: input.cmd,
    cwd: input.cwd,
    env: Object.fromEntries(
      Object.entries({ ...process.env, ...input.env }).filter(
        (pair): pair is [string, string] => typeof pair[1] === 'string',
      ),
    ),
    detach: process.platform !== 'win32',
    cols: 80,
    rows: 24,
    onData(bytes) {
      const copy = bytes.slice();
      output.push(copy);
      input.onData?.(copy);
      byteLength += copy.byteLength;
      if (screen) {
        // xterm already owns an ordered write queue. Enqueue native chunks
        // immediately so it can parse a burst in one turn; chaining writes
        // behind each callback adds a timer turn for every ConPTY fragment.
        // The last callback also proves every earlier queued chunk was parsed.
        parsed = new Promise<void>((resolve) => {
          screen.write(copy, () => {
            revision++;
            resolve();
          });
        });
      } else revision++;
    },
  });
  const eof = host.exited.then(() => {});
  void eof.catch(() => {});
  void host.exited
    .finally(() => {
      ended = true;
    })
    .catch(() => {});
  return {
    host,
    eof,
    get ended() {
      return ended;
    },
    text: () => Buffer.concat(output).toString('utf8'),
    sinceAction: () => Buffer.concat(output).subarray(actionOffset).toString('utf8'),
    viewport: () => {
      const actual = requireScreen();
      return Array.from(
        { length: 24 },
        (_, row) =>
          actual.buffer.active
            .getLine(actual.buffer.active.viewportY + row)
            ?.translateToString(true) ?? '',
      ).join('\n');
    },
    async key(value: string) {
      await parsed;
      actionRevision = revision;
      actionOffset = byteLength;
      await host.write(value);
    },
    /** Navigation only: do not turn an already painted target into a no-op action. */
    async keyUnlessVisible(value: string, target: string) {
      const actual = requireScreen();
      await parsed;
      const viewport = Array.from(
        { length: 24 },
        (_, row) =>
          actual.buffer.active
            .getLine(actual.buffer.active.viewportY + row)
            ?.translateToString(true) ?? '',
      ).join('\n');
      if (viewport.includes(target)) return false;
      actionRevision = revision;
      actionOffset = byteLength;
      await host.write(value);
      return true;
    },
    async projection() {
      const actual = requireScreen();
      await parsed;
      if (renderedRevision !== revision) {
        renderedText = readTuiRender(actual);
        renderedRevision = revision;
      }
      return { fresh: revision > actionRevision, text: renderedText };
    },
    async drain() {
      await parsed;
    },
    close() {
      if (closed) return;
      closed = true;
      host.close();
      screen?.dispose();
    },
  };
}

export type TuiPTY = ReturnType<typeof spawnTuiPTY>;

export async function terminateTuiTree(
  owned: TuiPTY,
  input: {
    exitTimeoutMs: number;
    servicePid?: number;
    serviceExitTimeoutMs?: number;
    requireServiceAlive?: boolean;
  },
) {
  assert.equal(owned.ended, false, 'original host must be alive before tree termination');
  if (input.servicePid !== undefined) {
    assert.ok(Number.isSafeInteger(input.servicePid) && input.servicePid > 0);
    if (input.requireServiceAlive !== false) process.kill(input.servicePid, 0);
  }
  await owned.host.ready;
  owned.host.kill('SIGKILL');
  await ptyDeadline(
    Promise.all([owned.host.exited, owned.eof]),
    input.exitTimeoutMs,
    'original host tree did not exit',
  );
  if (process.platform !== 'win32') assert.equal(owned.host.signalCode, 'SIGKILL');
  if (input.servicePid !== undefined) {
    const end = Date.now() + (input.serviceExitTimeoutMs ?? input.exitTimeoutMs);
    for (;;) {
      try {
        process.kill(input.servicePid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
        throw error;
      }
      if (Date.now() >= end) throw Error('original Service remains alive after tree termination');
      await testSleep(20);
    }
  }
  await owned.drain();
}
