import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { spawnTui } from '../harness/pty-process';
import { waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

for (const mode of ['shell', 'thinking', 'tools', 'subagents', 'mixed', 'approved-shells']) {
  for (const rows of [24, 40]) {
    test(`${mode} dynamic frames preserve scrolled history at ${rows} rows`, async () => {
      const workspace = createTestWorkspace();
      workspace.env.KITE_LIVE_SCROLL_CASE = mode;
      const tui = await spawnTui({
        cols: 80,
        rows,
        workspace,
        entryPath: resolve(import.meta.dir, '../fixtures/live-scroll-tui.tsx'),
      });
      try {
        await waitForText(
          () => tui.viewport(),
          mode === 'approved-shells' ? 'Bash' : 'Working',
          5_000,
        );
        await Bun.sleep(800);
        await tui.settleScreen();
        const liveLabel =
          mode === 'shell' || mode === 'approved-shells'
            ? 'Bash'
            : mode === 'thinking'
              ? 'Thinking'
              : mode === 'tools'
                ? 'read '
                : 'Delegating';
        expect(tui.viewport()).toContain(liveLabel);
        expect(tui.viewportPosition().baseY).toBeGreaterThan(20);
        await tui.scrollViewport(-50);
        const before = tui.viewportPosition();
        const history = tui.viewport();
        const mark = tui.markOutput();
        await Bun.sleep(2_500);
        await tui.settleScreen();
        const after = tui.viewportPosition();
        const bytes = tui.outputSince(mark);
        expect(bytes.length).toBeGreaterThan(0);
        expect(bytes).toContain(liveLabel);
        expect(bytes).not.toContain('\x1b[2J');
        expect(bytes).not.toContain('\x1b[3J');
        expect(after.viewportY).toBe(before.viewportY);
        expect(after.viewportY).toBeLessThan(after.baseY);
        expect(tui.viewport()).toBe(history);
        // Settlement appends final Static output while the user is still reading history.
        await Bun.sleep(2_000);
        await tui.settleScreen();
        expect(tui.viewportPosition().viewportY).toBe(before.viewportY);
        expect(tui.viewport()).toBe(history);
        await tui.scrollViewport(10_000);
        expect(tui.viewport()).toContain('SETTLED_DONE');
        expect(tui.viewport()).not.toContain('Working');
        if (mode === 'mixed') {
          for (const label of ['Thinking', 'Bash', 'Delegated']) {
            expect(tui.scrollback()).toContain(label);
          }
        }
        const idleOutput = tui.markOutput();
        await Bun.sleep(750);
        expect(tui.outputSince(idleOutput)).toBe('');
        console.log(
          JSON.stringify({
            mode,
            rows,
            before,
            after,
            animationAndEventBytes: bytes.length,
            settlementPreservedHistory: true,
            idleBytes: 0,
          }),
        );
      } finally {
        await cleanupTuiSystemFixtures({ tuis: [tui], workspaces: [workspace] });
      }
    }, 20_000);
  }
}
