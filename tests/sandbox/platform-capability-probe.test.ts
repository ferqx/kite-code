import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deniedReadVerdict,
  evaluatePlatformSupport,
  githubEvidenceSource,
  type PlatformCapabilityEvidenceV1,
  platformCapabilityEvidenceV1Schema,
  probeBrokeredGit,
} from '../../scripts/release/platform-capability-probe';

type ProbeInput = Omit<
  Omit<PlatformCapabilityEvidenceV1, 'digest'>,
  'outcome' | 'productionSupported' | 'limitations'
>;

function evidence(overrides: Partial<ProbeInput> = {}): ProbeInput {
  return {
    version: 1,
    evidenceId: 'fixture',
    capturedAt: '2026-07-31T00:00:00.000Z',
    platform: 'linux',
    osRelease: 'fixture',
    osVersion: 'fixture',
    arch: 'x64',
    bunVersion: '1.3.14',
    backend: 'bubblewrap',
    selectedNetworkMode: 'off',
    processCapabilitySurface: {
      shell: true,
      forkedSkill: false,
      localStdioMcp: false,
    },
    brokeredGit: {
      featureRevision: 'brokered-git-r1',
      nativeShellReadDeny: 'enforced',
      nativeShellWriteDeny: 'enforced',
      brokerPositive: 'unavailable',
      brokerHostile: 'unavailable',
      outcome: 'excluded',
      reason: 'broker_positive_and_hostile_not_proven',
    },
    environmentIdentity: { exactOsVersion: 'enforced' },
    backendIsolation: { syscallFilter: 'enforced' },
    entrypoints: { tui: 'enforced', foregroundCli: 'enforced' },
    filesystem: {
      workspaceRead: 'enforced',
      workspaceWrite: 'enforced',
      workspaceReadOnly: 'enforced',
      workspaceOutsideReadDeny: 'enforced',
      workspaceOutsideWriteDeny: 'enforced',
      protectedGitReadDeny: 'enforced',
      protectedGitWriteDeny: 'enforced',
      protectedAgentConfigReadDeny: 'enforced',
      protectedAgentConfigWriteDeny: 'enforced',
      protectedCredentialReadDeny: 'enforced',
      protectedCredentialWriteDeny: 'enforced',
      protectedShellProfileReadDeny: 'enforced',
      protectedShellProfileWriteDeny: 'enforced',
      symlinkEscapeReadDeny: 'enforced',
      symlinkEscapeWriteDeny: 'enforced',
      inProcessReadOnly: 'unsupported',
    },
    network: { off: 'enforced', allowlist: 'enforced' },
    processTree: {
      hardCountMechanism: 'cgroup_pids',
      hardCountLimit: 'enforced',
      killWithoutResidualDescendants: 'enforced',
    },
    inheritance: {
      shellDescendant: 'enforced',
      shellGrandchild: 'enforced',
      forkedSkill: 'enforced',
      localStdioMcp: 'enforced',
    },
    ...overrides,
  };
}

describe('platform capability probe admission', () => {
  test('runs the production App Git composition for broker positive, hostile and binary identity evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-platform-git-probe-'));
    try {
      const result = await probeBrokeredGit(
        process.platform === 'darwin'
          ? 'seatbelt'
          : process.platform === 'win32'
            ? 'windows_restricted_token'
            : 'bubblewrap',
        root,
        'enforced',
        'enforced',
        { tui: 'enforced', foregroundCli: 'enforced' },
      );
      if (process.platform === 'win32') {
        expect(result).toMatchObject({ outcome: 'excluded', brokerPositive: 'unavailable' });
      } else {
        expect(result).toMatchObject({
          outcome: 'excluded',
          brokerPositive: 'enforced',
          brokerHostile: 'enforced',
          reason: 'production_entrypoint_composition_unproven',
        });
        expect(result.evidenceBindings).toBeUndefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('qualified brokered Git cannot omit concrete profile, rules and receipt identities', () => {
    const candidate = {
      ...evidence(),
      evidenceId: '00000000-0000-4000-8000-000000000000',
      brokeredGit: {
        featureRevision: 'brokered-git-r1',
        nativeShellReadDeny: 'enforced',
        nativeShellWriteDeny: 'enforced',
        brokerPositive: 'enforced',
        brokerHostile: 'enforced',
        outcome: 'qualified',
      },
      outcome: 'excluded',
      productionSupported: false,
      limitations: ['fixture'],
      digest: `sha256:${'a'.repeat(64)}`,
    };
    expect(platformCapabilityEvidenceV1Schema.safeParse(candidate).success).toBe(false);
  });
  const githubSource = {
    QUALIFICATION_REPOSITORY: 'ferqx/kite-code',
    QUALIFICATION_REPOSITORY_ID: '1218896626',
    QUALIFICATION_HEAD_SHA: 'a'.repeat(40),
    QUALIFICATION_REF: 'refs/heads/main',
    QUALIFICATION_WORKFLOW: '.github/workflows/platform-capability-probe.yml',
    QUALIFICATION_WORKFLOW_REF:
      'ferqx/kite-code/.github/workflows/platform-capability-probe.yml@refs/heads/main',
    QUALIFICATION_WORKFLOW_SHA: 'b'.repeat(40),
    QUALIFICATION_RUN_ID: '123',
    QUALIFICATION_RUN_ATTEMPT: '1',
    QUALIFICATION_RUNNER_CLASS: 'ubuntu-24.04-x64-github-hosted',
  };

  test('qualification workflow watches the complete Windows runtime inputs', () => {
    const workflow = readFileSync(
      join(process.cwd(), '.github', 'workflows', 'platform-capability-probe.yml'),
      'utf8',
    );
    for (const path of [
      'src/core/tools/path-utils.ts',
      'src/core/tools/shell.ts',
      'src/core/tools/stream-output.ts',
      'src/core/types.ts',
      'vendor/isksh/**',
    ]) {
      expect(workflow).toContain(`- "${path}"`);
    }
  });

  test('binds source evidence to a closed GitHub-hosted runner class', () => {
    expect(
      githubEvidenceSource({ platform: 'linux', arch: 'x64' }, githubSource).source,
    ).toMatchObject({
      repository: 'ferqx/kite-code',
      repositoryId: '1218896626',
      runnerClass: 'ubuntu-24.04-x64-github-hosted',
    });
    expect(() =>
      githubEvidenceSource(
        { platform: 'linux', arch: 'x64' },
        { ...githubSource, QUALIFICATION_RUNNER_CLASS: 'self-hosted' },
      ),
    ).toThrow('runner class is not recognized');
    expect(() =>
      githubEvidenceSource(
        { platform: 'linux', arch: 'x64' },
        { ...githubSource, QUALIFICATION_REPOSITORY: 'attacker/fork' },
      ),
    ).toThrow('repository identity is not canonical');
    expect(() =>
      githubEvidenceSource(
        { platform: 'linux', arch: 'x64' },
        { ...githubSource, QUALIFICATION_HEAD_SHA: 'not-a-sha' },
      ),
    ).toThrow('source SHA is invalid');
    expect(() => githubEvidenceSource({ platform: 'darwin', arch: 'arm64' }, githubSource)).toThrow(
      'does not match the runtime',
    );
    expect(() =>
      githubEvidenceSource(
        { platform: 'linux', arch: 'x64' },
        { ...githubSource, QUALIFICATION_WORKFLOW_SHA: '' },
      ),
    ).toThrow('source identity is incomplete');
  });

  test('cannot mark a read denial enforced when the positive read control failed', () => {
    expect(deniedReadVerdict({ available: true, code: 1 }, false)).toBe('unavailable');
    expect(deniedReadVerdict({ available: true, code: 1 }, true)).toBe('enforced');
  });

  test('requires every process-capability probe before declaring supported', () => {
    expect(evaluatePlatformSupport(evidence())).toBe('supported');
    expect(
      evaluatePlatformSupport(
        evidence({
          processTree: {
            hardCountLimit: 'unsupported',
            killWithoutResidualDescendants: 'enforced',
          },
        }),
      ),
    ).toBe('excluded');
  });

  test('never calls a process artifact supported when Shell is absent from its surface', () => {
    expect(
      evaluatePlatformSupport(
        evidence({
          processCapabilitySurface: {
            shell: false,
            forkedSkill: false,
            localStdioMcp: false,
          },
        }),
      ),
    ).toBe('excluded');
  });

  test('requires inheritance only for process capabilities admitted by the evidence', () => {
    expect(evaluatePlatformSupport(evidence())).toBe('supported');
    expect(
      evaluatePlatformSupport(
        evidence({
          processCapabilitySurface: {
            shell: true,
            forkedSkill: true,
            localStdioMcp: false,
          },
          inheritance: {
            ...evidence().inheritance,
            forkedSkill: 'unsupported',
          },
        }),
      ),
    ).toBe('excluded');
  });

  test('admits the Windows restricted-token backend with a named Job hard-count mechanism', () => {
    expect(
      evaluatePlatformSupport(
        evidence({
          backend: 'windows_restricted_token',
          processTree: {
            hardCountMechanism: 'windows_job_active_process_limit',
            hardCountLimit: 'enforced',
            killWithoutResidualDescendants: 'enforced',
          },
        }),
      ),
    ).toBe('supported');
    expect(
      evaluatePlatformSupport(
        evidence({
          backend: 'windows_restricted_token',
          processTree: {
            hardCountMechanism: 'windows_job_active_process_limit',
            hardCountLimit: 'unsupported',
            killWithoutResidualDescendants: 'enforced',
          },
        }),
      ),
    ).toBe('excluded');
  });

  test('requires bubblewrap syscall-filter evidence but not a Seatbelt substitute', () => {
    expect(
      evaluatePlatformSupport(evidence({ backendIsolation: { syscallFilter: 'unsupported' } })),
    ).toBe('excluded');
    expect(
      evaluatePlatformSupport(
        evidence({
          backend: 'seatbelt',
          backendIsolation: { syscallFilter: 'unsupported' },
        }),
      ),
    ).toBe('supported');
  });

  test('treats pre-extension V1 bubblewrap evidence as unsupported instead of throwing', () => {
    const legacy = evidence();
    delete legacy.backendIsolation;
    expect(evaluatePlatformSupport(legacy)).toBe('excluded');
  });

  test('requires a named hard-count mechanism even when a legacy verdict claims enforced', () => {
    const missingMechanism = evidence();
    delete missingMechanism.processTree.hardCountMechanism;
    expect(evaluatePlatformSupport(missingMechanism)).toBe('excluded');
    expect(
      evaluatePlatformSupport(
        evidence({ processTree: { ...evidence().processTree, hardCountMechanism: 'none' } }),
      ),
    ).toBe('excluded');
  });

  test('allows only a separately verified no-process fallback to be read_only_only', () => {
    expect(
      evaluatePlatformSupport(
        evidence({
          filesystem: {
            workspaceRead: 'unsupported',
            workspaceWrite: 'unsupported',
            workspaceReadOnly: 'unsupported',
            workspaceOutsideReadDeny: 'unsupported',
            workspaceOutsideWriteDeny: 'unsupported',
            protectedGitReadDeny: 'unsupported',
            protectedGitWriteDeny: 'unsupported',
            protectedAgentConfigReadDeny: 'unsupported',
            protectedAgentConfigWriteDeny: 'unsupported',
            protectedCredentialReadDeny: 'unsupported',
            protectedCredentialWriteDeny: 'unsupported',
            protectedShellProfileReadDeny: 'unsupported',
            protectedShellProfileWriteDeny: 'unsupported',
            symlinkEscapeReadDeny: 'unsupported',
            symlinkEscapeWriteDeny: 'unsupported',
            inProcessReadOnly: 'enforced',
          },
          network: { off: 'enforced', allowlist: 'unsupported' },
          processTree: {
            hardCountLimit: 'unsupported',
            killWithoutResidualDescendants: 'unsupported',
          },
          inheritance: {
            shellDescendant: 'unsupported',
            shellGrandchild: 'unsupported',
            forkedSkill: 'unsupported',
            localStdioMcp: 'unsupported',
          },
        }),
      ),
    ).toBe('read_only_only');
  });

  test('does not treat backend discovery, shell permits, or process cleanup as hard enforcement', () => {
    expect(
      evaluatePlatformSupport(
        evidence({
          processTree: {
            hardCountLimit: 'unsupported',
            killWithoutResidualDescendants: 'enforced',
          },
        }),
      ),
    ).toBe('excluded');
  });

  test('rejects an impossible process-sandbox claim when no backend exists', () => {
    expect(evaluatePlatformSupport(evidence({ backend: 'none' }))).toBe('excluded');
  });

  test('admits network-off independently but requires allowlist when it is selected', () => {
    expect(
      evaluatePlatformSupport(evidence({ network: { off: 'enforced', allowlist: 'unsupported' } })),
    ).toBe('supported');
    expect(
      evaluatePlatformSupport(
        evidence({
          selectedNetworkMode: 'allowlist',
          network: { off: 'enforced', allowlist: 'unsupported' },
        }),
      ),
    ).toBe('excluded');
  });
});
