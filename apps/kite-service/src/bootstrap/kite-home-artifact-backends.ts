import { capabilityResultEvidenceDigest } from '@kite-ai/builtin-runtime';
import {
  canonicalModelJson,
  type PrivateArtifactGarbageCollectionOptions,
  type PrivateArtifactGarbageCollectionResult,
  PrivateArtifactStorageError,
  type PrivateImmutableArtifactRef,
  type PrivateImmutableArtifactStorageBackend,
} from '@kite-ai/builtin-runtime/model';
import {
  PlanArtifactError,
  type PlanArtifactStorageBackend,
} from '@kite-ai/builtin-runtime/planning';
import type { CapabilityResult, PlanArtifactRef, PlanDocument } from '@kite-ai/runtime-contract';
import type {
  KiteHomeArtifactGarbageCollectionInput,
  KiteHomeArtifactGarbageCollectionResult,
  KiteHomeArtifactStore,
  KiteHomePrivateArtifactReference,
} from '@kite-ai/runtime-storage-sqlite';

export interface KiteHomeBuiltinArtifactBackends {
  readonly model: PrivateImmutableArtifactStorageBackend<
    'model_surface' | 'model_response' | 'provider_options'
  >;
  readonly capability: PrivateImmutableArtifactStorageBackend<'capability_result'>;
  readonly plan: PlanArtifactStorageBackend;
  readonly filesystemPreimage: PrivateImmutableArtifactStorageBackend<'filesystem_preimage'>;
  readonly sandboxPreparation: PrivateImmutableArtifactStorageBackend<'sandbox_preparation'>;
  readonly subagentTask: PrivateImmutableArtifactStorageBackend<
    'subagent_task_request' | 'subagent_task'
  >;
  readonly subagentLifecycle: PrivateImmutableArtifactStorageBackend<'subagent_handle'>;
  readonly subagentContinuation: PrivateImmutableArtifactStorageBackend<'subagent_continuation'>;
}

/** Adapt Builtin's schema-aware readers/writers to the dedicated Store 9 Artifact tables. */
export function createKiteHomeBuiltinArtifactBackends(
  store: KiteHomeArtifactStore,
  now: () => number = Date.now,
): KiteHomeBuiltinArtifactBackends {
  return Object.freeze({
    model: backend<'model_surface' | 'model_response' | 'provider_options'>({
      write(ref, text) {
        store.writeModel({
          ref,
          artifactFormatVersion: 1,
          canonicalJson: text,
          createdAt: time(now),
        });
      },
      read: (ref) => store.readModel(ref).canonicalJson,
      collect: (input) => store.collectModelGarbage(input),
    }),
    capability: backend<'capability_result'>({
      write(ref, text, value) {
        const envelope = record(value);
        if (envelope.artifactFormatVersion !== 2 || typeof envelope.invocationId !== 'string') {
          corrupt();
        }
        store.writeCapability({
          ref,
          invocationId: envelope.invocationId,
          evidenceDigest: capabilityResultEvidenceDigest(envelope.result as CapabilityResult),
          artifactFormatVersion: 2,
          canonicalJson: text,
          createdAt: time(now),
        });
      },
      read: (ref) => store.readCapability(ref).canonicalJson,
      collect: (input) => store.collectCapabilityGarbage(input),
    }),
    plan: Object.freeze({
      write(input: {
        readonly taskId: string;
        readonly plan: PlanDocument;
        readonly markdown: string;
      }) {
        const ref = planReference(input.taskId, input.plan, input.markdown);
        try {
          store.writePlan({
            ref,
            artifactFormatVersion: 1,
            planJson: canonicalModelJson(input.plan),
            markdown: input.markdown,
            createdAt: time(now),
          });
          return ref;
        } catch {
          throw new PlanArtifactError('Plan Artifact backend write failed.', 'artifact_conflict');
        }
      },
      read(ref: PlanArtifactRef) {
        try {
          const stored = store.readPlan(ref);
          return Object.freeze({
            plan: JSON.parse(stored.planJson) as PlanDocument,
            markdown: stored.markdown,
          });
        } catch (error) {
          const code =
            error && typeof error === 'object' && 'code' in error
              ? (error as { readonly code?: unknown }).code
              : undefined;
          throw new PlanArtifactError(
            'Plan Artifact backend read failed.',
            code === 'artifact_missing' ? 'artifact_missing' : 'artifact_corrupt',
          );
        }
      },
    }),
    filesystemPreimage: backend<'filesystem_preimage'>({
      write(ref, text, value) {
        const envelope = record(value);
        if (
          envelope.artifactFormatVersion !== 1 ||
          typeof envelope.invocationId !== 'string' ||
          typeof envelope.operationDigest !== 'string' ||
          typeof envelope.targetIdentityDigest !== 'string'
        ) {
          corrupt();
        }
        store.writeFilesystemPreimage({
          ref,
          invocationId: envelope.invocationId,
          operationDigest: envelope.operationDigest,
          targetIdentityDigest: envelope.targetIdentityDigest,
          artifactFormatVersion: 1,
          canonicalJson: text,
          createdAt: time(now),
        });
      },
      read: (ref) => store.readFilesystemPreimage(ref).canonicalJson,
      collect: (input) => store.collectFilesystemPreimageGarbage(input),
    }),
    sandboxPreparation: backend<'sandbox_preparation'>({
      write(ref, text, value) {
        const envelope = record(value);
        const prepared = record(envelope.prepared);
        if (
          envelope.artifactFormatVersion !== 1 ||
          typeof prepared.preparationDigest !== 'string' ||
          !Number.isSafeInteger(prepared.expiresAtMs)
        ) {
          corrupt();
        }
        store.writeSandboxPreparation({
          ref,
          preparationDigest: prepared.preparationDigest,
          artifactFormatVersion: 1,
          canonicalJson: text,
          expiresAtMs: prepared.expiresAtMs as number,
          createdAt: time(now),
        });
      },
      read: (ref) => store.readSandboxPreparation(ref).canonicalJson,
      collect: (input) => store.collectSandboxPreparationGarbage(input),
    }),
    subagentTask: backend<'subagent_task_request' | 'subagent_task'>({
      write(ref, text, value) {
        if (record(value).artifactFormatVersion !== 1) corrupt();
        store.writeSubagentTask({
          ref,
          artifactFormatVersion: 1,
          canonicalJson: text,
          createdAt: time(now),
        });
      },
      read: (ref) => store.readSubagentTask(ref).canonicalJson,
      collect: (input) => store.collectSubagentTaskGarbage(input),
    }),
    subagentLifecycle: backend<'subagent_handle'>({
      write(ref, text, value) {
        if (record(value).artifactFormatVersion !== 1) corrupt();
        store.writeSubagentLifecycle({
          ref,
          artifactFormatVersion: 1,
          canonicalJson: text,
          createdAt: time(now),
        });
      },
      read: (ref) => store.readSubagentLifecycle(ref).canonicalJson,
      collect: (input) => store.collectSubagentLifecycleGarbage(input),
    }),
    subagentContinuation: backend<'subagent_continuation'>({
      write(ref, text, value) {
        if (record(value).artifactFormatVersion !== 1) corrupt();
        store.writeSubagentContinuation({
          ref,
          artifactFormatVersion: 1,
          canonicalJson: text,
          createdAt: time(now),
        });
      },
      read: (ref) => store.readSubagentContinuation(ref).canonicalJson,
      collect: (input) => store.collectSubagentContinuationGarbage(input),
    }),
  });
}

function planReference(taskId: string, plan: PlanDocument, markdown: string): PlanArtifactRef {
  const logicalPath = `kite.sqlite#plans/${taskId}/${plan.planId}/v${plan.version}`;
  return Object.freeze({
    artifactId: `${plan.planId}:v${plan.version}`,
    taskId,
    planId: plan.planId,
    version: plan.version,
    fileName: `v${plan.version}.md`,
    relativePath: logicalPath,
    displayPath: logicalPath,
    structuralDigest: plan.structuralDigest,
    byteLength: Buffer.byteLength(markdown, 'utf8'),
  });
}

function backend<Kind extends string>(owner: {
  readonly write: (
    ref: KiteHomePrivateArtifactReference<Kind>,
    canonicalJson: string,
    value: unknown,
  ) => void;
  readonly read: (ref: KiteHomePrivateArtifactReference<Kind>) => string;
  readonly collect: (
    input: KiteHomeArtifactGarbageCollectionInput,
  ) => KiteHomeArtifactGarbageCollectionResult;
}): PrivateImmutableArtifactStorageBackend<Kind> {
  return Object.freeze({
    write(ref: PrivateImmutableArtifactRef<Kind>, payload: Uint8Array) {
      const canonicalJson = decodeCanonical(payload);
      try {
        owner.write(ref, canonicalJson, JSON.parse(canonicalJson) as unknown);
      } catch (error) {
        throw map(error, 'publish_failed');
      }
    },
    read(ref: PrivateImmutableArtifactRef<Kind>) {
      try {
        return Buffer.from(owner.read(ref), 'utf8');
      } catch (error) {
        throw map(error, 'artifact_corrupt');
      }
    },
    collectGarbage(options: PrivateArtifactGarbageCollectionOptions<Kind>) {
      try {
        const result = owner.collect({
          complete: options.reachability.complete,
          reachableArtifactIds: options.reachability.reachable.map((ref) => ref.artifactId),
          createdBeforeOrAt: Math.max(
            0,
            Math.floor((options.nowMs ?? Date.now()) - options.minimumRetentionMs),
          ),
        });
        return gcResult(result);
      } catch (error) {
        throw map(error, 'artifact_corrupt');
      }
    },
  });
}

function decodeCanonical(payload: Uint8Array): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    const value: unknown = JSON.parse(text);
    if (canonicalModelJson(value) !== text) corrupt();
    return text;
  } catch (error) {
    if (error instanceof PrivateArtifactStorageError) throw error;
    corrupt();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) corrupt();
  return value as Record<string, unknown>;
}

function time(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Artifact clock is invalid.');
  }
  return value;
}

function gcResult(
  result: KiteHomeArtifactGarbageCollectionResult,
): PrivateArtifactGarbageCollectionResult {
  return Object.freeze({
    scannedEntries: result.retainedArtifacts + result.deletedArtifacts,
    retainedArtifacts: result.retainedArtifacts,
    deletedArtifacts: result.deletedArtifacts,
    deletedTemporaryFiles: 0,
  });
}

function map(
  error: unknown,
  fallback: 'artifact_corrupt' | 'publish_failed',
): PrivateArtifactStorageError {
  if (error instanceof PrivateArtifactStorageError) return error;
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === 'artifact_missing') {
      return new PrivateArtifactStorageError('artifact_missing', 'Private Artifact is missing.');
    }
    if (
      code === 'invalid_reference' ||
      code === 'artifact_corrupt' ||
      code === 'artifact_conflict'
    ) {
      return new PrivateArtifactStorageError('artifact_corrupt', 'Private Artifact is corrupt.');
    }
    if (code === 'reachability_incomplete') {
      return new PrivateArtifactStorageError(
        'reachability_incomplete',
        'Private Artifact reachability is incomplete.',
      );
    }
  }
  return new PrivateArtifactStorageError(fallback, 'Private Artifact backend operation failed.');
}

function corrupt(): never {
  throw new PrivateArtifactStorageError('artifact_corrupt', 'Private Artifact payload is invalid.');
}
