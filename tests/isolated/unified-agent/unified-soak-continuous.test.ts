import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyContinuousEvidence } from '../../../scripts/runtime/unified-soak-continuous';
import {
  activeDuration,
  openContinuousFixture,
  runContinuousSchedule,
} from '../../fixtures/unified-agent/soak/continuous';

test('continuous workload counts union of busy intervals, never parallel sum', () => {
  expect(
    activeDuration([
      [10, 30],
      [20, 40],
      [50, 60],
    ]),
  ).toBe(40);
  expect(
    activeDuration([
      [20, 25],
      [10, 40],
      [15, 18],
    ]),
  ).toBe(30);
  expect(() => activeDuration([[2, 1]])).toThrow('invalid_work_interval');
});
test('bounded continuous load uses two real Services, twenty original Sessions and a slow SSE consumer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-soak-continuous-'));
  const fixture = await openContinuousFixture(root);
  try {
    await fixture.cycle();
    await fixture.cycle();
    const evidence = fixture.evidence();
    expect(evidence.serviceCount).toBe(2);
    expect(new Set(fixture.services.map((service) => service.bootstrap.instanceId)).size).toBe(2);
    expect(
      fixture.services.every((service) => service.bootstrap.storeId === evidence.storeId),
    ).toBe(true);
    expect(evidence.sessionIds).toHaveLength(20);
    expect(evidence.commandIds).toHaveLength(40);
    expect(new Set(evidence.commandIds).size).toBe(40);
    expect(evidence.synchronousEffects).toBe(40);
    expect(evidence.childCalls).toBe(40);
    expect(evidence.childExecutionIds).toHaveLength(40);
    expect(evidence.slowEntered).toBe(true);
    expect(evidence.peerEvents).toBeGreaterThan(0);
    expect(evidence.reconnects).toBe(2);
    expect(evidence.activeWorkloadDurationMs).toBeGreaterThan(0);
    expect(evidence.activeWorkloadDurationMs).toBeLessThanOrEqual(evidence.wallDurationMs);
    expect(evidence.missing).toContain('qualified_background_shell');
    console.log(JSON.stringify({ caseId: 'continuous_diagnostic', ...evidence }));
    const stop = new AbortController();
    const stopping = setTimeout(() => stop.abort(), 300);
    try {
      let stopped: unknown;
      try {
        await fixture.cycle(stop.signal);
      } catch (error) {
        stopped = error;
      }
      expect(stopped).toBeInstanceOf(Error);
      expect((stopped as Error).message).toBe('continuous_schedule_stopped');
      expect(fixture.evidence().commandIds.length).toBeLessThan(60);
    } finally {
      clearTimeout(stopping);
    }
  } finally {
    await fixture.close();
    for (const service of fixture.services)
      expect(
        await new Promise<boolean>((resolve, reject) => {
          const url = new URL(service.endpoint);
          const socket = createConnection({ host: url.hostname, port: Number(url.port) });
          const deadline = setTimeout(() => {
            socket.destroy();
            reject(Error('owned_listener_probe_deadline'));
          }, 2000);
          socket.once('connect', () => {
            clearTimeout(deadline);
            socket.destroy();
            resolve(false);
          });
          socket.once('error', () => {
            clearTimeout(deadline);
            socket.destroy();
            resolve(true);
          });
        }),
      ).toBe(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 180000);

test('schedule refuses pre-stopped work and unsupported formal before Profile I/O', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-soak-continuous-refuse-'));
  try {
    const formalRoot = join(root, 'formal');
    await expect(
      runContinuousSchedule(
        formalRoot,
        'formal',
        process.platform === 'darwin' ? AbortSignal.abort() : undefined,
      ),
    ).rejects.toThrow(
      process.platform === 'darwin'
        ? 'continuous_schedule_stopped'
        : 'continuous_qualified_background_shell_required',
    );
    expect(existsSync(formalRoot)).toBe(false);
    const stopRoot = join(root, 'stopped');
    await expect(
      runContinuousSchedule(stopRoot, 'diagnostic', AbortSignal.abort()),
    ).rejects.toThrow('continuous_schedule_stopped');
    expect(existsSync(stopRoot)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('scheduled diagnostic retains original busy union and rejects padded, summed and forged formal evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-soak-scheduled-'));
  try {
    const evidence = await runContinuousSchedule(root, 'diagnostic');
    expect(verifyContinuousEvidence(evidence, false)).toEqual([]);
    expect(evidence.completedCycles).toBe(2);
    expect(evidence.commandIds).toHaveLength(40);
    expect(evidence.busyIntervals).toHaveLength(40);
    expect(evidence.cleanupConfirmed).toBe(true);
    expect(
      verifyContinuousEvidence(
        { ...evidence, activeWorkloadDurationMs: evidence.wallDurationMs },
        false,
      ),
    ).toContain('continuous_busy_union_invalid');
    expect(
      verifyContinuousEvidence(
        { ...evidence, busyIntervals: [[0, evidence.wallDurationMs]] },
        false,
      ),
    ).toContain('continuous_timing_invalid');
    expect(
      verifyContinuousEvidence(
        { ...evidence, operationDurationMs: evidence.operationDurationMs.map(() => 180001) },
        false,
      ),
    ).toContain('continuous_timing_invalid');
    expect(verifyContinuousEvidence({ ...evidence, mode: 'formal', missing: [] }, true)).toContain(
      'continuous_formal_unqualified',
    );
    expect(
      verifyContinuousEvidence({ ...evidence, future: true } as typeof evidence, false),
    ).toContain('continuous_structure_invalid');
    const scale = 500000 / evidence.activeWorkloadDurationMs;
    const forged = {
      ...evidence,
      mode: 'formal' as const,
      missing: [],
      wallDurationMs: evidence.wallDurationMs * scale,
      activeWorkloadDurationMs: 500000,
      busyIntervals: evidence.busyIntervals.map(
        ([start, end]) => [start * scale, end * scale] as [number, number],
      ),
      operationDurationMs: evidence.operationDurationMs.map((value) => value * scale),
    };
    expect(verifyContinuousEvidence(forged, true)).toContain(
      'continuous_background_shell_unqualified',
    );
    console.log(JSON.stringify({ caseId: 'continuous_schedule_diagnostic', ...evidence }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 180000);
