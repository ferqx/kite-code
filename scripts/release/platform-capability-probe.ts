import { spawnSync } from 'node:child_process';
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
import {
  arch,
  networkInterfaces,
  version as nodeOsVersion,
  platform,
  release,
  tmpdir,
} from 'node:os';
import { join, resolve } from 'node:path';
import { generateBwrapArgs } from '../../src/core/sandbox/bwrap';
import { detectSandboxBackend, type SandboxBackend } from '../../src/core/sandbox/platform';
import { generateSandboxProfile } from '../../src/core/sandbox/profile';

export type NativeProbeVerdict = 'enforced' | 'unsupported' | 'unavailable';
export type PlatformSupportOutcome = 'supported' | 'read_only_only' | 'excluded';

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
  environmentIdentity: {
    exactOsVersion: NativeProbeVerdict;
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
    const exactOsVersion = readExactOsVersion();
    const { shellGrandchildDeny, ...filesystem } = await probeFilesystem(
      backend,
      workspace,
      outside,
    );
    const networkOff = await probeNetworkOff(backend, workspace);
    const processTree = await probeProcessTree(backend, workspace);
    const partial: Omit<EvidenceWithoutDigest, 'outcome' | 'productionSupported' | 'limitations'> =
      {
        version: 1,
        evidenceId: randomUUID(),
        capturedAt: new Date().toISOString(),
        platform: platform(),
        osRelease: release(),
        osVersion: exactOsVersion.value,
        arch: arch(),
        bunVersion: Bun.version,
        backend,
        selectedNetworkMode: 'off',
        environmentIdentity: {
          exactOsVersion: exactOsVersion.verdict,
        },
        // This spike exercises the concrete backend generator directly. Task
        // 1B.7 must prove that both production composition roots install the
        // identical boundary before either entrypoint can be admitted.
        entrypoints: { tui: 'unavailable', foregroundCli: 'unavailable' },
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
          // Forked Skill shares shellExecutor but lacks an independent native fixture;
          // local stdio MCP currently spawns outside the sandbox executor.
          forkedSkill: 'unavailable',
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
      digest: `sha256:${createHash('sha256').update(canonicalJson(withoutDigest)).digest('hex')}`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function evaluatePlatformSupport(
  evidence: Omit<EvidenceWithoutDigest, 'outcome' | 'productionSupported' | 'limitations'>,
): PlatformSupportOutcome {
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
    evidence.inheritance.forkedSkill,
    evidence.inheritance.localStdioMcp,
  ];
  if (
    evidence.backend !== 'none' &&
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
  const workspaceWrite =
    workspaceResult.available && workspaceResult.code === 0 && existsSync(workspaceTarget)
      ? 'enforced'
      : workspaceResult.available
        ? 'unsupported'
        : 'unavailable';
  const backendUsable = workspaceWrite === 'enforced';
  return {
    workspaceRead:
      backendUsable && workspaceReadResult.available && workspaceReadResult.code === 0
        ? 'enforced'
        : workspaceReadResult.available
          ? 'unsupported'
          : 'unavailable',
    workspaceWrite,
    // The current backend API cannot construct a workspace-read-only process boundary.
    workspaceReadOnly: 'unsupported',
    workspaceOutsideReadDeny: deniedReadVerdict(outsideReadResult, backendUsable),
    workspaceOutsideWriteDeny: deniedVerdict(outsideResult, outsideTarget, backendUsable),
    protectedGitReadDeny: deniedReadVerdict(gitReadResult, backendUsable),
    protectedGitWriteDeny: deniedUnchangedVerdict(
      gitWriteResult,
      gitTarget,
      'protected',
      backendUsable,
    ),
    protectedAgentConfigReadDeny: deniedReadVerdict(agentConfigReadResult, backendUsable),
    protectedAgentConfigWriteDeny: deniedUnchangedVerdict(
      agentConfigWriteResult,
      agentConfigTarget,
      'protected',
      backendUsable,
    ),
    protectedCredentialReadDeny: deniedReadVerdict(credentialReadResult, backendUsable),
    protectedCredentialWriteDeny: deniedUnchangedVerdict(
      credentialWriteResult,
      credentialTarget,
      'protected',
      backendUsable,
    ),
    protectedShellProfileReadDeny: deniedReadVerdict(shellProfileReadResult, backendUsable),
    protectedShellProfileWriteDeny: deniedUnchangedVerdict(
      shellProfileWriteResult,
      shellProfileTarget,
      'protected',
      backendUsable,
    ),
    symlinkEscapeReadDeny: deniedReadVerdict(symlinkReadResult, backendUsable),
    symlinkEscapeWriteDeny: deniedVerdict(symlinkWriteResult, symlinkTarget, backendUsable),
    inProcessReadOnly: 'unsupported',
    shellGrandchildDeny: deniedVerdict(grandchildResult, grandchildTarget, backendUsable),
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
  if (backend === 'none') {
    return {
      hardCountLimit: 'unsupported',
      killWithoutResidualDescendants: 'unsupported',
    };
  }
  await runSandboxCommand(
    backend,
    workspace,
    'sleep 0.2 & sleep 0.2 & sleep 0.2 & sleep 0.2 & wait',
    {},
  );
  return {
    // The production boundary has no per-invocation hard process-tree counter.
    hardCountLimit: 'unsupported',
    // Natural child exit is not proof of bounded cancellation cleanup.
    killWithoutResidualDescendants: 'unsupported',
  };
}

async function runSandboxCommand(
  backend: SandboxBackend,
  workspace: string,
  command: string,
  env: Record<string, string>,
): Promise<{ available: boolean; code: number }> {
  const invocation = sandboxInvocation(backend, workspace, command);
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
): string[] | undefined {
  if (backend === 'seatbelt') {
    return [
      '/usr/bin/sandbox-exec',
      '-p',
      generateSandboxProfile(workspace, { network: 'disabled' }),
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
      ...generateBwrapArgs(workspace, { network: 'disabled' }),
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

function deniedReadVerdict(
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

function collectLimitations(
  evidence: Omit<EvidenceWithoutDigest, 'outcome' | 'productionSupported' | 'limitations'>,
): string[] {
  const limitations: string[] = [];
  if (evidence.environmentIdentity.exactOsVersion !== 'enforced')
    limitations.push('exact_os_version_not_available');
  if (evidence.entrypoints.tui !== 'enforced')
    limitations.push('tui_boundary_composition_not_proven');
  if (evidence.entrypoints.foregroundCli !== 'enforced')
    limitations.push('foreground_cli_boundary_composition_not_proven');
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
  if (evidence.inheritance.forkedSkill !== 'enforced')
    limitations.push('forked_skill_inheritance_not_proven');
  if (evidence.inheritance.localStdioMcp !== 'enforced')
    limitations.push('local_stdio_mcp_bypasses_boundary');
  return limitations;
}

function readExactOsVersion(): { verdict: NativeProbeVerdict; value: string } {
  if (process.platform === 'darwin') {
    const product = spawnSync('/usr/bin/sw_vers', ['-productVersion'], {
      encoding: 'utf8',
    });
    const build = spawnSync('/usr/bin/sw_vers', ['-buildVersion'], {
      encoding: 'utf8',
    });
    if (product.status === 0 && build.status === 0) {
      return {
        verdict: 'enforced',
        value: `macOS ${product.stdout.trim()} (${build.stdout.trim()})`,
      };
    }
  } else if (process.platform === 'linux') {
    try {
      const fields = Object.fromEntries(
        readFileSync('/etc/os-release', 'utf8')
          .split('\n')
          .filter((line) => line.includes('='))
          .map((line) => {
            const separator = line.indexOf('=');
            return [
              line.slice(0, separator),
              line
                .slice(separator + 1)
                .replace(/^"/, '')
                .replace(/"$/, ''),
            ];
          }),
      );
      const description = fields.PRETTY_NAME ?? fields.VERSION_ID;
      if (description) return { verdict: 'enforced', value: description };
    } catch {
      // Fall through to the runtime's OS version.
    }
  } else if (process.platform === 'win32') {
    const script =
      '$os = Get-CimInstance Win32_OperatingSystem; "$($os.Caption) $($os.Version) build $($os.BuildNumber)"';
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = spawnSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.status === 0 && result.stdout.trim()) {
      return { verdict: 'enforced', value: result.stdout.trim() };
    }
  }
  const fallback = nodeOsVersion();
  if (fallback && fallback !== 'unknown') return { verdict: 'enforced', value: fallback };
  return { verdict: 'unavailable', value: 'unavailable' };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

if (import.meta.main) {
  const evidence = await runPlatformCapabilityProbe();
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  const outputPath = process.argv[2];
  if (outputPath) writeFileSync(resolve(outputPath), serialized, 'utf8');
  process.stdout.write(serialized);
}
