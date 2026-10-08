import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildTerminalBundle } from '../../../scripts/release/terminal-bundle';
import { runStableCrashSeries } from '../../../scripts/runtime/unified-soak';
import { sameNativeProcess } from '../../../scripts/runtime/unified-soak-native';
import { runProbe } from '../../../scripts/runtime/unified-soak-probe';

test.skipIf(process.platform === 'win32')(
  'lifecycle observations cover the active window without replacing earlier measured boundaries',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-soak-active-window-'));
    try {
      const result = await runProbe(root, 'lifecycle', 3, 2000);
      if (result.completedCycles === undefined) throw Error('lifecycle_cycle_count_missing');
      expect(result.completedCycles).toBeGreaterThan(3);
      expect(result.calls).toBe(result.completedCycles * 2);
      expect(result.points.map((point) => point.sequence)).toEqual([0, 1, 2]);
      expect(result.workloadDurationMs).toBeGreaterThanOrEqual(2000);
      expect(
        result.points.slice(1).reduce((total, point) => total + point.durationMs, 0),
      ).toBeGreaterThan(1000);
      for (const point of result.points) {
        expect(point.durationMs).toBeLessThan(180000);
        expect(
          sameNativeProcess(point.observations.before.native, point.observations.after.native),
        ).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);

test.skipIf(process.platform === 'win32')(
  'stable SIGKILL collector owns warmup plus eight actual recovery points',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-soak-nine-kills-'));
    try {
      const candidate = await buildTerminalBundle({ destination: join(root, 'candidate') });
      symlinkSync(join(candidate.root, 'node_modules'), join(root, 'node_modules'), 'dir');
      const built = await Bun.build({
        entrypoints: [resolve(import.meta.dir, '../../../scripts/runtime/unified-soak-probe.ts')],
        target: 'bun',
        packages: 'external',
        outdir: root,
      });
      expect(built.success).toBe(true);
      const directory = join(root, 'series');
      mkdirSync(directory, { mode: 0o700 });
      const spawn = (path: string, mode: string) =>
        Bun.spawn(
          [
            join(candidate.root, 'runtime/bun'),
            join(root, 'unified-soak-probe.js'),
            path,
            mode,
            '1',
            '0',
          ],
          {
            cwd: root,
            env: { PATH: process.env.PATH ?? '', HOME: root, TMPDIR: root },
            stdout: 'ignore',
            stderr: 'pipe',
          },
        );
      const result = await runStableCrashSeries(directory, 9, spawn);
      expect(result.points).toHaveLength(9);
      for (const [sequence, point] of result.points.entries()) {
        expect(point.sequence).toBe(sequence);
        expect(point.assertions.every((receipt) => receipt.passed)).toBe(true);
        expect(point.observations?.before.native.pid).toBe(process.pid);
        expect(
          sameNativeProcess(
            result.points[0]!.observations!.before.native,
            point.observations!.after.native,
          ),
        ).toBe(true);
        expect(point.descendants).toHaveLength(2);
        expect(
          point.descendants!.every(
            (child) =>
              child.native.parentPid === process.pid &&
              child.native.startIdentity !== null &&
              child.reaped,
          ),
        ).toBe(true);
        expect(point.durationMs).toBeLessThan(180000);
      }
      expect(
        new Set(
          result.points.flatMap((point) =>
            point.descendants!.map(
              (child) => `${child.native.pid}:${child.native.startIdentity!.value}`,
            ),
          ),
        ).size,
      ).toBe(18);
      expect(
        result.identities.every(
          (identity) =>
            identity.storeId &&
            identity.sessionId &&
            identity.runId &&
            identity.executionId &&
            identity.commandId,
        ),
      ).toBe(true);
      console.log(JSON.stringify({ caseId: 'stable_sigkill_diagnostic', ...result }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  180000,
);
