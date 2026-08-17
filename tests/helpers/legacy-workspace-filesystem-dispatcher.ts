import { digestCapability } from '@/core/capabilities/catalog';
import type { WorkspaceFilesystemInvocationDispatcherV1 } from '@/core/execution/tool-pipeline/workspace-filesystem';
import {
  LocalWorkspaceFilesystemProviderV1,
  WorkspaceFilesystemGrantAuthorityV1,
} from '@/core/execution/workspace-filesystem';
import {
  workspaceFilesystemMutationReadyDigestV1,
  workspaceFilesystemProtectedBoundaryDigestV1,
} from '@/core/execution/workspace-filesystem/grant-authority';
import { createProtectedPathEvaluatorV1 } from '@/core/policies/protected-path';
import type { FilePreimageRecorder } from '@/core/runtime/file-checkpoints';
import { canonicalPathForComparison } from '@/core/tools/path-utils';
import type { WorkspaceFilesystemObservationRecordV1 } from '@/protocol/capabilities';
import type {
  WorkspaceFilesystemOperationV1,
  WorkspaceFilesystemProviderFailureV1,
} from '@/protocol/workspace-filesystem-provider';

/**
 * Test-only legacy behavior oracle. Production never imports this module and
 * cannot bypass durable Tool Pipeline intent/ready receipts through it.
 */
export class LegacyWorkspaceFilesystemDispatcherV1
  implements WorkspaceFilesystemInvocationDispatcherV1
{
  readonly #workspace: string;
  readonly #authority = new WorkspaceFilesystemGrantAuthorityV1();
  readonly #provider: LocalWorkspaceFilesystemProviderV1;
  readonly #stamps: Map<string, string>;
  readonly #actor: string;
  readonly #recorder?: FilePreimageRecorder;
  #sequence = 0;

  constructor(input: {
    workspace: string;
    stamps?: Map<string, string>;
    actor?: string;
    recorder?: FilePreimageRecorder;
  }) {
    this.#workspace = canonicalPathForComparison(input.workspace);
    this.#provider = new LocalWorkspaceFilesystemProviderV1(this.#authority.verifier());
    this.#stamps = input.stamps ?? new Map();
    this.#actor = input.actor ?? 'parent';
    this.#recorder = input.recorder;
  }

  async dispatch(operation: WorkspaceFilesystemOperationV1) {
    const invocationId = `legacy-test-${++this.#sequence}`;
    const projection = createProtectedPathEvaluatorV1({
      workspaceRoot: this.#workspace,
      mode: 'deny',
    }).projectFilesystemBoundary();
    const unsignedBoundary = {
      schema: 'kite.workspace-filesystem-protected-boundary.v1' as const,
      ...structuredClone(projection),
    };
    const protectedBoundary = {
      ...unsignedBoundary,
      boundaryDigest: workspaceFilesystemProtectedBoundaryDigestV1(unsignedBoundary),
    };
    const binding = {
      threadId: 'legacy-test-thread',
      turnId: 'legacy-test-turn',
      toolCallId: invocationId,
      invocationId,
      attempt: 1,
      intentDigest: `sha256:${digestCapability({ schema: 'legacy-filesystem-intent.v1', invocationId })}`,
      searchBoundaryDigest: protectedBoundary.boundaryDigest,
      capabilityRevision: 'legacy-test-revision',
      effectDigest: 'legacy-test-effect',
      canonicalWorkspace: this.#workspace,
      protectedPathRevision: 'legacy-test-protected-path',
      approvalSummary: operation.kind,
    };
    if (
      operation.kind === 'read_file' ||
      operation.kind === 'search_files' ||
      operation.kind === 'search_content'
    ) {
      const result = await this.#provider.observe({
        grant: this.#authority.issueObserveGrant({
          binding,
          operation,
          protectedBoundary,
          ttlMs: 30_000,
        }),
      });
      if (!result.ok) return result;
      if (result.observation.kind === 'read_file') {
        this.#stamps.set(
          this.#stampKey(result.observation.targetEvidence.lexicalTargetDigest),
          result.observation.contentDigest,
        );
        return {
          ok: true as const,
          observation: result.observation,
          filesystemObservation: this.#observation(
            result.observation.targetEvidence,
            result.observation.contentDigest,
          ),
        };
      }
      return { ok: true as const, observation: result.observation };
    }

    const prepared = await this.#provider.prepareMutation({
      grant: this.#authority.issuePrepareGrant({
        binding,
        operation,
        protectedBoundary,
        ttlMs: 30_000,
      }),
    });
    if (!prepared.ok) return prepared;
    if (operation.kind === 'edit_file') {
      const stamped = this.#stamps.get(
        this.#stampKey(prepared.observation.targetEvidence.lexicalTargetDigest),
      );
      if (!stamped) return failed('read_required', 'File must be read before edit_file.');
      if (stamped !== prepared.observation.preimage.contentDigest) {
        return failed('stale_read', 'File changed after it was read.');
      }
    }
    try {
      this.#recorder?.(
        operation.path,
        prepared.observation.preimage.content,
        prepared.observation.preimage.existed,
      );
    } catch {
      // Legacy tests preserve the historical best-effort rewind projection.
    }
    const readyUnsigned = {
      attempt: binding.attempt,
      intentDigest: binding.intentDigest,
      operationDigest: prepared.observation.operationDigest,
      targetIdentityDigest: prepared.observation.targetIdentityDigest,
      preimageDigest: prepared.observation.preimage.contentDigest,
      preimageArtifact: {
        artifactId: `pa_${digestCapability({ schema: 'legacy-preimage-id.v1', invocationId })}`,
        kind: 'filesystem_preimage' as const,
        integrityIdentifier: `hmac-sha256:${digestCapability({ schema: 'legacy-preimage-integrity.v1', invocationId })}`,
        byteLength: prepared.observation.preimage.byteLength,
      },
      readyAt: '1970-01-01T00:00:00.000Z',
    };
    const ready = {
      ...readyUnsigned,
      readyDigest: workspaceFilesystemMutationReadyDigestV1(readyUnsigned),
    };
    const authorization = this.#authority.acknowledgeMutationReady({
      binding,
      operation,
      protectedBoundary,
      prepared: prepared.observation,
      ready,
    });
    const committed = await this.#provider.commitMutation({
      grant: this.#authority.issueCommitGrant({ authorization, ttlMs: 30_000 }),
    });
    if (!committed.ok) return committed;
    try {
      this.#recorder?.recordPostimage?.(operation.path, committed.observation.content, true);
    } catch {
      // Legacy-only projection.
    }
    this.#stamps.set(
      this.#stampKey(committed.observation.targetEvidence.lexicalTargetDigest),
      committed.observation.afterContentDigest,
    );
    return {
      ok: true as const,
      observation: committed.observation,
      preimage: prepared.observation.preimage,
      filesystemObservation: this.#observation(
        committed.observation.targetEvidence,
        committed.observation.afterContentDigest,
      ),
    };
  }

  #stampKey(lexicalTargetDigest: string): string {
    return `${this.#actor}:${lexicalTargetDigest}`;
  }

  #observation(
    target: {
      lexicalTargetDigest: string;
      canonicalTargetDigest: string;
      targetIdentityDigest: string;
    },
    contentDigest: string,
  ): WorkspaceFilesystemObservationRecordV1 {
    return {
      actorIdentityDigest: digestCapability({ actor: this.#actor }),
      ...target,
      contentDigest,
    };
  }
}

function failed(code: WorkspaceFilesystemProviderFailureV1['code'], message: string) {
  return { ok: false as const, failure: { code, message } };
}
