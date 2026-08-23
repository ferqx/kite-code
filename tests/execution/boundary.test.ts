import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalWorkspaceFilesystemProviderV1,
  WorkspaceFilesystemGrantAuthorityV1,
  workspaceFilesystemMutationReadyDigestV1,
  workspaceFilesystemProtectedBoundaryDigestV1,
} from '@kite/builtin-runtime/filesystem';
import { createProtectedPathEvaluatorV1 } from '@kite/builtin-runtime/sandbox';
import type {
  WorkspaceFilesystemCommittedMutationV1,
  WorkspaceFilesystemMutationOperationV1,
  WorkspaceFilesystemObserveObservationV1,
  WorkspaceFilesystemObserveOperationV1,
  WorkspaceFilesystemPreparedMutationV1,
  WorkspaceFilesystemProviderResultV1,
} from '@kite/runtime-spi';

function builtinFilesystemFixture(workspace: string) {
  const authority = new WorkspaceFilesystemGrantAuthorityV1({
    idSource: (() => {
      let id = 0;
      return () => `boundary-grant-${++id}`;
    })(),
  });
  const evaluator = createProtectedPathEvaluatorV1({ workspaceRoot: workspace, mode: 'deny' });
  const unsignedBoundary = {
    schema: 'kite.workspace-filesystem-protected-boundary.v1' as const,
    ...structuredClone(evaluator.projectFilesystemBoundary()),
  };
  const protectedBoundary = {
    ...unsignedBoundary,
    boundaryDigest: workspaceFilesystemProtectedBoundaryDigestV1(unsignedBoundary),
  };
  const binding = {
    threadId: 'boundary-test-thread',
    turnId: 'boundary-test-turn',
    toolCallId: 'boundary-test-call',
    invocationId: 'boundary-test-invocation',
    attempt: 1,
    intentDigest: `sha256:${'3'.repeat(64)}`,
    searchBoundaryDigest: protectedBoundary.boundaryDigest,
    capabilityRevision: 'boundary-test-capability',
    effectDigest: 'boundary-test-effect',
    canonicalWorkspace: realpathSync(workspace),
    protectedPathRevision: 'boundary-test-protected-path',
    approvalSummary: 'boundary test fixture',
  };
  const provider = new LocalWorkspaceFilesystemProviderV1(authority.verifier());

  async function observe(
    operation: WorkspaceFilesystemObserveOperationV1,
  ): Promise<WorkspaceFilesystemProviderResultV1<WorkspaceFilesystemObserveObservationV1>> {
    return provider.observe({
      grant: authority.issueObserveGrant({
        binding,
        operation,
        protectedBoundary,
        ttlMs: 30_000,
      }),
    });
  }

  async function mutate(
    operation: WorkspaceFilesystemMutationOperationV1,
  ): Promise<WorkspaceFilesystemProviderResultV1<WorkspaceFilesystemCommittedMutationV1>> {
    const prepared = await provider.prepareMutation({
      grant: authority.issuePrepareGrant({
        binding,
        operation,
        protectedBoundary,
        ttlMs: 30_000,
      }),
    });
    if (!prepared.ok) return prepared;
    const preparedMutation: WorkspaceFilesystemPreparedMutationV1 = prepared.observation;
    const preimageArtifact = {
      artifactId: `pa_${'0'.repeat(64)}`,
      kind: 'filesystem_preimage' as const,
      integrityIdentifier: `sha256:${'0'.repeat(64)}`,
      byteLength: preparedMutation.preimage.byteLength,
    };
    const readyWithoutDigest = {
      attempt: binding.attempt,
      intentDigest: binding.intentDigest,
      operationDigest: preparedMutation.operationDigest,
      targetIdentityDigest: preparedMutation.targetIdentityDigest,
      preimageDigest: preparedMutation.preimage.contentDigest,
      preimageArtifact,
      readyAt: new Date().toISOString(),
    };
    const ready = {
      ...readyWithoutDigest,
      readyDigest: workspaceFilesystemMutationReadyDigestV1(readyWithoutDigest),
    };
    const authorization = authority.acknowledgeMutationReady({
      binding,
      operation,
      protectedBoundary,
      prepared: preparedMutation,
      ready,
    });
    return provider.commitMutation({
      grant: authority.issueCommitGrant({ authorization, ttlMs: 30_000 }),
    });
  }

  return { observe, mutate };
}

describe('workspace path boundary', () => {
  test('file Provider allows absolute paths inside workspace and rejects ~', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-boundary-'));
    try {
      const absolute = join(workspace, 'inside.txt');
      // Absolute path that resolves inside workspace → allowed
      const filesystem = builtinFilesystemFixture(workspace);
      const write = await filesystem.mutate({
        kind: 'write_file',
        path: absolute,
        pathScope: 'workspace_only',
        content: 'x',
      });
      expect(write.ok).toBe(true);
      // ~ home expansion → still rejected
      const read = await filesystem.observe({
        kind: 'read_file',
        path: '~/.ssh/config',
        pathScope: 'workspace_only',
      });
      expect(read.ok).toBe(false);
      if (read.ok) throw new Error('home path unexpectedly succeeded');
      expect(read.failure.code).toBe('path_outside_workspace');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('file Provider rejects parent-directory escape', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-boundary-'));
    try {
      const result = await builtinFilesystemFixture(workspace).mutate({
        kind: 'write_file',
        path: '../outside.txt',
        pathScope: 'workspace_only',
        content: 'x',
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('parent escape unexpectedly succeeded');
      expect(result.failure.code).toBe('path_outside_workspace');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
