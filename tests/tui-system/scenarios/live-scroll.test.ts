import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { spawnReadyTui } from '../harness/pty-process';
import {
  screenContains,
  waitForCondition,
  waitForOutputQuiescence,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

for (const mode of ['shell', 'thinking', 'tools', 'subagents', 'mixed', 'approved-shells']) {
  for (const rows of [24, 40]) {
    test(`${mode} dynamic frames preserve scrolled history at ${rows} rows`, async () => {
      const workspace = createTestWorkspace();
      workspace.env.KITE_LIVE_SCROLL_CASE = mode;
      const tui = await spawnReadyTui({
        cols: 80,
        rows,
        workspace,
        entryPath: resolve(import.meta.dir, '../fixtures/live-scroll-tui.tsx'),
        readiness: {
          description: 'live-scroll fixture to expose activity and native scrollback',
          waitForQuiescence: false,
          isReady: (candidate) =>
            candidate.viewportPosition().baseY > 20 &&
            screenContains(candidate.viewport(), 'Working'),
        },
      });
      let sampler: ReturnType<typeof setInterval> | undefined;
      let samples = 0;
      const violations: string[] = [];
      const observedUpdates = new Set<string>();
      try {
        sampler = setInterval(() => {
          const buffer = tui.scrollback();
          if (buffer.includes('SETTLED_DONE')) return;
          samples++;
          const limits: Array<[RegExp, number]> = [
            [/^.*Thinking \d+s.*$/gm, 1],
            [/^.*read \d+ files.*$/gm, 1],
            [/^.*Delegating ·.*$/gm, 1],
            [/^.*Bash.*$/gm, mode === 'approved-shells' ? 3 : 1],
          ];
          for (const [pattern, limit] of limits) {
            if ((buffer.match(pattern) ?? []).length > limit && violations.length === 0)
              violations.push(buffer);
          }
          // Each fixture publishes one current output generation per activity.
          // A stale tail can survive without duplicating the header itself.
          for (const prefix of ['THINKING', 'LIVE', 'OUTPUT_0', 'OUTPUT_1', 'OUTPUT_2']) {
            const generations = new Set(
              [...buffer.matchAll(new RegExp(`${prefix}_(\\d+)`, 'g'))].map((match) => match[1]),
            );
            if (generations.size > 1 && violations.length === 0) violations.push(buffer);
          }
          for (const label of [
            'SHELL_0',
            'SHELL_1',
            'SHELL_2',
            'Child 0',
            'Child 1',
            'Child 2',
            'Child 3',
          ]) {
            if (buffer.split(label).length - 1 > 1 && violations.length === 0)
              violations.push(buffer);
          }
          for (const value of buffer.match(
            /(?:THINKING_\d+|LIVE_\d+|OUTPUT_\d+_\d+|file-\d+\.ts|read-\d+|read \d+ files)/g,
          ) ?? [])
            observedUpdates.add(value);
        }, 25);
        await waitForText(
          () => tui.viewport(),
          mode === 'approved-shells' ? 'Bash' : 'Working',
          5_000,
        );
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
        const updatesBeforeScroll = observedUpdates.size;
        await waitForCondition(
          () => observedUpdates.size > updatesBeforeScroll,
          'live presentation to advance while scrolled',
          5_000,
        );
        await tui.settleScreen();
        const after = tui.viewportPosition();
        expect(after.viewportY).toBe(before.viewportY);
        expect(after.viewportY).toBeLessThan(after.baseY);
        expect(tui.viewport()).toBe(history);
        // Settlement appends final Static output while the user is still reading history.
        await waitForText(() => tui.scrollback(), 'SETTLED_DONE', 5_000);
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
        clearInterval(sampler);
        expect(samples).toBeGreaterThan(30);
        if (violations.length) console.log('Invalid intermediate frame:', violations[0]);
        expect(violations).toHaveLength(0);
        expect(observedUpdates.size).toBeGreaterThan(1);
        const idleOutput = tui.markOutput();
        const idleFrames = tui.markScreen();
        await waitForOutputQuiescence(() => tui.outputSince(idleOutput), 2_000, 750, false);
        expect(tui.screenFramesSince(idleFrames)).toEqual([]);
        console.log(
          JSON.stringify({
            mode,
            rows,
            intermediateSamples: samples,
            observedUpdates: observedUpdates.size,
            before,
            after,
            settlementPreservedHistory: true,
            idleFrames: 0,
          }),
        );
      } finally {
        clearInterval(sampler);
        await cleanupTuiSystemFixtures({ tuis: [tui], workspaces: [workspace] });
      }
    }, 20_000);
  }
}
