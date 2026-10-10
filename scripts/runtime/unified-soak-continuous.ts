import { createHash } from 'node:crypto';
import {
  decodeLinuxShellProcessEvidence,
  decodeMacosShellProcessEvidence as decodeShellProcessEvidence,
  type LinuxShellProcessEvidence,
  type MacosShellProcessEvidence as ShellProcessEvidence,
  shellProcessEvidenceEnded,
} from '@kite-ai/agent/jobs/shell';
import {
  type PairedServiceResources,
  verifyPairedServiceResources,
} from './unified-soak-service-resources';

/** Closed workload evidence. Formal thresholds cannot be caller overrides. */
export const CONTINUOUS_MINIMUM_BUSY_MS = 450_000;
export const CONTINUOUS_OPERATION_MS = 180_000;
export const CONTINUOUS_SHELL_UNITS = 65_536;
export const CONTINUOUS_SHELL_SOURCE = `import{createHash}from'node:crypto';
const nonce=process.argv[1];const bytes=Buffer.alloc(65536,16);const startedAt=Date.now();let digest='';
for(let unit=0;unit<${CONTINUOUS_SHELL_UNITS};unit++){bytes.writeUInt32LE(unit);digest=createHash('sha256').update(bytes).digest('hex');}
console.log(JSON.stringify({nonce,startedAt,endedAt:Date.now(),units:${CONTINUOUS_SHELL_UNITS},digest}));`;
export interface ContinuousShellEvidence {
  backend: 'macos-launchd-coalition';
  candidateDigest: string;
  sourceSha256: string;
  wallStartedAt: number;
  jobs: {
    commandId: string;
    sessionId: string;
    executionId: string;
    coalitionId: string;
    startedAt: number;
    endedAt: number;
    units: number;
    digest: string;
    processTreeStopped: true;
    stdoutSha256: string;
    /** Original Shell Job handoff only; no whole Runtime resource qualification. */
    ownedProcesses?: ShellProcessEvidence;
  }[];
  coldRead: boolean;
  noReplay: boolean;
  /** Optional independently versioned Service boundary observation; not whole resource qualification. */
  serviceResources?: PairedServiceResources;
}
export interface ContinuousLinuxShellEvidence {
  backend: 'linux-pid-namespace';
  candidateDigest: string;
  sourceSha256: string;
  wallStartedAt: number;
  jobs: {
    commandId: string;
    sessionId: string;
    executionId: string;
    startedAt: number;
    endedAt: number;
    units: number;
    digest: string;
    processTreeStopped: true;
    stdoutSha256: string;
    /** Original persisted ready reference and terminal result; never reconstructed control. */
    startupProcesses: LinuxShellProcessEvidence;
    ownedProcesses: LinuxShellProcessEvidence;
  }[];
  coldRead: boolean;
  noReplay: boolean;
  serviceResources: PairedServiceResources;
}
export type ContinuousOwnedShellEvidence = ContinuousShellEvidence | ContinuousLinuxShellEvidence;
export interface ContinuousEvidence {
  version: 1 | 2 | 3;
  mode: 'diagnostic' | 'formal';
  status: 'passed' | 'failed';
  storeId: string;
  serviceInstanceIds: string[];
  sessionIds: string[];
  commandIds: string[];
  childExecutionIds: string[];
  synchronousEffects: number;
  childCalls: number;
  slowEntered: boolean;
  peerEvents: number;
  reconnects: number;
  completedCycles: number;
  wallDurationMs: number;
  activeWorkloadDurationMs: number;
  busyIntervals: [number, number][];
  operationDurationMs: number[];
  admissionLatencyMs: number[];
  cleanupConfirmed: boolean;
  missing: string[];
  /** v2 Mac / v3 Linux: actual default packaged Service producer. */
  shell?: ContinuousOwnedShellEvidence;
}
export function unionBusyIntervals(intervals: readonly (readonly [number, number])[]) {
  const ordered = [...intervals].sort((a, b) => a[0] - b[0]);
  const union: [number, number][] = [];
  for (const [start, end] of ordered) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start)
      throw Error('invalid_work_interval');
    const last = union.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else union.push([start, end]);
  }
  return union;
}
export function busyDuration(intervals: readonly (readonly [number, number])[]) {
  return unionBusyIntervals(intervals).reduce((sum, [start, end]) => sum + end - start, 0);
}
function linuxOwnershipIdentity(proof: LinuxShellProcessEvidence) {
  const owner = proof.owner,
    ns = owner.namespace!,
    root = ns.root!;
  return JSON.stringify({
    ownerPid: owner.ownerPid,
    mode: owner.admission.mode,
    wrapper: [owner.wrapper.pid, owner.wrapper.parentPid, owner.wrapper.birth],
    namespace: [ns.dev, ns.ino],
    init: [ns.init.pid, ns.init.parentPid, ns.init.birth, ns.init.localPid],
    root: [root.pid, root.parentPid, root.birth, root.localPid],
  });
}
function originalLinuxHandoff(
  job: ContinuousLinuxShellEvidence['jobs'][number],
  resources: PairedServiceResources,
) {
  const proof = job.ownedProcesses;
  const terminal =
    proof &&
    decodeLinuxShellProcessEvidence(proof, {
      sessionId: job.sessionId,
      executionId: job.executionId,
      nonce: proof.binding?.nonce,
    });
  const ready =
    terminal &&
    decodeLinuxShellProcessEvidence(
      job.startupProcesses,
      terminal.binding,
      terminal.owner.ownerPid,
    );
  if (!terminal || !shellProcessEvidenceEnded(terminal) || !ready) return false;
  const owner = ready.owner,
    ns = owner.namespace,
    root = ns?.root,
    wait = terminal.owner.namespace?.root?.waitReceipt;
  return !!(
    owner.phase === 'ready' &&
    !owner.fdClosed &&
    !owner.closeUnknown &&
    owner.wrapper.exit === null &&
    !owner.wrapper.closed &&
    !owner.wrapper.stdoutEof &&
    !owner.wrapper.stderrEof &&
    ns &&
    !ns.treeStopped &&
    !ns.init.dead &&
    root &&
    !root.dead &&
    root.waitReceipt === null &&
    wait?.code === 0 &&
    wait.signal === null &&
    wait.rawStatus === 0 &&
    Array.isArray(resources?.services) &&
    resources.services.some((service) => service?.pid === owner.ownerPid) &&
    linuxOwnershipIdentity(ready) === linuxOwnershipIdentity(terminal)
  );
}
export function verifyContinuousEvidence(
  value: ContinuousEvidence,
  formal: boolean,
  platform?: string,
) {
  const expected = [
    'version',
    'mode',
    'status',
    'storeId',
    'serviceInstanceIds',
    'sessionIds',
    'commandIds',
    'childExecutionIds',
    'synchronousEffects',
    'childCalls',
    'slowEntered',
    'peerEvents',
    'reconnects',
    'completedCycles',
    'wallDurationMs',
    'activeWorkloadDurationMs',
    'busyIntervals',
    'operationDurationMs',
    'admissionLatencyMs',
    'cleanupConfirmed',
    'missing',
    ...(value?.version === 2 || value?.version === 3 ? ['shell'] : []),
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== expected.length ||
    !expected.every((key) => Object.hasOwn(value, key))
  )
    return ['continuous_structure_invalid'];
  const ids = (values: unknown, count?: number): values is string[] =>
    Array.isArray(values) &&
    (count === undefined || values.length === count) &&
    new Set(values).size === values.length &&
    values.every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id));
  if (
    ![1, 2, 3].includes(value.version) ||
    !['diagnostic', 'formal'].includes(value.mode) ||
    value.status !== 'passed' ||
    !ids([value.storeId], 1) ||
    !ids(value.serviceInstanceIds, 2) ||
    !ids(value.sessionIds, 20) ||
    !ids(value.commandIds) ||
    !ids(value.childExecutionIds) ||
    !Number.isSafeInteger(value.completedCycles) ||
    value.completedCycles < 2 ||
    value.commandIds.length !== 20 * value.completedCycles ||
    value.synchronousEffects !== value.commandIds.length ||
    value.childCalls !== value.commandIds.length ||
    value.childExecutionIds.length !== value.commandIds.length ||
    value.slowEntered !== true ||
    !Number.isSafeInteger(value.peerEvents) ||
    value.peerEvents <= 0 ||
    value.reconnects !== value.completedCycles ||
    value.cleanupConfirmed !== true ||
    !Array.isArray(value.missing) ||
    !value.missing.every((item) => typeof item === 'string')
  )
    return ['continuous_workload_invalid'];
  if (
    !Number.isFinite(value.wallDurationMs) ||
    value.wallDurationMs < 0 ||
    !Number.isFinite(value.activeWorkloadDurationMs) ||
    value.activeWorkloadDurationMs <= 0 ||
    value.activeWorkloadDurationMs > value.wallDurationMs ||
    !Array.isArray(value.busyIntervals) ||
    value.busyIntervals.length !== value.commandIds.length ||
    !value.busyIntervals.every(
      (interval) =>
        Array.isArray(interval) &&
        interval.length === 2 &&
        interval.every((part) => typeof part === 'number'),
    ) ||
    !Array.isArray(value.operationDurationMs) ||
    value.operationDurationMs.length !== value.commandIds.length ||
    value.operationDurationMs.some(
      (duration) =>
        !Number.isFinite(duration) || duration < 0 || duration > CONTINUOUS_OPERATION_MS,
    ) ||
    !Array.isArray(value.admissionLatencyMs) ||
    value.admissionLatencyMs.length !== value.commandIds.length ||
    value.admissionLatencyMs.some(
      (duration) =>
        !Number.isFinite(duration) || duration < 0 || duration > CONTINUOUS_OPERATION_MS,
    )
  )
    return ['continuous_timing_invalid'];
  try {
    if (
      value.busyIntervals.some(([, end]) => end > value.wallDurationMs) ||
      value.busyIntervals.some(([start, end], index) =>
        value.version === 1
          ? Math.abs(end - start - value.operationDurationMs[index]!) > 0.001
          : end - start > value.operationDurationMs[index]!,
      ) ||
      Math.abs(busyDuration(value.busyIntervals) - value.activeWorkloadDurationMs) > 0.001
    )
      return ['continuous_busy_union_invalid'];
  } catch {
    return ['continuous_busy_union_invalid'];
  }
  if (value.version === 2) {
    const shell = value.shell;
    const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const bytes = Buffer.alloc(65536, 16);
    bytes.writeUInt32LE(CONTINUOUS_SHELL_UNITS - 1);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (
      !shell ||
      Object.keys(shell).sort().join(',') !==
        [
          'backend',
          'candidateDigest',
          'coldRead',
          'jobs',
          'noReplay',
          'sourceSha256',
          'wallStartedAt',
          ...(Object.hasOwn(shell, 'serviceResources') ? ['serviceResources'] : []),
        ]
          .sort()
          .join(',') ||
      shell.backend !== 'macos-launchd-coalition' ||
      (platform !== undefined && platform !== 'darwin') ||
      !hash(shell.candidateDigest) ||
      shell.sourceSha256 !== createHash('sha256').update(CONTINUOUS_SHELL_SOURCE).digest('hex') ||
      !Number.isSafeInteger(shell.wallStartedAt) ||
      shell.wallStartedAt <= 0 ||
      shell.coldRead !== true ||
      shell.noReplay !== true ||
      !Array.isArray(shell.jobs) ||
      shell.jobs.length !== value.commandIds.length ||
      !ids(shell.jobs.map((job) => job.executionId)) ||
      new Set(shell.jobs.map((job) => job.coalitionId)).size !== shell.jobs.length ||
      shell.jobs.some(
        (job, index) =>
          Object.keys(job).sort().join(',') !==
            [
              'coalitionId',
              'commandId',
              'digest',
              'endedAt',
              'executionId',
              'processTreeStopped',
              'sessionId',
              'startedAt',
              'stdoutSha256',
              'units',
              ...(Object.hasOwn(job, 'ownedProcesses') ? ['ownedProcesses'] : []),
            ]
              .sort()
              .join(',') ||
          job.commandId !== value.commandIds[index] ||
          !value.sessionIds.includes(job.sessionId) ||
          !/^[1-9][0-9]{0,19}$/.test(job.coalitionId) ||
          !Number.isSafeInteger(job.startedAt) ||
          !Number.isSafeInteger(job.endedAt) ||
          job.endedAt <= job.startedAt ||
          job.units !== CONTINUOUS_SHELL_UNITS ||
          job.digest !== digest ||
          job.processTreeStopped !== true ||
          !hash(job.stdoutSha256) ||
          job.stdoutSha256 !==
            createHash('sha256')
              .update(
                `${JSON.stringify({ nonce: job.commandId, startedAt: job.startedAt, endedAt: job.endedAt, units: job.units, digest: job.digest })}\n`,
              )
              .digest('hex') ||
          job.startedAt - shell.wallStartedAt !== value.busyIntervals[index]![0] ||
          job.endedAt - shell.wallStartedAt !== value.busyIntervals[index]![1],
      )
    )
      return ['continuous_background_shell_invalid'];
    for (const job of shell.jobs) {
      if (!Object.hasOwn(job, 'ownedProcesses')) continue;
      const proof = job.ownedProcesses;
      const decoded =
        proof &&
        decodeShellProcessEvidence(proof, {
          sessionId: job.sessionId,
          executionId: job.executionId,
          nonce: proof.binding?.nonce,
        });
      if (
        !decoded ||
        !shellProcessEvidenceEnded(decoded) ||
        decoded.coalition.id !== job.coalitionId ||
        (shell.serviceResources &&
          (!Array.isArray(shell.serviceResources.services) ||
            !shell.serviceResources.services.some((service) => service?.pid === decoded.ownerPid)))
      )
        return ['continuous_shell_process_handoff_invalid'];
    }
  }
  if (value.version === 3) {
    const shell = value.shell;
    const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const bytes = Buffer.alloc(65536, 16);
    bytes.writeUInt32LE(CONTINUOUS_SHELL_UNITS - 1);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (
      !shell ||
      Object.keys(shell).sort().join(',') !==
        'backend,candidateDigest,coldRead,jobs,noReplay,serviceResources,sourceSha256,wallStartedAt' ||
      shell.backend !== 'linux-pid-namespace' ||
      (platform !== undefined && platform !== 'linux') ||
      !hash(shell.candidateDigest) ||
      shell.sourceSha256 !== createHash('sha256').update(CONTINUOUS_SHELL_SOURCE).digest('hex') ||
      !Number.isSafeInteger(shell.wallStartedAt) ||
      shell.wallStartedAt <= 0 ||
      shell.coldRead !== true ||
      shell.noReplay !== true ||
      shell.serviceResources?.version !== 2 ||
      !Array.isArray(shell.jobs) ||
      shell.jobs.length !== value.commandIds.length ||
      !ids(shell.jobs.map((job) => job?.executionId)) ||
      shell.jobs.some(
        (job, index) =>
          !job ||
          Object.keys(job).sort().join(',') !==
            'commandId,digest,endedAt,executionId,ownedProcesses,processTreeStopped,sessionId,startedAt,startupProcesses,stdoutSha256,units' ||
          job.commandId !== value.commandIds[index] ||
          !value.sessionIds.includes(job.sessionId) ||
          !Number.isSafeInteger(job.startedAt) ||
          !Number.isSafeInteger(job.endedAt) ||
          job.endedAt <= job.startedAt ||
          job.units !== CONTINUOUS_SHELL_UNITS ||
          job.digest !== digest ||
          job.processTreeStopped !== true ||
          !hash(job.stdoutSha256) ||
          job.stdoutSha256 !==
            createHash('sha256')
              .update(
                `${JSON.stringify({ nonce: job.commandId, startedAt: job.startedAt, endedAt: job.endedAt, units: job.units, digest: job.digest })}\n`,
              )
              .digest('hex') ||
          job.startedAt - shell.wallStartedAt !== value.busyIntervals[index]![0] ||
          job.endedAt - shell.wallStartedAt !== value.busyIntervals[index]![1],
      )
    )
      return ['continuous_background_shell_invalid'];
    if (
      shell.jobs.some((job) => !originalLinuxHandoff(job, shell.serviceResources)) ||
      new Set(shell.jobs.map((job) => linuxOwnershipIdentity(job.ownedProcesses))).size !==
        shell.jobs.length
    )
      return ['continuous_shell_process_handoff_invalid'];
  }
  if (
    (value.version === 2 || value.version === 3) &&
    value.shell &&
    Object.hasOwn(value.shell, 'serviceResources')
  ) {
    const resourceErrors = verifyPairedServiceResources(value.shell.serviceResources!, {
      storeId: value.storeId,
      candidateDigest: value.shell.candidateDigest,
      instanceIds: value.serviceInstanceIds,
      coldRead: value.shell.coldRead,
      platform: platform ?? (value.version === 3 ? 'linux' : 'darwin'),
    });
    if (resourceErrors.length) return resourceErrors;
  }
  if (
    formal &&
    (value.mode !== 'formal' ||
      value.missing.length ||
      value.activeWorkloadDurationMs < CONTINUOUS_MINIMUM_BUSY_MS)
  )
    return ['continuous_formal_unqualified'];
  if (formal && value.version === 1) return ['continuous_background_shell_unqualified'];
  return [];
}
