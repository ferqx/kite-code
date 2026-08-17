import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildCgroupPidsInvocationV1,
  type CgroupPidsRunnerV1,
} from '../../src/core/execution/sandbox-execution/cgroup-pids-contract';
import {
  buildCgroupPidsKillInvocationV1,
  cgroupPidsUnitFromArgvV1,
  isCgroupPidsPathV1,
  isCgroupPidsUnitNameV1,
  LINUX_CGROUP_SCOPE_CANDIDATE_SCHEMA_V1,
  parseCgroupPidsEmptyV1,
  parseCgroupPidsPopulatedV1,
  parseLinuxCgroupScopeIdentityV1,
} from '../../src/core/execution/sandbox-execution/linux-cgroup-scope';
import { canonicalJsonBytes, sha256DomainSeparated } from '../release/canonical-json';

/**
 * This is deliberately an evaluation-only artifact. It is not a platform
 * capability evidence schema and must never be consumed by production Core.
 */
export const LINUX_CGROUP_DESCENDANT_CLEANUP_SCHEMA_V1 =
  'kite.eval.linux-cgroup-descendant-cleanup.v1' as const;
export const LINUX_CGROUP_DESCENDANT_CLEANUP_ARTIFACT_CLASS_V1 = 'candidate_only' as const;

export type LinuxCgroupDescendantCleanupStatusV1 = 'passed' | 'unavailable' | 'unsupported';

export type LinuxCgroupDescendantCleanupReasonV1 =
  | 'none'
  | 'native_opt_in_required'
  | 'non_linux'
  | 'cgroup_v2_unavailable'
  | 'cgroup_pids_controller_unavailable'
  | 'systemd_run_unavailable'
  | 'systemctl_unavailable'
  | 'user_systemd_unavailable'
  | 'fixture_interpreter_unavailable'
  | 'invalid_max_tasks'
  | 'scope_start_failed'
  | 'scope_identity_mismatch'
  | 'scope_disappeared_before_empty'
  | 'tasks_max_failed'
  | 'descendant_ownership_failed'
  | 'kill_all_failed'
  | 'scope_disposal_unconfirmed'
  | 'cleanup_evidence_unavailable'
  | 'probe_internal_failure';

export interface LinuxCgroupDescendantCleanupChecksV1 {
  readonly exactRuntimeOwnedUnit: boolean;
  readonly controlGroupExact: boolean;
  readonly tasksMax: boolean;
  readonly forkEagain: boolean;
  readonly descendantOwnership: boolean;
  readonly exactKillAll: boolean;
  readonly populatedZeroBeforePathDisappearance: boolean;
  readonly emptyCgroupProcsBeforePathDisappearance: boolean;
}

type MutableLinuxCgroupDescendantCleanupChecksV1 = {
  -readonly [Key in keyof LinuxCgroupDescendantCleanupChecksV1]: LinuxCgroupDescendantCleanupChecksV1[Key];
};

export interface LinuxCgroupDescendantCleanupReportV1 {
  readonly schema: typeof LINUX_CGROUP_DESCENDANT_CLEANUP_SCHEMA_V1;
  readonly artifactClass: typeof LINUX_CGROUP_DESCENDANT_CLEANUP_ARTIFACT_CLASS_V1;
  readonly evaluationOnly: true;
  readonly productionEvidence: false;
  readonly productionSupported: false;
  readonly platform: NodeJS.Platform;
  readonly nativeOptIn: boolean;
  readonly status: LinuxCgroupDescendantCleanupStatusV1;
  readonly reason: LinuxCgroupDescendantCleanupReasonV1;
  readonly checks: LinuxCgroupDescendantCleanupChecksV1;
  readonly digest: `sha256:${string}`;
}

export interface LinuxCgroupCleanupCommandResultV1 {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LinuxCgroupCleanupChildV1 {
  readonly pid: number;
  readonly wait: () => Promise<number>;
  readonly kill: (signal?: 'SIGKILL' | 'SIGTERM') => void;
}

export interface LinuxCgroupCleanupHostV1 {
  readonly platform: NodeJS.Platform;
  readonly findExecutable: (name: string) => string | undefined;
  readonly pathExists: (path: string) => boolean;
  readonly readText: (path: string) => string;
  readonly run: (argv: readonly string[]) => Promise<LinuxCgroupCleanupCommandResultV1>;
  readonly spawn: (argv: readonly string[]) => LinuxCgroupCleanupChildV1;
  /** Optional override used by deterministic unit fakes. */
  readonly checkUserSystemd?: (systemctlExecutable: string) => Promise<boolean>;
  /** Optional filesystem hooks used by deterministic unit fakes. */
  readonly createTempDirectory?: () => string;
  readonly writeText?: (path: string, contents: string) => void;
  readonly removePath?: (path: string) => void;
}

export interface RunLinuxCgroupDescendantCleanupInputV1 {
  /** Must be true; no scope is allocated otherwise. */
  readonly nativeOptIn?: boolean;
  readonly host?: LinuxCgroupCleanupHostV1;
  readonly identity?: string;
  readonly maxTasks?: number;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

const DEFAULT_MAX_TASKS = 16;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 10;
const NATIVE_COMMAND_TIMEOUT_MS = 2_000;
const NATIVE_COMMAND_OUTPUT_LIMIT_BYTES = 64 * 1024;
const CGROUP_ROOT = '/sys/fs/cgroup';
const FIXTURE_FACT_KEYS = [
  'descendantCgroupPath',
  'descendantOwned',
  'descendantParentPid',
  'descendantPid',
  'descendantSessionId',
  'forkEagain',
  'pidsMax',
  'ready',
] as const;

const EMPTY_CHECKS: LinuxCgroupDescendantCleanupChecksV1 = Object.freeze({
  exactRuntimeOwnedUnit: false,
  controlGroupExact: false,
  tasksMax: false,
  forkEagain: false,
  descendantOwnership: false,
  exactKillAll: false,
  populatedZeroBeforePathDisappearance: false,
  emptyCgroupProcsBeforePathDisappearance: false,
});

/** Create a fresh low-information check set for a report or a fake. */
export function createLinuxCgroupDescendantCleanupChecksV1(): MutableLinuxCgroupDescendantCleanupChecksV1 {
  return { ...EMPTY_CHECKS };
}

function report(
  input: Pick<LinuxCgroupDescendantCleanupReportV1, 'platform' | 'nativeOptIn'> & {
    readonly status: LinuxCgroupDescendantCleanupStatusV1;
    readonly reason: LinuxCgroupDescendantCleanupReasonV1;
    readonly checks?: LinuxCgroupDescendantCleanupChecksV1;
  },
): LinuxCgroupDescendantCleanupReportV1 {
  const material = {
    schema: LINUX_CGROUP_DESCENDANT_CLEANUP_SCHEMA_V1,
    artifactClass: LINUX_CGROUP_DESCENDANT_CLEANUP_ARTIFACT_CLASS_V1,
    evaluationOnly: true as const,
    productionEvidence: false as const,
    productionSupported: false as const,
    platform: input.platform,
    nativeOptIn: input.nativeOptIn,
    status: input.status,
    reason: input.reason,
    checks: input.checks ?? createLinuxCgroupDescendantCleanupChecksV1(),
  };
  return {
    ...material,
    digest: sha256DomainSeparated(
      'kite.eval.linux-cgroup-descendant-cleanup.v1',
      canonicalJsonBytes(material),
    ),
  };
}

function unavailable(
  platform: NodeJS.Platform,
  nativeOptIn: boolean,
  reason: LinuxCgroupDescendantCleanupReasonV1,
): LinuxCgroupDescendantCleanupReportV1 {
  return report({ platform, nativeOptIn, status: 'unavailable', reason });
}

function unsupported(
  platform: NodeJS.Platform,
  nativeOptIn: boolean,
  reason: LinuxCgroupDescendantCleanupReasonV1,
  checks: LinuxCgroupDescendantCleanupChecksV1,
): LinuxCgroupDescendantCleanupReportV1 {
  return report({ platform, nativeOptIn, status: 'unsupported', reason, checks });
}

function passed(
  platform: NodeJS.Platform,
  nativeOptIn: boolean,
  checks: LinuxCgroupDescendantCleanupChecksV1,
): LinuxCgroupDescendantCleanupReportV1 {
  return report({ platform, nativeOptIn, status: 'passed', reason: 'none', checks });
}

/**
 * Run the candidate-only Linux lifecycle. Native allocation is impossible
 * unless `nativeOptIn` is explicitly true. All platform and lifecycle
 * failures are returned as structured reports rather than thrown.
 */
export async function runLinuxCgroupDescendantCleanupV1(
  input: RunLinuxCgroupDescendantCleanupInputV1 = {},
): Promise<LinuxCgroupDescendantCleanupReportV1> {
  const host = input.host ?? createNativeLinuxCgroupCleanupHostV1();
  try {
    return await runLinuxCgroupDescendantCleanupInternalV1({ ...input, host });
  } catch (error) {
    return unsupported(
      host.platform,
      input.nativeOptIn === true,
      error instanceof Error && error.message === 'kill_all_failed'
        ? 'kill_all_failed'
        : error instanceof Error && error.message === 'scope_disposal_unconfirmed'
          ? 'scope_disposal_unconfirmed'
          : 'probe_internal_failure',
      createLinuxCgroupDescendantCleanupChecksV1(),
    );
  }
}

async function runLinuxCgroupDescendantCleanupInternalV1(
  input: RunLinuxCgroupDescendantCleanupInputV1 = {},
): Promise<LinuxCgroupDescendantCleanupReportV1> {
  const nativeOptIn = input.nativeOptIn === true;
  const host = input.host ?? createNativeLinuxCgroupCleanupHostV1();
  const platform = host.platform;
  if (!nativeOptIn) return unavailable(platform, false, 'native_opt_in_required');
  if (platform !== 'linux') return unavailable(platform, true, 'non_linux');

  const maxTasks = input.maxTasks ?? DEFAULT_MAX_TASKS;
  if (!Number.isSafeInteger(maxTasks) || maxTasks < 2) {
    return unsupported(
      platform,
      true,
      'invalid_max_tasks',
      createLinuxCgroupDescendantCleanupChecksV1(),
    );
  }
  const timeoutMs = boundedPositiveInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS);
  const pollIntervalMs = boundedPositiveInteger(input.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);

  const cgroupControllersPath = `${CGROUP_ROOT}/cgroup.controllers`;
  if (!host.pathExists(cgroupControllersPath)) {
    return unavailable(platform, true, 'cgroup_v2_unavailable');
  }
  let controllers: string;
  try {
    controllers = host.readText(cgroupControllersPath);
  } catch {
    return unavailable(platform, true, 'cgroup_v2_unavailable');
  }
  if (!new Set(controllers.trim().split(/\s+/u).filter(Boolean)).has('pids')) {
    return unavailable(platform, true, 'cgroup_pids_controller_unavailable');
  }

  const runnerExecutable = host.findExecutable('systemd-run');
  if (!runnerExecutable) return unavailable(platform, true, 'systemd_run_unavailable');
  const systemctlExecutable = host.findExecutable('systemctl');
  if (!systemctlExecutable) return unavailable(platform, true, 'systemctl_unavailable');
  const pythonExecutable = host.findExecutable('python3');
  if (!pythonExecutable) return unavailable(platform, true, 'fixture_interpreter_unavailable');

  try {
    const userSystemdAvailable = host.checkUserSystemd
      ? await host.checkUserSystemd(systemctlExecutable)
      : await checkUserSystemdV1(host, systemctlExecutable);
    if (!userSystemdAvailable) return unavailable(platform, true, 'user_systemd_unavailable');
  } catch {
    return unavailable(platform, true, 'user_systemd_unavailable');
  }

  const checks = createLinuxCgroupDescendantCleanupChecksV1();
  let unitName: string;
  try {
    unitName = createRuntimeUnitName(input.identity);
  } catch {
    return unsupported(platform, true, 'scope_identity_mismatch', checks);
  }
  const runner: CgroupPidsRunnerV1 = {
    mechanism: 'systemd_user_scope_tasks_max',
    executable: runnerExecutable,
    systemctlExecutable,
  };

  let temporaryDirectory: string | undefined;
  let child: LinuxCgroupCleanupChildV1 | undefined;
  let cleanupIssued = false;
  let exactScopeVerified = false;
  let exactUnitCleanupInvocation: readonly string[] | undefined;
  let exactCleanupInvocation: readonly string[] | undefined;
  let exactCgroupDirectory: string | undefined;
  let stopPath: string | undefined;
  let finalResult: LinuxCgroupDescendantCleanupReportV1 | undefined;
  const finish = (value: LinuxCgroupDescendantCleanupReportV1) => {
    finalResult = value;
    return value;
  };
  const overrideCleanupFailure = (reason: LinuxCgroupDescendantCleanupReasonV1): void => {
    if (!finalResult) return;
    const replacement = unsupported(platform, true, reason, checks);
    Object.assign(finalResult as unknown as Record<string, unknown>, replacement);
  };
  try {
    temporaryDirectory = createTemporaryDirectory(host);
    const readyPath = join(temporaryDirectory, 'ready.json');
    const goPath = join(temporaryDirectory, 'go');
    stopPath = join(temporaryDirectory, 'stop');
    const fixturePath = join(temporaryDirectory, 'fixture.py');
    writeHostText(host, fixturePath, linuxCgroupFixtureSourceV1());
    const invocation = buildCgroupPidsInvocationV1({
      runner,
      maxTasks,
      unitName,
      command: [pythonExecutable, fixturePath, readyPath, goPath, stopPath, String(maxTasks)],
    });
    checks.exactRuntimeOwnedUnit = cgroupPidsUnitFromArgvV1(invocation) === unitName;
    if (!checks.exactRuntimeOwnedUnit) {
      return finish(unsupported(platform, true, 'scope_identity_mismatch', checks));
    }

    exactUnitCleanupInvocation = buildExactUnitKillInvocationV1(systemctlExecutable, unitName);
    child = host.spawn(invocation);
    const ready = await waitForReadyV1({
      host,
      readyPath,
      child,
      timeoutMs,
      pollIntervalMs,
    });
    if (!ready) return finish(unsupported(platform, true, 'scope_start_failed', checks));

    const controlGroupResult = await safeRun(host, [
      systemctlExecutable,
      '--user',
      '--no-ask-password',
      '--quiet',
      'show',
      '--property=ControlGroup',
      '--value',
      unitName,
    ]);
    if (controlGroupResult?.exitCode !== 0) {
      return finish(unsupported(platform, true, 'scope_disappeared_before_empty', checks));
    }
    const controlGroup = controlGroupResult.stdout.trim();
    const candidate = {
      schema: LINUX_CGROUP_SCOPE_CANDIDATE_SCHEMA_V1,
      unitName,
      runnerExecutable,
      systemctlExecutable,
      cgroupPath: controlGroup,
    } as const;
    const parsedScope = parseLinuxCgroupScopeIdentityV1({ argv: invocation, candidate });
    checks.controlGroupExact =
      !parsedScope.invalid && parsedScope.scope?.cgroupPath === controlGroup;
    if (!checks.controlGroupExact || !isCgroupPidsPathV1(controlGroup, unitName)) {
      return finish(unsupported(platform, true, 'scope_identity_mismatch', checks));
    }
    exactScopeVerified = true;

    const cgroupDirectory = `${CGROUP_ROOT}${controlGroup}`;
    exactCgroupDirectory = cgroupDirectory;
    exactCleanupInvocation = buildCgroupPidsKillInvocationV1({
      scope: {
        unitName,
        runnerExecutable,
        systemctlExecutable,
        cgroupPath: controlGroup,
      },
    });
    const pidsMax = readHostText(host, `${cgroupDirectory}/pids.max`);
    const initialFixtureFacts = readFixtureFactsV1(host, readyPath);
    checks.tasksMax =
      pidsMax.trim() === String(maxTasks) &&
      initialFixtureFacts.pidsMax === String(maxTasks) &&
      initialFixtureFacts.forkEagain === false &&
      initialFixtureFacts.descendantCgroupPath === '' &&
      initialFixtureFacts.descendantPid === 0 &&
      initialFixtureFacts.descendantParentPid === 0 &&
      initialFixtureFacts.descendantSessionId === 0 &&
      initialFixtureFacts.descendantOwned === false;
    if (!checks.tasksMax) {
      return finish(unsupported(platform, true, 'tasks_max_failed', checks));
    }
    // No descendant exists until exact ControlGroup and TasksMax have been
    // read back. This keeps identity mismatch paths free of detached leaks.
    writeHostText(host, goPath, 'go');
    const fixtureFacts = await waitForFixtureFactsV1({
      host,
      readyPath,
      timeoutMs,
      pollIntervalMs,
    });
    checks.forkEagain = fixtureFacts.forkEagain;
    if (!checks.forkEagain) {
      return finish(unsupported(platform, true, 'tasks_max_failed', checks));
    }
    if (!isPositiveSafeInteger(fixtureFacts.descendantPid)) {
      return finish(unsupported(platform, true, 'descendant_ownership_failed', checks));
    }
    let observedDescendant: DescendantOwnershipObservationV1;
    try {
      observedDescendant = readDescendantOwnershipV1(host, fixtureFacts.descendantPid);
    } catch {
      return finish(unsupported(platform, true, 'descendant_ownership_failed', checks));
    }
    checks.descendantOwnership =
      fixtureFacts.descendantOwned &&
      fixtureFacts.descendantCgroupPath === controlGroup &&
      observedDescendant.cgroupPath === controlGroup &&
      observedDescendant.parentPid === fixtureFacts.descendantParentPid &&
      observedDescendant.sessionId === fixtureFacts.descendantSessionId &&
      observedDescendant.parentPid > 0 &&
      observedDescendant.sessionId !== observedDescendant.parentPid &&
      observedDescendant.sessionId !== fixtureFacts.descendantPid;
    if (!checks.descendantOwnership) {
      return finish(unsupported(platform, true, 'descendant_ownership_failed', checks));
    }

    if (!exactCleanupInvocation) throw new Error('missing exact cleanup authority');
    const killInvocation = exactCleanupInvocation;
    checks.exactKillAll =
      killInvocation[0] === systemctlExecutable &&
      killInvocation.at(-1) === unitName &&
      killInvocation.includes('--kill-who=all') &&
      killInvocation.includes('--signal=SIGKILL');
    if (!checks.exactKillAll) {
      return finish(unsupported(platform, true, 'scope_identity_mismatch', checks));
    }
    const killResult = await safeRun(host, killInvocation);
    if (killResult?.exitCode !== 0) {
      await requestFixtureStopV1(host, stopPath, child, Math.min(timeoutMs, 1_000));
      // This is an emergency direct-child stop only. It is deliberately not
      // reflected as cleanup evidence and the report remains unsupported.
      safeKillChildV1(child);
      return finish(unsupported(platform, true, 'kill_all_failed', checks));
    }

    const cleanup = await observeEmptyCgroupBeforeDisappearanceV1({
      host,
      cgroupDirectory,
      timeoutMs,
      pollIntervalMs,
    });
    checks.populatedZeroBeforePathDisappearance = cleanup.populatedZero;
    checks.emptyCgroupProcsBeforePathDisappearance = cleanup.emptyProcs;
    if (!cleanup.ok) {
      return finish(
        unsupported(platform, true, cleanup.reason ?? 'cleanup_evidence_unavailable', checks),
      );
    }
    if (!(await settleChildV1(child, timeoutMs))) {
      await requestFixtureStopV1(host, stopPath, child, Math.min(timeoutMs, 1_000));
      safeKillChildV1(child);
      return finish(unsupported(platform, true, 'scope_disposal_unconfirmed', checks));
    }
    cleanupIssued = true;
    return finish(passed(platform, true, checks));
  } catch {
    return finish(unsupported(platform, true, 'probe_internal_failure', checks));
  } finally {
    if (child && !cleanupIssued) {
      let cleanupFailure: LinuxCgroupDescendantCleanupReasonV1 | undefined;
      try {
        const stop = await requestFixtureStopV1(host, stopPath, child, Math.min(timeoutMs, 1_000));
        if (!stop.written) cleanupFailure = 'kill_all_failed';
        if (!exactUnitCleanupInvocation) {
          cleanupFailure ??= 'kill_all_failed';
        } else {
          const cleanupResult = await safeRun(host, exactUnitCleanupInvocation);
          if (cleanupResult?.exitCode !== 0) {
            cleanupFailure ??= 'kill_all_failed';
          } else if (exactScopeVerified && exactCleanupInvocation && exactCgroupDirectory) {
            const cleanup = await observeEmptyCgroupBeforeDisappearanceV1({
              host,
              cgroupDirectory: exactCgroupDirectory,
              timeoutMs: Math.min(timeoutMs, 1_000),
              pollIntervalMs,
            });
            if (!cleanup.ok) {
              cleanupFailure ??= cleanup.reason ?? 'cleanup_evidence_unavailable';
            }
          }
          if (!cleanupFailure && !(await settleChildV1(child, Math.min(timeoutMs, 1_000)))) {
            cleanupFailure = 'scope_disposal_unconfirmed';
          }
        }
      } catch {
        cleanupFailure = 'probe_internal_failure';
      }
      if (cleanupFailure) {
        overrideCleanupFailure(cleanupFailure);
        // Emergency stop is not evidence of descendant cleanup. Keep the
        // unsupported report and its original check booleans intact.
        safeKillChildV1(child);
        await settleChildV1(child, Math.min(timeoutMs, 1_000));
      }
    }
    if (temporaryDirectory) removeTemporaryDirectory(host, temporaryDirectory);
  }
}

function createRuntimeUnitName(identity: string | undefined): string {
  const value = identity ?? randomUUID();
  const unit = `kite-sandbox-${value}.scope`;
  if (!isCgroupPidsUnitNameV1(unit)) throw new Error('invalid runtime unit identity');
  return unit;
}

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

/** Cleanup authority established from the generated unique unit immediately after spawn. */
function buildExactUnitKillInvocationV1(
  systemctlExecutable: string,
  unitName: string,
): readonly string[] {
  return [
    systemctlExecutable,
    '--user',
    '--no-ask-password',
    '--quiet',
    'kill',
    '--kill-who=all',
    '--signal=SIGKILL',
    unitName,
  ];
}

async function checkUserSystemdV1(
  host: LinuxCgroupCleanupHostV1,
  systemctlExecutable: string,
): Promise<boolean> {
  const result = await host.run([
    systemctlExecutable,
    '--user',
    '--no-ask-password',
    '--quiet',
    'show',
    '--property=Version',
    '--value',
  ]);
  return result.exitCode === 0;
}

async function safeRun(
  host: LinuxCgroupCleanupHostV1,
  argv: readonly string[],
): Promise<LinuxCgroupCleanupCommandResultV1 | undefined> {
  try {
    return await host.run(argv);
  } catch {
    return undefined;
  }
}

/**
 * Cooperative fixture stop is emergency leak prevention only. Its result is
 * never projected into the exact kill/empty checks used for a pass.
 */
async function requestFixtureStopV1(
  host: LinuxCgroupCleanupHostV1,
  stopPath: string | undefined,
  child: LinuxCgroupCleanupChildV1,
  timeoutMs: number,
): Promise<{ readonly written: boolean; readonly settled: boolean }> {
  if (!stopPath) return { written: false, settled: false };
  try {
    writeHostText(host, stopPath, 'stop');
  } catch {
    return { written: false, settled: false };
  }
  return { written: true, settled: await settleChildV1(child, timeoutMs) };
}

async function waitForReadyV1(input: {
  readonly host: LinuxCgroupCleanupHostV1;
  readonly readyPath: string;
  readonly child: LinuxCgroupCleanupChildV1;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}): Promise<boolean> {
  const deadline = Date.now() + input.timeoutMs;
  let childState: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  let childExit: Promise<'fulfilled' | 'rejected'>;
  try {
    childExit = input.child.wait().then(
      () => {
        childState = 'fulfilled';
        return 'fulfilled' as const;
      },
      () => {
        childState = 'rejected';
        return 'rejected' as const;
      },
    );
  } catch {
    childState = 'rejected';
    childExit = Promise.resolve('rejected');
  }
  while (Date.now() <= deadline) {
    if (input.host.pathExists(input.readyPath)) {
      await Promise.resolve();
      return childState === 'pending';
    }
    const exited = await Promise.race([childExit, delayV1(input.pollIntervalMs)]);
    if (exited === 'fulfilled' || exited === 'rejected') return false;
  }
  await Promise.resolve();
  return input.host.pathExists(input.readyPath) && childState === 'pending';
}

interface FixtureFactsV1 {
  readonly pidsMax: string;
  readonly forkEagain: boolean;
  readonly descendantCgroupPath: string;
  readonly descendantPid: number;
  readonly descendantParentPid: number;
  readonly descendantSessionId: number;
  readonly descendantOwned: boolean;
}

function readFixtureFactsV1(host: LinuxCgroupCleanupHostV1, path: string): FixtureFactsV1 {
  const parsed: unknown = JSON.parse(readHostText(host, path));
  if (!isRecord(parsed)) throw new Error('fixture facts are not an object');
  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== FIXTURE_FACT_KEYS.length ||
    keys.some((key, index) => key !== FIXTURE_FACT_KEYS[index])
  ) {
    throw new Error('fixture facts keys are not exact');
  }
  if (
    typeof parsed.pidsMax !== 'string' ||
    typeof parsed.forkEagain !== 'boolean' ||
    typeof parsed.descendantCgroupPath !== 'string' ||
    !isNonNegativeSafeInteger(parsed.descendantPid) ||
    !isNonNegativeSafeInteger(parsed.descendantParentPid) ||
    !isNonNegativeSafeInteger(parsed.descendantSessionId) ||
    typeof parsed.descendantOwned !== 'boolean' ||
    parsed.ready !== true
  ) {
    throw new Error('fixture facts are incomplete');
  }
  return {
    pidsMax: parsed.pidsMax,
    forkEagain: parsed.forkEagain,
    descendantCgroupPath: parsed.descendantCgroupPath,
    descendantPid: parsed.descendantPid,
    descendantParentPid: parsed.descendantParentPid,
    descendantSessionId: parsed.descendantSessionId,
    descendantOwned: parsed.descendantOwned,
  };
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

interface DescendantOwnershipObservationV1 {
  readonly cgroupPath: string;
  readonly parentPid: number;
  readonly sessionId: number;
}

/** Read descendant ownership independently from the fixture's self-report. */
function readDescendantOwnershipV1(
  host: LinuxCgroupCleanupHostV1,
  descendantPid: number,
): DescendantOwnershipObservationV1 {
  const cgroupText = host.readText(`/proc/${descendantPid}/cgroup`);
  const cgroupPath = cgroupText
    .split('\n')
    .find((line) => line.startsWith('0::'))
    ?.slice('0::'.length)
    .trim();
  if (!cgroupPath) throw new Error('descendant cgroup identity unavailable');

  const stat = host.readText(`/proc/${descendantPid}/stat`);
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 0) throw new Error('descendant process stat unavailable');
  const fields = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  // After the comm field, /proc/<pid>/stat starts with state, ppid, pgrp,
  // session. The lastIndexOf handles a command name containing ')'.
  const parentPid = Number(fields[1]);
  const sessionId = Number(fields[3]);
  if (!isPositiveSafeInteger(parentPid) || !isPositiveSafeInteger(sessionId)) {
    throw new Error('descendant process session identity unavailable');
  }
  return { cgroupPath, parentPid, sessionId };
}

async function waitForFixtureFactsV1(input: {
  readonly host: LinuxCgroupCleanupHostV1;
  readonly readyPath: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}): Promise<FixtureFactsV1> {
  const deadline = Date.now() + input.timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      const facts = readFixtureFactsV1(input.host, input.readyPath);
      if (facts.descendantCgroupPath.length > 0) return facts;
    } catch (error) {
      lastError = error;
    }
    await delayV1(input.pollIntervalMs);
  }
  throw lastError instanceof Error ? lastError : new Error('fixture facts unavailable');
}

async function observeEmptyCgroupBeforeDisappearanceV1(input: {
  readonly host: LinuxCgroupCleanupHostV1;
  readonly cgroupDirectory: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}): Promise<{
  readonly ok: boolean;
  readonly populatedZero: boolean;
  readonly emptyProcs: boolean;
  readonly reason?: 'scope_disappeared_before_empty' | 'cleanup_evidence_unavailable';
}> {
  const eventsPath = `${input.cgroupDirectory}/cgroup.events`;
  const procsPath = `${input.cgroupDirectory}/cgroup.procs`;
  const deadline = Date.now() + input.timeoutMs;
  let populatedZero = false;
  let emptyProcs = false;
  while (Date.now() <= deadline) {
    if (!input.host.pathExists(input.cgroupDirectory)) {
      return {
        ok: false,
        populatedZero,
        emptyProcs,
        reason: 'scope_disappeared_before_empty',
      };
    }
    let events: boolean | undefined;
    let procs: boolean | undefined;
    try {
      events = parseCgroupPidsPopulatedV1(input.host.readText(eventsPath));
      procs = parseCgroupPidsEmptyV1(input.host.readText(procsPath));
    } catch {
      return {
        ok: false,
        populatedZero,
        emptyProcs,
        reason: 'cleanup_evidence_unavailable',
      };
    }
    if (events === undefined || procs === undefined) {
      return {
        ok: false,
        populatedZero,
        emptyProcs,
        reason: 'cleanup_evidence_unavailable',
      };
    }
    populatedZero = events === false;
    emptyProcs = procs === true;
    if (populatedZero && emptyProcs) return { ok: true, populatedZero, emptyProcs };
    await delayV1(input.pollIntervalMs);
  }
  return {
    ok: false,
    populatedZero,
    emptyProcs,
    reason: 'cleanup_evidence_unavailable',
  };
}

async function settleChildV1(
  child: LinuxCgroupCleanupChildV1 | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (!child) return true;
  let wait: Promise<'fulfilled' | 'rejected'>;
  try {
    wait = child.wait().then(
      () => 'fulfilled' as const,
      () => 'rejected' as const,
    );
  } catch {
    return false;
  }
  const result = await Promise.race([wait, delayV1(timeoutMs)]);
  return result === 'fulfilled';
}

function safeKillChildV1(child: LinuxCgroupCleanupChildV1): boolean {
  try {
    child.kill('SIGKILL');
    return true;
  } catch {
    return false;
  }
}

function delayV1(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function createTemporaryDirectory(host: LinuxCgroupCleanupHostV1): string {
  if (host.createTempDirectory) return host.createTempDirectory();
  const directory = mkdtempSync(join(tmpdir(), 'kite-linux-cgroup-eval-'));
  chmodSync(directory, 0o700);
  return directory;
}

function writeHostText(host: LinuxCgroupCleanupHostV1, path: string, contents: string): void {
  if (host.writeText) {
    host.writeText(path, contents);
    return;
  }
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readHostText(host: LinuxCgroupCleanupHostV1, path: string): string {
  return host.readText(path);
}

function removeTemporaryDirectory(host: LinuxCgroupCleanupHostV1, path: string): void {
  if (host.removePath) {
    host.removePath(path);
    return;
  }
  rmSync(path, { recursive: true, force: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The fixture deliberately exercises all three ownership facts inside the
 * scope: cgroup pids.max, fork EAGAIN, and a detached setsid/double-fork
 * descendant. It writes only private host-side readiness data; the report
 * never includes that data, PIDs, paths, command output, or process text.
 */
function linuxCgroupFixtureSourceV1(): string {
  return [
    'import errno, json, os, sys, time',
    'ready_path = sys.argv[1]',
    'go_path = sys.argv[2]',
    'stop_path = sys.argv[3]',
    'expected = int(sys.argv[4])',
    'def stop_requested(): return os.path.exists(stop_path)',
    "proc_cgroup = next((line.split(':', 2)[2].strip() for line in open('/proc/self/cgroup') if line.startswith('0::')), '')",
    'if not proc_cgroup: raise SystemExit(21)',
    "cgroup_dir = '/sys/fs/cgroup' + proc_cgroup",
    "pids_max = open(cgroup_dir + '/pids.max').read().strip()",
    "with open(ready_path, 'w', encoding='utf-8') as ready: json.dump({'ready': True, 'pidsMax': pids_max, 'forkEagain': False, 'descendantCgroupPath': '', 'descendantPid': 0, 'descendantParentPid': 0, 'descendantSessionId': 0, 'descendantOwned': False}, ready, separators=(',', ':'))",
    'while not os.path.exists(go_path):',
    '    if stop_requested(): raise SystemExit(143)',
    '    time.sleep(0.01)',
    'if stop_requested(): raise SystemExit(143)',
    'read_fd, write_fd = os.pipe()',
    'os.set_inheritable(write_fd, True)',
    'detached_pid = os.fork()',
    'if detached_pid == 0:',
    '    os.close(read_fd)',
    '    os.setsid()',
    '    grandchild_pid = os.fork()',
    '    if grandchild_pid > 0:',
    "        os.write(write_fd, str(grandchild_pid).encode('ascii'))",
    '        os.close(write_fd)',
    '        os._exit(0)',
    '    while not stop_requested(): time.sleep(0.05)',
    '    os._exit(0)',
    'os.close(write_fd)',
    'grandchild_pid = int(os.read(read_fd, 64).decode("ascii"))',
    'os.close(read_fd)',
    'os.waitpid(detached_pid, 0)',
    'if stop_requested(): raise SystemExit(143)',
    'children = []',
    'fork_eagain = False',
    'for _ in range(expected * 4):',
    '    if stop_requested(): raise SystemExit(143)',
    '    try:',
    '        pid = os.fork()',
    '    except OSError as error:',
    '        if error.errno == errno.EAGAIN:',
    '            fork_eagain = True',
    '            break',
    '        raise',
    '    if pid == 0:',
    '        while not stop_requested(): time.sleep(0.05)',
    '        os._exit(0)',
    '    children.append(pid)',
    "descendant_path = next((line.split(':', 2)[2].strip() for line in open('/proc/' + str(grandchild_pid) + '/cgroup') if line.startswith('0::')), '')",
    "descendant_stat = open('/proc/' + str(grandchild_pid) + '/stat').read()",
    "descendant_stat_fields = descendant_stat[descendant_stat.rfind(')') + 1:].strip().split()",
    'descendant_parent_pid = int(descendant_stat_fields[1])',
    'descendant_session_id = int(descendant_stat_fields[3])',
    'facts = {',
    "    'ready': True,",
    "    'pidsMax': pids_max,",
    "    'forkEagain': fork_eagain,",
    "    'descendantCgroupPath': descendant_path,",
    "    'descendantPid': grandchild_pid,",
    "    'descendantParentPid': descendant_parent_pid,",
    "    'descendantSessionId': descendant_session_id,",
    "    'descendantOwned': descendant_path == proc_cgroup,",
    '}',
    "with open(ready_path, 'w', encoding='utf-8') as ready: json.dump(facts, ready, separators=(',', ':'))",
    'while not stop_requested(): time.sleep(0.05)',
    'for pid in children:',
    '    try: os.waitpid(pid, 0)',
    '    except ChildProcessError: pass',
    'os._exit(143)',
  ].join('\n');
}

/** Native host adapter. It is only reached after explicit opt-in. */
export function createNativeLinuxCgroupCleanupHostV1(): LinuxCgroupCleanupHostV1 {
  return {
    platform: process.platform,
    findExecutable: (name) => Bun.which(name) ?? undefined,
    pathExists: (path) => existsSync(path),
    readText: (path) => readFileSync(path, 'utf8'),
    run: async (argv) => {
      const processHandle = Bun.spawn([...argv], { stdout: 'pipe', stderr: 'pipe' });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          Promise.all([
            processHandle.exited,
            readNativeStreamBoundedV1(processHandle.stdout),
            readNativeStreamBoundedV1(processHandle.stderr),
          ]).then(([exitCode, stdout, stderr]) => ({
            timedOut: false as const,
            exitCode,
            stdout,
            stderr,
          })),
          new Promise<{ readonly timedOut: true }>((resolvePromise) => {
            timer = setTimeout(() => resolvePromise({ timedOut: true }), NATIVE_COMMAND_TIMEOUT_MS);
          }),
        ]);
        if (result.timedOut) {
          processHandle.kill('SIGKILL');
          await processHandle.exited;
          return { exitCode: 124, stdout: '', stderr: 'native command timeout' };
        }
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      } catch {
        processHandle.kill('SIGKILL');
        await processHandle.exited;
        return { exitCode: 124, stdout: '', stderr: 'native command output unavailable' };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    spawn: (argv) => {
      const processHandle = Bun.spawn([...argv], { stdout: 'ignore', stderr: 'ignore' });
      return {
        pid: processHandle.pid,
        wait: () => processHandle.exited,
        kill: (signal = 'SIGKILL') => processHandle.kill(signal),
      };
    },
  };
}

async function readNativeStreamBoundedV1(
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = next.value;
    length += chunk.byteLength;
    if (length > NATIVE_COMMAND_OUTPUT_LIMIT_BYTES) {
      throw new Error('native command output exceeded diagnostic bound');
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Write the canonical owner-only candidate artifact. */
export function writeLinuxCgroupDescendantCleanupArtifactV1(
  outputPath: string,
  value: LinuxCgroupDescendantCleanupReportV1,
): void {
  const target = resolve(outputPath);
  const parent = resolve(target, '..');
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  // Candidate artifacts are exclusive-create: never follow or overwrite a
  // pre-existing file/symlink supplied by a caller or a stale workflow run.
  writeFileSync(target, canonicalJsonBytes(value), { flag: 'wx', mode: 0o600 });
  chmodSync(target, 0o600);
}

function nativeOptInFromEnvironment(): boolean {
  return process.env.KITE_RUN_LINUX_CGROUP_DESCENDANT_CLEANUP === '1';
}

async function main(): Promise<void> {
  const outputIndex = process.argv.indexOf('--output');
  const outputPath =
    outputIndex >= 0 && process.argv[outputIndex + 1]
      ? resolve(process.argv[outputIndex + 1]!)
      : resolve('linux-cgroup-descendant-cleanup.json');
  const nativeOptIn = nativeOptInFromEnvironment() || process.argv.includes('--native');
  const value = await runLinuxCgroupDescendantCleanupV1({ nativeOptIn });
  writeLinuxCgroupDescendantCleanupArtifactV1(outputPath, value);
  process.stdout.write(`${new TextDecoder().decode(canonicalJsonBytes(value))}\n`);
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    // Never fabricate a replacement report after artifact publication fails:
    // an exclusive-create target must remain absent (or unchanged), and the
    // workflow upload must fail rather than retain stale evidence.
    process.stderr.write('linux cgroup cleanup diagnostic artifact was not published.\n');
    process.exitCode = 1;
  }
}
