import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildTerminalBundle } from '../../../scripts/release/terminal-bundle';
import { sameNativeProcess } from '../../../scripts/runtime/unified-soak-native';
import { runTuiCase } from '../../fixtures/unified-agent/soak/tui';

test.skipIf(process.platform === 'win32')(
  'soak migrated TUI uses actual owned PTY and default source-free paired Service',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-soak-tui-'));
    try {
      const candidate = await buildTerminalBundle({ destination: join(root, 'candidate') });
      symlinkSync(join(candidate.root, 'node_modules'), join(root, 'node_modules'), 'dir');
      const sampler = await Bun.build({
        entrypoints: [resolve(import.meta.dir, '../../../scripts/runtime/unified-soak-cases.ts')],
        target: 'bun',
        packages: 'external',
        outdir: root,
      });
      expect(sampler.success).toBe(true);
      const result = await runTuiCase(
        join(root, 'case'),
        candidate.artifact,
        join(root, 'unified-soak-cases.js'),
        9,
      );
      if (result.status !== 'passed') console.error(JSON.stringify(result));
      expect(result.unavailable).toEqual([]);
      expect(result.status).toBe('passed');
      expect(result.cleanupConfirmed).toBe(true);
      expect(result.points).toHaveLength(9);
      expect(result.pid).not.toBe(process.pid);
      for (const [sequence, point] of result.points!.entries()) {
        expect(point.sequence).toBe(sequence);
        expect(point.observations!.before.native.pid).toBe(result.pid);
        expect(
          sameNativeProcess(
            result.points![0]!.observations!.before.native,
            point.observations!.after.native,
          ),
        ).toBe(true);
        expect(point.before.fileDescriptors).toBeGreaterThan(0);
        expect(point.before.listeners).toBeGreaterThan(0);
        expect(point.before.activeResources).toBeNull();
        expect(point.before.handles).toBeNull();
      }
      console.log(JSON.stringify({ diagnostic: 'tui_focus_diagnostic', ...result }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  180000,
);
