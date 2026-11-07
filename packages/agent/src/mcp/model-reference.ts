import type { AuthorizationRequest, Json, ToolContext, ToolResult } from '../extensions';
import { canonicalJson } from '../json';
import { modelIdentifier, readModelIdentifier } from '../model-identifier';
import { modelReference, readModelReference } from '../model-reference';
import { AgentError } from '../storage/types';

const object = (value: Json | undefined): Record<string, Json> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
type Kind = 'connection' | 'resource' | 'prompt';
const field = (kind: Kind) => `${kind}Ref`;
const kinds = { connection: 'mc', resource: 'mr', prompt: 'mp' };
function locator(value: Json | undefined) {
  if (typeof value !== 'string' || value.length > 4096)
    throw new AgentError('tool_reference_invalid');
  const kind = (Object.keys(kinds) as Kind[]).find((kind) => value.startsWith(`${kinds[kind]}_`));
  const bytes = Buffer.from(value.slice(3), 'base64url');
  if (bytes.toString('base64url') !== value.slice(3))
    throw new AgentError('tool_reference_invalid');
  if (!kind || bytes.length < (kind === 'connection' ? 2 : 6))
    throw new AgentError('tool_reference_invalid');
  const end = kind === 'connection' ? bytes.length : bytes.length - 4;
  const executionId = readModelIdentifier(
    `${String.fromCharCode(bytes[0]!)}${bytes.subarray(1, end).toString('base64url')}`,
  );
  return {
    kind,
    executionId,
    revision: '1',
    ...(kind === 'connection' ? {} : { index: bytes.readUInt32BE(end) }),
  };
}
export function mcpModelReference(kind: Kind, executionId: string, index?: number): string {
  const id = modelIdentifier(executionId);
  const suffix = Buffer.alloc(kind === 'connection' ? 0 : 4);
  if (kind !== 'connection') {
    if (index === undefined || !Number.isSafeInteger(index) || index < 0 || index > 0xffffffff)
      throw new AgentError('mcp_reference_unavailable');
    suffix.writeUInt32BE(index);
  } else if (index !== undefined) throw new AgentError('mcp_reference_unavailable');
  return `${kinds[kind]}_${Buffer.concat([Buffer.from(id[0]!), Buffer.from(id.slice(1), 'base64url'), suffix]).toString('base64url')}`;
}
/** Routing is read from the original receipt, never copied by the Model. Full dispatch proof remains mandatory. */
export async function mcpModelInputHint(
  request: Pick<
    AuthorizationRequest,
    'kind' | 'definitionId' | 'definitionVersion' | 'sessionId' | 'input'
  >,
  scope: {
    readExecution(id: string): Promise<{ sessionId: string; status: string; result: Json } | null>;
  },
): Promise<Record<string, Json>> {
  const raw = object(request.input);
  if (
    request.kind !== 'tool' ||
    request.definitionVersion !== '1' ||
    ![
      'mcp.catalogue.refresh',
      'mcp.resources.list',
      'mcp.resources.read',
      'mcp.prompts.list',
      'mcp.prompts.get',
    ].includes(request.definitionId)
  )
    return raw;
  for (const kind of ['connection', 'resource', 'prompt'] as const) {
    if (raw[field(kind)] === undefined) continue;
    const target = locator(raw[field(kind)]);
    if (target.kind !== kind) throw new AgentError('tool_reference_invalid');
    const execution = await scope.readExecution(target.executionId);
    if (!execution || execution.sessionId !== request.sessionId || execution.status !== 'succeeded')
      throw new AgentError('tool_reference_scope_denied');
    const details = object(object(execution.result).details);
    const original =
      kind === 'connection'
        ? details.connection_ref
        : object(
            Array.isArray(details.descriptors) ? details.descriptors[target.index!] : undefined,
          )[`${kind}_ref`];
    const binding = object(kind === 'connection' ? details.modelBinding : details.binding);
    if (original !== raw[field(kind)] || typeof binding.serverId !== 'string')
      throw new AgentError('tool_reference_unavailable');
    return {
      serverId: binding.serverId,
      ...(kind === 'prompt' ? { arguments: raw.arguments ?? {} } : {}),
    };
  }
  return raw;
}
export async function mcpModelInput(
  input: Json,
  kind: Kind,
  context: ToolContext,
): Promise<Record<string, Json>> {
  const raw = object(input),
    value = raw[field(kind)];
  if (value === undefined) return raw; // Canonical trusted Actions retain their original explicit contract.
  const target = locator(value);
  if (target.kind !== kind) throw new AgentError('tool_reference_invalid');
  const { result } = await readModelReference(
    modelReference('mcp', target.executionId, undefined, target.revision),
    'mcp',
    context,
    'builtin.mcp',
    kind === 'connection'
      ? { 'mcp.connect': ['1'], 'mcp.catalogue.refresh': ['1'] }
      : { [kind === 'resource' ? 'mcp.resources.list' : 'mcp.prompts.list']: ['1'] },
  );
  const details = object(result.details);
  const original =
    kind === 'connection'
      ? details.connection_ref
      : Array.isArray(details.descriptors) && typeof target.index === 'number'
        ? object(details.descriptors[target.index])[`${kind}_ref`]
        : undefined;
  if (original !== value) throw new AgentError('tool_reference_unavailable');
  if (kind === 'connection') {
    const binding = object(details.modelBinding);
    if (typeof binding.serverId !== 'string') throw new AgentError('tool_reference_unavailable');
    return binding;
  }
  const binding = object(details.binding),
    descriptor = object(details.descriptors && (details.descriptors as Json[])[target.index!]);
  if (typeof binding.serverId !== 'string') throw new AgentError('tool_reference_unavailable');
  const item = object(descriptor.descriptor);
  return {
    serverId: binding.serverId!,
    connectionKey: binding.connectionKey!,
    configDigest: binding.configDigest!,
    generation: binding.generation!,
    catalogueExecutionId: target.executionId,
    descriptorDigest: descriptor.descriptorDigest!,
    ...(kind === 'resource' ? { uri: item.uri! } : { name: item.name! }),
    ...(kind === 'prompt' ? { arguments: raw.arguments ?? {} } : {}),
  };
}
export function mcpReferenceResult(
  result: ToolResult,
  kind: 'connection' | 'resources' | 'prompts',
  executionId: string,
  connection?: Record<string, Json>,
): ToolResult {
  if (result.outcome !== 'succeeded') return result;
  const details = { ...object(result.details) };
  if (kind === 'connection') {
    if (!connection) throw new AgentError('mcp_reference_unavailable');
    details.modelBinding = connection;
    details.connection_ref = mcpModelReference('connection', executionId);
  } else {
    const category = kind === 'resources' ? 'resource' : 'prompt';
    details.descriptors = (details.descriptors as Json[]).map((raw, index) => {
      const item = object(raw);
      return {
        ...item,
        [`${category}_ref`]: mcpModelReference(category, executionId, index),
      };
    });
  }
  return {
    ...result,
    details,
    content: canonicalJson(details),
  };
}
