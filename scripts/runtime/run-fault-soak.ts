import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  buildRuntimeFaultSoakReport,
  type OptionalMetric,
  RUNTIME_FAULT_SOAK_QUALIFICATION_LIFECYCLE_IDS,
  RUNTIME_FAULT_SOAK_RUNNER_REVISION,
  type RuntimeBudgetUsageEvidenceV2,
  type RuntimeFaultSoakAttemptV2,
  type RuntimeFaultSoakCaseId,
  type RuntimeFaultSoakMetricEvidenceV2,
  type RuntimeFaultSoakProfile,
  type RuntimeFaultSoakSourceV2,
} from './fault-soak-report';
import { readOsProcessStartIdentity } from './process-start-identity';

const QUALIFICATION_REPEAT_COUNT = 9;
const MAX_CAPTURED_OUTPUT_BYTES = 256 * 1024;
const CAPTURE_DRAIN_TIMEOUT_MS = 2_000;
const PROCESS_REAP_TIMEOUT_MS = 5_000;
export const RUNTIME_FAULT_SOAK_SETTLE_RESERVE_MS = 30_000;
const INSPECTION_TIMEOUT_MS = 1_000;
export const TUI_FAULT_SOAK_PROBE_ARGS = [
  'run',
  'scripts/run-tui-system-tests.ts',
  '--with-lifecycle-harness',
  'session-switch',
  'tool-lifecycle',
  'model-stream-reconnect',
] as const;
const telemetryPreload = resolve(
  process.cwd(),
  'tests/runtime/harness/fault-soak-telemetry-preload.ts',
);
const testCaseRunner = resolve(process.cwd(), 'scripts/runtime/run-fault-soak-test-case.ts');

interface ProbeDefinition {
  id: RuntimeFaultSoakCaseId;
  args: readonly string[];
  qualificationLifecycleFiles: readonly string[];
  qualificationPrewarmFiles?: readonly string[];
  terminalEvidence: Readonly<Record<string, RegExp>>;
  invariantEvidence: RegExp;
}

const PROBES: readonly ProbeDefinition[] = [
  {
    id: 'long_runtime_replay',
    args: [
      'test',
      'tests/runtime/fault-soak-long-runtime-lifecycle.test.ts',
      'tests/runtime/agent.integration.test.ts',
      'tests/runtime/context-compaction.test.ts',
      'tests/runtime/fault-soak-runtime-budget.test.ts',
    ],
    qualificationLifecycleFiles: [
      'tests/runtime/fault-soak-long-runtime-lifecycle.test.ts',
      'tests/runtime/fault-soak-runtime-budget.test.ts',
    ],
    qualificationPrewarmFiles: ['tests/runtime/fault-soak-long-runtime-lifecycle.test.ts'],
    terminalEvidence: {
      completed: /\(pass\).*replays a long deterministic event stream without violating invariants/,
    },
    invariantEvidence:
      /\(pass\).*replays a long deterministic event stream without violating invariants/,
  },
  {
    id: 'subagent_cancel_recovery',
    args: ['test', 'tests/runtime/cancel-resume.test.ts', 'tests/subagent-runner.test.ts'],
    qualificationLifecycleFiles: ['tests/runtime/cancel-resume.test.ts'],
    terminalEvidence: {
      cancelled:
        /\(pass\).*restores cancelled waiters, unknown dispatches, and cancel-incomplete terminal facts/,
      reconciliation_required:
        /\(pass\).*persists a structured unknown terminal when recovery is blocked/,
    },
    invariantEvidence:
      /\(pass\).*restores cancelled waiters, unknown dispatches, and cancel-incomplete terminal facts/,
  },
  {
    id: 'model_transient_stream',
    args: [
      'test',
      'tests/model.test.ts',
      'tests/model-invoke.test.ts',
      'tests/runtime/agent-deadline.test.ts',
      'tests/runtime/failure-mode-conformance.test.ts',
    ],
    qualificationLifecycleFiles: ['tests/runtime/agent-deadline.test.ts'],
    terminalEvidence: {
      model_retry_exhausted:
        /\(pass\).*model_rate_limit admits exactly one retry only while the bounded retry budget remains/,
      deadline_exceeded:
        /\(pass\).*wakes a pending interaction wait and emits one deadline terminal/,
    },
    invariantEvidence: /\(pass\).*wakes a pending interaction wait and emits one deadline terminal/,
  },
  {
    id: 'mcp_churn',
    args: [
      'test',
      'tests/mcp-manager.test.ts',
      'tests/mcp-supervisor.test.ts',
      'tests/runtime/tool-controller.test.ts',
      'tests/runtime/failure-mode-conformance.test.ts',
    ],
    qualificationLifecycleFiles: ['tests/mcp-supervisor.test.ts'],
    terminalEvidence: {
      mcp_unavailable: /\(pass\).*degrades a real stdio provider that exits during an invocation/,
      reconciliation_required:
        /\(pass\).*required MCP revision drift preserves unknown evidence and requires reconciliation/,
    },
    invariantEvidence:
      /\(pass\).*required MCP revision drift preserves unknown evidence and requires reconciliation/,
  },
  {
    id: 'runtime_sigkill_recovery',
    args: [
      'test',
      'tests/runtime/fault-injection.test.ts',
      'tests/runtime/failure-mode-conformance.test.ts',
      '-t',
      'abrupt process termination|never continues or degrades while prior external effects remain unknown',
    ],
    qualificationLifecycleFiles: ['tests/runtime/fault-injection.test.ts'],
    terminalEvidence: {
      reconciliation_required:
        /\(pass\).*never continues or degrades while prior external effects remain unknown/,
    },
    invariantEvidence:
      /\(pass\).*abrupt process termination preserves intent, Plan, Verification, and unknown dispatch/,
  },
  {
    id: 'storage_and_logger_faults',
    args: [
      'test',
      'tests/runtime/fault-injection.test.ts',
      'tests/session-logger/composition.test.ts',
      'tests/runtime/failure-mode-conformance.test.ts',
      '-t',
      'storage fault|writer construction failure|covers every failure mode|disk_full propagates known external-effect evidence',
    ],
    qualificationLifecycleFiles: ['tests/runtime/fault-injection.test.ts'],
    terminalEvidence: {
      persistence_unavailable:
        /\(pass\).*disk_full propagates known external-effect evidence instead of inventing none/,
      completed: /\(pass\).*writer construction failure reports once and does not stop the Runtime/,
    },
    invariantEvidence:
      /\(pass\).*storage fault rolls back an injected SQLite full write without corrupting recovery/,
  },
  {
    id: 'tui_lifecycle_churn',
    args: TUI_FAULT_SOAK_PROBE_ARGS,
    qualificationLifecycleFiles: [],
    terminalEvidence: {
      completed: /\(pass\).*keeps partial text and commits only the recovered tool lifecycle/,
      cancelled:
        /\(pass\).*full lifecycle: interrupt .* deny .* current turn stops without model continuation/,
    },
    invariantEvidence:
      /\(pass\).*runs repeated InputLine focus-listener mount and unmount in one owned child process/,
  },
];

interface RunnerOptions {
  profile: RuntimeFaultSoakProfile;
  iterations: number;
  seed: number;
  perCaseTimeoutMs: number;
  output?: string;
  source: RuntimeFaultSoakSourceV2;
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readOption(args: readonly string[], name: string): string | undefined {
  const inline = args.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function boundedFaultSoakProbeTimeoutMs(
  perCaseTimeoutMs: number,
  globalRemainingMs: number,
): number | undefined {
  if (globalRemainingMs <= RUNTIME_FAULT_SOAK_SETTLE_RESERVE_MS) return undefined;
  return Math.max(
    1,
    Math.min(perCaseTimeoutMs, globalRemainingMs - RUNTIME_FAULT_SOAK_SETTLE_RESERVE_MS),
  );
}

function parseSource(args: readonly string[]): RuntimeFaultSoakSourceV2 {
  const values = {
    repository: readOption(args, '--source-repository'),
    headSha: readOption(args, '--source-head-sha'),
    ref: readOption(args, '--source-ref'),
    workflow: readOption(args, '--source-workflow'),
    workflowRef: readOption(args, '--source-workflow-ref'),
    workflowSha: readOption(args, '--source-workflow-sha'),
    runId: readOption(args, '--source-run-id'),
    runAttempt: readOption(args, '--source-run-attempt'),
  };
  const supplied = Object.values(values).filter((value) => value !== undefined).length;
  if (supplied === 0) return { kind: 'local' };
  if (supplied !== Object.keys(values).length) {
    throw new Error('GitHub Actions source identity options must be supplied together');
  }
  if (Object.values(values).some((value) => value?.trim().length === 0)) {
    throw new Error('GitHub Actions source identity options must be non-empty');
  }
  return {
    kind: 'github_actions',
    repository: values.repository!,
    headSha: values.headSha!,
    ref: values.ref!,
    workflow: values.workflow!,
    workflowRef: values.workflowRef!,
    workflowSha: values.workflowSha!,
    runId: values.runId!,
    runAttempt: positiveInteger(values.runAttempt, '--source-run-attempt'),
  };
}

export function parseRuntimeFaultSoakOptions(args: readonly string[]): RunnerOptions {
  const profile = readOption(args, '--profile') ?? 'ci';
  if (profile !== 'ci' && profile !== 'qualification') {
    throw new Error(`--profile must be ci or qualification, received ${profile}`);
  }
  return {
    profile,
    iterations: positiveInteger(
      readOption(args, '--iterations') ?? (profile === 'qualification' ? '8' : '1'),
      '--iterations',
    ),
    seed: positiveInteger(readOption(args, '--seed') ?? '1729', '--seed'),
    perCaseTimeoutMs: positiveInteger(
      readOption(args, '--timeout-ms') ?? (profile === 'qualification' ? '180000' : '120000'),
      '--timeout-ms',
    ),
    output: readOption(args, '--output'),
    source: parseSource(args),
  };
}

export function buildFaultSoakProbeArgs(
  args: readonly string[],
  profile: RuntimeFaultSoakProfile,
  qualificationLifecycleFiles: readonly string[] = args.filter((argument) =>
    argument.endsWith('.test.ts'),
  ),
  qualificationPrewarmFiles: readonly string[] = [],
): string[] {
  return args[0] === 'test'
    ? [
        'run',
        testCaseRunner,
        '--preload',
        telemetryPreload,
        '--repeat-count',
        String(profile === 'qualification' ? QUALIFICATION_REPEAT_COUNT : 1),
        ...qualificationLifecycleFiles.flatMap((file) => ['--repeat-file', basename(file)]),
        ...(profile === 'qualification'
          ? qualificationPrewarmFiles.flatMap((file) => ['--prewarm-file', basename(file)])
          : []),
        '--',
        ...args.slice(1),
      ]
    : [...args];
}

function unsupported<T>(reason: string): OptionalMetric<T> {
  return { supported: false, reason };
}

export function terminateFaultSoakProcessTree(
  proc: ReturnType<typeof Bun.spawn>,
  knownIdentities: ReadonlyMap<number, string> = new Map(),
): void {
  if (process.platform === 'win32') {
    Bun.spawnSync(['taskkill.exe', '/pid', String(proc.pid), '/t', '/f'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    return;
  }
  // Snapshot first. Killing the coordinator group can reparent nested detached
  // per-file/fixture groups and make them undiscoverable by PPID afterwards.
  const owned = new Set([
    ...knownIdentities.keys(),
    ...(descendantPids(proc.pid) ?? []),
    ...(processGroupPids(proc.pid) ?? []),
  ]);
  const identities = new Map(knownIdentities);
  for (const pid of owned) {
    if (!identities.has(pid)) {
      const identity = readOsProcessStartIdentity(pid);
      if (identity) identities.set(pid, identity);
    }
  }
  for (const pid of [...owned].reverse()) {
    const expectedIdentity = identities.get(pid);
    if (!expectedIdentity || readOsProcessStartIdentity(pid) !== expectedIdentity) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The process may exit between discovery and termination.
    }
  }
  if (proc.exitCode === null) {
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      try {
        proc.kill('SIGKILL');
      } catch {
        // The process-group signal may already have reaped the leader.
      }
    }
  }
}

export async function captureBounded(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let captured = '';
  let capturedBytes = 0;
  let rejectAbort: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(new Error('capture drain deadline exceeded'));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), aborted]);
      if (result.done) break;
      if (capturedBytes >= MAX_CAPTURED_OUTPUT_BYTES) continue;
      const remaining = MAX_CAPTURED_OUTPUT_BYTES - capturedBytes;
      const chunk =
        result.value.byteLength <= remaining ? result.value : result.value.slice(0, remaining);
      captured += decoder.decode(chunk, { stream: true });
      capturedBytes += chunk.byteLength;
    }
  } catch (error) {
    if (!signal.aborted) throw error;
    void reader.cancel().catch(() => {});
    captured += '\n[fault-soak output capture ended at the bounded drain deadline]';
  } finally {
    signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // An aborted pending read can retain the lock until cancellation settles.
    }
  }
  return captured + decoder.decode();
}

function registeredWorktrees(): Set<string> | undefined {
  try {
    const result = spawnSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: INSPECTION_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    if (result.status !== 0 || result.error) return undefined;
    return new Set(
      result.stdout
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length)),
    );
  } catch {
    return undefined;
  }
}

function residualEntries(root: string): string[] {
  const entries: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      entries.push(relative(root, absolute));
      if (entry.isDirectory()) visit(absolute);
    }
  };
  visit(root);
  return entries.sort();
}

export interface TelemetryRecord {
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
  before: {
    rssBytes: number;
    activeResources: number;
    fileDescriptors?: number;
    listeners: number;
    handles?: number;
  };
  after: TelemetryRecord['before'];
}

export interface RuntimeBudgetTelemetryRecord extends RuntimeBudgetUsageEvidenceV2 {
  version: 2;
  kind: 'runtime_budget_usage';
  pid: number;
  sequence: number;
  iteration: number;
  caseId: string;
  lifecycleId: string;
  processStartNonce: string;
  osProcessStartIdentity?: string;
  lifecycleGroupNonce: string;
}

interface FaultSoakTelemetry {
  resources: TelemetryRecord[];
  runtimeBudgets: RuntimeBudgetTelemetryRecord[];
}

function readTelemetry(file: string): FaultSoakTelemetry {
  try {
    const source = readFileSync(file, 'utf8');
    const records = source
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TelemetryRecord | RuntimeBudgetTelemetryRecord)
      .filter((record) => record.version === 2);
    return {
      resources: records.filter(
        (record): record is TelemetryRecord => record.kind === 'process_resource',
      ),
      runtimeBudgets: records.filter(
        (record): record is RuntimeBudgetTelemetryRecord => record.kind === 'runtime_budget_usage',
      ),
    };
  } catch {
    return { resources: [], runtimeBudgets: [] };
  } finally {
    try {
      unlinkSync(file);
    } catch {
      // A failed process may not produce telemetry.
    }
  }
}

export function runtimeBudgetUsage(
  records: readonly RuntimeBudgetTelemetryRecord[],
  resourceRecords: readonly TelemetryRecord[],
  caseId: RuntimeFaultSoakCaseId,
  attemptNonce: string,
  iteration: number,
  expectedSamples: number,
): OptionalMetric<readonly RuntimeBudgetUsageEvidenceV2[]> {
  const candidates = records.filter(
    (record) =>
      record.caseId === caseId &&
      record.iteration === iteration &&
      record.lifecycleId === 'fault-soak-runtime-budget.test.ts' &&
      record.source === 'actual_runtime_ledger',
  );
  if (
    candidates.some(
      (record) =>
        record.processStartNonce !== `${attemptNonce}:${record.pid}` ||
        !record.osProcessStartIdentity ||
        record.lifecycleGroupNonce === 'unbound',
    )
  ) {
    return unsupported('Runtime budget telemetry contained an unbound or wrong-attempt receipt');
  }
  const selected = candidates;
  if (
    selected.some(
      (receipt) =>
        !resourceRecords.some(
          (resource) =>
            resource.caseId === receipt.caseId &&
            resource.lifecycleId === receipt.lifecycleId &&
            resource.pid === receipt.pid &&
            resource.sequence === receipt.sequence &&
            resource.processStartNonce === receipt.processStartNonce &&
            resource.osProcessStartIdentity === receipt.osProcessStartIdentity &&
            resource.lifecycleGroupNonce === receipt.lifecycleGroupNonce,
        ),
    )
  ) {
    return unsupported('Runtime budget receipt did not match its process resource lifecycle');
  }
  const groups = new Set(
    selected.map(
      (record) => `${record.pid}:${record.processStartNonce}:${record.lifecycleGroupNonce}`,
    ),
  );
  const sequences = selected.map((record) => record.sequence).sort((left, right) => left - right);
  const complete =
    selected.length === expectedSamples &&
    groups.size === 1 &&
    sequences.every((sequence, index) => sequence === index + 1);
  const evidence = selected.map(
    ({
      source,
      reconciled,
      committed,
      ceilings,
      reservationStates,
      pid,
      sequence,
      processStartNonce,
      osProcessStartIdentity,
      lifecycleGroupNonce,
    }) => ({
      source,
      reconciled,
      committed,
      ceilings,
      reservationStates,
      provenance: {
        caseId,
        iteration,
        lifecycleId: 'fault-soak-runtime-budget.test.ts',
        pid,
        sequence,
        processStartNonce,
        osProcessStartIdentity: osProcessStartIdentity!,
        lifecycleGroupNonce,
      },
    }),
  );
  return complete
    ? { supported: true, value: evidence }
    : unsupported(
        `probe published an incomplete bound Runtime budget ledger group (${selected.length}/${expectedSamples} receipts, ${groups.size} groups)`,
      );
}

function telemetryPair(
  records: readonly TelemetryRecord[],
  key: keyof TelemetryRecord['before'],
): OptionalMetric<RuntimeFaultSoakMetricEvidenceV2> {
  const first = records[0]?.before[key];
  const last = records.at(-1)?.after[key];
  return typeof first === 'number' && typeof last === 'number'
    ? {
        supported: true,
        value: { kind: 'fresh_process_diagnostic', before: first, after: last },
      }
    : unsupported('child process did not publish this telemetry metric');
}

interface QualificationTelemetryOptions {
  caseId: RuntimeFaultSoakCaseId;
  repeatCount: number;
  expectedLifecycleIds: ReadonlySet<string>;
  prewarmLifecycleIds?: ReadonlySet<string>;
  attemptNonce: string;
}

/**
 * Converts file reruns into a post-warmup same-process sample. Each group of
 * repeatCount records is one test file executed repeatedly in one PID. The
 * first accepted run warms module/JIT/fixture state; only the remaining eight
 * runs contribute lifecycle points. A declared prewarm lifecycle executes one
 * additional allocator/JIT preconditioning run before that retained warm-up.
 * Every file group is retained so a stable file cannot mask a leaking sibling.
 */
export function qualificationTelemetryMetric(
  records: readonly TelemetryRecord[],
  key: keyof TelemetryRecord['before'],
  options: QualificationTelemetryOptions,
): OptionalMetric<RuntimeFaultSoakMetricEvidenceV2> {
  if (!Number.isInteger(options.repeatCount) || options.repeatCount < 9) {
    return unsupported('qualification requires one warm-up and eight measured reruns');
  }
  const selected = records.filter(
    (record) =>
      record.caseId === options.caseId && options.expectedLifecycleIds.has(record.lifecycleId),
  );
  if (selected.length === 0) {
    return unsupported('no matching same-process lifecycle telemetry was published');
  }
  if (
    selected.some(
      (record) =>
        record.processStartNonce !== `${options.attemptNonce}:${record.pid}` ||
        !record.osProcessStartIdentity ||
        record.lifecycleGroupNonce === 'unbound',
    )
  ) {
    return unsupported('same-process lifecycle telemetry was not bound to this probe attempt');
  }
  const groups = new Map<string, TelemetryRecord[]>();
  for (const record of selected) {
    const groupKey = `${record.pid}:${record.processStartNonce}:${record.lifecycleGroupNonce}:${record.lifecycleId}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), record]);
  }
  const groupsByLifecycle = new Map<string, number>();
  for (const group of groups.values()) {
    const lifecycleId = group[0]?.lifecycleId;
    if (lifecycleId)
      groupsByLifecycle.set(lifecycleId, (groupsByLifecycle.get(lifecycleId) ?? 0) + 1);
  }
  for (const lifecycleId of options.expectedLifecycleIds) {
    if (groupsByLifecycle.get(lifecycleId) !== 1) {
      return unsupported(`expected exactly one complete lifecycle group for ${lifecycleId}`);
    }
  }
  const series: Extract<
    RuntimeFaultSoakMetricEvidenceV2,
    { kind: 'same_process_lifecycle' }
  >['series'][number][] = [];
  for (const group of groups.values()) {
    group.sort((left, right) => left.sequence - right.sequence);
    const lifecycleId = group[0]?.lifecycleId;
    const prewarmRuns = lifecycleId && options.prewarmLifecycleIds?.has(lifecycleId) ? 1 : 0;
    const actualRepeatCount = options.repeatCount + prewarmRuns;
    if (group.length % actualRepeatCount !== 0) {
      return unsupported('same-process lifecycle telemetry ended with an incomplete rerun group');
    }
    for (let offset = 0; offset < group.length; offset += actualRepeatCount) {
      const chunk = group.slice(offset, offset + actualRepeatCount);
      const first = chunk[0];
      const last = chunk.at(-1);
      if (
        !first ||
        !last ||
        last.sequence - first.sequence !== actualRepeatCount - 1 ||
        chunk.some(
          (record) =>
            record.pid !== first.pid ||
            record.processStartNonce !== first.processStartNonce ||
            record.osProcessStartIdentity !== first.osProcessStartIdentity ||
            record.lifecycleGroupNonce !== first.lifecycleGroupNonce ||
            record.lifecycleId !== first.lifecycleId ||
            record.caseId !== first.caseId,
        )
      ) {
        return unsupported('same-process lifecycle telemetry sequence was discontinuous');
      }
      const accepted = chunk.slice(prewarmRuns);
      const retainedWarmup = accepted[0];
      if (!retainedWarmup || accepted.length !== options.repeatCount) {
        return unsupported('same-process lifecycle did not retain one warm-up and eight reruns');
      }
      const values = accepted.map((record) => ({
        before: record.before[key],
        after: record.after[key],
      }));
      if (
        values.some((value) => typeof value.before !== 'number' || typeof value.after !== 'number')
      ) {
        return unsupported('same-process lifecycle did not publish this telemetry metric');
      }
      const point = (record: TelemetryRecord, sequence: number) => ({
        sequence,
        before: record.before[key] as number,
        after: record.after[key] as number,
        durationMs: record.durationMs,
        deadlineMs: record.deadlineMs,
        cleanupConfirmed:
          record.cleanup.confirmed &&
          record.cleanup.descendantInspectionSupported &&
          record.cleanup.descendantPidsAfter.length === 0,
      });
      series.push({
        process: {
          pid: retainedWarmup.pid,
          startNonce: retainedWarmup.processStartNonce,
          osProcessStartIdentity: retainedWarmup.osProcessStartIdentity!,
          lifecycleId: retainedWarmup.lifecycleId,
          lifecycleGroupNonce: retainedWarmup.lifecycleGroupNonce,
        },
        warmup: point(retainedWarmup, 0),
        lifecycles: accepted.slice(1).map((record, index) => point(record, index + 1)),
      });
    }
  }
  if (series.length === 0) {
    return unsupported('no complete post-warmup lifecycle group was published');
  }
  return { supported: true, value: { kind: 'same_process_lifecycle', series } };
}

function descendantPids(rootPid: number): number[] | undefined {
  if (process.platform === 'win32') return undefined;
  let output: string;
  try {
    const listing = spawnSync('ps', ['-Ao', 'pid=,ppid='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: INSPECTION_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    if (listing.status !== 0 || listing.error) return undefined;
    output = listing.stdout;
  } catch {
    return undefined;
  }
  const children = new Map<number, number[]>();
  for (const line of output.split('\n')) {
    const [pidText, parentText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const parent = Number(parentText);
    if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
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
  return descendants;
}

function processGroupPids(groupId: number): number[] | undefined {
  if (process.platform === 'win32') return undefined;
  let output: string;
  try {
    const listing = spawnSync('ps', ['-Ao', 'pid=,pgid='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: INSPECTION_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    if (listing.status !== 0 || listing.error) return undefined;
    output = listing.stdout;
  } catch {
    return undefined;
  }
  return output.split('\n').flatMap((line) => {
    const [pidText, groupText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const group = Number(groupText);
    return Number.isInteger(pid) && group === groupId && pid !== groupId ? [pid] : [];
  });
}

function liveOwnedPids(
  pids: ReadonlySet<number>,
  identities: ReadonlyMap<number, string>,
): { supported: boolean; pids: number[] } {
  let supported = true;
  const live = [...pids].filter((pid) => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    const expectedIdentity = identities.get(pid);
    const currentIdentity = readOsProcessStartIdentity(pid);
    if (!expectedIdentity || !currentIdentity) {
      supported = false;
      return false;
    }
    // A different identity means the numeric PID was reused after the owned
    // child exited. It is neither an orphan nor safe for this runner to kill.
    return expectedIdentity === currentIdentity;
  });
  return { supported, pids: live };
}

function rotatedProbes(seed: number, iteration: number): readonly ProbeDefinition[] {
  const offset = (seed + iteration - 1) % PROBES.length;
  return [...PROBES.slice(offset), ...PROBES.slice(0, offset)];
}

function expectedQualificationLifecycleIds(definition: ProbeDefinition): ReadonlySet<string> {
  return new Set(RUNTIME_FAULT_SOAK_QUALIFICATION_LIFECYCLE_IDS[definition.id]);
}

async function runProbe(
  definition: ProbeDefinition,
  iteration: number,
  options: RunnerOptions,
  root: string,
  processTimeoutMs: number,
): Promise<RuntimeFaultSoakAttemptV2> {
  const probeRoot = join(root, `${String(iteration).padStart(3, '0')}-${definition.id}`);
  const telemetryFile = join(probeRoot, 'child-telemetry.jsonl');
  const worktreesBefore = registeredWorktrees();
  mkdirSync(probeRoot, { recursive: true });
  const startedAt = performance.now();
  const args = buildFaultSoakProbeArgs(
    definition.args,
    options.profile,
    definition.qualificationLifecycleFiles,
    definition.qualificationPrewarmFiles,
  );
  const attemptNonce = randomUUID();
  const proc = Bun.spawn([process.execPath, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TMPDIR: probeRoot,
      TMP: probeRoot,
      TEMP: probeRoot,
      KITE_FAULT_SOAK_CASE_ID: definition.id,
      KITE_FAULT_SOAK_ITERATION: String(iteration),
      KITE_FAULT_SOAK_SEED: String(options.seed),
      KITE_FAULT_SOAK_TELEMETRY_FILE: telemetryFile,
      KITE_FAULT_SOAK_TELEMETRY_PRELOAD: telemetryPreload,
      KITE_FAULT_SOAK_REPEAT_COUNT: String(
        options.profile === 'qualification' ? QUALIFICATION_REPEAT_COUNT : 1,
      ),
      KITE_FAULT_SOAK_PROCESS_NONCE: attemptNonce,
      KITE_FAULT_SOAK_LIFECYCLE_DEADLINE_MS: String(processTimeoutMs),
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: process.platform !== 'win32',
  });
  const captureAbort = new AbortController();
  const stdout = captureBounded(proc.stdout, captureAbort.signal);
  const stderr = captureBounded(proc.stderr, captureAbort.signal);
  const ownedPids = new Set<number>();
  const ownedPidIdentities = new Map<number, string>();
  let pidTrackingSupported = process.platform !== 'win32';
  const sampleOwnedPids = (): void => {
    const descendants = descendantPids(proc.pid);
    const groupMembers = processGroupPids(proc.pid);
    if (descendants === undefined || groupMembers === undefined) {
      pidTrackingSupported = false;
      return;
    }
    for (const pid of [...descendants, ...groupMembers]) {
      ownedPids.add(pid);
      const identity = readOsProcessStartIdentity(pid);
      if (identity) ownedPidIdentities.set(pid, identity);
    }
  };
  sampleOwnedPids();
  const pidMonitor = setInterval(sampleOwnedPids, 50);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timed_out'>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout('timed_out'), processTimeoutMs);
  });
  const outcome = await Promise.race([proc.exited, timeout]);
  if (timer) clearTimeout(timer);
  clearInterval(pidMonitor);
  if (outcome === 'timed_out') {
    sampleOwnedPids();
    terminateFaultSoakProcessTree(proc, ownedPidIdentities);
    await Promise.race([
      proc.exited.catch(() => undefined),
      Bun.sleep(PROCESS_REAP_TIMEOUT_MS).then(() => undefined),
    ]);
  }
  sampleOwnedPids();
  const drainTimer = setTimeout(() => captureAbort.abort(), CAPTURE_DRAIN_TIMEOUT_MS);
  const [capturedStdout, capturedStderr] = await Promise.all([stdout, stderr]);
  clearTimeout(drainTimer);
  const telemetry = readTelemetry(telemetryFile);
  for (const record of telemetry.resources) {
    if (record.processStartNonce === `${attemptNonce}:${record.pid}`) {
      ownedPids.add(record.pid);
      if (record.osProcessStartIdentity) {
        ownedPidIdentities.set(record.pid, record.osProcessStartIdentity);
      }
    }
  }
  await Bun.sleep(100);
  const liveOwned = liveOwnedPids(ownedPids, ownedPidIdentities);
  if (!liveOwned.supported) pidTrackingSupported = false;
  const orphanPids = pidTrackingSupported ? liveOwned.pids : undefined;
  for (const pid of orphanPids ?? []) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The observed orphan may exit before cleanup.
    }
  }
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  const leftovers = residualEntries(probeRoot);
  const worktreesAfter = registeredWorktrees();
  const orphanWorktrees =
    worktreesBefore && worktreesAfter
      ? {
          supported: true as const,
          value: [...worktreesAfter]
            .filter((path) => !worktreesBefore.has(path))
            .map((path) => relative(process.cwd(), path))
            .sort(),
        }
      : unsupported<readonly string[]>('Git worktree inspection is unsupported on this platform');
  rmSync(probeRoot, { recursive: true, force: true });
  const status = outcome === 'timed_out' ? 'timed_out' : outcome === 0 ? 'passed' : 'failed';
  if (status !== 'passed') {
    const diagnostic = (capturedStderr || capturedStdout).trim().slice(-2000);
    console.error(`[fault-soak] ${definition.id} ${status}${diagnostic ? `\n${diagnostic}` : ''}`);
  }
  const tuiTelemetryReason =
    'TUI CI smoke uses multiple child processes; qualification requires its repeated mount/unmount harness';
  const metric = (key: keyof TelemetryRecord['before']) => {
    if (options.profile === 'qualification') {
      return qualificationTelemetryMetric(telemetry.resources, key, {
        caseId: definition.id,
        repeatCount: QUALIFICATION_REPEAT_COUNT,
        expectedLifecycleIds: expectedQualificationLifecycleIds(definition),
        prewarmLifecycleIds: new Set(
          (definition.qualificationPrewarmFiles ?? []).map((file) => basename(file)),
        ),
        attemptNonce,
      });
    }
    return definition.id === 'tui_lifecycle_churn'
      ? unsupported<RuntimeFaultSoakMetricEvidenceV2>(tuiTelemetryReason)
      : telemetryPair(telemetry.resources, key);
  };
  const terminalTaxonomyAssertions = Object.fromEntries(
    Object.entries(definition.terminalEvidence).flatMap(([reason, pattern]) =>
      pattern.test(`${capturedStdout}\n${capturedStderr}`) ? [[reason, 1]] : [],
    ),
  );
  const stateInvariantAssertions = definition.invariantEvidence.test(
    `${capturedStdout}\n${capturedStderr}`,
  )
    ? 1
    : 0;
  return {
    caseId: definition.id,
    iteration,
    status,
    durationMs,
    failureCode:
      status === 'timed_out'
        ? 'probe_timeout'
        : status === 'failed'
          ? `probe_exit_${String(outcome)}`
          : undefined,
    stateInvariantAssertions: status === 'passed' ? stateInvariantAssertions : 0,
    terminalTaxonomyAssertions: status === 'passed' ? terminalTaxonomyAssertions : {},
    runtimeBudgetUsage:
      status === 'passed' && definition.id === 'long_runtime_replay'
        ? runtimeBudgetUsage(
            telemetry.runtimeBudgets,
            telemetry.resources,
            definition.id,
            attemptNonce,
            iteration,
            options.profile === 'qualification' ? QUALIFICATION_REPEAT_COUNT : 1,
          )
        : status === 'passed'
          ? unsupported('this case does not execute the Runtime budget qualification workload')
          : unsupported('failed probe cannot provide accepted Runtime budget usage'),
    cleanup: {
      confirmed:
        leftovers.length === 0 &&
        (!orphanWorktrees.supported || orphanWorktrees.value.length === 0) &&
        (orphanPids?.length ?? 0) === 0,
      orphanPids:
        orphanPids === undefined
          ? unsupported('owned descendant PID tracking is unsupported on this platform')
          : { supported: true, value: orphanPids },
      orphanWorktrees,
      residualPaths: leftovers,
    },
    resources: {
      rssBytes: metric('rssBytes'),
      activeResources: metric('activeResources'),
      fileDescriptors: metric('fileDescriptors'),
      listeners: metric('listeners'),
      handles: metric('handles'),
    },
  };
}

function failedRunnerAttempt(
  definition: ProbeDefinition,
  iteration: number,
  failureCode: 'global_deadline_exhausted' | 'runner_exception',
): RuntimeFaultSoakAttemptV2 {
  const reason = `runner did not execute accepted evidence: ${failureCode}`;
  return {
    caseId: definition.id,
    iteration,
    status: 'timed_out',
    durationMs: 0,
    failureCode,
    stateInvariantAssertions: 0,
    terminalTaxonomyAssertions: {},
    runtimeBudgetUsage: unsupported(reason),
    cleanup: {
      confirmed: false,
      orphanPids: unsupported(reason),
      orphanWorktrees: unsupported(reason),
      residualPaths: [],
    },
    resources: {
      rssBytes: unsupported(reason),
      activeResources: unsupported(reason),
      fileDescriptors: unsupported(reason),
      listeners: unsupported(reason),
      handles: unsupported(reason),
    },
  };
}

export async function runRuntimeFaultSoak(
  options: RunnerOptions,
): Promise<ReturnType<typeof buildRuntimeFaultSoakReport>> {
  const root = mkdtempSync(join(tmpdir(), 'kite-runtime-fault-soak-'));
  const startedAt = new Date().toISOString();
  const hardDeadlineAt = Date.now() + options.iterations * PROBES.length * options.perCaseTimeoutMs;
  const attempts: RuntimeFaultSoakAttemptV2[] = [];
  try {
    for (let iteration = 1; iteration <= options.iterations; iteration++) {
      for (const definition of rotatedProbes(options.seed, iteration)) {
        console.log(
          `[fault-soak] iteration=${iteration}/${options.iterations} case=${definition.id}`,
        );
        const remainingMs = hardDeadlineAt - Date.now();
        const processTimeoutMs = boundedFaultSoakProbeTimeoutMs(
          options.perCaseTimeoutMs,
          remainingMs,
        );
        if (processTimeoutMs === undefined) {
          attempts.push(failedRunnerAttempt(definition, iteration, 'global_deadline_exhausted'));
          continue;
        }
        try {
          attempts.push(await runProbe(definition, iteration, options, root, processTimeoutMs));
        } catch (error) {
          console.error(
            `[fault-soak] ${definition.id} runner exception: ${error instanceof Error ? error.message : String(error)}`,
          );
          attempts.push(failedRunnerAttempt(definition, iteration, 'runner_exception'));
        }
      }
    }
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // The report will still fail closed if an attempt could not confirm cleanup.
    }
  }
  const finishedAt = new Date().toISOString();
  return buildRuntimeFaultSoakReport({
    runnerRevision: RUNTIME_FAULT_SOAK_RUNNER_REVISION,
    seed: options.seed,
    profile: options.profile,
    iterations: options.iterations,
    perCaseTimeoutMs: options.perCaseTimeoutMs,
    startedAt,
    finishedAt,
    environment: {
      platform: process.platform,
      arch: process.arch,
      bunVersion: Bun.version,
    },
    source: options.source,
    attempts,
  });
}

if (import.meta.main) {
  const options = parseRuntimeFaultSoakOptions(process.argv.slice(2));
  const report = await runRuntimeFaultSoak(options);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    const output = resolve(options.output);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, serialized, { mode: 0o600 });
    chmodSync(output, 0o600);
    console.log(`[fault-soak] report written: ${output}`);
  } else {
    process.stdout.write(serialized);
  }
  if (report.status === 'failed') process.exit(1);
  if (report.status === 'inconclusive') process.exit(2);
}
