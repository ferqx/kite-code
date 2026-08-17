import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxBackendCapabilitiesV1 } from '../../src/core/execution/sandbox-execution/backend-capabilities';
import type { SandboxPreparationLifecycleV1 } from '../../src/core/execution/sandbox-execution/consumer';
import {
  sandboxCommandDigestV1,
  sandboxPreparationDigestV1,
  sandboxPreparedPlanDigestV1,
} from '../../src/core/execution/sandbox-execution/grant-authority';
import { executePosixSupervisedV1 } from '../../src/core/execution/sandbox-execution/posix-supervisor';
import { readComparablePosixProcessStartIdentityV1 } from '../../src/core/execution/sandbox-execution/posix-supervisor-identity';
import { generateBwrapArgs } from '../../src/core/sandbox/bwrap';
import { DEFAULT_RESOURCE_LIMITS } from '../../src/core/sandbox/types';
import type {
  PreparedSandboxExecutionV1,
  SandboxPreparationV1,
} from '../../src/protocol/sandbox-execution-provider';
import { canonicalJsonBytes, sha256DomainSeparated } from '../release/canonical-json';
import { compileOssReleaseExecutableV1 } from '../release/oss-candidate';

/**
 * This report is deliberately evaluation-only. It covers only the native
 * bubblewrap -> POSIX supervisor helper -> compiled CLI/TUI chain. It is not
 * a Provider/consumer lifecycle or cgroup qualification schema and must
 * never be consumed by production Core.
 */
export const LINUX_FULL_CHAIN_SCHEMA_V1 = 'kite.eval.linux-full-chain.v1' as const;
export const LINUX_FULL_CHAIN_ARTIFACT_CLASS_V1 = 'candidate_only' as const;
export const LINUX_FULL_CHAIN_COVERAGE_V1 =
  'bubblewrap_supervisor_release_entrypoints_only' as const;

const LINUX_FULL_CHAIN_WORKTREE_ROOT_V1 = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export type LinuxFullChainStatusV1 = 'passed' | 'unavailable' | 'unsupported';

export type LinuxFullChainReasonV1 =
  | 'none'
  | 'native_opt_in_required'
  | 'non_linux'
  | 'bubblewrap_unavailable'
  | 'fixture_interpreter_unavailable'
  | 'bubblewrap_namespace_unavailable'
  | 'release_compile_failed'
  | 'release_entrypoint_failed'
  | 'supervisor_failed'
  | 'descendant_exit_unconfirmed'
  | 'cleanup_unconfirmed'
  | 'probe_internal_failure';

export interface LinuxFullChainChecksV1 {
  readonly bubblewrapAvailable: boolean;
  readonly pidNamespace: boolean;
  readonly networkNamespace: boolean;
  readonly workspaceIsolation: boolean;
  readonly cliCompiledEntrypoint: boolean;
  readonly tuiCompiledEntrypoint: boolean;
  readonly cliSupervisorEntrypoint: boolean;
  readonly tuiSupervisorEntrypoint: boolean;
  readonly fullDescendantExit: boolean;
  readonly cleanupConfirmed: boolean;
}

export interface LinuxFullChainCandidateReportV1 {
  readonly schema: typeof LINUX_FULL_CHAIN_SCHEMA_V1;
  readonly artifactClass: typeof LINUX_FULL_CHAIN_ARTIFACT_CLASS_V1;
  readonly coverage: typeof LINUX_FULL_CHAIN_COVERAGE_V1;
  readonly evaluationOnly: true;
  readonly productionEvidence: false;
  readonly productionSupported: false;
  readonly platform: NodeJS.Platform;
  readonly nativeOptIn: boolean;
  readonly status: LinuxFullChainStatusV1;
  readonly reason: LinuxFullChainReasonV1;
  readonly checks: LinuxFullChainChecksV1;
  readonly digest: `sha256:${string}`;
}

export interface LinuxFullChainCommandResultV1 {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Native host seam used by the deterministic contract tests. The default
 * implementation below is the only path that allocates native processes.
 */
export interface LinuxFullChainHostV1 {
  readonly platform: NodeJS.Platform;
  readonly findExecutable: (name: string) => string | undefined;
  readonly pathExists: (path: string) => boolean;
  readonly readText: (path: string) => string;
  readonly readLink: (path: string) => string;
  readonly createTempDirectory: () => string;
  readonly writeText: (path: string, contents: string, mode?: number) => void;
  readonly removePath: (path: string) => void;
  readonly compileReleaseEntrypoint: (entrypoint: string, outfile: string) => Promise<void>;
  readonly run: (
    argv: readonly string[],
    timeoutMs: number,
  ) => Promise<LinuxFullChainCommandResultV1>;
  readonly runSupervised: (input: {
    readonly supervisorExecutablePath: string;
    readonly prepared: PreparedSandboxExecutionV1;
    readonly fixtureFactsPath: string;
    readonly descendantToken: string;
    readonly commandTimeoutMs: number;
  }) => Promise<LinuxFullChainSupervisedResultV1>;
  readonly findOwnedProcesses: (token: string) => readonly number[];
  readonly readProcessStartIdentity: (pid: number) => string | undefined;
  readonly killOwnedProcess: (pid: number, startIdentity: string) => boolean;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export interface LinuxFullChainSupervisedResultV1 {
  readonly outcomeOk: boolean;
  readonly timedOut: boolean;
  readonly cleanupConfirmed: boolean;
  readonly descendantObserved: boolean;
}

export interface RunLinuxFullChainInputV1 {
  /** Must be true; no native process is allocated otherwise. */
  readonly nativeOptIn?: boolean;
  readonly host?: LinuxFullChainHostV1;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const CLEANUP_TIMEOUT_MS = 2_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 64 * 1024;
const NATIVE_READER_SETTLE_TIMEOUT_MS = 250;
const NATIVE_PROCESS_SETTLE_TIMEOUT_MS = 500;
const EMPTY_CHECKS: LinuxFullChainChecksV1 = Object.freeze({
  bubblewrapAvailable: false,
  pidNamespace: false,
  networkNamespace: false,
  workspaceIsolation: false,
  cliCompiledEntrypoint: false,
  tuiCompiledEntrypoint: false,
  cliSupervisorEntrypoint: false,
  tuiSupervisorEntrypoint: false,
  fullDescendantExit: false,
  cleanupConfirmed: false,
});

type MutableChecksV1 = { -readonly [Key in keyof LinuxFullChainChecksV1]: boolean };

export function createLinuxFullChainChecksV1(): MutableChecksV1 {
  return { ...EMPTY_CHECKS };
}

function report(
  input: Pick<LinuxFullChainCandidateReportV1, 'platform' | 'nativeOptIn'> & {
    readonly status: LinuxFullChainStatusV1;
    readonly reason: LinuxFullChainReasonV1;
    readonly checks?: LinuxFullChainChecksV1;
  },
): LinuxFullChainCandidateReportV1 {
  const material = {
    schema: LINUX_FULL_CHAIN_SCHEMA_V1,
    artifactClass: LINUX_FULL_CHAIN_ARTIFACT_CLASS_V1,
    coverage: LINUX_FULL_CHAIN_COVERAGE_V1,
    evaluationOnly: true as const,
    productionEvidence: false as const,
    productionSupported: false as const,
    platform: input.platform,
    nativeOptIn: input.nativeOptIn,
    status: input.status,
    reason: input.reason,
    checks: input.checks ?? createLinuxFullChainChecksV1(),
  };
  return {
    ...material,
    digest: sha256DomainSeparated('kite.eval.linux-full-chain.v1', canonicalJsonBytes(material)),
  };
}

function unavailable(
  platform: NodeJS.Platform,
  nativeOptIn: boolean,
  reason: LinuxFullChainReasonV1,
): LinuxFullChainCandidateReportV1 {
  return report({ platform, nativeOptIn, status: 'unavailable', reason });
}

function unsupported(
  platform: NodeJS.Platform,
  nativeOptIn: boolean,
  reason: LinuxFullChainReasonV1,
  checks: LinuxFullChainChecksV1,
): LinuxFullChainCandidateReportV1 {
  return report({ platform, nativeOptIn, status: 'unsupported', reason, checks });
}

function passed(
  platform: NodeJS.Platform,
  nativeOptIn: boolean,
  checks: LinuxFullChainChecksV1,
): LinuxFullChainCandidateReportV1 {
  return report({ platform, nativeOptIn, status: 'passed', reason: 'none', checks });
}

/**
 * Execute the candidate-only Linux full chain. Native allocation is
 * impossible unless nativeOptIn is explicitly true. Every failure is a
 * structured unavailable/unsupported report; this function never fabricates
 * a pass after a spawn or cleanup error. The chain deliberately stops at the
 * supervisor helper seam; Provider/consumer durable lifecycle and cgroup
 * hard-count evidence remain separate diagnostics.
 */
export async function runLinuxFullChainCandidateV1(
  input: RunLinuxFullChainInputV1 = {},
): Promise<LinuxFullChainCandidateReportV1> {
  const host = input.host ?? createNativeLinuxFullChainHostV1();
  try {
    return await runLinuxFullChainInternalV1({ ...input, host });
  } catch {
    return unsupported(
      host.platform,
      input.nativeOptIn === true,
      'probe_internal_failure',
      createLinuxFullChainChecksV1(),
    );
  }
}

async function runLinuxFullChainInternalV1(
  input: RunLinuxFullChainInputV1 & { readonly host: LinuxFullChainHostV1 },
): Promise<LinuxFullChainCandidateReportV1> {
  const nativeOptIn = input.nativeOptIn === true;
  const host = input.host;
  if (!nativeOptIn) return unavailable(host.platform, false, 'native_opt_in_required');
  if (host.platform !== 'linux') return unavailable(host.platform, true, 'non_linux');

  const checks = createLinuxFullChainChecksV1();
  let finalResult: LinuxFullChainCandidateReportV1 | undefined;
  const finish = (value: LinuxFullChainCandidateReportV1): LinuxFullChainCandidateReportV1 => {
    finalResult = value;
    return value;
  };
  const bubblewrap = host.findExecutable('bwrap');
  if (!bubblewrap) return unavailable(host.platform, true, 'bubblewrap_unavailable');
  checks.bubblewrapAvailable = true;
  const python = host.findExecutable('python3');
  if (!python || !isSystemPath(python)) {
    return unavailable(host.platform, true, 'fixture_interpreter_unavailable');
  }

  const timeoutMs = boundedPositiveInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS);
  let temporaryRoot: string | undefined;
  const ownedTokens: string[] = [];
  let cleanupConfirmed = true;
  try {
    temporaryRoot = host.createTempDirectory();
    const workspace = join(temporaryRoot, 'workspace');
    const outside = join(temporaryRoot, 'outside-secret.txt');
    const runtimeRoot = join(temporaryRoot, 'runtime');
    const controlRoot = join(runtimeRoot, 'control');
    const dataRoot = join(runtimeRoot, 'data');
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    writeFileSync(outside, 'candidate-outside-sentinel', { mode: 0o600 });

    const cliExecutable = join(temporaryRoot, 'kite');
    const tuiExecutable = join(temporaryRoot, 'kite-tui');
    try {
      await host.compileReleaseEntrypoint('scripts/release/entrypoints/cli.ts', cliExecutable);
      await host.compileReleaseEntrypoint('scripts/release/entrypoints/tui.ts', tuiExecutable);
    } catch {
      return finish(unsupported(host.platform, true, 'release_compile_failed', checks));
    }

    checks.cliCompiledEntrypoint = await versionEntrypoint(host, cliExecutable, 'Kite Code ');
    checks.tuiCompiledEntrypoint = await versionEntrypoint(host, tuiExecutable, 'Kite Code TUI ');
    if (!checks.cliCompiledEntrypoint || !checks.tuiCompiledEntrypoint) {
      return finish(unsupported(host.platform, true, 'release_entrypoint_failed', checks));
    }

    const hostPidNamespace = host.readLink('/proc/self/ns/pid');
    const hostNetworkNamespace = host.readLink('/proc/self/ns/net');
    const fixturePath = join(workspace, 'fixture.py');
    host.writeText(fixturePath, fullChainFixtureSourceV1(), 0o700);
    const entrypoints = [['cli', cliExecutable] as const, ['tui', tuiExecutable] as const];
    checks.pidNamespace = true;
    checks.networkNamespace = true;
    checks.workspaceIsolation = true;
    checks.fullDescendantExit = true;
    checks.cleanupConfirmed = true;
    for (const [entrypoint, supervisorExecutablePath] of entrypoints) {
      const token = `kite-full-chain-${randomUUID().replaceAll('-', '')}`;
      ownedTokens.push(token);
      const factsPath = join(workspace, `${entrypoint}-facts.json`);
      const descendantReadyPath = join(workspace, `${entrypoint}-descendant.ready`);
      const stopPath = join(workspace, `${entrypoint}-stop`);
      const argv = [
        bubblewrap,
        ...generateBwrapArgs(workspace, {
          network: 'disabled',
          filesystemScope: 'workspace_write',
          sandboxRuntimeDir: dataRoot,
        }),
        python,
        fixturePath,
        factsPath,
        descendantReadyPath,
        stopPath,
        outside,
        hostPidNamespace,
        hostNetworkNamespace,
        token,
      ];
      const prepared = preparedPlanV1({
        workspace,
        controlRoot,
        dataRoot,
        argv,
      });
      const result = await host.runSupervised({
        supervisorExecutablePath,
        prepared,
        fixtureFactsPath: factsPath,
        descendantToken: token,
        commandTimeoutMs: timeoutMs,
      });
      const facts = readFixtureFactsV1(host, factsPath);
      if (!facts) {
        return finish(unsupported(host.platform, true, 'bubblewrap_namespace_unavailable', checks));
      }
      checks.pidNamespace &&= facts.pidNamespace;
      checks.networkNamespace &&= facts.networkNamespace;
      checks.workspaceIsolation &&= facts.workspaceIsolation;
      const supervisorEntrypointChain =
        result.cleanupConfirmed &&
        result.timedOut &&
        result.descendantObserved &&
        !result.outcomeOk;
      if (entrypoint === 'cli') checks.cliSupervisorEntrypoint = supervisorEntrypointChain;
      else checks.tuiSupervisorEntrypoint = supervisorEntrypointChain;
      checks.cleanupConfirmed &&= result.cleanupConfirmed;
      cleanupConfirmed &&= result.cleanupConfirmed;
      if (!result.descendantObserved) {
        checks.fullDescendantExit = false;
        checks.cleanupConfirmed = false;
      }
      const descendantsExited = await stopAndReapOwnedProcessesV1(host, token, stopPath);
      checks.fullDescendantExit &&= descendantsExited;
      cleanupConfirmed &&= descendantsExited;
      if (!descendantsExited) {
        return finish(unsupported(host.platform, true, 'descendant_exit_unconfirmed', checks));
      }
    }

    if (
      !checks.pidNamespace ||
      !checks.networkNamespace ||
      !checks.workspaceIsolation ||
      !checks.cliSupervisorEntrypoint ||
      !checks.tuiSupervisorEntrypoint ||
      !checks.fullDescendantExit ||
      !checks.cleanupConfirmed
    ) {
      return finish(unsupported(host.platform, true, 'supervisor_failed', checks));
    }
    return finish(passed(host.platform, true, checks));
  } catch {
    cleanupConfirmed = false;
    checks.cleanupConfirmed = false;
    return finish(unsupported(host.platform, true, 'probe_internal_failure', checks));
  } finally {
    for (const token of ownedTokens) {
      let reaped = false;
      try {
        reaped = await stopAndReapOwnedProcessesV1(host, token, undefined);
      } catch {
        // A single token inventory/identity failure must not prevent cleanup
        // attempts for later tokens or the temporary root.
        reaped = false;
      }
      cleanupConfirmed &&= reaped;
      if (!reaped) {
        checks.fullDescendantExit = false;
        checks.cleanupConfirmed = false;
      }
    }
    // Always attempt root cleanup after every token has had its own bounded
    // cleanup attempt. A failed token must not short-circuit this operation;
    // its failure is reflected only by the final cleanup_unconfirmed report.
    if (temporaryRoot) {
      try {
        host.removePath(temporaryRoot);
        if (host.pathExists(temporaryRoot)) {
          cleanupConfirmed = false;
          checks.cleanupConfirmed = false;
        }
      } catch {
        // Do not turn a cleanup failure into a fabricated pass. The report
        // has already been selected; the caller's artifact must remain
        // candidate-only and a later verification can classify the absence.
        cleanupConfirmed = false;
        checks.cleanupConfirmed = false;
      }
    }
    if (!cleanupConfirmed && finalResult) {
      Object.assign(finalResult, unsupported(host.platform, true, 'cleanup_unconfirmed', checks));
    }
  }
}

async function versionEntrypoint(
  host: LinuxFullChainHostV1,
  executable: string,
  prefix: string,
): Promise<boolean> {
  try {
    const result = await host.run([executable, '--version'], 10_000);
    return result.exitCode === 0 && result.stdout.startsWith(prefix) && !result.timedOut;
  } catch {
    return false;
  }
}

export function preparedPlanV1(input: {
  readonly workspace: string;
  readonly controlRoot: string;
  readonly dataRoot: string;
  readonly argv: readonly string[];
}): PreparedSandboxExecutionV1 {
  const commandDigest = sandboxCommandDigestV1(input.argv);
  const effectiveEffectsDigest = candidateDigestV1('effects', {
    filesystem: 'workspace_write',
    network: 'disabled',
  });
  const admissionDigest = candidateDigestV1('admission', {
    workspace: input.workspace,
    filesystem: 'workspace_write',
    network: 'disabled',
  });
  const invocationId = randomUUID();
  const preparation = candidatePreparationMaterialV1({
    invocationId,
    attempt: 1,
    workspace: input.workspace,
    argv: input.argv,
    commandDigest,
    effectiveEffectsDigest,
    admissionDigest,
    backend: 'bubblewrap',
  });
  return {
    schema: 'kite.sandbox-execution-provider.v1',
    kind: 'prepared_sandbox_execution',
    planId: randomUUID(),
    toolCallId: 'linux-full-chain-eval-tool',
    capabilityId: 'builtin:shell_execute',
    capabilityRevision: 'linux-full-chain-eval-v1',
    invocationId,
    attempt: preparation.attempt,
    canonicalWorkspace: input.workspace,
    effectiveEffectsDigest,
    admissionDigest,
    preparationDigest: sandboxPreparationDigestV1(preparation),
    commandDigest,
    approvedArgv: input.argv,
    argv: input.argv,
    cwd: input.workspace,
    env: null,
    stdin: null,
    transport: 'stdio',
    backend: 'bubblewrap',
    backendCapabilities: sandboxBackendCapabilitiesV1('bubblewrap'),
    // This fixture is a candidate diagnostic; it must not label the prepared
    // plan as production-enforced before the native qualification authority.
    enforcement: 'partial',
    resourceSemantics: 'allocating',
    expiresAtMs: Date.now() + 60_000,
    cleanup: {
      kind: 'runtime_directory',
      resourceId: 'linux-full-chain-eval-runtime',
      recoveryPayload: {
        controlRoot: input.controlRoot,
        dataRoot: input.dataRoot,
      },
    },
  };
}

function candidateDigestV1(domain: string, material: unknown): `sha256:${string}` {
  return sha256DomainSeparated(
    `kite.eval.linux-full-chain.${domain}.v1`,
    canonicalJsonBytes(material),
  );
}

function isCandidateDigestV1(value: string): value is `sha256:${string}` {
  return /^sha256:[a-f0-9]{64}$/u.test(value);
}

function candidatePreparationMaterialV1(input: {
  readonly invocationId: string;
  readonly attempt: number;
  readonly workspace: string;
  readonly argv: readonly string[];
  readonly commandDigest: string;
  readonly effectiveEffectsDigest: string;
  readonly admissionDigest: string;
  readonly backend: PreparedSandboxExecutionV1['backend'];
}): SandboxPreparationV1 {
  return {
    schema: 'kite.sandbox-execution-provider.v1',
    toolCallId: 'linux-full-chain-eval-tool',
    capabilityId: 'builtin:shell_execute',
    capabilityRevision: 'linux-full-chain-eval-v1',
    invocationId: input.invocationId,
    attempt: input.attempt,
    effectiveEffectsDigest: input.effectiveEffectsDigest,
    admissionDigest: input.admissionDigest,
    canonicalWorkspace: input.workspace,
    argv: [...input.argv],
    commandDigest: input.commandDigest,
    executionBoundaryDigest: candidateDigestV1('execution-boundary', {
      workspace: input.workspace,
      backend: input.backend,
    }),
    protectedPathRevision: candidateDigestV1('protected-path-revision', {
      backend: input.backend,
    }),
    filesystemMode: 'workspace_only',
    networkMode: 'disabled',
    executionTrust: null,
    resourceLimits: {
      ...DEFAULT_RESOURCE_LIMITS,
      maxProcessTreeTasks: null,
    },
    timeoutMs: 2_000,
    cancellationCorrelation: candidateDigestV1('cancellation', input.invocationId),
  };
}

export function candidatePreparationV1(prepared: PreparedSandboxExecutionV1): SandboxPreparationV1 {
  return candidatePreparationMaterialV1({
    invocationId: prepared.invocationId,
    attempt: prepared.attempt,
    workspace: prepared.canonicalWorkspace,
    argv: prepared.approvedArgv,
    commandDigest: prepared.commandDigest,
    effectiveEffectsDigest: prepared.effectiveEffectsDigest,
    admissionDigest: prepared.admissionDigest,
    backend: prepared.backend,
  });
}

function readFixtureFactsV1(
  host: LinuxFullChainHostV1,
  path: string,
):
  | {
      readonly pidNamespace: boolean;
      readonly networkNamespace: boolean;
      readonly workspaceIsolation: boolean;
    }
  | undefined {
  try {
    const parsed: unknown = JSON.parse(host.readText(path));
    if (!isRecord(parsed)) return undefined;
    const keys = Object.keys(parsed).sort();
    if (
      keys.length !== 4 ||
      keys[0] !== 'networkNamespace' ||
      keys[1] !== 'pidNamespace' ||
      keys[2] !== 'ready' ||
      keys[3] !== 'workspaceIsolation' ||
      parsed.ready !== true ||
      typeof parsed.pidNamespace !== 'boolean' ||
      typeof parsed.networkNamespace !== 'boolean' ||
      typeof parsed.workspaceIsolation !== 'boolean'
    ) {
      return undefined;
    }
    return {
      pidNamespace: parsed.pidNamespace,
      networkNamespace: parsed.networkNamespace,
      workspaceIsolation: parsed.workspaceIsolation,
    };
  } catch {
    return undefined;
  }
}

async function stopAndReapOwnedProcessesV1(
  host: LinuxFullChainHostV1,
  token: string,
  stopPath: string | undefined,
): Promise<boolean> {
  if (stopPath) {
    try {
      host.writeText(stopPath, 'stop\n', 0o600);
    } catch {
      // Process identity cleanup below is still attempted.
    }
  }
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  const observedIdentities = new Map<number, string>();
  while (Date.now() <= deadline) {
    const pids = host.findOwnedProcesses(token);
    if (pids.length === 0) return true;
    for (const pid of pids) {
      const startIdentity = host.readProcessStartIdentity(pid);
      if (!startIdentity) continue;
      const previousIdentity = observedIdentities.get(pid);
      if (previousIdentity && previousIdentity !== startIdentity) return false;
      observedIdentities.set(pid, startIdentity);
      host.killOwnedProcess(pid, startIdentity);
    }
    await host.sleep(20);
  }
  return host.findOwnedProcesses(token).length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSystemPath(path: string): boolean {
  return path === '/usr/bin/python3' || path === '/bin/python3' || path.startsWith('/usr/');
}

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, 30_000) : fallback;
}

export function fullChainFixtureSourceV1(): string {
  return [
    'import json, os, sys, time',
    'facts_path, ready_path, stop_path, outside_path, host_pid_ns, host_net_ns, token = sys.argv[1:8]',
    'def stopped(): return os.path.exists(stop_path)',
    'owner = os.fork()',
    'if owner == 0:',
    '    os.setsid()',
    '    descendant = os.fork()',
    '    if descendant > 0:',
    '        with open(ready_path, "w", encoding="utf-8") as ready: json.dump({"token": token, "pid": os.getpid()}, ready, sort_keys=True, separators=(",", ":"))',
    '        os._exit(0)',
    '    devnull = os.open("/dev/null", os.O_RDWR)',
    '    for fd in (0, 1, 2): os.dup2(devnull, fd)',
    '    os.close(devnull)',
    '    while not stopped(): time.sleep(0.02)',
    '    os._exit(0)',
    'os.waitpid(owner, 0)',
    'facts = {',
    '    "ready": True,',
    '    "pidNamespace": os.readlink("/proc/self/ns/pid") != host_pid_ns,',
    '    "networkNamespace": os.readlink("/proc/self/ns/net") != host_net_ns,',
    '    "workspaceIsolation": not os.path.exists(outside_path),',
    '}',
    'with open(facts_path, "w", encoding="utf-8") as facts_file: json.dump(facts, facts_file, sort_keys=True, separators=(",", ":"))',
    'while not stopped(): time.sleep(0.02)',
    'os._exit(0)',
  ].join('\n');
}

export function createNativeLinuxFullChainHostV1(): LinuxFullChainHostV1 {
  return {
    platform: process.platform,
    findExecutable: (name) => Bun.which(name) ?? undefined,
    pathExists: (path) => existsSync(path),
    readText: (path) => readFileSync(path, 'utf8'),
    readLink: (path) => readlinkSync(path),
    createTempDirectory: () => mkdtempSync(join(tmpdir(), 'kite-linux-full-chain-')),
    writeText: writeNativeExclusiveTextV1,
    removePath: removeNativeTemporaryRootV1,
    compileReleaseEntrypoint: compileOssReleaseExecutableV1,
    run: runNativeBoundedV1,
    runSupervised: runNativeSupervisedV1,
    findOwnedProcesses: findNativeOwnedProcessesV1,
    readProcessStartIdentity: (pid) => readComparablePosixProcessStartIdentityV1(pid) ?? undefined,
    killOwnedProcess: killNativeOwnedProcessV1,
    sleep: (milliseconds) => Bun.sleep(milliseconds),
  };
}

/**
 * Return the source worktree boundary used by the candidate writer. The
 * boundary is derived from this eval module rather than the caller's cwd, so
 * an explicit output cannot silently land in whichever checkout launched it.
 */
export function resolveLinuxFullChainWorktreeRootV1(): string {
  return realpathSync.native(LINUX_FULL_CHAIN_WORKTREE_ROOT_V1);
}

function writeNativeExclusiveTextV1(path: string, contents: string, mode = 0o600): void {
  writeFileSync(path, contents, { flag: 'wx', mode });
}

function removeNativeTemporaryRootV1(path: string): void {
  const target = resolve(path);
  const root = lstatSync(target);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error('temporary root identity is not a directory');
  }
  if (realpathSync.native(target) !== target) {
    throw new Error('temporary root canonical identity mismatch');
  }
  assertNoSymlinkInTemporaryTreeV1(target);
  rmSync(target, { recursive: true, force: false });
  if (existsSync(target)) throw new Error('temporary root removal was not confirmed');
}

function assertNoSymlinkInTemporaryTreeV1(path: string): void {
  const entries = readdirSync(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error('temporary root contains a symlink');
    if (entry.isDirectory()) assertNoSymlinkInTemporaryTreeV1(child);
  }
}

async function runNativeBoundedV1(
  argv: readonly string[],
  timeoutMs: number,
): Promise<LinuxFullChainCommandResultV1> {
  const child = Bun.spawn([...argv], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: '/usr/bin:/bin' },
  });
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanupAttempted = false;
  let completed = false;
  const read = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
    if (!stream) return '';
    const reader = stream.getReader();
    readers.push(reader);
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > COMMAND_OUTPUT_LIMIT_BYTES) {
          try {
            await reader.cancel('bounded output exceeded');
          } catch {
            // The outer cancellation path still releases this reader.
          }
          throw new Error('bounded output exceeded');
        }
        chunks.push(next.value);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // A concurrent bounded cancellation may already have released it.
      }
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  };
  const cancelReaders = async (): Promise<void> => {
    await Promise.all(
      readers.map(async (reader) => {
        try {
          await boundedNativeWaitV1(reader.cancel('native command cancelled'));
        } catch {
          // Reader cancellation is best-effort; releasing the lock below is
          // still required so a detached descendant cannot retain the pipe.
        }
        try {
          reader.releaseLock();
        } catch {
          // It may already be released by the read loop.
        }
      }),
    );
  };
  const abort = async (): Promise<void> => {
    if (cleanupAttempted) return;
    cleanupAttempted = true;
    await cancelReaders();
    try {
      child.kill('SIGKILL');
    } catch {
      // The child may have exited between the bounded read and the kill.
    }
    await boundedNativeWaitV1(child.exited, NATIVE_PROCESS_SETTLE_TIMEOUT_MS);
  };
  const timeoutMarker = Symbol('native command timeout');
  try {
    const result = await Promise.race([
      Promise.all([child.exited, read(child.stdout), read(child.stderr)]).then(
        ([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr, timedOut: false }),
      ),
      new Promise<typeof timeoutMarker>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(timeoutMarker), timeoutMs);
      }),
    ]);
    if (result === timeoutMarker) {
      await abort();
      return { exitCode: 124, stdout: '', stderr: '', timedOut: true };
    }
    completed = true;
    return result;
  } catch {
    await abort();
    return { exitCode: 124, stdout: '', stderr: '', timedOut: true };
  } finally {
    if (timer) clearTimeout(timer);
    if (!completed) await abort();
  }
}

async function boundedNativeWaitV1<T>(
  promise: PromiseLike<T>,
  timeoutMs = NATIVE_READER_SETTLE_TIMEOUT_MS,
): Promise<T | undefined> {
  return Promise.race([Promise.resolve(promise), Bun.sleep(timeoutMs).then(() => undefined)]);
}

async function runNativeSupervisedV1(input: {
  readonly supervisorExecutablePath: string;
  readonly prepared: PreparedSandboxExecutionV1;
  readonly fixtureFactsPath: string;
  readonly descendantToken: string;
  readonly commandTimeoutMs: number;
}): Promise<LinuxFullChainSupervisedResultV1> {
  let descendantObserved = false;
  const started = Date.now();
  const dispatchId = randomUUID();
  const supervisorNonce = randomUUID();
  const lifecycle = createCandidateSupervisorLifecycleV1();
  const preparation = candidatePreparationV1(input.prepared);
  const preparationIntent = await lifecycle.recordPreparationIntent(preparation);
  if (!isCandidateDigestV1(preparationIntent.intentDigest)) {
    throw new Error('candidate preparation intent digest was invalid');
  }
  if (!(await lifecycle.recordPreparationReady(input.prepared))) {
    throw new Error('candidate preparation-ready acknowledgement failed');
  }
  const dispatch = await lifecycle.recordExecutionDispatchIntent(input.prepared, {
    dispatchId,
    supervisorNonce,
  });
  const dispatchIntentDigest = dispatch.dispatchIntentDigest;
  const execution = executePosixSupervisedV1({
    shell: {
      workspace: input.prepared.canonicalWorkspace,
      command: 'linux full-chain candidate fixture',
    },
    prepared: input.prepared,
    lifecycle,
    dispatchId,
    supervisorNonce,
    dispatchIntentDigest,
    timeoutMs: input.commandTimeoutMs,
    supervisorExecutablePath: input.supervisorExecutablePath,
  });
  try {
    while (Date.now() - started < input.commandTimeoutMs) {
      if (existsSync(input.fixtureFactsPath)) {
        descendantObserved = findNativeOwnedProcessesV1(input.descendantToken).length > 0;
        if (descendantObserved) break;
      }
      await Bun.sleep(20);
    }
    const result = await execution;
    return {
      outcomeOk: result.outcome.ok,
      timedOut: result.outcome.terminationReason === 'timed_out',
      cleanupConfirmed:
        result.cleanupConfirmed &&
        result.outcome.processCleanup?.confirmedExited === true &&
        lifecycle.supervisorStarted,
      descendantObserved,
    };
  } finally {
    // If inventory/fixture observation fails, still wait for the supervisor
    // promise so its own bounded termination path gets a chance
    // to complete before the outer cleanup contract runs.
    await execution.catch(() => undefined);
  }
}

export type CandidateSupervisorLifecycleStateV1 =
  | 'empty'
  | 'intent_recorded'
  | 'ready'
  | 'dispatch_recorded'
  | 'supervisor_started';

export interface CandidateSupervisorLifecycleV1 extends SandboxPreparationLifecycleV1 {
  /** Candidate-only state; never a durable Runtime lifecycle receipt. */
  readonly durability: 'in_memory_non_durable';
  readonly state: CandidateSupervisorLifecycleStateV1;
  readonly supervisorStarted: boolean;
}

interface CandidatePreparationRecordV1 {
  readonly preparation: SandboxPreparationV1;
  readonly preparationDigest: string;
  readonly intentDigest: string;
}

interface CandidatePreparedRecordV1 {
  readonly prepared: PreparedSandboxExecutionV1;
  readonly preparedPlanDigest: string;
}

interface CandidateDispatchRecordV1 {
  readonly dispatchId: string;
  readonly supervisorNonce: string;
  readonly dispatchIntentDigest: string;
}

/**
 * Candidate-only in-memory lifecycle ledger. It intentionally has no durable
 * persistence, recovery authority, or production receipt semantics.
 */
export function createCandidateSupervisorLifecycleV1(): CandidateSupervisorLifecycleV1 {
  let state: CandidateSupervisorLifecycleStateV1 = 'empty';
  let preparationRecord: CandidatePreparationRecordV1 | undefined;
  let preparedRecord: CandidatePreparedRecordV1 | undefined;
  let dispatchRecord: CandidateDispatchRecordV1 | undefined;

  const samePrepared = (prepared: Readonly<PreparedSandboxExecutionV1>): boolean => {
    if (!preparedRecord) return false;
    try {
      return (
        sandboxPreparedPlanDigestV1(prepared) === preparedRecord.preparedPlanDigest &&
        sandboxPreparedPlanDigestV1(preparedRecord.prepared) === preparedRecord.preparedPlanDigest
      );
    } catch {
      return false;
    }
  };

  const samePreparation = (prepared: Readonly<PreparedSandboxExecutionV1>): boolean => {
    if (!preparationRecord) return false;
    try {
      const candidatePreparation = candidatePreparationV1(prepared);
      return (
        candidatePreparedBindsPreparationV1(prepared, candidatePreparation) &&
        prepared.preparationDigest === preparationRecord.preparationDigest &&
        sandboxPreparationDigestV1(candidatePreparation) === preparationRecord.preparationDigest &&
        sandboxPreparationDigestV1(preparationRecord.preparation) ===
          preparationRecord.preparationDigest &&
        candidateDigestV1('preparation-identity', candidatePreparation) ===
          candidateDigestV1('preparation-identity', preparationRecord.preparation)
      );
    } catch {
      return false;
    }
  };

  const lifecycle: CandidateSupervisorLifecycleV1 = {
    durability: 'in_memory_non_durable',
    get state() {
      return state;
    },
    get supervisorStarted() {
      return state === 'supervisor_started';
    },
    async recordPreparationIntent(preparation: Readonly<SandboxPreparationV1>) {
      if (state !== 'empty') {
        throw new Error('candidate preparation intent is out of order');
      }
      const snapshot = structuredClone(preparation);
      const preparationDigest = sandboxPreparationDigestV1(snapshot);
      const intentDigest = candidateDigestV1('preparation-intent', {
        preparationDigest,
        preparation: snapshot,
      });
      preparationRecord = { preparation: snapshot, preparationDigest, intentDigest };
      state = 'intent_recorded';
      return { intentDigest };
    },
    async recordPreparationReady(prepared) {
      if (state !== 'intent_recorded' || !preparationRecord) return false;
      if (
        prepared.schema !== 'kite.sandbox-execution-provider.v1' ||
        prepared.kind !== 'prepared_sandbox_execution' ||
        !isCandidateDigestV1(prepared.preparationDigest) ||
        !samePreparation(prepared)
      ) {
        return false;
      }
      try {
        const snapshot = structuredClone(prepared);
        const preparedPlanDigest = sandboxPreparedPlanDigestV1(snapshot);
        if (!isCandidateDigestV1(preparedPlanDigest)) return false;
        preparedRecord = { prepared: snapshot, preparedPlanDigest };
        state = 'ready';
        return true;
      } catch {
        return false;
      }
    },
    async recordExecutionDispatchIntent(prepared, dispatch) {
      if (state !== 'ready' || !preparedRecord || !preparationRecord) {
        throw new Error('candidate dispatch requires preparation-ready state');
      }
      if (!samePrepared(prepared) || !samePreparation(prepared)) {
        throw new Error('candidate dispatch prepared identity mismatch');
      }
      if (
        typeof dispatch.dispatchId !== 'string' ||
        dispatch.dispatchId.length === 0 ||
        typeof dispatch.supervisorNonce !== 'string' ||
        dispatch.supervisorNonce.length === 0
      ) {
        throw new Error('candidate dispatch intent identity mismatch');
      }
      const dispatchIntentDigest = candidateDigestV1('dispatch', {
        dispatchId: dispatch.dispatchId,
        supervisorNonce: dispatch.supervisorNonce,
        preparationIntentDigest: preparationRecord.intentDigest,
        preparedPlanDigest: preparedRecord.preparedPlanDigest,
      });
      dispatchRecord = {
        dispatchId: dispatch.dispatchId,
        supervisorNonce: dispatch.supervisorNonce,
        dispatchIntentDigest,
      };
      state = 'dispatch_recorded';
      return { dispatchIntentDigest };
    },
    async recordExecutionSupervisorStarted(prepared, started) {
      if (state !== 'dispatch_recorded' || !dispatchRecord || !samePrepared(prepared)) {
        return false;
      }
      const valid =
        started.dispatchId === dispatchRecord.dispatchId &&
        started.dispatchIntentDigest === dispatchRecord.dispatchIntentDigest &&
        Number.isSafeInteger(started.supervisorPid) &&
        started.supervisorPid > 0 &&
        Number.isSafeInteger(started.processGroupId) &&
        started.processGroupId > 0 &&
        started.supervisorPid === started.processGroupId &&
        typeof started.processStartIdentity === 'string' &&
        started.processStartIdentity.length > 0;
      if (!valid) return false;
      state = 'supervisor_started';
      return true;
    },
    // The outer harness owns token/process cleanup. These interface methods
    // remain candidate-safe if a future seam calls them, but this harness
    // does not treat their in-memory result as a durable disposal receipt.
    async recordDisposalIntent() {
      return {
        purpose: 'dispose' as const,
        lifecycleIntentDigest: candidateDigestV1('disposal-intent', {
          state,
          preparationIntentDigest: preparationRecord?.intentDigest ?? null,
          dispatchIntentDigest: dispatchRecord?.dispatchIntentDigest ?? null,
        }),
        cleanupAttempt: 1,
      };
    },
    async recordDisposalReceipt(receipt) {
      return receipt.disposed && state === 'supervisor_started';
    },
  };
  return lifecycle;
}

function candidatePreparedBindsPreparationV1(
  prepared: Readonly<PreparedSandboxExecutionV1>,
  preparation: Readonly<SandboxPreparationV1>,
): boolean {
  const recoveryPayload = prepared.cleanup.recoveryPayload;
  return (
    prepared.schema === 'kite.sandbox-execution-provider.v1' &&
    prepared.kind === 'prepared_sandbox_execution' &&
    prepared.planId.length > 0 &&
    prepared.toolCallId === preparation.toolCallId &&
    prepared.capabilityId === preparation.capabilityId &&
    prepared.capabilityRevision === preparation.capabilityRevision &&
    prepared.invocationId === preparation.invocationId &&
    prepared.attempt === preparation.attempt &&
    prepared.canonicalWorkspace === preparation.canonicalWorkspace &&
    prepared.cwd === preparation.canonicalWorkspace &&
    prepared.effectiveEffectsDigest === preparation.effectiveEffectsDigest &&
    prepared.admissionDigest === preparation.admissionDigest &&
    prepared.commandDigest === preparation.commandDigest &&
    candidateDigestV1('argv', prepared.approvedArgv) ===
      candidateDigestV1('argv', preparation.argv) &&
    candidateDigestV1('argv', prepared.argv) === candidateDigestV1('argv', preparation.argv) &&
    sandboxCommandDigestV1(prepared.approvedArgv) === preparation.commandDigest &&
    prepared.env === null &&
    prepared.stdin === null &&
    prepared.transport === 'stdio' &&
    prepared.backend === 'bubblewrap' &&
    candidateDigestV1('backend-capabilities', prepared.backendCapabilities) ===
      candidateDigestV1('backend-capabilities', sandboxBackendCapabilitiesV1('bubblewrap')) &&
    prepared.enforcement === 'partial' &&
    prepared.resourceSemantics === 'allocating' &&
    prepared.cleanup.kind === 'runtime_directory' &&
    prepared.cleanup.resourceId === 'linux-full-chain-eval-runtime' &&
    Object.keys(recoveryPayload).sort().join(',') === 'controlRoot,dataRoot' &&
    typeof recoveryPayload.controlRoot === 'string' &&
    typeof recoveryPayload.dataRoot === 'string' &&
    recoveryPayload.controlRoot.length > 0 &&
    recoveryPayload.dataRoot.length > 0
  );
}

function findNativeOwnedProcessesV1(token: string): readonly number[] {
  const owned: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    throw new Error('process_inventory_unavailable');
  }
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const commandLine = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      if (commandLine.includes(token)) owned.push(Number(entry));
    } catch (error) {
      // A process can exit between directory enumeration and cmdline read;
      // every other inventory error is fail-closed rather than an empty proof.
      if (isErrno(error, 'ENOENT')) continue;
      throw new Error('process_inventory_unavailable');
    }
  }
  return owned;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function killNativeOwnedProcessV1(pid: number, startIdentity: string): boolean {
  if (readComparablePosixProcessStartIdentityV1(pid) !== startIdentity) return false;
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

function assertOwnedDirectoryV1(path: string): void {
  const status = lstatSync(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error('artifact parent must be a canonical directory');
  }
  if ((status.mode & 0o777) !== 0o700) {
    throw new Error('artifact parent must have POSIX mode 0700');
  }
  const uid = process.getuid?.();
  if (process.platform !== 'win32' && uid !== undefined && status.uid !== uid) {
    throw new Error('artifact parent is not owned by the current user');
  }
}

function assertPathOutsideWorktreeV1(path: string, worktreeRoot: string): void {
  const relativePath = relative(worktreeRoot, path);
  if (
    relativePath === '' ||
    (!isAbsolute(relativePath) &&
      relativePath !== '..' &&
      !relativePath.startsWith('../') &&
      !relativePath.startsWith('..\\'))
  ) {
    throw new Error('candidate artifact must be outside the worktree');
  }
}

function ensureCanonicalArtifactParentV1(parent: string, worktreeRoot: string): string {
  const missing: string[] = [];
  let current = parent;
  while (true) {
    try {
      const status = lstatSync(current);
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new Error('artifact parent must be a canonical directory');
      }
      const canonicalCurrent = realpathSync.native(current);
      if (canonicalCurrent !== current) {
        throw new Error('artifact parent must be a canonical directory');
      }
      assertPathOutsideWorktreeV1(canonicalCurrent, worktreeRoot);
      break;
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
      const next = dirname(current);
      if (next === current) throw new Error('artifact parent does not exist');
      missing.push(current);
      current = next;
    }
  }
  while (missing.length > 0) {
    const candidate = missing.pop()!;
    mkdirSync(candidate, { mode: 0o700 });
    assertOwnedDirectoryV1(candidate);
  }
  assertOwnedDirectoryV1(parent);
  const canonicalParent = realpathSync.native(parent);
  if (canonicalParent !== parent) {
    throw new Error('artifact parent must be a canonical directory');
  }
  assertPathOutsideWorktreeV1(canonicalParent, worktreeRoot);
  assertOwnedDirectoryV1(canonicalParent);
  return canonicalParent;
}

function sameFsIdentityV1(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertOwnedArtifactFileV1(
  status: ReturnType<typeof fstatSync>,
  expectedSize: number,
): void {
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw new Error('candidate artifact must be a single regular file');
  }
  const uid = process.getuid?.();
  if (process.platform !== 'win32' && uid !== undefined && status.uid !== uid) {
    throw new Error('candidate artifact is not owned by the current user');
  }
  if (status.size !== expectedSize) throw new Error('candidate artifact size changed');
}

function canonicalLinuxFullChainReportBytesV1(value: LinuxFullChainCandidateReportV1): Uint8Array {
  const { digest, ...material } = value;
  const expectedDigest = sha256DomainSeparated(
    LINUX_FULL_CHAIN_SCHEMA_V1,
    canonicalJsonBytes(material),
  );
  if (!isCandidateDigestV1(digest) || digest !== expectedDigest) {
    throw new Error('candidate report digest mismatch');
  }
  return canonicalJsonBytes(value);
}

/** Write the canonical owner-only candidate artifact without overwriting. */
export function writeLinuxFullChainArtifactV1(
  outputPath: string,
  value: LinuxFullChainCandidateReportV1,
): void {
  const bytes = canonicalLinuxFullChainReportBytesV1(value);
  const lexicalTarget = resolve(outputPath);
  const parent = dirname(lexicalTarget);
  const worktreeRoot = resolveLinuxFullChainWorktreeRootV1();
  assertPathOutsideWorktreeV1(lexicalTarget, worktreeRoot);
  const canonicalParent = ensureCanonicalArtifactParentV1(parent, worktreeRoot);
  const target = resolve(canonicalParent, basename(lexicalTarget));

  let descriptor: number | undefined;
  let createdIdentity: { readonly dev: number; readonly ino: number } | undefined;
  try {
    descriptor = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const before = fstatSync(descriptor);
    assertOwnedArtifactFileV1(before, 0);
    createdIdentity = { dev: before.dev, ino: before.ino };
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, bytes);
    const after = fstatSync(descriptor);
    assertOwnedArtifactFileV1(after, bytes.byteLength);
    if (!sameFsIdentityV1(before, after)) throw new Error('candidate artifact identity changed');
    closeSync(descriptor);
    descriptor = undefined;

    const published = lstatSync(target);
    assertOwnedArtifactFileV1(published, bytes.byteLength);
    if (
      published.isSymbolicLink() ||
      !published.isFile() ||
      published.nlink !== 1 ||
      !sameFsIdentityV1(published, after) ||
      realpathSync.native(target) !== target
    ) {
      throw new Error('candidate artifact publication identity changed');
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the publication error below.
      }
    }
    if (createdIdentity) {
      try {
        const current = lstatSync(target);
        if (
          current.isFile() &&
          !current.isSymbolicLink() &&
          sameFsIdentityV1(current, createdIdentity)
        ) {
          unlinkSync(target);
        }
      } catch {
        // Never remove an object whose identity is no longer ours.
      }
    }
    throw error;
  }
}

function nativeOptInFromEnvironment(): boolean {
  return process.env.KITE_RUN_LINUX_FULL_CHAIN === '1';
}

async function main(): Promise<void> {
  const outputPath = requireExplicitLinuxFullChainOutputV1(process.argv);
  const nativeOptIn = nativeOptInFromEnvironment() || process.argv.includes('--native');
  const value = await runLinuxFullChainCandidateV1({ nativeOptIn });
  writeLinuxFullChainArtifactV1(outputPath, value);
  process.stdout.write(`${new TextDecoder().decode(canonicalJsonBytes(value))}\n`);
}

export function requireExplicitLinuxFullChainOutputV1(args: readonly string[]): string {
  const outputIndexes = args.flatMap((arg, index) => (arg === '--output' ? [index] : []));
  if (outputIndexes.length !== 1) {
    throw new Error('linux full-chain diagnostic requires exactly one --output path');
  }
  const outputIndex = outputIndexes[0]!;
  const outputPath = args[outputIndex + 1];
  if (!outputPath || outputPath.startsWith('--')) {
    throw new Error('linux full-chain diagnostic requires an explicit --output path');
  }
  return resolve(outputPath);
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    // Exclusive-create publication and native failures are fail-closed: a
    // stale or partial artifact must never be presented as candidate output.
    process.stderr.write('linux full-chain diagnostic artifact was not published.\n');
    process.exitCode = 1;
  }
}
