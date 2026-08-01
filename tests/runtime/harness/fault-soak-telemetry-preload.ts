import { afterAll, beforeAll } from 'bun:test';
import { appendFileSync, readdirSync } from 'node:fs';
import { readOsProcessStartIdentity } from '../../../scripts/runtime/process-start-identity';

interface ProcessResourceSample {
  rssBytes: number;
  activeResources: number;
  fileDescriptors?: number;
  listeners: number;
  handles?: number;
}

interface ProcessResourceRecordV2 {
  version: 2;
  kind: 'process_resource';
  pid: number;
  parentPid: number;
  sequence: number;
  caseId: string;
  lifecycleId: string;
  processStartNonce: string;
  osProcessStartIdentity?: string;
  lifecycleGroupNonce: string;
  durationMs: number;
  deadlineMs: number;
  cleanup: {
    confirmed: boolean;
    descendantInspectionSupported: boolean;
    descendantPidsAfter: number[];
  };
  before: ProcessResourceSample;
  after: ProcessResourceSample;
}

interface FaultSoakLifecycleGlobal {
  __KITE_FAULT_SOAK_LIFECYCLE_SEQUENCE__?: number;
}

function descendantPids(rootPid: number): number[] | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const listing = Bun.spawnSync(['ps', '-Ao', 'pid=,ppid='], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    if (listing.exitCode !== 0) return undefined;
    const children = new Map<number, number[]>();
    for (const line of listing.stdout.toString().split('\n')) {
      const [pidText, parentText] = line.trim().split(/\s+/);
      const pid = Number(pidText);
      const parent = Number(parentText);
      if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
      if (pid === listing.pid) continue;
      children.set(parent, [...(children.get(parent) ?? []), pid]);
    }
    const descendants: number[] = [];
    const visit = (parent: number): void => {
      for (const child of children.get(parent) ?? []) {
        descendants.push(child);
        visit(child);
      }
    };
    visit(rootPid);
    return descendants.sort((left, right) => left - right);
  } catch {
    return undefined;
  }
}

function fileDescriptorCount(): number | undefined {
  if (process.platform === 'win32') return undefined;
  const directory = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
  try {
    return readdirSync(directory).length;
  } catch {
    return undefined;
  }
}

function activeHandleCount(): number | undefined {
  const getActiveHandles = (
    process as typeof process & { _getActiveHandles?: () => readonly unknown[] }
  )._getActiveHandles;
  return typeof getActiveHandles === 'function' ? getActiveHandles().length : undefined;
}

function sample(): ProcessResourceSample {
  return {
    rssBytes: process.memoryUsage.rss(),
    activeResources: process.getActiveResourcesInfo().length,
    fileDescriptors: fileDescriptorCount(),
    listeners: process
      .eventNames()
      .reduce((total, eventName) => total + process.listenerCount(eventName), 0),
    handles: activeHandleCount(),
  };
}

const telemetryFile = process.env.KITE_FAULT_SOAK_TELEMETRY_FILE;
if (telemetryFile) {
  let before: ProcessResourceSample | undefined;
  let startedAt = 0;
  let sequence = 0;
  const lifecycleGroupNonce = process.env.KITE_FAULT_SOAK_LIFECYCLE_GROUP_NONCE ?? 'unbound';
  const processStartNonce = `${process.env.KITE_FAULT_SOAK_PROCESS_NONCE ?? 'unbound'}:${process.pid}`;
  const configuredDeadline = Number(process.env.KITE_FAULT_SOAK_LIFECYCLE_DEADLINE_MS);
  const deadlineMs =
    Number.isInteger(configuredDeadline) && configuredDeadline > 0 ? configuredDeadline : 180_000;
  beforeAll(() => {
    sequence += 1;
    (globalThis as FaultSoakLifecycleGlobal).__KITE_FAULT_SOAK_LIFECYCLE_SEQUENCE__ = sequence;
    startedAt = performance.now();
    before = sample();
  });
  afterAll(async () => {
    await Bun.sleep(0);
    const descendants = descendantPids(process.pid);
    const record: ProcessResourceRecordV2 = {
      version: 2,
      kind: 'process_resource',
      pid: process.pid,
      parentPid: process.ppid,
      sequence,
      caseId: process.env.KITE_FAULT_SOAK_CASE_ID ?? 'unknown',
      lifecycleId: process.env.KITE_FAULT_SOAK_LIFECYCLE_ID ?? 'bun-test-probe',
      processStartNonce,
      osProcessStartIdentity: readOsProcessStartIdentity(process.pid),
      lifecycleGroupNonce,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      deadlineMs,
      cleanup: {
        confirmed: descendants !== undefined && descendants.length === 0,
        descendantInspectionSupported: descendants !== undefined,
        descendantPidsAfter: descendants ?? [],
      },
      before: before ?? sample(),
      after: sample(),
    };
    appendFileSync(telemetryFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  });
}
