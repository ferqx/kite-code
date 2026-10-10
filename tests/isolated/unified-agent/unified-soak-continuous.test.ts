import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LinuxShellProcessEvidence } from '@kite-ai/agent/jobs/shell';
import {
  CONTINUOUS_SHELL_SOURCE,
  CONTINUOUS_SHELL_UNITS,
  type ContinuousEvidence,
  type ContinuousLinuxShellEvidence,
  verifyContinuousEvidence,
} from '../../../scripts/runtime/unified-soak-continuous';
import type {
  NativeProcessObservation,
  NativeProcessResources,
} from '../../../scripts/runtime/unified-soak-native';
import type { PairedServiceResources } from '../../../scripts/runtime/unified-soak-service-resources';
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

function linuxContinuousPacket() {
  const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
  const bytes = Buffer.alloc(65536, 16);
  bytes.writeUInt32LE(CONTINUOUS_SHELL_UNITS - 1);
  const digest = hash(bytes),
    wallStartedAt = 10000;
  const sessionIds = Array.from({ length: 20 }, (_, index) => `session-${index}`),
    commandIds = Array.from({ length: 40 }, (_, index) => `command-${index}`);
  const services: PairedServiceResources['services'] = [60, 61].map((pid, index) => {
    const spawn: NativeProcessObservation = {
      collector: 'linux-procfs',
      pid,
      parentPid: 50,
      startIdentity: {
        kind: 'linux-boot-start-ticks',
        value: `12345678-1234-1234-1234-123456789abc:${pid}`,
      },
      fileDescriptors: 4,
      unavailable: [],
    };
    const sample = (observedAt: number): NativeProcessResources => ({
      version: 2 as const,
      pid,
      observedAt,
      before: structuredClone(spawn),
      after: structuredClone(spawn),
      rssBytes: 1024,
      fileDescriptors: 4,
      activeResources: null,
      handles: null,
      unsupported: ['activeResources', 'handles'],
      unavailable: [],
    });
    return {
      instanceId: `service-${index}`,
      pid,
      spawn,
      ready: sample(100),
      preclose: sample(200),
      exit: { exitCode: 0, originalExited: true, reaped: true, kernelState: 'absent' },
    };
  });
  const shell: ContinuousLinuxShellEvidence = {
    backend: 'linux-pid-namespace',
    candidateDigest: 'a'.repeat(64),
    sourceSha256: hash(CONTINUOUS_SHELL_SOURCE),
    wallStartedAt,
    coldRead: true,
    noReplay: true,
    serviceResources: {
      version: 2,
      coverage: 'paired-services-only',
      storeId: 'original-store',
      candidateDigest: 'a'.repeat(64),
      ownerPid: 50,
      services,
      cold: {
        storeId: 'original-store',
        cursor: '123',
        unchanged: true,
        providerCallsBefore: 80,
        providerCallsAfter: 80,
      },
    },
    jobs: commandIds.map((commandId, index) => {
      const ownerPid = 60 + (index % 2),
        wrapperPid = 100 + index * 3,
        startedAt = wallStartedAt + index * 10,
        endedAt = startedAt + 10;
      const startupProcesses: LinuxShellProcessEvidence = {
        version: 2,
        coverage: 'shell-owned-pid-namespace',
        binding: {
          sessionId: sessionIds[index % 20]!,
          executionId: `job-${index}`,
          nonce: `nonce-${index}`,
        },
        owner: {
          version: 1,
          coverage: 'linux-pid-namespace',
          admission: { mode: 'full', nonce: `nonce-${index}` },
          ownerPid,
          phase: 'ready',
          fdClosed: false,
          closeUnknown: false,
          wrapper: {
            pid: wrapperPid,
            parentPid: ownerPid,
            birth: String(1000 + index * 3),
            exit: null,
            closed: false,
            stdoutEof: false,
            stderrEof: false,
          },
          namespace: {
            dev: '4',
            // A closed namespace inode may be reused; original process births differ.
            ino: '5',
            init: {
              pid: wrapperPid + 1,
              parentPid: wrapperPid,
              birth: String(1001 + index * 3),
              localPid: 1,
              dead: false,
            },
            root: {
              pid: wrapperPid + 2,
              parentPid: wrapperPid + 1,
              birth: String(1002 + index * 3),
              localPid: 2,
              dead: false,
              waitReceipt: null,
            },
            treeStopped: false,
          },
        },
      };
      const ownedProcesses = structuredClone(startupProcesses),
        owner = ownedProcesses.owner;
      owner.phase = 'terminal';
      owner.fdClosed = true;
      Object.assign(owner.wrapper, {
        exit: { code: 0, signal: null, reaped: true },
        closed: true,
        stdoutEof: true,
        stderrEof: true,
      });
      owner.namespace!.treeStopped = true;
      owner.namespace!.init.dead = true;
      Object.assign(owner.namespace!.root!, {
        dead: true,
        waitReceipt: {
          localPid: 2,
          code: 0,
          signal: null,
          rawStatus: 0,
          waitConfirmed: true,
          reaped: true,
        },
      });
      return {
        commandId,
        sessionId: sessionIds[index % 20]!,
        executionId: `job-${index}`,
        startedAt,
        endedAt,
        units: CONTINUOUS_SHELL_UNITS,
        digest,
        processTreeStopped: true,
        stdoutSha256: hash(
          `${JSON.stringify({ nonce: commandId, startedAt, endedAt, units: CONTINUOUS_SHELL_UNITS, digest })}\n`,
        ),
        startupProcesses,
        ownedProcesses,
      };
    }),
  };
  const evidence: ContinuousEvidence = {
    version: 3,
    mode: 'diagnostic',
    status: 'passed',
    storeId: 'original-store',
    serviceInstanceIds: ['service-0', 'service-1'],
    sessionIds,
    commandIds,
    childExecutionIds: commandIds.map((id) => `child-${id}`),
    synchronousEffects: 40,
    childCalls: 40,
    slowEntered: true,
    peerEvents: 1,
    reconnects: 2,
    completedCycles: 2,
    wallDurationMs: 401,
    activeWorkloadDurationMs: 400,
    busyIntervals: commandIds.map((_, index) => [index * 10, (index + 1) * 10]),
    operationDurationMs: commandIds.map(() => 10),
    admissionLatencyMs: commandIds.map(() => 1),
    cleanupConfirmed: true,
    missing: [],
    shell,
  };
  return { evidence, shell };
}

test('Linux continuous v3 binds original ready and ended namespace owners and keeps formal and resource gates', () => {
  const { evidence } = linuxContinuousPacket();
  expect(verifyContinuousEvidence(evidence, false, 'linux')).toEqual([]);
  expect(verifyContinuousEvidence(evidence, false, 'darwin')).toContain(
    'continuous_background_shell_invalid',
  );
  expect(verifyContinuousEvidence({ ...evidence, mode: 'formal' }, true, 'linux')).toContain(
    'continuous_formal_unqualified',
  );
  const reject = (
    change: (shell: ContinuousLinuxShellEvidence) => void,
    error = 'continuous_shell_process_handoff_invalid',
  ) => {
    const { evidence, shell } = linuxContinuousPacket();
    change(shell);
    expect(verifyContinuousEvidence(evidence, false, 'linux')).toContain(error);
  };
  reject((shell) => {
    shell.jobs[0]!.startupProcesses.owner.namespace!.root!.birth += '1';
  });
  reject((shell) => {
    shell.jobs[0]!.startupProcesses.owner.namespace!.root!.dead = true;
  });
  reject((shell) => {
    shell.jobs[0]!.startupProcesses.binding.nonce = 'foreign';
  });
  reject((shell) => {
    shell.jobs[0]!.ownedProcesses.owner.namespace!.root!.waitReceipt!.code = 7;
    shell.jobs[0]!.ownedProcesses.owner.namespace!.root!.waitReceipt!.rawStatus = 1792;
  });
  reject((shell) => {
    shell.jobs[0]!.ownedProcesses.owner.closeUnknown = true;
  });
  reject((shell) => {
    Object.assign(shell.jobs[0]!, { coalitionId: '123' });
  }, 'continuous_background_shell_invalid');
  reject((shell) => {
    shell.serviceResources.services[0]!.exit!.reaped = false;
  }, 'continuous_service_resources_unqualified');
  reject((shell) => {
    shell.serviceResources.cold!.providerCallsAfter++;
  }, 'continuous_service_resources_unqualified');
});

test('schedule refuses pre-stopped work and unsupported formal before Profile I/O', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-soak-continuous-refuse-'));
  try {
    const formalRoot = join(root, 'formal');
    await expect(
      runContinuousSchedule(
        formalRoot,
        'formal',
        ['darwin', 'linux'].includes(process.platform) ? AbortSignal.abort() : undefined,
      ),
    ).rejects.toThrow(
      ['darwin', 'linux'].includes(process.platform)
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
