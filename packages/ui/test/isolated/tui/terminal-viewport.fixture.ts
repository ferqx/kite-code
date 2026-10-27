import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { createHeadlessTerminalScreen } = (await import(
  join(import.meta.dir, '../../../../../tests/tui-system/harness/terminal-screen')
)) as {
  createHeadlessTerminalScreen(
    cols: number,
    rows: number,
  ): { append(bytes: Uint8Array): Promise<void>; viewport(): string };
};

// Mirror actual terminal bytes through VT parsing. ANSI diff frames are not full screens.
const target = process.env.KITE_TUI_VIEWPORT;
if (target) {
  const screen = createHeadlessTerminalScreen(80, 24);
  const original = process.stdout.write.bind(process.stdout);
  let carriageReturn = false;
  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    // The real Python-owned PTY uses ONLCR. Mirror that kernel newline expansion.
    const bytes: number[] = [];
    for (const byte of typeof chunk === 'string' ? Buffer.from(chunk) : chunk) {
      if (byte === 10 && !carriageReturn) bytes.push(13);
      bytes.push(byte);
      carriageReturn = byte === 13;
    }
    void screen.append(Uint8Array.from(bytes)).then(() => {
      writeFileSync(target, screen.viewport());
    });
    return original(chunk, ...(args as []));
  }) as typeof process.stdout.write;
}
