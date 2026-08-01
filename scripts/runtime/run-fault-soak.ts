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
import { dirname, join, relative, resolve } from 'node:path';
import {
  buildRuntimeFaultSoakReport,
  type OptionalMetric,
  type RuntimeFaultSoakAttemptV1,
  type RuntimeFaultSoakCaseId,
  type RuntimeFaultSoakProfile,
} from './fault-soak-report';

const RUNNER_REVISION = 'runtime-fault-soak-v1';
const MAX_CAPTURED_OUTPUT_BYTES = 256 * 1024;
const CAPTURE_DRAIN_TIMEOUT_MS = 2_000;
const telemetryPreload = resolve(
  process.cwd(),
  'tests/runtime/harness/fault-soak-telemetry-preload.ts',
);

interface ProbeDefinition {
  id: RuntimeFaultSoakCaseId;
  args: readonly string[];
  terminalEvidence: Readonly<Record<string, RegExp>>;
}

const PROBES: readonly ProbeDefinition[] = [
  {
    id: 'long_runtime_replay',
    args: [
      'test',
      'tests/runtime/stability.test.ts',
      'tests/runtime/agent.integration.test.ts',
      'tests/runtime/context-compaction.test.ts',
    ],
    terminalEvidence: {
      completed: /\(pass\).*replays a long deterministic event stream without violating invariants/,
    },
  },
  {
    id: 'subagent_cancel_recovery',
    args: ['test', 'tests/runtime/cancel-resume.test.ts', 'tests/subagent-runner.test.ts'],
    terminalEvidence: {
      cancelled:
        /\(pass\).*restores cancelled waiters, unknown dispatches, and cancel-incomplete terminal facts/,
      reconciliation_required:
        /\(pass\).*persists a structured unknown terminal when recovery is blocked/,
    },
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
    terminalEvidence: {
      model_retry_exhausted:
        /\(pass\).*model_rate_limit admits exactly one retry only while the bounded retry budget remains/,
      deadline_exceeded:
        /\(pass\).*wakes a pending interaction wait and emits one deadline terminal/,
    },
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
    terminalEvidence: {
      mcp_unavailable: /\(pass\).*degrades a real stdio provider that exits during an invocation/,
      reconciliation_required:
        /\(pass\).*required MCP revision drift preserves unknown evidence and requires reconciliation/,
    },
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
    terminalEvidence: {
      reconciliation_required:
        /\(pass\).*never continues or degrades while prior external effects remain unknown/,
    },
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
    terminalEvidence: {
      persistence_unavailable:
        /\(pass\).*disk_full propagates known external-effect evidence instead of inventing none/,
      completed: /\(pass\).*writer construction failure reports once and does not stop the Runtime/,
    },
  },
  {
    id: 'tui_lifecycle_churn',
    args: [
      'run',
      'scripts/run-tui-system-tests.ts',
      'session-switch',
      'tool-lifecycle',
      'model-stream-reconnect',
    ],
    terminalEvidence: {
      completed: /\(pass\).*keeps partial text and commits only the recovered tool lifecycle/,
      cancelled:
        /\(pass\).*full lifecycle: interrupt .* deny .* current turn stops without model continuation/,
    },
  },
];

interface RunnerOptions {
  profile: RuntimeFaultSoakProfile;
  iterations: number;
  seed: number;
  perCaseTimeoutMs: number;
  output?: string;
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
  };
}

function unsupported<T>(reason: string): OptionalMetric<T> {
  return { supported: false, reason };
}

function terminateProcessTree(proc: ReturnType<typeof Bun.spawn>): void {
  if (process.platform === 'win32') {
    Bun.spawnSync(['taskkill.exe', '/pid', String(proc.pid), '/t', '/f'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    return;
  }
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    // A detached process group may already be gone or unavailable.
  }
  let listing = '';
  try {
    listing = Bun.spawnSync(['ps', '-Ao', 'pid=,ppid='], {
      stdout: 'pipe',
      stderr: 'ignore',
    }).stdout.toString();
  } catch {
    listing = '';
  }
  const children = new Map<number, number[]>();
  for (const line of listing.split('\n')) {
    const [pidText, parentText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const parent = Number(parentText);
    if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const descendants: number[] = [];
  const visit = (parent: number): void => {
    for (const child of children.get(parent) ?? []) {
      visit(child);
      descendants.push(child);
    }
  };
  visit(proc.pid);
  for (const pid of descendants) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The process may exit between discovery and termination.
    }
  }
  try {
    proc.kill('SIGKILL');
  } catch {
    // The process-group signal may already have reaped the leader.
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
    const result = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'ignore',
    });
    if (result.exitCode !== 0) return undefined;
    return new Set(
      result.stdout
        .toString()
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

interface TelemetryRecord {
  version: 1;
  before: {
    rssBytes: number;
    activeResources: number;
    fileDescriptors?: number;
    listeners: number;
    handles?: number;
  };
  after: TelemetryRecord['before'];
}

function readTelemetry(file: string): TelemetryRecord[] {
  try {
    const source = readFileSync(file, 'utf8');
    return source
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TelemetryRecord)
      .filter((record) => record.version === 1);
  } catch {
    return [];
  } finally {
    try {
      unlinkSync(file);
    } catch {
      // A failed process may not produce telemetry.
    }
  }
}

function telemetryPair(
  records: readonly TelemetryRecord[],
  key: keyof TelemetryRecord['before'],
): OptionalMetric<{ before: number; after: number }> {
  const first = records[0]?.before[key];
  const last = records.at(-1)?.after[key];
  return typeof first === 'number' && typeof last === 'number'
    ? {
        supported: true,
        value: { before: first, after: last },
        qualificationEligible: false,
      }
    : unsupported('child process did not publish this telemetry metric');
}

function descendantPids(rootPid: number): number[] | undefined {
  if (process.platform === 'win32') return undefined;
  let output: string;
  try {
    const listing = Bun.spawnSync(['ps', '-Ao', 'pid=,ppid='], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    if (listing.exitCode !== 0) return undefined;
    output = listing.stdout.toString();
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
    const listing = Bun.spawnSync(['ps', '-Ao', 'pid=,pgid='], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    if (listing.exitCode !== 0) return undefined;
    output = listing.stdout.toString();
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

function livePids(pids: ReadonlySet<number>): number[] {
  return [...pids].filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}

function rotatedProbes(seed: number, iteration: number): readonly ProbeDefinition[] {
  const offset = (seed + iteration - 1) % PROBES.length;
  return [...PROBES.slice(offset), ...PROBES.slice(0, offset)];
}

async function runProbe(
  definition: ProbeDefinition,
  iteration: number,
  options: RunnerOptions,
  root: string,
): Promise<RuntimeFaultSoakAttemptV1> {
  const probeRoot = join(root, `${String(iteration).padStart(3, '0')}-${definition.id}`);
  const telemetryFile = join(probeRoot, 'child-telemetry.jsonl');
  const worktreesBefore = registeredWorktrees();
  mkdirSync(probeRoot, { recursive: true });
  const startedAt = performance.now();
  const args =
    definition.args[0] === 'test'
      ? [
          'test',
          '--preload',
          telemetryPreload,
          ...definition.args.slice(1),
          '--seed',
          String(options.seed + iteration),
        ]
      : [...definition.args];
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
  let pidTrackingSupported = process.platform !== 'win32';
  const sampleOwnedPids = (): void => {
    const descendants = descendantPids(proc.pid);
    const groupMembers = processGroupPids(proc.pid);
    if (descendants === undefined || groupMembers === undefined) {
      pidTrackingSupported = false;
      return;
    }
    for (const pid of [...descendants, ...groupMembers]) ownedPids.add(pid);
  };
  sampleOwnedPids();
  const pidMonitor = setInterval(sampleOwnedPids, 50);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timed_out'>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout('timed_out'), options.perCaseTimeoutMs);
  });
  const outcome = await Promise.race([proc.exited, timeout]);
  if (timer) clearTimeout(timer);
  clearInterval(pidMonitor);
  if (outcome === 'timed_out') {
    terminateProcessTree(proc);
    await proc.exited.catch(() => {});
  }
  sampleOwnedPids();
  const drainTimer = setTimeout(() => captureAbort.abort(), CAPTURE_DRAIN_TIMEOUT_MS);
  const [capturedStdout, capturedStderr] = await Promise.all([stdout, stderr]);
  clearTimeout(drainTimer);
  await Bun.sleep(100);
  const orphanPids = pidTrackingSupported ? livePids(ownedPids) : undefined;
  for (const pid of orphanPids ?? []) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The observed orphan may exit before cleanup.
    }
  }
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  const telemetry = readTelemetry(telemetryFile);
  const leftovers = residualEntries(probeRoot);
  const worktreesAfter = registeredWorktrees();
  const orphanWorktrees =
    worktreesBefore && worktreesAfter
      ? [...worktreesAfter]
          .filter((path) => !worktreesBefore.has(path))
          .map((path) => relative(process.cwd(), path))
          .sort()
      : ['<git-worktree-inspection-unsupported>'];
  rmSync(probeRoot, { recursive: true, force: true });
  const status = outcome === 'timed_out' ? 'timed_out' : outcome === 0 ? 'passed' : 'failed';
  if (status !== 'passed') {
    const diagnostic = (capturedStderr || capturedStdout).trim().slice(-2000);
    console.error(`[fault-soak] ${definition.id} ${status}${diagnostic ? `\n${diagnostic}` : ''}`);
  }
  const tuiTelemetryReason =
    'TUI lifecycle probe uses multiple child processes; same-process lifecycle telemetry is required';
  const metric = (key: keyof TelemetryRecord['before']) =>
    definition.id === 'tui_lifecycle_churn'
      ? unsupported<{ before: number; after: number }>(tuiTelemetryReason)
      : telemetryPair(telemetry, key);
  const terminalTaxonomyAssertions = Object.fromEntries(
    Object.entries(definition.terminalEvidence).flatMap(([reason, pattern]) =>
      pattern.test(`${capturedStdout}\n${capturedStderr}`) ? [[reason, 1]] : [],
    ),
  );
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
    invariantsPassed: status === 'passed',
    terminalTaxonomyAssertions: status === 'passed' ? terminalTaxonomyAssertions : {},
    cleanup: {
      confirmed:
        leftovers.length === 0 && orphanWorktrees.length === 0 && (orphanPids?.length ?? 0) === 0,
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

export async function runRuntimeFaultSoak(
  options: RunnerOptions,
): Promise<ReturnType<typeof buildRuntimeFaultSoakReport>> {
  const root = mkdtempSync(join(tmpdir(), 'kite-runtime-fault-soak-'));
  const startedAt = new Date().toISOString();
  const attempts: RuntimeFaultSoakAttemptV1[] = [];
  try {
    for (let iteration = 1; iteration <= options.iterations; iteration++) {
      for (const definition of rotatedProbes(options.seed, iteration)) {
        console.log(
          `[fault-soak] iteration=${iteration}/${options.iterations} case=${definition.id}`,
        );
        attempts.push(await runProbe(definition, iteration, options, root));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const finishedAt = new Date().toISOString();
  return buildRuntimeFaultSoakReport({
    runnerRevision: RUNNER_REVISION,
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
