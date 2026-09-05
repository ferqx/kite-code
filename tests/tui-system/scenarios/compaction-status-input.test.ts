/**
 * PTY System Test — manual and automatic compaction stay inline and non-modal
 *
 * The fixture mounts the real App composition. It starts in manual compaction
 * and switches to automatic compaction after the first submitted draft, so
 * both sources exercise the real message area, Footer, and InputLine.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { activeInput, submitCurrentInput, typeText } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains } from '../harness/terminal-screen';

const TIMEOUT = 30_000;

describe('TUI PTY System — inline compaction input', () => {
  let tui: PtyProcess;

  beforeAll(async () => {
    tui = await spawnReadyTui({
      cols: 120,
      rows: 20,
      entryPath: resolve(import.meta.dir, '..', 'fixtures', 'compaction-status-input-tui.tsx'),
    });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui] });
  });

  test(
    'renders both compaction sources inline and accepts input throughout',
    async () => {
      const manualScreen = tui.viewport();
      expect(screenContains(manualScreen, '/compact')).toBe(true);
      expect(screenContains(manualScreen, 'Summarizing context')).toBe(true);
      expect(screenContains(manualScreen, 'Thinking')).toBe(false);

      const manualDraft = 'manual compaction keeps input available';
      await typeText(tui, manualDraft);
      expect(activeInput(tui.inputViewport())).toEqual({ kind: 'main', value: manualDraft });

      await submitCurrentInput(tui, {
        acceptWhen: (viewport) => screenContains(viewport, '/auto-compact'),
        requireAcceptWhen: true,
      });

      const automaticScreen = tui.viewport();
      expect(screenContains(automaticScreen, '/auto-compact')).toBe(true);
      expect(screenContains(automaticScreen, 'Summarizing context')).toBe(true);
      expect(screenContains(automaticScreen, 'Working')).toBe(true);

      const automaticDraft = 'automatic compaction keeps input available';
      await typeText(tui, automaticDraft);
      expect(activeInput(tui.inputViewport())).toEqual({ kind: 'main', value: automaticDraft });
      expect(screenContains(tui.viewport(), 'Waiting for response...')).toBe(false);

      await submitCurrentInput(tui, {
        acceptWhen: (viewport) => screenContains(viewport, 'Automatic input submitted'),
        requireAcceptWhen: true,
      });
      expect(screenContains(tui.viewport(), 'Automatic input submitted')).toBe(true);
    },
    TIMEOUT,
  );
});
