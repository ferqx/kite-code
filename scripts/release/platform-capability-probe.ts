import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { composeAppSandboxExecutorV1 } from '../../src/app/sandbox/composition';
import { generateBwrapArgs } from '../../src/core/sandbox/bwrap';
import { readExecutionEnvironmentIdentityV1 } from '../../src/core/sandbox/environment-identity';
import { detectSandboxBackend, type SandboxBackend } from '../../src/core/sandbox/platform';
import {
  currentProcessTreeCapabilityV1,
  type ProcessTreeHardLimitMechanismV1,
} from '../../src/core/sandbox/process-tree-capability';
import { generateSandboxProfile } from '../../src/core/sandbox/profile';
import { findApplySeccomp } from '../../src/core/sandbox/seccomp';
import { canonicalJsonBytes } from './canonical-json';

export type NativeProbeVerdict = 'enforced' | 'unsupported' | 'unavailable';
export type PlatformSupportOutcome = 'supported' | 'read_only_only' | 'excluded';
export type GithubHostedRunnerClassV1 =
  | 'macos-15-arm64-github-hosted'
  | 'ubuntu-24.04-x64-github-hosted'
  | 'windows-2025-x64-github-hosted';

const GITHUB_HOSTED_RUNNER_CLASSES_V1 = new Set<GithubHostedRunnerClassV1>([
  'macos-15-arm64-github-hosted',
  'ubuntu-24.04-x64-github-hosted',
  'windows-2025-x64-github-hosted',
]);

const nativeProbeVerdictSchema = z.enum(['enforced', 'unsupported', 'unavailable']);
const boundedIdentitySchema = z.string().trim().min(1).max(512);
export const platformCapabilitySourceV1Schema = z
  .object({
    repository: z.literal('ferqx/kite-code'),
    repositoryId: z.literal('1218896626'),
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    ref: z.string().regex(/^refs\/(?:heads|tags|pull)\/[A-Za-z0-9._/-]{1,240}$/),
    workflow: z.literal('.github/workflows/platform-capability-probe.yml'),
    workflowRef: z
      .string()
      .regex(
        /^ferqx\/kite-code\/\.github\/workflows\/platform-capability-probe\.yml@refs\/(?:heads|tags|pull)\/[A-Za-z0-9._/-]{1,240}$/,
      ),
    workflowSha: z.string().regex(/^[a-f0-9]{40}$/),
    runId: z.string().regex(/^[1-9][0-9]*$/),
    runAttempt: z.string().regex(/^[1-9][0-9]*$/),
    runnerClass: z.enum([
      'macos-15-arm64-github-hosted',
      'ubuntu-24.04-x64-github-hosted',
      'windows-2025-x64-github-hosted',
    ]),
  })
  .strict()
  .superRefine((source, context) => {
    if (source.workflowRef !== `${source.repository}/${source.workflow}@${source.ref}`) {
      context.addIssue({
        code: 'custom',
        path: ['workflowRef'],
        message: 'workflowRef must bind the canonical workflow to the exact source ref',
      });
    }
  });

const filesystemEvidenceSchema = z
  .object({
    workspaceRead: nativeProbeVerdictSchema,
    workspaceWrite: nativeProbeVerdictSchema,
    workspaceReadOnly: nativeProbeVerdictSchema,
    workspaceOutsideReadDeny: nativeProbeVerdictSchema,
    workspaceOutsideWriteDeny: nativeProbeVerdictSchema,
    protectedGitReadDeny: nativeProbeVerdictSchema,
    protectedGitWriteDeny: nativeProbeVerdictSchema,
    protectedAgentConfigReadDeny: nativeProbeVerdictSchema,
    protectedAgentConfigWriteDeny: nativeProbeVerdictSchema,
    protectedCredentialReadDeny: nativeProbeVerdictSchema,
    protectedCredentialWriteDeny: nativeProbeVerdictSchema,
    protectedShellProfileReadDeny: nativeProbeVerdictSchema,
    protectedShellProfileWriteDeny: nativeProbeVerdictSchema,
    symlinkEscapeReadDeny: nativeProbeVerdictSchema,
    symlinkEscapeWriteDeny: nativeProbeVerdictSchema,
    inProcessReadOnly: nativeProbeVerdictSchema,
  })
  .strict();

export const platformCapabilityEvidenceV1Schema = z
  .object({
    version: z.literal(1),
    evidenceId: z.string().uuid(),
    capturedAt: z.iso.datetime({ offset: true }),
    platform: z.enum(['darwin', 'linux', 'win32']),
    osRelease: boundedIdentitySchema,
    osVersion: boundedIdentitySchema,
    arch: z.enum(['arm64', 'x64']),
    bunVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
    backend: z.enum(['seatbelt', 'bubblewrap', 'none']),
    selectedNetworkMode: z.enum(['off', 'allowlist']),
    processCapabilitySurface: z
      .object({ shell: z.boolean(), forkedSkill: z.boolean(), localStdioMcp: z.boolean() })
      .strict(),
    source: platformCapabilitySourceV1Schema.optional(),
    environmentIdentity: z.object({ exactOsVersion: nativeProbeVerdictSchema }).strict(),
    backendIsolation: z.object({ syscallFilter: nativeProbeVerdictSchema }).strict(),
    entrypoints: z
      .object({ tui: nativeProbeVerdictSchema, foregroundCli: nativeProbeVerdictSchema })
      .strict(),
    filesystem: filesystemEvidenceSchema,
    network: z
      .object({ off: nativeProbeVerdictSchema, allowlist: nativeProbeVerdictSchema })
      .strict(),
    processTree: z
      .object({
        hardCountMechanism: z.enum([
          'none',
          'cgroup_pids',
          'windows_job_active_process_limit',
          'accepted_equivalent',
        ]),
        hardCountLimit: z.enum(['enforced', 'unsupported']),
        killWithoutResidualDescendants: z.enum(['enforced', 'unsupported']),
      })
      .strict(),
    inheritance: z
      .object({
        shellDescendant: nativeProbeVerdictSchema,
        shellGrandchild: nativeProbeVerdictSchema,
        forkedSkill: nativeProbeVerdictSchema,
        localStdioMcp: nativeProbeVerdictSchema,
      })
      .strict(),
    outcome: z.enum(['supported', 'read_only_only', 'excluded']),
    productionSupported: z.literal(false),
    limitations: z.array(z.string().trim().min(1).max(512)).max(128),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export interface PlatformCapabilityEvidenceV1 {
  version: 1;
  evidenceId: string;
  capturedAt: string;
  platform: NodeJS.Platform;
  osRelease: string;
  osVersion: string;
  arch: string;
  bunVersion: string;
  backend: SandboxBackend;
  selectedNetworkMode: 'off' | 'allowlist';
  processCapabilitySurface: {
    shell: boolean;
    forkedSkill: boolean;
    localStdioMcp: boolean;
  };
  source?: {
    repository: string;
    repositoryId: string;
    headSha: string;
    ref: string;
    workflow: string;
    workflowRef: string;
    workflowSha: string;
    runId: string;
    runAttempt: string;
    runnerClass: GithubHostedRunnerClassV1;
  };
  environmentIdentity: {
    exactOsVersion: NativeProbeVerdict;
  };
  backendIsolation?: {
    /** Bubblewrap requires independent syscall-filter conformance before support. */
    syscallFilter: NativeProbeVerdict;
  };
  entrypoints: {
    tui: NativeProbeVerdict;
    foregroundCli: NativeProbeVerdict;
  };
  filesystem: {
    workspaceRead: NativeProbeVerdict;
    workspaceWrite: NativeProbeVerdict;
    workspaceReadOnly: NativeProbeVerdict;
    workspaceOutsideReadDeny: NativeProbeVerdict;
    workspaceOutsideWriteDeny: NativeProbeVerdict;
    protectedGitReadDeny: NativeProbeVerdict;
    protectedGitWriteDeny: NativeProbeVerdict;
    protectedAgentConfigReadDeny: NativeProbeVerdict;
    protectedAgentConfigWriteDeny: NativeProbeVerdict;
    protectedCredentialReadDeny: NativeProbeVerdict;
    protectedCredentialWriteDeny: NativeProbeVerdict;
    protectedShellProfileReadDeny: NativeProbeVerdict;
    protectedShellProfileWriteDeny: NativeProbeVerdict;
    symlinkEscapeReadDeny: NativeProbeVerdict;
    symlinkEscapeWriteDeny: NativeProbeVerdict;
    inProcessReadOnly: NativeProbeVerdict;
  };
  network: {
    off: NativeProbeVerdict;
    allowlist: NativeProbeVerdict;
  };
  processTree: {
    /** Additive V1 field; absent legacy artifacts normalize to `none`. */
    hardCountMechanism?: ProcessTreeHardLimitMechanismV1;
    hardCountLimit: Exclude<NativeProbeVerdict, 'unavailable'>;
    killWithoutResidualDescendants: Exclude<NativeProbeVerdict, 'unavailable'>;
  };
  inheritance: {
    shellDescendant: NativeProbeVerdict;
    shellGrandchild: NativeProbeVerdict;
    forkedSkill: NativeProbeVerdict;
    localStdioMcp: NativeProbeVerdict;
  };
  outcome: PlatformSupportOutcome;
  productionSupported: false;
  limitations: string[];
  digest: string;
}

type EvidenceWithoutDigest = Omit<PlatformCapabilityEvidenceV1, 'digest'>;
type PlatformCapabilityProbeInputV1 = Omit<
  EvidenceWithoutDigest,
  'outcome' | 'productionSupported' | 'limitations'
>;
type FilesystemProbeResult = PlatformCapabilityEvidenceV1['filesystem'] & {
  shellGrandchildDeny: NativeProbeVerdict;
};

export async function runPlatformCapabilityProbe(): Promise<PlatformCapabilityEvidenceV1> {
  const backend = detectSandboxBackend();
  const root = mkdtempSync(join(tmpdir(), 'kite-platform-capability-probe-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  mkdirSync(join(workspace, '.git'), { recursive: true });
  mkdirSync(outside);
  symlinkSync(
    outside,
    join(workspace, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  try {
    const environmentIdentity = readExecutionEnvironmentIdentityV1();
    const { shellGrandchildDeny, ...filesystem } = await probeFilesystem(
      backend,
      workspace,
      outside,
    );
    const networkOff = await probeNetworkOff(backend, workspace);
    const processTree = await probeProcessTree(backend, workspace);
    const entrypoints = await probeEntrypoints(backend, workspace);
    const syscallFilter = await probeSyscallFilter(backend, workspace);
    const partial: Omit<EvidenceWithoutDigest, 'outcome' | 'productionSupported' | 'limitations'> =
      {
        version: 1,
        evidenceId: randomUUID(),
        capturedAt: new Date().toISOString(),
        platform: environmentIdentity.platform,
        osRelease: environmentIdentity.osRelease,
        osVersion: environmentIdentity.osVersion,
        arch: environmentIdentity.arch,
        bunVersion: environmentIdentity.bunVersion,
        backend,
        selectedNetworkMode: 'off',
        processCapabilitySurface: {
          shell: true,
          forkedSkill: false,
          localStdioMcp: false,
        },
        ...githubEvidenceSource(environmentIdentity),
        environmentIdentity: {
          exactOsVersion: environmentIdentity.exactOsVersionAvailable ? 'enforced' : 'unavailable',
        },
        backendIsolation: {
          syscallFilter,
        },
        entrypoints,
        filesystem: {
          ...filesystem,
          // Task 1B.1 must separately prove the no-process fallback allowlist.
          inProcessReadOnly: 'unsupported',
        },
        network: {
          off: networkOff,
          // No current backend implements DNS/redirect-safe host allowlisting.
          allowlist: 'unsupported',
        },
        processTree,
        inheritance: {
          shellDescendant: filesystem.workspaceOutsideWriteDeny,
          shellGrandchild: shellGrandchildDeny,
          // These capabilities are deliberately outside the first platform surface.
          forkedSkill: 'unsupported',
          localStdioMcp: 'unsupported',
        },
      };
    const outcome = evaluatePlatformSupport(partial);
    const limitations = collectLimitations(partial);
    const withoutDigest: EvidenceWithoutDigest = {
      ...partial,
      outcome,
      // Native probes establish only technical capability. Production admission
      // additionally requires an accepted ADR, closed D-04, and a pinned matrix.
      productionSupported: false,
      limitations,
    };
    return {
      ...withoutDigest,
      digest: computePlatformCapabilityEvidenceDigestV1(withoutDigest),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function evaluatePlatformSupport(
  evidence: PlatformCapabilityProbeInputV1,
): PlatformSupportOutcome {
  const hardCountMechanism = evidence.processTree.hardCountMechanism ?? 'none';
  const selectedNetworkBoundary =
    evidence.selectedNetworkMode === 'off' ? evidence.network.off : evidence.network.allowlist;
  const processCapabilities = [
    evidence.environmentIdentity.exactOsVersion,
    evidence.entrypoints.tui,
    evidence.entrypoints.foregroundCli,
    evidence.filesystem.workspaceRead,
    evidence.filesystem.workspaceWrite,
    evidence.filesystem.workspaceReadOnly,
    evidence.filesystem.workspaceOutsideReadDeny,
    evidence.filesystem.workspaceOutsideWriteDeny,
    evidence.filesystem.protectedGitReadDeny,
    evidence.filesystem.protectedGitWriteDeny,
    evidence.filesystem.protectedAgentConfigReadDeny,
    evidence.filesystem.protectedAgentConfigWriteDeny,
    evidence.filesystem.protectedCredentialReadDeny,
    evidence.filesystem.protectedCredentialWriteDeny,
    evidence.filesystem.protectedShellProfileReadDeny,
    evidence.filesystem.protectedShellProfileWriteDeny,
    evidence.filesystem.symlinkEscapeReadDeny,
    evidence.filesystem.symlinkEscapeWriteDeny,
    selectedNetworkBoundary,
    evidence.processTree.hardCountLimit,
    evidence.processTree.killWithoutResidualDescendants,
    evidence.inheritance.shellDescendant,
    evidence.inheritance.shellGrandchild,
    ...(evidence.processCapabilitySurface.forkedSkill ? [evidence.inheritance.forkedSkill] : []),
    ...(evidence.processCapabilitySurface.localStdioMcp
      ? [evidence.inheritance.localStdioMcp]
      : []),
    ...(evidence.backend === 'bubblewrap' ? [syscallFilterVerdict(evidence)] : []),
  ];
  if (
    evidence.processCapabilitySurface.shell === true &&
    evidence.backend !== 'none' &&
    hardCountMechanism !== 'none' &&
    processCapabilities.every((verdict) => verdict === 'enforced')
  ) {
    return 'supported';
  }
  if (
    evidence.environmentIdentity.exactOsVersion === 'enforced' &&
    evidence.entrypoints.tui === 'enforced' &&
    evidence.entrypoints.foregroundCli === 'enforced' &&
    evidence.filesystem.inProcessReadOnly === 'enforced' &&
    evidence.selectedNetworkMode === 'off' &&
    evidence.network.off === 'enforced'
  ) {
    return 'read_only_only';
  }
  return 'excluded';
}

async function probeFilesystem(
  backend: SandboxBackend,
  workspace: string,
  outside: string,
): Promise<FilesystemProbeResult> {
  if (backend === 'none') {
    return {
      workspaceRead: 'unavailable',
      workspaceWrite: 'unavailable',
      workspaceReadOnly: 'unsupported',
      workspaceOutsideReadDeny: 'unavailable',
      workspaceOutsideWriteDeny: 'unavailable',
      protectedGitReadDeny: 'unavailable',
      protectedGitWriteDeny: 'unavailable',
      protectedAgentConfigReadDeny: 'unavailable',
      protectedAgentConfigWriteDeny: 'unavailable',
      protectedCredentialReadDeny: 'unavailable',
      protectedCredentialWriteDeny: 'unavailable',
      protectedShellProfileReadDeny: 'unavailable',
      protectedShellProfileWriteDeny: 'unavailable',
      symlinkEscapeReadDeny: 'unavailable',
      symlinkEscapeWriteDeny: 'unavailable',
      inProcessReadOnly: 'unsupported',
      shellGrandchildDeny: 'unavailable',
    };
  }
  const workspaceReadable = join(workspace, 'readable.txt');
  const workspaceTarget = join(workspace, 'allowed.txt');
  const workspaceReadOnlyTarget = join(workspace, 'read-only-denied.txt');
  const grandchildWorkspaceTarget = join(workspace, 'grandchild-allowed.txt');
  const outsideReadable = join(outside, 'read-secret.txt');
  const outsideTarget = join(outside, 'denied.txt');
  const gitTarget = join(workspace, '.git', 'config');
  const agentConfigTarget = join(workspace, '.kite-code', 'kite-code.jsonc');
  const credentialTarget = join(workspace, '.env');
  const shellProfileTarget = join(workspace, '.profile');
  const symlinkReadable = join(outside, 'symlink-secret.txt');
  const symlinkTarget = join(workspace, 'escape', 'denied-via-link.txt');
  const grandchildTarget = join(outside, 'denied-via-grandchild.txt');
  writeFileSync(workspaceReadable, 'readable');
  writeFileSync(outsideReadable, 'outside-secret');
  writeFileSync(gitTarget, 'protected');
  mkdirSync(join(workspace, '.kite-code'));
  writeFileSync(agentConfigTarget, 'protected');
  writeFileSync(credentialTarget, 'protected');
  writeFileSync(shellProfileTarget, 'protected');
  writeFileSync(symlinkReadable, 'symlink-secret');
  const baseEnv = {
    PROBE_WORKSPACE_READABLE: workspaceReadable,
    PROBE_WORKSPACE_TARGET: workspaceTarget,
    PROBE_GRANDCHILD_WORKSPACE_TARGET: grandchildWorkspaceTarget,
    PROBE_OUTSIDE_READABLE: outsideReadable,
    PROBE_OUTSIDE_TARGET: outsideTarget,
    PROBE_GIT_TARGET: gitTarget,
    PROBE_AGENT_CONFIG_TARGET: agentConfigTarget,
    PROBE_CREDENTIAL_TARGET: credentialTarget,
    PROBE_SHELL_PROFILE_TARGET: shellProfileTarget,
    PROBE_SYMLINK_READABLE: join(workspace, 'escape', 'symlink-secret.txt'),
    PROBE_SYMLINK_TARGET: symlinkTarget,
    PROBE_GRANDCHILD_TARGET: grandchildTarget,
  };
  const workspaceReadResult = await runSandboxCommand(
    backend,
    workspace,
    'test "$(cat "$PROBE_WORKSPACE_READABLE")" = readable',
    baseEnv,
  );
  const workspaceResult = await runSandboxCommand(
    backend,
    workspace,
    'printf allowed > "$PROBE_WORKSPACE_TARGET"',
    baseEnv,
  );
  const workspaceReadOnlyResult = await runSandboxCommand(
    backend,
    workspace,
    'printf denied > "$PROBE_WORKSPACE_READ_ONLY_TARGET"',
    { ...baseEnv, PROBE_WORKSPACE_READ_ONLY_TARGET: workspaceReadOnlyTarget },
    { filesystemScope: 'read_only' },
  );
  const workspaceReadOnlyReadResult = await runSandboxCommand(
    backend,
    workspace,
    'test "$(cat "$PROBE_WORKSPACE_READABLE")" = readable',
    baseEnv,
    { filesystemScope: 'read_only' },
  );
  const outsideResult = await runSandboxCommand(
    backend,
    workspace,
    'printf denied > "$PROBE_OUTSIDE_TARGET"',
    baseEnv,
  );
  const outsideReadResult = await runSandboxCommand(
    backend,
    workspace,
    'cat "$PROBE_OUTSIDE_READABLE" >/dev/null',
    baseEnv,
  );
  const gitReadResult = await runSandboxCommand(
    backend,
    workspace,
    'cat "$PROBE_GIT_TARGET" >/dev/null',
    baseEnv,
  );
  const gitWriteResult = await runSandboxCommand(
    backend,
    workspace,
    'printf denied > "$PROBE_GIT_TARGET"',
    baseEnv,
  );
  const agentConfigReadResult = await runSandboxCommand(
    backend,
    workspace,
    'cat "$PROBE_AGENT_CONFIG_TARGET" >/dev/null',
    baseEnv,
  );
  const agentConfigWriteResult = await runSandboxCommand(
    backend,
    workspace,
    'printf denied > "$PROBE_AGENT_CONFIG_TARGET"',
    baseEnv,
  );
  const credentialReadResult = await runSandboxCommand(
    backend,
    workspace,
    'cat "$PROBE_CREDENTIAL_TARGET" >/dev/null',
    baseEnv,
  );
  const credentialWriteResult = await runSandboxCommand(
    backend,
    workspace,
    'printf denied > "$PROBE_CREDENTIAL_TARGET"',
    baseEnv,
  );
  const shellProfileReadResult = await runSandboxCommand(
    backend,
    workspace,
    'cat "$PROBE_SHELL_PROFILE_TARGET" >/dev/null',
    baseEnv,
  );
  const shellProfileWriteResult = await runSandboxCommand(
    backend,
    workspace,
    'printf denied > "$PROBE_SHELL_PROFILE_TARGET"',
    baseEnv,
  );
  const symlinkReadResult = await runSandboxCommand(
    backend,
    workspace,
    'cat "$PROBE_SYMLINK_READABLE" >/dev/null',
    baseEnv,
  );
  const symlinkWriteResult = await runSandboxCommand(
    backend,
    workspace,
    'printf denied > "$PROBE_SYMLINK_TARGET"',
    baseEnv,
  );
  const grandchildResult = await runSandboxCommand(
    backend,
    workspace,
    `/bin/sh -c 'printf denied > "$PROBE_GRANDCHILD_TARGET"'`,
    baseEnv,
  );
  const grandchildControl = await runSandboxCommand(
    backend,
    workspace,
    `/bin/sh -c 'printf allowed > "$PROBE_GRANDCHILD_WORKSPACE_TARGET"'`,
    baseEnv,
  );
  const workspaceWrite =
    workspaceResult.available && workspaceResult.code === 0 && existsSync(workspaceTarget)
      ? 'enforced'
      : workspaceResult.available
        ? 'unsupported'
        : 'unavailable';
  const backendUsable = workspaceWrite === 'enforced';
  const readControlUsable =
    backendUsable && workspaceReadResult.available && workspaceReadResult.code === 0;
  const readOnlyControlUsable =
    backendUsable &&
    workspaceReadOnlyReadResult.available &&
    workspaceReadOnlyReadResult.code === 0;
  const grandchildControlUsable =
    backendUsable &&
    grandchildControl.available &&
    grandchildControl.code === 0 &&
    existsSync(grandchildWorkspaceTarget);
  return {
    workspaceRead: readControlUsable
      ? 'enforced'
      : workspaceReadResult.available
        ? 'unsupported'
        : 'unavailable',
    workspaceWrite,
    workspaceReadOnly: deniedVerdict(
      workspaceReadOnlyResult,
      workspaceReadOnlyTarget,
      readOnlyControlUsable,
    ),
    workspaceOutsideReadDeny: deniedReadVerdict(outsideReadResult, readControlUsable),
    workspaceOutsideWriteDeny: deniedVerdict(outsideResult, outsideTarget, backendUsable),
    protectedGitReadDeny: deniedReadVerdict(gitReadResult, readControlUsable),
    protectedGitWriteDeny: deniedUnchangedVerdict(
      gitWriteResult,
      gitTarget,
      'protected',
      backendUsable,
    ),
    protectedAgentConfigReadDeny: deniedReadVerdict(agentConfigReadResult, readControlUsable),
    protectedAgentConfigWriteDeny: deniedUnchangedVerdict(
      agentConfigWriteResult,
      agentConfigTarget,
      'protected',
      backendUsable,
    ),
    protectedCredentialReadDeny: deniedReadVerdict(credentialReadResult, readControlUsable),
    protectedCredentialWriteDeny: deniedUnchangedVerdict(
      credentialWriteResult,
      credentialTarget,
      'protected',
      backendUsable,
    ),
    protectedShellProfileReadDeny: deniedReadVerdict(shellProfileReadResult, readControlUsable),
    protectedShellProfileWriteDeny: deniedUnchangedVerdict(
      shellProfileWriteResult,
      shellProfileTarget,
      'protected',
      backendUsable,
    ),
    symlinkEscapeReadDeny: deniedReadVerdict(symlinkReadResult, readControlUsable),
    symlinkEscapeWriteDeny: deniedVerdict(symlinkWriteResult, symlinkTarget, backendUsable),
    inProcessReadOnly: 'unsupported',
    shellGrandchildDeny: deniedVerdict(grandchildResult, grandchildTarget, grandchildControlUsable),
  };
}

async function probeNetworkOff(
  backend: SandboxBackend,
  workspace: string,
): Promise<NativeProbeVerdict> {
  const curl = Bun.which('curl');
  if (backend === 'none' || !curl) return 'unavailable';
  const control = await runSandboxCommand(backend, workspace, 'exit 0', {});
  if (!control.available || control.code !== 0) return 'unavailable';
  const nonLoopbackAddress = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .find((entry) => entry.family === 'IPv4' && !entry.internal)?.address;
  if (!nonLoopbackAddress) return 'unavailable';
  let requests = 0;
  const server = Bun.serve({
    hostname: '0.0.0.0',
    port: 0,
    fetch() {
      requests++;
      return new Response('reachable');
    },
  });
  try {
    const urls = [
      `http://127.0.0.1:${server.port}/loopback`,
      `http://${nonLoopbackAddress}:${server.port}/non-loopback`,
    ];
    for (const url of urls) {
      const positiveControl = Bun.spawn({
        cmd: [curl, '--noproxy', '*', '-fsS', '--max-time', '2', url],
        stdout: 'ignore',
        stderr: 'ignore',
      });
      if ((await positiveControl.exited) !== 0) return 'unavailable';
    }
    if (requests !== urls.length) return 'unavailable';
    requests = 0;
    for (const url of urls) {
      const result = await runSandboxCommand(
        backend,
        workspace,
        '"$PROBE_CURL" --noproxy "*" -fsS --max-time 2 "$PROBE_URL"',
        {
          PROBE_CURL: curl,
          PROBE_URL: url,
        },
      );
      if (!result.available) return 'unavailable';
      if (result.code === 0) return 'unsupported';
    }
    return requests === 0 ? 'enforced' : 'unsupported';
  } finally {
    server.stop(true);
  }
}

async function probeProcessTree(
  backend: SandboxBackend,
  workspace: string,
): Promise<PlatformCapabilityEvidenceV1['processTree']> {
  if (backend !== 'bubblewrap') {
    const projection = currentProcessTreeCapabilityV1(backend);
    return {
      hardCountMechanism: projection.hardCountMechanism,
      hardCountLimit: projection.hardCountLimit,
      killWithoutResidualDescendants: projection.terminationCleanup,
    };
  }
  const python = Bun.which('python3');
  if (!python) {
    const projection = currentProcessTreeCapabilityV1(backend);
    return {
      hardCountMechanism: projection.hardCountMechanism,
      hardCountLimit: projection.hardCountLimit,
      killWithoutResidualDescendants: projection.terminationCleanup,
    };
  }
  const maxTasks = 16;
  const fixturePath = join(workspace, 'cgroup-pids-conformance.py');
  writeFileSync(
    fixturePath,
    [
      'import errno, os, time',
      `expected = ${maxTasks}`,
      "path = next((line.split(':', 2)[2].strip() for line in open('/proc/self/cgroup') if line.startswith('0::')), '')",
      'if not path: raise SystemExit(21)',
      "if open('/sys/fs/cgroup' + path + '/pids.max').read().strip() != str(expected): raise SystemExit(22)",
      'children = []',
      'limited = False',
      'for _ in range(expected * 4):',
      '    try:',
      '        pid = os.fork()',
      '    except OSError as error:',
      '        if error.errno == errno.EAGAIN:',
      '            limited = True',
      '            break',
      '        raise',
      '    if pid == 0:',
      '        time.sleep(0.2)',
      '        os._exit(0)',
      '    children.append(pid)',
      'for pid in children:',
      '    os.waitpid(pid, 0)',
      'if not limited: raise SystemExit(23)',
    ].join('\n'),
  );
  const executor = technicalAppExecutor('foreground_cli', workspace, maxTasks);
  const hardLimit = await executor({
    workspace,
    command: `${python} cgroup-pids-conformance.py`,
    timeoutMs: 5_000,
  });
  const projection = currentProcessTreeCapabilityV1(backend, {
    hardLimitMechanism: 'cgroup_pids',
    hardLimitConformancePassed: hardLimit.ok,
    // A POSIX process-group receipt cannot prove that a setsid/double-fork
    // descendant left the transient cgroup. Keep cleanup unsupported until a
    // unit-owned cgroup empty/populated verifier is wired into the executor.
    terminationCleanupConformancePassed: false,
  });
  return {
    hardCountMechanism: projection.hardCountMechanism,
    hardCountLimit: projection.hardCountLimit,
    killWithoutResidualDescendants: projection.terminationCleanup,
  };
}

async function probeSyscallFilter(
  backend: SandboxBackend,
  workspace: string,
): Promise<NativeProbeVerdict> {
  if (backend === 'none') return 'unavailable';
  if (backend !== 'bubblewrap') return 'unsupported';
  const python = Bun.which('python3');
  if (!python || !findApplySeccomp()) return 'unavailable';
  const control = Bun.spawnSync(
    [python, '-c', 'import socket; socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)'],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  if (control.exitCode !== 0) return 'unavailable';
  const executor = technicalAppExecutor('foreground_cli', workspace, 32);
  const positive = await executor({
    workspace,
    command: `${python} -c 'import socket; print(socket.AF_UNIX)'`,
  });
  if (!positive.ok) return 'unavailable';
  const denied = await executor({
    workspace,
    command: `${python} -c 'import errno,socket,sys\ntry: socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\nexcept OSError as error: sys.exit(77 if error.errno in (errno.EPERM, errno.EACCES) else 78)\nsys.exit(0)'`,
  });
  return denied.exitCode === 77 || denied.exitCode === 159 ? 'enforced' : 'unsupported';
}

async function probeEntrypoints(
  backend: SandboxBackend,
  _workspace: string,
): Promise<PlatformCapabilityEvidenceV1['entrypoints']> {
  if (backend === 'none') return { tui: 'unavailable', foregroundCli: 'unavailable' };
  // Importing the shared composition helper is not evidence that both real App
  // roots still install it. Keep both verdicts unavailable until the workflow
  // executes entrypoint-owned integration probes with a negative disconnect
  // control for each root.
  return {
    tui: 'unavailable',
    foregroundCli: 'unavailable',
  };
}

function technicalAppExecutor(
  entrypoint: 'tui' | 'foreground_cli',
  workspace: string,
  maxProcessTreeTasks: number,
) {
  return composeAppSandboxExecutorV1({
    entrypoint,
    workspace,
    config: {
      sandbox: { enabled: true },
      executionBoundary: {
        filesystemScope: 'workspace_write',
        workspaceRoot: workspace,
        networkMode: 'off',
        networkAllowlist: [],
        allowLocalAndPrivateNetwork: false,
        protectedPathPolicy: 'deny',
        maxProcessTreeSizePerShellInvocation: maxProcessTreeTasks,
        sandboxRequired: true,
        sandboxUnavailable: 'fail',
      },
      executionCapabilitySurface: {
        inProcessReadOnlyTools: null,
        network: false,
        process: true,
        write: true,
        workspaceWrite: true,
        shell: true,
        skillChild: false,
        localStdioMcp: false,
      },
    },
  });
}

export function githubEvidenceSource(
  environment: { platform: NodeJS.Platform; arch: string },
  env: NodeJS.ProcessEnv = process.env,
): { source?: PlatformCapabilityEvidenceV1['source'] } {
  const values = {
    repository: env.QUALIFICATION_REPOSITORY,
    repositoryId: env.QUALIFICATION_REPOSITORY_ID,
    headSha: env.QUALIFICATION_HEAD_SHA,
    ref: env.QUALIFICATION_REF,
    workflow: env.QUALIFICATION_WORKFLOW,
    workflowRef: env.QUALIFICATION_WORKFLOW_REF,
    workflowSha: env.QUALIFICATION_WORKFLOW_SHA,
    runId: env.QUALIFICATION_RUN_ID,
    runAttempt: env.QUALIFICATION_RUN_ATTEMPT,
    runnerClass: env.QUALIFICATION_RUNNER_CLASS,
  };
  if (Object.values(values).every((value) => value === undefined)) return {};
  if (Object.values(values).some((value) => !value?.trim())) {
    throw new Error('Formal platform qualification source identity is incomplete.');
  }
  if (!GITHUB_HOSTED_RUNNER_CLASSES_V1.has(values.runnerClass as GithubHostedRunnerClassV1)) {
    throw new Error('Formal platform qualification runner class is not recognized.');
  }
  if (values.repository !== 'ferqx/kite-code' || values.repositoryId !== '1218896626') {
    throw new Error('Formal platform qualification repository identity is not canonical.');
  }
  if (!/^[a-f0-9]{40}$/.test(values.headSha!) || !/^[a-f0-9]{40}$/.test(values.workflowSha!)) {
    throw new Error('Formal platform qualification source SHA is invalid.');
  }
  if (!/^refs\/(?:heads|tags|pull)\/[A-Za-z0-9._/-]{1,240}$/.test(values.ref!)) {
    throw new Error('Formal platform qualification ref is invalid.');
  }
  if (values.workflow !== '.github/workflows/platform-capability-probe.yml') {
    throw new Error('Formal platform qualification workflow path is invalid.');
  }
  if (
    !/^ferqx\/kite-code\/\.github\/workflows\/platform-capability-probe\.yml@refs\/(?:heads|tags|pull)\/[A-Za-z0-9._/-]{1,240}$/.test(
      values.workflowRef!,
    )
  ) {
    throw new Error('Formal platform qualification workflow ref is invalid.');
  }
  if (values.workflowRef !== `${values.repository}/${values.workflow}@${values.ref}`) {
    throw new Error('Formal platform qualification workflow ref does not match the source ref.');
  }
  if (!/^[1-9][0-9]*$/.test(values.runId!) || !/^[1-9][0-9]*$/.test(values.runAttempt!)) {
    throw new Error('Formal platform qualification run identity is invalid.');
  }
  const expectedEnvironment: Record<
    GithubHostedRunnerClassV1,
    { platform: NodeJS.Platform; arch: string }
  > = {
    'macos-15-arm64-github-hosted': { platform: 'darwin', arch: 'arm64' },
    'ubuntu-24.04-x64-github-hosted': { platform: 'linux', arch: 'x64' },
    'windows-2025-x64-github-hosted': { platform: 'win32', arch: 'x64' },
  };
  const expected = expectedEnvironment[values.runnerClass as GithubHostedRunnerClassV1];
  if (environment.platform !== expected.platform || environment.arch !== expected.arch) {
    throw new Error('Formal platform qualification runner class does not match the runtime.');
  }
  return {
    source: {
      ...(values as Record<keyof typeof values, string>),
      runnerClass: values.runnerClass as GithubHostedRunnerClassV1,
    },
  };
}

function syscallFilterVerdict(evidence: PlatformCapabilityProbeInputV1): NativeProbeVerdict {
  // Early V1 artifacts did not carry this additive field. Missing evidence is
  // never inferred from backend discovery; it normalizes fail-closed.
  return evidence.backendIsolation?.syscallFilter ?? 'unsupported';
}

async function runSandboxCommand(
  backend: SandboxBackend,
  workspace: string,
  command: string,
  env: Record<string, string>,
  options: { filesystemScope?: 'read_only' | 'workspace_write' } = {},
): Promise<{ available: boolean; code: number }> {
  const invocation = sandboxInvocation(backend, workspace, command, options);
  if (!invocation) return { available: false, code: -1 };
  try {
    const child = Bun.spawn({
      cmd: invocation,
      cwd: workspace,
      env: { ...process.env, ...env },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([
      child.exited,
      new Promise<number>((resolveTimeout) => {
        timeout = setTimeout(() => {
          child.kill();
          resolveTimeout(-1);
        }, 5_000);
        timeout.unref?.();
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    return { available: true, code };
  } catch {
    return { available: false, code: -1 };
  }
}

function sandboxInvocation(
  backend: SandboxBackend,
  workspace: string,
  command: string,
  options: { filesystemScope?: 'read_only' | 'workspace_write' },
): string[] | undefined {
  if (backend === 'seatbelt') {
    return [
      '/usr/bin/sandbox-exec',
      '-p',
      generateSandboxProfile(workspace, {
        network: 'disabled',
        filesystemScope: options.filesystemScope,
      }),
      '/bin/sh',
      '-c',
      command,
    ];
  }
  if (backend === 'bubblewrap') {
    const bwrap = Bun.which('bwrap');
    if (!bwrap) return undefined;
    return [
      bwrap,
      ...generateBwrapArgs(workspace, {
        network: 'disabled',
        filesystemScope: options.filesystemScope,
      }),
      '--',
      '/bin/sh',
      '-c',
      command,
    ];
  }
  return undefined;
}

function deniedVerdict(
  result: { available: boolean; code: number },
  target: string,
  backendUsable: boolean,
): NativeProbeVerdict {
  if (!backendUsable || !result.available) return 'unavailable';
  return result.code !== 0 && !existsSync(target) ? 'enforced' : 'unsupported';
}

export function deniedReadVerdict(
  result: { available: boolean; code: number },
  backendUsable: boolean,
): NativeProbeVerdict {
  if (!backendUsable || !result.available) return 'unavailable';
  return result.code !== 0 ? 'enforced' : 'unsupported';
}

function deniedUnchangedVerdict(
  result: { available: boolean; code: number },
  target: string,
  expected: string,
  backendUsable: boolean,
): NativeProbeVerdict {
  if (!backendUsable || !result.available) return 'unavailable';
  try {
    return result.code !== 0 && readFileSync(target, 'utf8') === expected
      ? 'enforced'
      : 'unsupported';
  } catch {
    return 'unsupported';
  }
}

export function collectLimitations(
  evidence: Omit<EvidenceWithoutDigest, 'outcome' | 'productionSupported' | 'limitations'>,
): string[] {
  const limitations: string[] = [];
  if (evidence.environmentIdentity.exactOsVersion !== 'enforced')
    limitations.push('exact_os_version_not_available');
  if (evidence.backend === 'bubblewrap' && syscallFilterVerdict(evidence) !== 'enforced') {
    limitations.push('bubblewrap_syscall_filter_not_proven');
  }
  if (evidence.entrypoints.tui !== 'enforced')
    limitations.push('tui_boundary_composition_not_proven');
  if (evidence.entrypoints.foregroundCli !== 'enforced')
    limitations.push('foreground_cli_boundary_composition_not_proven');
  if ((evidence.processTree.hardCountMechanism ?? 'none') === 'none') {
    limitations.push('process_tree_hard_limit_mechanism_not_proven');
  }
  if (evidence.filesystem.workspaceRead !== 'enforced')
    limitations.push('workspace_read_not_proven');
  if (evidence.filesystem.workspaceReadOnly !== 'enforced')
    limitations.push('workspace_read_only_not_enforced');
  if (evidence.filesystem.workspaceOutsideReadDeny !== 'enforced')
    limitations.push('workspace_outside_read_not_denied');
  if (evidence.filesystem.workspaceOutsideWriteDeny !== 'enforced')
    limitations.push('workspace_outside_write_not_denied');
  if (evidence.filesystem.protectedGitReadDeny !== 'enforced')
    limitations.push('protected_git_read_not_denied');
  if (evidence.filesystem.protectedGitWriteDeny !== 'enforced')
    limitations.push('protected_git_write_not_denied');
  if (evidence.filesystem.protectedAgentConfigReadDeny !== 'enforced')
    limitations.push('protected_agent_config_read_not_denied');
  if (evidence.filesystem.protectedAgentConfigWriteDeny !== 'enforced')
    limitations.push('protected_agent_config_write_not_denied');
  if (evidence.filesystem.protectedCredentialReadDeny !== 'enforced')
    limitations.push('protected_credential_read_not_denied');
  if (evidence.filesystem.protectedCredentialWriteDeny !== 'enforced')
    limitations.push('protected_credential_write_not_denied');
  if (evidence.filesystem.protectedShellProfileReadDeny !== 'enforced')
    limitations.push('protected_shell_profile_read_not_denied');
  if (evidence.filesystem.protectedShellProfileWriteDeny !== 'enforced')
    limitations.push('protected_shell_profile_write_not_denied');
  if (evidence.filesystem.symlinkEscapeReadDeny !== 'enforced')
    limitations.push('symlink_escape_read_not_denied');
  if (evidence.filesystem.symlinkEscapeWriteDeny !== 'enforced')
    limitations.push('symlink_escape_write_not_denied');
  if (evidence.selectedNetworkMode === 'allowlist' && evidence.network.allowlist !== 'enforced') {
    limitations.push('selected_network_allowlist_not_enforced');
  }
  if (evidence.network.allowlist !== 'enforced')
    limitations.push('network_allowlist_capability_unavailable');
  if (evidence.processTree.hardCountLimit !== 'enforced')
    limitations.push('process_tree_hard_limit_not_enforced');
  if (evidence.processTree.killWithoutResidualDescendants !== 'enforced')
    limitations.push('process_tree_cleanup_not_proven');
  if (evidence.inheritance.shellGrandchild !== 'enforced')
    limitations.push('shell_grandchild_inheritance_not_proven');
  if (
    evidence.processCapabilitySurface.forkedSkill &&
    evidence.inheritance.forkedSkill !== 'enforced'
  )
    limitations.push('forked_skill_inheritance_not_proven');
  if (
    evidence.processCapabilitySurface.localStdioMcp &&
    evidence.inheritance.localStdioMcp !== 'enforced'
  )
    limitations.push('local_stdio_mcp_bypasses_boundary');
  return limitations;
}

export function computePlatformCapabilityEvidenceDigestV1(
  evidence: Omit<PlatformCapabilityEvidenceV1, 'digest'>,
): string {
  return `sha256:${createHash('sha256').update(canonicalJsonBytes(evidence)).digest('hex')}`;
}

export function encodePlatformCapabilityEvidenceV1(
  evidence: PlatformCapabilityEvidenceV1,
): Uint8Array {
  platformCapabilityEvidenceV1Schema.parse(evidence);
  return canonicalJsonBytes(evidence);
}

if (import.meta.main) {
  const evidence = await runPlatformCapabilityProbe();
  const encoded = encodePlatformCapabilityEvidenceV1(evidence);
  const outputPath = process.argv[2];
  if (outputPath) writeFileSync(resolve(outputPath), encoded, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${new TextDecoder().decode(encoded)}\n`);
}
