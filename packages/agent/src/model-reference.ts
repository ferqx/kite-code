import type { Json, PublicExecution, ToolContext } from './extensions';
import { AgentError } from './storage/types';

export interface ModelReference {
  executionId: string;
  resultRevision: string;
  index?: number;
}

/** Locator only. The original receipt, owner, scope and domain state remain authoritative. */
export function modelReference(
  kind: string,
  executionId: string,
  index?: number,
  resultRevision = '1',
): string {
  return `${kind}.${Buffer.from(JSON.stringify([executionId, resultRevision, ...(index === undefined ? [] : [index])])).toString('base64url')}`;
}

export function parseModelReference(value: Json | undefined, kind: string): ModelReference {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith(`${kind}.`))
    throw new AgentError('tool_reference_invalid');
  const encoded = value.slice(kind.length + 1);
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw Error();
    const input = JSON.parse(bytes.toString('utf8'));
    if (
      !Array.isArray(input) ||
      input.length < 2 ||
      input.length > 3 ||
      typeof input[0] !== 'string' ||
      !input[0] ||
      input[0].length > 256 ||
      typeof input[1] !== 'string' ||
      !/^[1-9][0-9]*$/.test(input[1]) ||
      (input.length === 3 && (!Number.isSafeInteger(input[2]) || input[2] < 0))
    )
      throw Error();
    return {
      executionId: input[0],
      resultRevision: input[1],
      ...(input.length === 3 ? { index: input[2] } : {}),
    };
  } catch {
    throw new AgentError('tool_reference_invalid');
  }
}

/** Never reads another Session, accepts an unknown result, or borrows another owner's receipt. */
export async function readModelReference(
  value: Json | undefined,
  kind: string,
  context: ToolContext,
  owner?: string,
  definitions?: Readonly<Record<string, readonly string[]>>,
): Promise<{
  execution: PublicExecution;
  result: Record<string, Json>;
  reference: ModelReference;
}> {
  const reference = parseModelReference(value, kind);
  context.signal.throwIfAborted();
  let original: PublicExecution | null;
  let current: PublicExecution | null;
  try {
    [original, current] = await Promise.all([
      context.getExecution(reference.executionId),
      context.getExecution(context.executionId),
    ]);
  } catch {
    context.signal.throwIfAborted();
    throw new AgentError('tool_reference_scope_denied');
  }
  if (
    !context.runId ||
    !current?.originStoreId ||
    !original ||
    original.sessionId !== context.sessionId ||
    current.sessionId !== context.sessionId ||
    original.originStoreId !== current.originStoreId ||
    !original.runId ||
    current.runId !== context.runId ||
    original.id === current.id ||
    original.kind !== 'tool' ||
    !original.extensionId ||
    (owner !== undefined && original.extensionId !== owner) ||
    (definitions !== undefined &&
      !definitions[original.definitionId ?? '']?.includes(original.definitionVersion ?? ''))
  )
    throw new AgentError('tool_reference_scope_denied');
  if (
    original.status !== 'succeeded' ||
    original.resultRevision !== reference.resultRevision ||
    original.authorization?.dispatched !== true
  )
    throw new AgentError('tool_reference_unavailable');
  const result = original.result;
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    result.outcome !== 'succeeded'
  )
    throw new AgentError('tool_reference_unavailable');
  context.signal.throwIfAborted();
  return { execution: original, result, reference };
}
