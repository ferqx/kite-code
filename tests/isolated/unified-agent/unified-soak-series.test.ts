import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '#kite-test';
import {
  fixtureNodeExecutable,
  fixtureNodeLoader,
} from '../../../packages/agent/test/fixtures/node-runtime';
import { buildTerminalBundle } from '../../../scripts/release/terminal-bundle';
import { buildUnifiedSoakProbe, runStableCrashSeries } from '../../../scripts/runtime/unified-soak';
import { sameNativeProcess } from '../../../scripts/runtime/unified-soak-native';
import type { ProbeEvidence } from '../../../scripts/runtime/unified-soak-report';
import { spawn as spawnFixtureProcess } from '../../../scripts/tooling/process';
import { privateDirectory } from '../../fixtures/test-filesystem';

test.skipIf(process.platform === 'win32')(
  'lifecycle observations cover the active window without replacing earlier measured boundaries',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-soak-active-window-'));
    try {
      const child = spawnFixtureProcess(
        [
          fixtureNodeExecutable(),
          '--no-global-search-paths',
          '--expose-gc',
          '--import',
          fixtureNodeLoader,
          join(import.meta.dirname, '../../../scripts/runtime/unified-soak-probe.ts'),
          root,
          'lifecycle',
          '3',
          '2000',
        ],
        {
          env: { PATH: process.env.PATH ?? '', HOME: root, TMPDIR: root },
          stdout: 'ignore',
          stderr: 'pipe',
        },
      );
      const stderr = new Response(child.stderr).text();
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      try {
        expect(await child.exited, await stderr).toBe(0);
      } finally {
        clearTimeout(timer);
      }
      const result = JSON.parse(
        readFileSync(join(root, 'lifecycle.json'), 'utf8'),
      ) as ProbeEvidence;
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
          sameNativeProcess(point.observations!.before.native, point.observations!.after.native),
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
      const { probe } = await buildUnifiedSoakProbe(root);
      const directory = join(root, 'series');
      privateDirectory(directory);
      const spawn = (path: string, mode: string) =>
        spawnFixtureProcess(
          [
            candidate.artifact.executable,
            '--no-global-search-paths',
            '--expose-gc',
            probe,
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
      expect(
        result.points.every((point) =>
          point.descendants!.every(
            (child) => child.kernelState === 'absent' || child.kernelState === 'reused',
          ),
        ),
      ).toBe(true);
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
