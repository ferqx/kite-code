import { expect, test } from 'bun:test';
import { Terminal } from '@xterm/headless';
import { readFileRecoveryRender } from './fixtures/file-recovery-pty';

test('Files PTY keeps the full current card and discards erased renders with or without sync markers', async () => {
  for (const synchronized of [true, false]) {
    const screen = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
    const render = (body: string) =>
      new Promise<void>((resolve) =>
        screen.write(
          `${synchronized ? '\x1b[?2026h' : ''}\x1b[2J\x1b[3J\x1b[H${body}${synchronized ? '\x1b[?2026l' : ''}`,
          resolve,
        ),
      );
    try {
      const longCard = ['Files recovery: current', ...Array(39).fill('detail'), 'phase: current'];
      await render(longCard.join('\r\n'));
      expect(screen.buffer.active.baseY).toBeGreaterThan(0);
      expect(readFileRecoveryRender(screen)).toContain('Files recovery: current');
      expect(readFileRecoveryRender(screen)).toContain('phase: current');

      // Two renders can arrive after one key. The erased one cannot satisfy a wait.
      await render('Files recovery: stale phase');
      await render('Approval current: none (Enter has no answer)');
      const current = readFileRecoveryRender(screen);
      expect(current).toContain('Approval current: none (Enter has no answer)');
      expect(current).not.toContain('Files recovery:');
      expect(current).not.toContain('phase:');
    } finally {
      screen.dispose();
    }
  }
});
