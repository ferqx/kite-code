import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeInProcessReadOnlyToolCatalogDigestV1 } from '@/core/config';
import { evaluateExecutionBoundaryQualificationV1 } from '@/core/config/execution-boundary';
import {
  currentProcessTreeCapabilityV1,
  type ExecutionBoundaryV1,
  type ProductionExecutionQualificationV1,
} from '@/core/sandbox';

function qualification(
  workspace: string,
  processTreeLimit: 'enforced' | 'unsupported',
): { boundary: ExecutionBoundaryV1; qualification: ProductionExecutionQualificationV1 } {
  const catalog = {
    version: 1 as const,
    revision: 'empty-negative-conformance-v1',
    tools: [],
  };
  const boundary: ExecutionBoundaryV1 = {
    filesystemScope: 'workspace_write',
    workspaceRoot: workspace,
    networkMode: 'off',
    networkAllowlist: [],
    allowLocalAndPrivateNetwork: false,
    protectedPathPolicy: 'deny',
    maxProcessTreeSizePerShellInvocation: 8,
    sandboxRequired: true,
    sandboxUnavailable: 'fail',
  };
  return {
    boundary,
    qualification: {
      version: 1,
      qualificationId: 'negative-process-tree-fixture',
      decisionId: 'D-04',
      outcome: 'supported',
      platform: 'darwin',
      osRelease: 'fixture',
      osVersion: 'fixture',
      arch: 'arm64',
      bunVersion: 'fixture',
      backend: 'seatbelt',
      selectedNetworkMode: 'off',
      entrypoints: ['tui', 'foreground_cli'],
      evidenceDigest: `sha256:${'a'.repeat(64)}`,
      evidenceCommit: 'a'.repeat(40),
      backendCapabilities: {
        backend: 'seatbelt',
        filesystem: {
          read_only: 'enforced',
          workspace_write: 'enforced',
          full_access: 'unsupported',
        },
        network: { off: 'enforced', allowlist: 'unsupported' },
        syscallFilter: 'unsupported',
        processTreeLimit,
        childProcessInheritance: 'enforced',
        verifiedInProcessReadOnly: 'unsupported',
      },
      inProcessReadOnlyTools: {
        ...catalog,
        digest: computeInProcessReadOnlyToolCatalogDigestV1(catalog),
      },
    },
  };
}

describe('native process-tree hard-limit projection', () => {
  test.each([
    'seatbelt',
    'bubblewrap',
    'none',
  ] as const)('keeps the current %s backend hard limit unsupported', (backend) => {
    expect(currentProcessTreeCapabilityV1(backend)).toEqual({
      hardCountMechanism: 'none',
      hardCountLimit: 'unsupported',
      terminationCleanup: 'unsupported',
    });
  });

  test('unsupported hard limits close every production capability surface', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-process-limit-'));
    try {
      const fixture = qualification(workspace, 'unsupported');
      const decision = evaluateExecutionBoundaryQualificationV1({
        featureEnabled: true,
        workspaceRoot: workspace,
        ...fixture,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('backend_process_tree_unsupported');
      expect(decision.surface.inProcessReadOnlyTools).toBeNull();
      expect(
        Object.values(decision.surface).filter((value) => typeof value === 'boolean'),
      ).not.toContain(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
