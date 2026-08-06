import { randomBytes } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertLiveIsolatedTransportSourceDriftV1,
  LIVE_ISOLATED_TRANSPORT_SOURCE_PATHS_V1,
} from '../contracts/qualification/live-isolated-transport-binding-v1';
import type { LiveRouteModelBoundaryLeaseV1 } from '../contracts/qualification/live-route-resolver-v1';
import {
  encodeLiveIsolatedTransportFrameV1,
  isLiveIsolatedTransportRequestV1,
  LIVE_ISOLATED_TRANSPORT_MAX_FRAME_BYTES_V1,
  type LiveIsolatedTransportChildFrameV1,
  type LiveIsolatedTransportResultFrameV1,
  type LiveIsolatedTransportTestModeV1,
  liveIsolatedTransportPromptDigestV1,
  parseLiveIsolatedTransportChildFrameV1,
  parseLiveIsolatedTransportFrameLineV1,
} from './live-isolated-transport-protocol-v1';
import {
  type LiveIsolatedTransportFixtureV1,
  type LiveIsolatedTransportTerminalV1,
  liveIsolatedTransportDeadlineV1,
  type RunLiveIsolatedTransportInputV1,
  type RunLiveIsolatedTransportTestDependenciesV1,
} from './live-isolated-transport-v1';
import {
  hasFreshLiveScratchSupervisorHealthV1,
  liveScratchSupervisorActivationIsImplementedV1,
} from './live-scratch-supervisor-health-v1';

const LIVE_ISOLATED_CHILD_ENTRYPOINT_PATH_V1 = fileURLToPath(
  new URL('./live-isolated-transport-child-v1.ts', import.meta.url),
);
// This entrypoint exists only for the descendant-reaping contract test. It
// cannot be supplied by input, config, environment, fixture, or model lease.
const LIVE_ISOLATED_DESCENDANT_TEST_ENTRYPOINT_PATH_V1 = fileURLToPath(
  new URL('./live-isolated-transport-hang-descendant-v1.ts', import.meta.url),
);

// These are fixed module-relative paths, never cwd- or caller-derived paths.
// The binding module is the declared bootstrap for this accidental-drift guard;
// its own literal digest inventory is reviewed independently of any ledger.
const LIVE_ISOLATED_TRANSPORT_SOURCE_URLS_V1 = [
  new URL('./live-model-transport-v1.ts', import.meta.url),
  new URL('./live-isolated-transport-v1.ts', import.meta.url),
  new URL('./live-isolated-transport-protocol-v1.ts', import.meta.url),
  new URL('./live-isolated-transport-child-v1.ts', import.meta.url),
  new URL('./live-scratch-supervisor-health-v1.ts', import.meta.url),
] as const;

const MAX_PRIVATE_STDOUT_BYTES_V1 = LIVE_ISOLATED_TRANSPORT_MAX_FRAME_BYTES_V1 * 2 + 2;
/**
 * This is deliberately independent of `TMPDIR`/`TEMP`/`TMP` and of cwd. The
 * conventional OS temp root must be root-owned, non-symlinked, sticky, and
 * world-writable; unsupported platforms fail before scratch or a lease exists.
 */
const FIXED_TRUSTED_SCRATCH_PARENT_V1 =
  process.platform === 'darwin'
    ? '/private/tmp'
    : process.platform === 'linux'
      ? '/var/tmp'
      : undefined;

type ChildProcessV1 = Bun.Subprocess<'pipe', 'pipe', 'ignore'>;

interface SealedScratchV1 {
  readonly root: string;
  readonly fixtureRoot: string;
  readonly cwd: string;
  /** Test-only fixed descendant marker; never leaves the parent boundary. */
  readonly leaderExitMarkerPath: string;
  readonly environment: Readonly<Record<string, string>>;
}

interface FixedChildLaunchV1 {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly testMode?: LiveIsolatedTransportTestModeV1;
}

class ScratchSetupFailureV1 extends Error {
  readonly scratchReleased: boolean;

  constructor(scratchReleased: boolean) {
    super('isolated_transport_scratch_setup_failed');
    this.scratchReleased = scratchReleased;
  }
}

let activeIsolatedTransportV1 = false;

/**
 * Runtime uses only the checked-in fixed source closure. This is an
 * accidental-source-drift guard, not an anti-tamper root of trust.
 */
function fixedLiveIsolatedTransportSourceIsBoundV1(forceDriftForTest: boolean): boolean {
  try {
    const sources = LIVE_ISOLATED_TRANSPORT_SOURCE_URLS_V1.map((sourceUrl, index) => {
      const sourceBytes = new Uint8Array(readFileSync(fileURLToPath(sourceUrl)));
      if (!forceDriftForTest || index !== 0) {
        return {
          path: LIVE_ISOLATED_TRANSPORT_SOURCE_PATHS_V1[index]!,
          sourceBytes,
        };
      }
      const mutated = new Uint8Array(sourceBytes.byteLength + 1);
      mutated.set(sourceBytes);
      mutated[mutated.byteLength - 1] = 0;
      return {
        path: LIVE_ISOLATED_TRANSPORT_SOURCE_PATHS_V1[index]!,
        sourceBytes: mutated,
      };
    });
    assertLiveIsolatedTransportSourceDriftV1({ sources });
    return true;
  } catch {
    return false;
  }
}

function trustedScratchParentV1(): string {
  const parent = FIXED_TRUSTED_SCRATCH_PARENT_V1;
  if (!parent) throw new Error('isolated_transport_trusted_temp_unavailable');
  const stat = lstatSync(parent);
  const permissions = stat.mode & 0o7777;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    (permissions & 0o002) === 0 ||
    (permissions & 0o1000) === 0
  ) {
    throw new Error('isolated_transport_trusted_temp_invalid');
  }
  return parent;
}

function assertFixture(input: LiveIsolatedTransportFixtureV1): void {
  if (!/^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/.test(input.fixtureId)) {
    throw new Error('isolated_transport_fixture_identifier_invalid');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(input.fixtureDigest) || input.bytes.byteLength === 0) {
    throw new Error('isolated_transport_fixture_invalid');
  }
}

function assertReadOnly(path: string, kind: 'directory' | 'file'): void {
  const stat = lstatSync(path);
  if ((kind === 'directory' && !stat.isDirectory()) || (kind === 'file' && !stat.isFile())) {
    throw new Error('isolated_transport_fixture_kind_invalid');
  }
  if (stat.isSymbolicLink() || (stat.mode & (kind === 'directory' ? 0o222 : 0o333)) !== 0) {
    throw new Error('isolated_transport_fixture_permissions_invalid');
  }
  if (kind === 'file') {
    try {
      accessSync(path, constants.W_OK);
      throw new Error('isolated_transport_fixture_write_accessible');
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'isolated_transport_fixture_write_accessible'
      ) {
        throw error;
      }
    }
  }
}

/**
 * `true` means the root is gone and the singleton may be released. Any error
 * (including a post-delete test fault) is deliberately indistinguishable from
 * a retention failure to production callers.
 */
function removeScratchRootV1(
  root: string,
  fixtureRoot: string | undefined,
  forceFailureAfterRemoval: boolean,
): boolean {
  try {
    // The parent owns these paths. Restoring permissions prevents a fixed
    // child from turning a normal cleanup into an ambient privilege boundary.
    chmodSync(root, 0o700);
    if (fixtureRoot) chmodSync(fixtureRoot, 0o700);
    rmSync(root, { recursive: true, force: true });
    // `lstat` also ensures `rmSync({ force: true })` did not silently leave a
    // root behind. Test-only fault injection happens *after* actual removal,
    // so it cannot leave a synthetic scratch tree on the host.
    lstatSync(root);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return !forceFailureAfterRemoval;
    return false;
  }
}

function createScratch(
  fixture: LiveIsolatedTransportFixtureV1,
  options: { readonly forceSetupFailure: boolean; readonly forceCleanupFailure: boolean },
): SealedScratchV1 {
  const root = mkdtempSync(join(trustedScratchParentV1(), 'kite-qualification-l3-transport-'));
  let fixtureRoot: string | undefined;
  try {
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('isolated_transport_scratch_root_invalid');
    }
    chmodSync(root, 0o700);
    fixtureRoot = join(root, 'fixture');
    const cwd = join(root, 'cwd');
    const tmp = join(root, 'tmp');
    mkdirSync(fixtureRoot, { mode: 0o700 });
    mkdirSync(cwd, { mode: 0o700 });
    mkdirSync(tmp, { mode: 0o700 });
    const homes = Object.fromEntries(
      [
        'HOME',
        'KITE_CODE_HOME',
        'USERPROFILE',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
      ].map((key) => {
        const path = join(root, key.toLowerCase());
        mkdirSync(path, { mode: 0o700 });
        return [key, path];
      }),
    ) as Record<
      | 'HOME'
      | 'KITE_CODE_HOME'
      | 'USERPROFILE'
      | 'XDG_CONFIG_HOME'
      | 'XDG_DATA_HOME'
      | 'XDG_STATE_HOME',
      string
    >;
    const fixtureFile = join(fixtureRoot, 'fixture.v1.json');
    writeFileSync(fixtureFile, fixture.bytes, { mode: 0o400, flag: 'wx' });
    chmodSync(fixtureFile, 0o400);
    chmodSync(fixtureRoot, 0o500);
    assertReadOnly(fixtureRoot, 'directory');
    assertReadOnly(fixtureFile, 'file');
    if (options.forceSetupFailure) throw new Error('isolated_transport_fixed_setup_failure');

    // Exact, source-owned child environment. It intentionally does not
    // inherit caller PATH/locale/TZ, credentials, proxy variables,
    // NODE_OPTIONS, BUN_*, or an ambient temp-root selector.
    const environment = Object.freeze({
      HOME: homes.HOME,
      KITE_CODE_HOME: homes.KITE_CODE_HOME,
      USERPROFILE: homes.USERPROFILE,
      XDG_CONFIG_HOME: homes.XDG_CONFIG_HOME,
      XDG_DATA_HOME: homes.XDG_DATA_HOME,
      XDG_STATE_HOME: homes.XDG_STATE_HOME,
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
      TZ: 'UTC',
    });
    return Object.freeze({
      root,
      fixtureRoot,
      cwd,
      leaderExitMarkerPath: join(root, 'isolated-transport-leader-exit-marker.v1'),
      environment,
    });
  } catch {
    throw new ScratchSetupFailureV1(
      removeScratchRootV1(root, fixtureRoot, options.forceCleanupFailure),
    );
  }
}

function deleteScratch(scratch: SealedScratchV1, forceFailureAfterRemoval: boolean): boolean {
  return removeScratchRootV1(scratch.root, scratch.fixtureRoot, forceFailureAfterRemoval);
}

function newNonce(): string {
  return randomBytes(16).toString('hex');
}

function writeFrame(processHandle: ChildProcessV1, frame: unknown): boolean {
  const encoded = encodeLiveIsolatedTransportFrameV1(frame);
  if (!encoded || !processHandle.stdin) return false;
  try {
    processHandle.stdin.write(`${encoded}\n`);
    void Promise.resolve(processHandle.stdin.flush()).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

function closePrivateStdio(processHandle: ChildProcessV1): void {
  try {
    processHandle.stdin?.end();
  } catch {
    // The terminal state is already fail-closed; no error text is retained.
  }
}

/** Returns false when a platform cannot prove process-group termination. */
function killDetachedProcessGroup(processHandle: ChildProcessV1): boolean {
  if (process.platform === 'win32') {
    try {
      processHandle.kill('SIGKILL');
    } catch {
      // Fall through to the false fail-closed result.
    }
    return false;
  }
  try {
    process.kill(-processHandle.pid, 'SIGKILL');
    return true;
  } catch {
    try {
      processHandle.kill('SIGKILL');
    } catch {
      // Fall through to the false fail-closed result.
    }
    return false;
  }
}

/** `Subprocess.exited` only proves the leader exited, not its descendants. */
function detachedProcessGroupIsAbsent(processHandle: ChildProcessV1): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-processHandle.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function deadlineIsValid(cutoffAtMs: number, exitDeadlineAtMs: number): boolean {
  return (
    Number.isSafeInteger(cutoffAtMs) &&
    Number.isSafeInteger(exitDeadlineAtMs) &&
    cutoffAtMs > Date.now() &&
    exitDeadlineAtMs > cutoffAtMs
  );
}

/**
 * The sole AQ-8/AQ-9B parent process creator. It has a fixed executable and
 * a fixed absolute entrypoint, never a caller-provided command. Bun IPC/fork
 * is intentionally not used because those mechanisms may add bootstrap env.
 */
function spawnFixedLiveIsolatedChildV1(launch: FixedChildLaunchV1): ChildProcessV1 {
  if (launch.testMode === 'fixed_spawn_failure_with_cleanup_failure') {
    throw new Error('isolated_transport_fixed_spawn_failure');
  }
  const entrypoint =
    launch.testMode === 'spawn_fixed_descendant_then_hang' ||
    launch.testMode === 'leader_exits_with_descendant_then_exit'
      ? LIVE_ISOLATED_DESCENDANT_TEST_ENTRYPOINT_PATH_V1
      : LIVE_ISOLATED_CHILD_ENTRYPOINT_PATH_V1;
  return Bun.spawn([process.execPath, '--no-env-file', entrypoint], {
    cwd: launch.cwd,
    env: launch.environment,
    detached: true,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  }) as ChildProcessV1;
}

/**
 * Shared fixed-child transport entrypoint. Both the process creator and the
 * private credential framing live in this non-exported-launcher module: no
 * caller can provide a child process that later observes a lease frame.
 */
export async function runLiveIsolatedTransportV1(
  input: RunLiveIsolatedTransportInputV1,
  dependencies: RunLiveIsolatedTransportTestDependenciesV1 = {},
): Promise<LiveIsolatedTransportTerminalV1> {
  const forceScratchCleanupFailure =
    dependencies.testMode === 'fixed_spawn_failure_with_cleanup_failure' ||
    dependencies.testMode === 'fixed_setup_failure_with_cleanup_failure';
  const forceScratchSetupFailure =
    dependencies.testMode === 'fixed_setup_failure_with_cleanup_failure';
  const request = dependencies.testMode
    ? Object.freeze({ ...input.request, testMode: dependencies.testMode })
    : input.request;
  const fixedNoCredentialTest =
    dependencies.testMode !== undefined &&
    request.operation === 'test' &&
    input.modelBoundary === undefined;
  // No health record can activate this transport today. The source-literal
  // activation gate is checked before even looking at a caller-owned ledger
  // path, then the future health shape is a second independent requirement.
  // Closed fixture tests are the sole exception and cannot carry a model lease.
  if (
    !fixedLiveIsolatedTransportSourceIsBoundV1(dependencies.forceSourceDriftForTest === true) ||
    (!fixedNoCredentialTest &&
      (!liveScratchSupervisorActivationIsImplementedV1() ||
        !hasFreshLiveScratchSupervisorHealthV1({
          ledgerRoot: input.supervisorLedgerRoot,
        })))
  ) {
    return { status: 'child_failure', dispatched: 'known_zero', exitConfirmed: true };
  }
  if (
    // Windows cannot prove that a detached child has no surviving descendants
    // with this launcher. Refuse before a scratch root or credential lease is
    // created rather than pretending `Subprocess.exited` is sufficient.
    process.platform === 'win32' ||
    activeIsolatedTransportV1 ||
    !deadlineIsValid(input.cutoffAtMs, input.exitDeadlineAtMs) ||
    !isLiveIsolatedTransportRequestV1(request) ||
    (dependencies.testMode === undefined && input.modelBoundary === undefined) ||
    (dependencies.testMode !== undefined && request.operation !== 'test')
  ) {
    return { status: 'child_failure', dispatched: 'known_zero', exitConfirmed: true };
  }
  try {
    assertFixture(input.fixture);
  } catch {
    return { status: 'child_failure', dispatched: 'known_zero', exitConfirmed: true };
  }
  if (input.operationSignal?.aborted) {
    return { status: 'cancelled_before_dispatch', dispatched: 'known_zero', exitConfirmed: true };
  }

  activeIsolatedTransportV1 = true;
  let scratch: SealedScratchV1 | undefined;
  try {
    scratch = createScratch(input.fixture, {
      forceSetupFailure: forceScratchSetupFailure,
      forceCleanupFailure: forceScratchCleanupFailure,
    });
  } catch (error) {
    // A setup failure before `mkdtemp` creates no root. Once a root exists,
    // only a confirmed deletion may release the singleton; otherwise later
    // live work must remain quarantined even though no child was spawned.
    if (!(error instanceof ScratchSetupFailureV1) || error.scratchReleased) {
      activeIsolatedTransportV1 = false;
    }
    return { status: 'child_failure', dispatched: 'known_zero', exitConfirmed: true };
  }

  return await new Promise<LiveIsolatedTransportTerminalV1>((resolve) => {
    let processHandle: ChildProcessV1;
    try {
      processHandle = spawnFixedLiveIsolatedChildV1({
        cwd: scratch!.cwd,
        environment: scratch!.environment,
        ...(dependencies.testMode ? { testMode: dependencies.testMode } : {}),
      });
    } catch {
      // A spawn failure has the same retention obligation as a post-run
      // failure: do not release the singleton unless the root is confirmed
      // gone. No caller-provided spawner can bypass this branch.
      if (deleteScratch(scratch!, forceScratchCleanupFailure)) activeIsolatedTransportV1 = false;
      resolve({ status: 'child_failure', dispatched: 'known_zero', exitConfirmed: true });
      return;
    }

    const nonce = newNonce();
    let stage: 'waiting_ready' | 'waiting_result' | 'waiting_cancelled_result' | 'terminal' =
      'waiting_ready';
    let terminalStatus: LiveIsolatedTransportTerminalV1['status'] | undefined;
    let terminalResult: LiveIsolatedTransportResultFrameV1 | undefined;
    let dispatchState: LiveIsolatedTransportTerminalV1['dispatched'] = 'known_zero';
    // `Subprocess.exited` is only a leader witness. `exitConfirmed` becomes
    // true only after the detached POSIX process group is absent as well.
    let exitConfirmed = false;
    let childLeaderExited = false;
    let exitCode: number | undefined;
    let groupKillTrusted = true;
    let completed = false;
    let quarantined = false;
    let cutoffTimer: ReturnType<typeof setTimeout> | undefined;
    let fullDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let cancellationResultTimer: ReturnType<typeof setTimeout> | undefined;
    let cancellationResultDeadlineMs: number | undefined;

    const cleanupAndRelease = (): boolean => {
      if (deleteScratch(scratch!, forceScratchCleanupFailure)) {
        activeIsolatedTransportV1 = false;
        return true;
      }
      // Retention deletion is governance-significant. Keep the singleton
      // sticky (rather than admitting another live child) and force the
      // current caller down its no-observation/full-charge path.
      return false;
    };
    const clearTimers = () => {
      if (cutoffTimer) clearTimeout(cutoffTimer);
      if (fullDeadlineTimer) clearTimeout(fullDeadlineTimer);
      if (cancellationResultTimer) clearTimeout(cancellationResultTimer);
      input.operationSignal?.removeEventListener('abort', onExternalAbort);
    };
    const finalStatus = (): LiveIsolatedTransportTerminalV1['status'] => {
      if (terminalStatus === 'result' && exitCode === 0) return 'result';
      if (terminalStatus === 'cancelled_before_dispatch') return 'cancelled_before_dispatch';
      if (terminalStatus === 'deadline_exceeded') return 'deadline_exceeded';
      return 'child_failure';
    };
    const settleConfirmed = () => {
      if (completed || !exitConfirmed || !terminalStatus) return;
      completed = true;
      clearTimers();
      const status = groupKillTrusted ? finalStatus() : 'child_failure';
      const dispatched =
        status === 'cancelled_before_dispatch'
          ? 'known_zero'
          : dispatchState === 'known_zero' && status === 'child_failure'
            ? 'known_zero'
            : dispatchState;
      const scratchDeleted = cleanupAndRelease();
      resolve({
        status: scratchDeleted ? status : 'child_failure',
        ...(scratchDeleted && status === 'result' && terminalResult
          ? { result: terminalResult }
          : {}),
        dispatched,
        exitConfirmed: true,
      });
    };
    const resolveUnconfirmed = () => {
      if (completed) return;
      completed = true;
      quarantined = true;
      clearTimers();
      closePrivateStdio(processHandle);
      // A stale negative PID must never be signalled after the leader exit
      // event: PID/PGID reuse could target an unrelated process group.
      if (!childLeaderExited && !killDetachedProcessGroup(processHandle)) {
        groupKillTrusted = false;
      }
      // Do not delete the root or release the singleton while a child might
      // still have its cwd/credential lease. The unreconciled governance
      // reservation remains active and charges at expiry.
      resolve({
        status: 'child_exit_unconfirmed',
        dispatched: dispatchState === 'known_zero' ? 'known_zero' : 'unknown',
        exitConfirmed: false,
      });
      if (dependencies.testMode === 'leader_exits_with_descendant_then_exit' && childLeaderExited) {
        // A test fixture may scrub only after a fresh *absence* probe and a
        // fixed marker proves its descendant survived the leader transition.
        // This never sends `SIGKILL` to an old PGID and never applies to a
        // production `child_exit_unconfirmed`, which remains process-lifetime
        // sticky with retained scratch/ledger quarantine.
        setTimeout(() => {
          if (!detachedProcessGroupIsAbsent(processHandle)) return;
          try {
            const marker = lstatSync(scratch!.leaderExitMarkerPath);
            if (!marker.isFile() || marker.isSymbolicLink()) return;
          } catch {
            return;
          }
          if (!deleteScratch(scratch!, false)) return;
          activeIsolatedTransportV1 = false;
          try {
            dependencies.onQuarantineScrubbed?.();
          } catch {
            // A test observer cannot affect the already-confirmed scrub.
          }
        }, 400);
      }
    };
    const beginTerminal = (
      status: Exclude<LiveIsolatedTransportTerminalV1['status'], 'child_exit_unconfirmed'>,
      options: { kill: boolean; result?: LiveIsolatedTransportResultFrameV1 },
    ) => {
      if (stage === 'terminal') return;
      stage = 'terminal';
      terminalStatus = status;
      terminalResult = options.result;
      closePrivateStdio(processHandle);
      if (options.kill && !childLeaderExited && !killDetachedProcessGroup(processHandle)) {
        groupKillTrusted = false;
      }
      if (childLeaderExited) confirmDetachedGroupExit();
      settleConfirmed();
    };
    const confirmDetachedGroupExit = () => {
      if (!childLeaderExited || exitConfirmed) return;
      if (detachedProcessGroupIsAbsent(processHandle)) {
        exitConfirmed = true;
        if (completed && quarantined) {
          cleanupAndRelease();
          return;
        }
        settleConfirmed();
        return;
      }
      // A leader may have exited while an accidental descendant retains the
      // old process group. Do not signal `-oldPid`: it could have been reused.
      // Keep root/ledger/concurrency state quarantined instead.
      if (!completed) resolveUnconfirmed();
    };
    const resultMatchesRequest = (result: LiveIsolatedTransportResultFrameV1): boolean => {
      if (result.phase !== request.phase || result.promptDigest !== request.promptDigest)
        return false;
      if (result.outcome === 'success' && result.providerDispatchCount !== 1) return false;
      if (result.outcome === 'success') {
        const { inputTokens, outputTokens, totalTokens } = result.usage;
        if (
          typeof inputTokens !== 'number' ||
          typeof outputTokens !== 'number' ||
          typeof totalTokens !== 'number' ||
          inputTokens > request.maxInputTokens ||
          outputTokens > request.maxOutputTokens ||
          totalTokens > request.maxInputTokens + request.maxOutputTokens
        ) {
          return false;
        }
      }
      if (result.outcome === 'cancelled') return result.providerDispatchCount === 1;
      if (request.phase === 'summary') {
        return (
          (result.outcome === 'success' && result.generation?.kind === 'accepted_summary') ||
          (result.outcome === 'not_observed' && result.generation?.kind === 'tool_marker') ||
          (result.outcome === 'not_observed' && result.generation?.kind === 'empty')
        );
      }
      if (request.phase === 'primary') {
        return (
          (result.outcome === 'success' && result.generation?.kind === 'accepted_primary') ||
          (result.outcome === 'not_observed' && result.generation?.kind === 'tool_marker') ||
          (result.outcome === 'not_observed' && result.generation?.kind === 'empty')
        );
      }
      return result.generation === undefined;
    };
    const beginDispatch = () => {
      if (stage !== 'waiting_ready') return;
      if (Date.now() >= input.cutoffAtMs) {
        beginTerminal('deadline_exceeded', { kill: true });
        return;
      }
      stage = 'waiting_result';
      const dispatch = (lease?: { readonly baseURL: string; readonly apiKey: string }) => {
        if (stage !== 'waiting_result' || Date.now() >= input.cutoffAtMs) {
          beginTerminal('deadline_exceeded', { kill: true });
          return;
        }
        const sent = writeFrame(processHandle, {
          schema: 'LiveIsolatedTransportProtocolV1',
          version: 1,
          kind: 'dispatch',
          nonce,
          request,
          ...(lease ? { lease } : {}),
        });
        dispatchState = sent ? 'known_one' : 'unknown';
        if (!sent) {
          beginTerminal('child_failure', { kill: true });
          return;
        }
        try {
          dependencies.onDispatched?.();
        } catch {
          beginTerminal('child_failure', { kill: true });
        }
      };
      if (request.operation === 'test') {
        dispatch();
        return;
      }
      try {
        input.modelBoundary!.withModelTransport((transport) => {
          // The raw endpoint/key occupy only this one lease callback and the
          // immediately-written private pipe frame. They never reach report,
          // ledger, fixture, argv, child env, or an error object.
          dispatch({ baseURL: transport.baseURL, apiKey: transport.apiKey });
        });
      } catch {
        dispatchState = 'unknown';
        beginTerminal('child_failure', { kill: true });
      }
    };
    const onChildFrame = (frame: LiveIsolatedTransportChildFrameV1) => {
      // Terminal fence: late/duplicate output cannot reopen a product tail or
      // evidence construction, even if the child was slow to die after kill.
      if (stage === 'terminal') return;
      // The parent, not merely the child timer, enforces the absolute cutoff
      // before every ready/result transition. A late buffered frame can never
      // become an accepted diagnostic terminal.
      if (Date.now() >= input.cutoffAtMs) {
        beginTerminal('deadline_exceeded', { kill: true });
        return;
      }
      if (frame.nonce !== nonce) {
        dispatchState = dispatchState === 'known_zero' ? 'known_zero' : 'unknown';
        beginTerminal('child_failure', { kill: true });
        return;
      }
      if (stage === 'waiting_ready') {
        if (frame.kind !== 'ready') {
          beginTerminal('child_failure', { kill: true });
          return;
        }
        beginDispatch();
        return;
      }
      if (stage === 'waiting_cancelled_result') {
        if (
          Date.now() >= (cancellationResultDeadlineMs ?? input.cutoffAtMs) ||
          frame.kind !== 'result' ||
          frame.phase !== request.phase ||
          frame.promptDigest !== request.promptDigest ||
          frame.outcome !== 'cancelled' ||
          frame.providerDispatchCount !== 1
        ) {
          // A success (including one already buffered when abort arrived) is
          // never accepted after external cancellation. Keep the result
          // fence closed and stop the complete detached group.
          beginTerminal('child_failure', { kill: true });
          return;
        }
        beginTerminal('result', { kill: false, result: frame });
        return;
      }
      if (frame.kind !== 'result' || !resultMatchesRequest(frame)) {
        dispatchState = dispatchState === 'known_zero' ? 'known_zero' : 'unknown';
        beginTerminal('child_failure', { kill: true });
        return;
      }
      beginTerminal('result', { kill: false, result: frame });
    };
    const consumePrivateStdout = async () => {
      const reader = processHandle.stdout.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let totalBytes = 0;
      try {
        while (stage !== 'terminal') {
          const next = await reader.read();
          if (next.done) break;
          totalBytes += next.value.byteLength;
          if (totalBytes > MAX_PRIVATE_STDOUT_BYTES_V1) {
            beginTerminal('child_failure', { kill: true });
            return;
          }
          pending += decoder.decode(next.value, { stream: true });
          if (
            new TextEncoder().encode(pending).byteLength >
            LIVE_ISOLATED_TRANSPORT_MAX_FRAME_BYTES_V1
          ) {
            beginTerminal('child_failure', { kill: true });
            return;
          }
          let newline = pending.indexOf('\n');
          while (newline >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            const parsed = parseLiveIsolatedTransportChildFrameV1(
              parseLiveIsolatedTransportFrameLineV1(line),
            );
            if (!parsed) {
              beginTerminal('child_failure', { kill: true });
              return;
            }
            onChildFrame(parsed);
            newline = pending.indexOf('\n');
          }
        }
      } catch {
        beginTerminal('child_failure', { kill: true });
      } finally {
        reader.releaseLock();
      }
    };
    const onExternalAbort = () => {
      if (stage === 'terminal') return;
      if (stage === 'waiting_ready') {
        beginTerminal('cancelled_before_dispatch', { kill: true });
        return;
      }
      if (stage === 'waiting_cancelled_result') return;
      stage = 'waiting_cancelled_result';
      // This is an acceptance grace, not a second deadline. A child that
      // ignores cancel is killed/fail-closed at this bounded point; it cannot
      // keep a cancellation wrapper alive for the full normal L3 budget.
      cancellationResultDeadlineMs = Math.min(input.cutoffAtMs, Date.now() + 1_000);
      cancellationResultTimer = setTimeout(
        () => {
          if (stage === 'waiting_cancelled_result') beginTerminal('child_failure', { kill: true });
        },
        Math.max(0, cancellationResultDeadlineMs - Date.now()),
      );
      const sent = writeFrame(processHandle, {
        schema: 'LiveIsolatedTransportProtocolV1',
        version: 1,
        kind: 'cancel',
        nonce,
      });
      if (!sent) {
        dispatchState = 'unknown';
        beginTerminal('child_failure', { kill: true });
      }
    };

    try {
      dependencies.onChildSpawn?.(processHandle.pid);
    } catch {
      beginTerminal('child_failure', { kill: true });
      return;
    }
    void consumePrivateStdout();
    void processHandle.exited.then((code) => {
      childLeaderExited = true;
      exitCode = code;
      if (!completed && stage !== 'terminal') {
        beginTerminal(Date.now() >= input.cutoffAtMs ? 'deadline_exceeded' : 'child_failure', {
          kill: false,
        });
      }
      confirmDetachedGroupExit();
    });
    cutoffTimer = setTimeout(
      () => beginTerminal('deadline_exceeded', { kill: true }),
      Math.max(0, input.cutoffAtMs - Date.now()),
    );
    fullDeadlineTimer = setTimeout(
      () => {
        if (stage !== 'terminal') beginTerminal('deadline_exceeded', { kill: true });
        if (!exitConfirmed) resolveUnconfirmed();
      },
      Math.max(0, input.exitDeadlineAtMs - Date.now()),
    );
    input.operationSignal?.addEventListener('abort', onExternalAbort, { once: true });
    if (input.operationSignal?.aborted) {
      onExternalAbort();
      return;
    }
    const init = {
      schema: 'LiveIsolatedTransportProtocolV1',
      version: 1,
      kind: 'init',
      nonce,
      // The parent owns the earlier dispatch cutoff and process-group kill.
      // The child owns this full-policy hard stop so it also exits if it hangs
      // before `ready`; the exit grace is still inside the caller's budget.
      cutoffAtMs: input.exitDeadlineAtMs,
      ...(dependencies.testMode === 'hang_before_ready'
        ? { testMode: 'hang_before_ready' as const }
        : {}),
    };
    if (!writeFrame(processHandle, init)) beginTerminal('child_failure', { kill: true });
  });
}

export interface LiveModelUsageBucketV1 {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

/** Raw content and transport errors deliberately never leave this module. */
export interface LiveModelTransportOutcomeV1 {
  readonly outcome: 'success' | 'cancelled' | 'not_observed';
  readonly providerDispatchCount: 0 | 1;
  readonly usage: LiveModelUsageBucketV1;
}

export interface InvokeSealedLiveModelInputV1 {
  readonly modelBoundary: LiveRouteModelBoundaryLeaseV1;
  /** Checked-in sealed synthetic text; it is not returned or logged. */
  readonly prompt: string;
  readonly maxOutputTokens: number;
  readonly maxInputTokens: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly fixture?: LiveIsolatedTransportFixtureV1;
  /** Shared runner deadline; external cancellation is deliberately separate. */
  readonly cutoffAtMs?: number;
  readonly exitDeadlineAtMs?: number;
  /** Future persistent-supervisor health root, supplied only by an L3 runner. */
  readonly supervisorLedgerRoot?: string;
}

export interface LiveModelTransportDetailedOutcomeV1 extends LiveModelTransportOutcomeV1 {
  readonly terminal: LiveIsolatedTransportTerminalV1;
}

function noDispatch(
  terminal: LiveIsolatedTransportTerminalV1,
): LiveModelTransportDetailedOutcomeV1 {
  return {
    outcome: terminal.status === 'cancelled_before_dispatch' ? 'cancelled' : 'not_observed',
    providerDispatchCount: 0,
    usage: { inputTokens: null, outputTokens: null, totalTokens: null },
    terminal,
  };
}

function mapTerminal(
  terminal: LiveIsolatedTransportTerminalV1,
): LiveModelTransportDetailedOutcomeV1 {
  const result = terminal.result;
  if (terminal.status !== 'result' || !result) {
    return terminal.dispatched === 'known_zero'
      ? noDispatch(terminal)
      : {
          outcome: 'not_observed',
          providerDispatchCount: 1,
          usage: { inputTokens: null, outputTokens: null, totalTokens: null },
          terminal,
        };
  }
  return {
    outcome: result.outcome,
    providerDispatchCount: result.providerDispatchCount,
    usage: result.usage,
    terminal,
  };
}

/**
 * Parent-only AQ-8 direct transport proxy. The real provider code executes
 * only in the fixed child process; the parent never receives raw text/error,
 * changes env/cwd, or uses the G1 retry/config path.
 */
export async function invokeSealedLiveModelWithDependenciesV1(
  input: InvokeSealedLiveModelInputV1,
  dependencies: RunLiveIsolatedTransportTestDependenciesV1 = {},
): Promise<LiveModelTransportDetailedOutcomeV1> {
  if (
    !Number.isInteger(input.maxOutputTokens) ||
    input.maxOutputTokens <= 0 ||
    !Number.isInteger(input.maxInputTokens) ||
    input.maxInputTokens <= 0 ||
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    input.prompt.length === 0 ||
    !input.fixture
  ) {
    return noDispatch({ status: 'child_failure', dispatched: 'known_zero', exitConfirmed: true });
  }
  const deadline =
    input.cutoffAtMs !== undefined && input.exitDeadlineAtMs !== undefined
      ? { cutoffAtMs: input.cutoffAtMs, exitDeadlineAtMs: input.exitDeadlineAtMs }
      : liveIsolatedTransportDeadlineV1(input.timeoutMs);
  if (!deadline) {
    return noDispatch({ status: 'child_failure', dispatched: 'known_zero', exitConfirmed: true });
  }
  const terminal = await runLiveIsolatedTransportV1(
    {
      fixture: input.fixture,
      // Fixed test modes carry neither a credential lease nor a model
      // boundary. They can never exercise the production activation path.
      ...(dependencies.testMode ? {} : { modelBoundary: input.modelBoundary }),
      request: {
        operation: dependencies.testMode ? 'test' : 'aq8',
        routeAlias: 'qualification-qwen3.6-flash',
        model: 'qwen3.6-flash',
        phase: 'aq8',
        maxInputTokens: input.maxInputTokens,
        maxOutputTokens: input.maxOutputTokens,
        promptDigest: liveIsolatedTransportPromptDigestV1({
          operation: dependencies.testMode ? 'test' : 'aq8',
          phase: 'aq8',
          ...(dependencies.testMode ? {} : { prompt: input.prompt }),
        }),
        ...(dependencies.testMode ? { testMode: dependencies.testMode } : { prompt: input.prompt }),
      },
      cutoffAtMs: deadline.cutoffAtMs,
      exitDeadlineAtMs: deadline.exitDeadlineAtMs,
      operationSignal: input.signal,
      supervisorLedgerRoot: input.supervisorLedgerRoot,
    },
    dependencies,
  );
  return mapTerminal(terminal);
}

export async function invokeSealedLiveModelV1(
  input: InvokeSealedLiveModelInputV1,
): Promise<LiveModelTransportOutcomeV1> {
  const detailed = await invokeSealedLiveModelWithDependenciesV1(input);
  return {
    outcome: detailed.outcome,
    providerDispatchCount: detailed.providerDispatchCount,
    usage: detailed.usage,
  };
}
