import { describe, expect, test } from 'bun:test';
import {
  deniedReadVerdict,
  evaluatePlatformSupport,
  type PlatformCapabilityEvidenceV1,
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
    environmentIdentity: { exactOsVersion: 'enforced' },
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
