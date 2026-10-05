import {
  type ModelAdapter,
  type ModelAdapterSnapshot,
  type ModelRequest,
  reasoningEfforts,
} from '@kite-ai/ai';
import type { ExecutionScope } from './execution';
import { semanticDigest } from './json';
import { AgentError, type Json } from './storage/types';

/** Actual per-Execution facts. Request content/order/schema remain in its complete immutable input. */
export interface ModelRequestMetadata {
  readonly version: 1;
  readonly adapter:
    | ({ readonly availability: 'available' } & ModelAdapterSnapshot)
    | { readonly availability: 'unavailable'; readonly reason: 'adapter_opaque' };
  readonly assembly: {
    readonly extensions: readonly { id: string; version: string }[];
    readonly tools: readonly { id: string; definitionVersion: string; extensionId: string }[];
    readonly capabilitySnapshotDigest: string | null;
  };
  readonly context: {
    readonly transformationId: 'kite.model-request';
    readonly transformationVersion: '1';
    readonly messageOrder: 'request.messages';
    readonly sourceOrder: 'request.messages[].sourceIds';
    readonly sources: readonly { id: string; digest: string }[];
  };
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function closed(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}
/** A host may provide known facts; opaque Provider objects and arbitrary extra fields are never projected. */
function adapterSnapshot(value: ModelAdapterSnapshot): ModelAdapterSnapshot {
  if (
    !object(value) ||
    !closed(value, ['adapterId', 'adapterVersion', 'provider', 'settings', 'transformation']) ||
    typeof value.adapterId !== 'string' ||
    !value.adapterId ||
    typeof value.adapterVersion !== 'string' ||
    !value.adapterVersion ||
    !object(value.provider) ||
    !object(value.settings) ||
    !object(value.transformation) ||
    !closed(value.transformation, ['id', 'version']) ||
    typeof value.transformation.id !== 'string' ||
    typeof value.transformation.version !== 'string' ||
    !closed(value.settings, [
      'reasoningEffort',
      'temperature',
      'topP',
      'maxOutputTokens',
      'maxRetries',
      'maxSteps',
      'allowSystemInMessages',
      'includeUsage',
    ]) ||
    !Number.isSafeInteger(value.settings.maxRetries) ||
    value.settings.maxRetries < 0 ||
    !Number.isSafeInteger(value.settings.maxSteps) ||
    value.settings.maxSteps < 1 ||
    typeof value.settings.allowSystemInMessages !== 'boolean' ||
    (value.settings.includeUsage !== undefined &&
      typeof value.settings.includeUsage !== 'boolean') ||
    (value.settings.reasoningEffort !== undefined &&
      !reasoningEfforts.includes(value.settings.reasoningEffort)) ||
    ['temperature', 'topP', 'maxOutputTokens'].some(
      (key) =>
        value.settings[key as keyof typeof value.settings] !== undefined &&
        (typeof value.settings[key as keyof typeof value.settings] !== 'number' ||
          !Number.isFinite(value.settings[key as keyof typeof value.settings])),
    ) ||
    (value.provider.availability === 'available'
      ? !closed(value.provider, ['availability', 'family', 'modelId']) ||
        typeof value.provider.family !== 'string' ||
        typeof value.provider.modelId !== 'string'
      : value.provider.availability !== 'unavailable' ||
        !closed(value.provider, ['availability', 'reason']) ||
        typeof value.provider.reason !== 'string')
  )
    throw new AgentError('model_snapshot_invalid');
  return structuredClone(value);
}
export async function captureModelRequestMetadata(
  scope: ExecutionScope,
  model: ModelAdapter,
  request: ModelRequest,
): Promise<ModelRequestMetadata> {
  const described = model.describeRequest?.(request);
  return {
    version: 1,
    adapter: described
      ? { availability: 'available', ...adapterSnapshot(described) }
      : { availability: 'unavailable', reason: 'adapter_opaque' },
    assembly: {
      extensions: (scope.bindings?.extensions ?? []).map(({ id, version }) => ({ id, version })),
      tools: request.tools.map((tool) => {
        const extension = scope.bindings?.extensions.find((entry) =>
          entry.tools?.some(
            (definition) =>
              definition.id === tool.id && definition.version === tool.definitionVersion,
          ),
        );
        if (!extension) throw new AgentError('model_snapshot_definition_unavailable');
        return {
          id: tool.id,
          definitionVersion: tool.definitionVersion,
          extensionId: extension.id,
        };
      }),
      capabilitySnapshotDigest:
        scope.bindings?.capabilitySnapshot === undefined
          ? null
          : await semanticDigest(scope.bindings.capabilitySnapshot),
    },
    context: {
      transformationId: 'kite.model-request',
      transformationVersion: '1',
      messageOrder: 'request.messages',
      sourceOrder: 'request.messages[].sourceIds',
      sources: (scope.decisionSources ?? []).map(({ id, digest }) => ({ id, digest })),
    },
  };
}
export function modelMetadataJson(value: ModelRequestMetadata): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

export interface ModelDispatchMetadata {
  readonly availability: 'available';
  readonly allowed: true;
  readonly revision: string;
  readonly definitionVersion: string;
  readonly inputDigest: string;
  readonly controlReads?: readonly import('./storage/port').PermissionControlRead[];
  readonly policy: { namespace: string; version: string; data: Json } | null;
}
export type ModelInputMetadata = (
  | ModelRequestMetadata
  | {
      version: 1;
      adapter: { availability: 'unavailable'; reason: 'not_recorded' | 'unsupported_version' };
      assembly: null;
      context: null;
    }
) & {
  authorization: ModelDispatchMetadata | { availability: 'unavailable'; reason: 'not_dispatched' };
};
function json(value: unknown): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(json);
  return object(value) && Object.values(value).every(json);
}
function identity(value: unknown): value is { id: string; version: string } {
  return (
    object(value) &&
    closed(value, ['id', 'version']) &&
    typeof value.id === 'string' &&
    typeof value.version === 'string'
  );
}
/** Closed version-1 projection; a future version is unavailable, never interpreted as the current format. */
export function persistedModelRequestMetadata(value: Json): ModelRequestMetadata {
  if (!object(value) || value.version !== 1)
    throw new AgentError('model_snapshot_version_unavailable');
  if (
    !closed(value, ['version', 'adapter', 'assembly', 'context']) ||
    !object(value.adapter) ||
    !object(value.assembly) ||
    !object(value.context)
  )
    throw new AgentError('model_snapshot_invalid');
  const adapter = value.adapter;
  if (adapter.availability === 'available') {
    const { availability: _availability, ...description } = adapter;
    adapterSnapshot(description as unknown as ModelAdapterSnapshot);
  } else if (
    adapter.availability !== 'unavailable' ||
    !closed(adapter, ['availability', 'reason']) ||
    adapter.reason !== 'adapter_opaque'
  )
    throw new AgentError('model_snapshot_invalid');
  const assembly = value.assembly,
    context = value.context;
  if (
    !closed(assembly, ['extensions', 'tools', 'capabilitySnapshotDigest']) ||
    !Array.isArray(assembly.extensions) ||
    !assembly.extensions.every(identity) ||
    !Array.isArray(assembly.tools) ||
    !assembly.tools.every(
      (tool) =>
        object(tool) &&
        closed(tool, ['id', 'definitionVersion', 'extensionId']) &&
        ['id', 'definitionVersion', 'extensionId'].every((key) => typeof tool[key] === 'string'),
    ) ||
    (assembly.capabilitySnapshotDigest !== null &&
      (typeof assembly.capabilitySnapshotDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(assembly.capabilitySnapshotDigest))) ||
    !closed(context, [
      'transformationId',
      'transformationVersion',
      'messageOrder',
      'sourceOrder',
      'sources',
    ]) ||
    context.transformationId !== 'kite.model-request' ||
    context.transformationVersion !== '1' ||
    context.messageOrder !== 'request.messages' ||
    context.sourceOrder !== 'request.messages[].sourceIds' ||
    !Array.isArray(context.sources) ||
    !context.sources.every(
      (source) =>
        object(source) &&
        closed(source, ['id', 'digest']) &&
        typeof source.id === 'string' &&
        typeof source.digest === 'string',
    )
  )
    throw new AgentError('model_snapshot_invalid');
  return structuredClone(value) as unknown as ModelRequestMetadata;
}
export function modelDispatchMetadata(value: Json | null): ModelInputMetadata['authorization'] {
  if (value === null) return { availability: 'unavailable', reason: 'not_dispatched' };
  if (
    !object(value) ||
    !closed(value, [
      'allowed',
      'revision',
      'definitionVersion',
      'inputDigest',
      'snapshot',
      'controlReads',
      'reviewExecutionId',
      'interactionId',
      'decisionRevision',
    ]) ||
    value.allowed !== true ||
    typeof value.revision !== 'string' ||
    typeof value.definitionVersion !== 'string' ||
    typeof value.inputDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.inputDigest)
  )
    throw new AgentError('model_snapshot_invalid');
  const snapshot = value.snapshot;
  if (
    snapshot !== undefined &&
    (!object(snapshot) ||
      !closed(snapshot, ['namespace', 'version', 'data']) ||
      typeof snapshot.namespace !== 'string' ||
      !snapshot.namespace ||
      typeof snapshot.version !== 'string' ||
      !snapshot.version ||
      !json(snapshot.data))
  )
    throw new AgentError('model_snapshot_invalid');
  if (
    value.controlReads !== undefined &&
    (!Array.isArray(value.controlReads) ||
      value.controlReads.length > 3 ||
      !value.controlReads.every(
        (read) =>
          object(read) &&
          closed(read, ['kind', 'scope', 'revision']) &&
          ['permission.mode', 'workspace.trust'].includes(String(read.kind)) &&
          typeof read.scope === 'string' &&
          typeof read.revision === 'string' &&
          /^(0|[1-9][0-9]*)$/.test(read.revision) &&
          BigInt(read.revision) <= 9223372036854775807n,
      ))
  )
    throw new AgentError('model_snapshot_invalid');
  return {
    availability: 'available',
    allowed: true,
    revision: value.revision,
    definitionVersion: value.definitionVersion,
    inputDigest: value.inputDigest,
    ...(value.controlReads === undefined
      ? {}
      : {
          controlReads: structuredClone(
            value.controlReads,
          ) as unknown as import('./storage/port').PermissionControlRead[],
        }),
    policy:
      snapshot === undefined
        ? null
        : (structuredClone(snapshot) as unknown as ModelDispatchMetadata['policy']),
  };
}
export function modelInputMetadata(
  value: Json | null,
  authorization: Json | null,
): ModelInputMetadata {
  const dispatch = modelDispatchMetadata(authorization);
  if (value === null || (object(value) && value.version !== 1))
    return {
      version: 1,
      adapter: {
        availability: 'unavailable',
        reason: value === null ? 'not_recorded' : 'unsupported_version',
      },
      assembly: null,
      context: null,
      authorization: dispatch,
    };
  return { ...persistedModelRequestMetadata(value), authorization: dispatch };
}
