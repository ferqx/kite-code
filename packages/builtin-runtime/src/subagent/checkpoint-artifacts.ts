import type { BaseMessage } from '../model/messages';
import {
  type PrivateImmutableArtifactRef,
  PrivateImmutableArtifactStorage,
  type PrivateImmutableArtifactStorageBackend,
} from '../model/private-immutable-artifacts';
import { canonicalModelJson } from '../model/surface-canonicalizer';
import { subagentCheckpointArtifactRoot } from './artifact-paths';

export type SubagentCheckpointArtifactRef = PrivateImmutableArtifactRef<'subagent_checkpoint'>;

export interface SubagentCheckpoint {
  readonly ownerKey: string;
  readonly taskId: string;
  readonly modelInvocationOrdinal: number;
  readonly messages: readonly BaseMessage[];
}

/** Full private child transcript. Ref possession does not grant a new execution. */
export class SubagentCheckpointArtifactStore {
  readonly #storage: PrivateImmutableArtifactStorage<'subagent_checkpoint'>;

  constructor(
    options: {
      root?: string;
      backend?: PrivateImmutableArtifactStorageBackend<'subagent_checkpoint'>;
    } = {},
  ) {
    this.#storage = new PrivateImmutableArtifactStorage({
      ...(options.backend
        ? { backend: options.backend }
        : { root: options.root ?? subagentCheckpointArtifactRoot() }),
      namespace: 'subagent-checkpoints',
      partitions: [{ kind: 'subagent_checkpoint', directory: 'checkpoints', extension: '.json' }],
    });
  }

  write(checkpoint: SubagentCheckpoint): SubagentCheckpointArtifactRef {
    // Provider response metadata may contain optional undefined values. They
    // have no transcript meaning and are omitted by the model's JSON transport.
    const messages = JSON.parse(JSON.stringify(checkpoint.messages)) as unknown;
    const value = validateCheckpoint({ ...checkpoint, messages });
    return this.#storage.write(
      'subagent_checkpoint',
      Buffer.from(canonicalModelJson({ artifactFormatVersion: 1, ...value }), 'utf8'),
    );
  }

  read(ref: SubagentCheckpointArtifactRef, ownerKey: string, taskId: string): SubagentCheckpoint {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(this.#storage.read(ref));
    const value: unknown = JSON.parse(text);
    if (
      !plain(value) ||
      JSON.stringify(Object.keys(value).sort()) !==
        JSON.stringify(
          [
            'artifactFormatVersion',
            'messages',
            'modelInvocationOrdinal',
            'ownerKey',
            'taskId',
          ].sort(),
        ) ||
      canonicalModelJson(value) !== text ||
      value.artifactFormatVersion !== 1
    ) {
      throw new Error('Subagent checkpoint Artifact is invalid.');
    }
    const checkpoint = validateCheckpoint(value);
    if (checkpoint.ownerKey !== ownerKey || checkpoint.taskId !== taskId) {
      throw new Error('Subagent checkpoint Artifact owner does not match.');
    }
    return checkpoint;
  }
}

function validateCheckpoint(value: unknown): SubagentCheckpoint {
  if (
    !plain(value) ||
    typeof value.ownerKey !== 'string' ||
    value.ownerKey.length === 0 ||
    typeof value.taskId !== 'string' ||
    value.taskId.length === 0 ||
    !Number.isSafeInteger(value.modelInvocationOrdinal) ||
    (value.modelInvocationOrdinal as number) < 1 ||
    !Array.isArray(value.messages) ||
    value.messages.length === 0 ||
    !value.messages.every(validMessage)
  ) {
    throw new Error('Subagent checkpoint Artifact payload is invalid.');
  }
  return Object.freeze({
    ownerKey: value.ownerKey,
    taskId: value.taskId,
    modelInvocationOrdinal: value.modelInvocationOrdinal as number,
    messages: Object.freeze(structuredClone(value.messages) as BaseMessage[]),
  });
}

function validMessage(value: unknown): boolean {
  return (
    plain(value) &&
    ['human', 'ai', 'system', 'tool'].includes(String(value.type)) &&
    (typeof value.content === 'string' || Array.isArray(value.content)) &&
    plain(value.additional_kwargs) &&
    plain(value.response_metadata)
  );
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
