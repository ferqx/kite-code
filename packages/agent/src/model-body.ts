import type { ModelRequest } from '@kite-ai/ai';
import type { ArtifactReference, Json } from './storage/types';
import { AgentError } from './storage/types';

/** An immutable transport representation, never a substitute for the Provider body. */
export interface ModelBodyReference {
  kind: 'model_body';
  version: 1;
  reference: ArtifactReference;
}
export function bodyReference(value: unknown): ModelBodyReference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== 'model_body') return null;
  const ref = candidate.reference as ArtifactReference | undefined;
  if (
    candidate.version !== 1 ||
    !ref ||
    typeof ref.hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(ref.hash) ||
    !ref.scope ||
    !ref.storeId ||
    !ref.sessionId ||
    !ref.subjectId
  )
    throw new AgentError('model_body_invalid');
  return candidate as unknown as ModelBodyReference;
}
export function utf8Body(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new AgentError('model_body_encoding_invalid');
  }
}
export function jsonBody(bytes: Uint8Array): Json {
  try {
    return JSON.parse(utf8Body(bytes)) as Json;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError('model_body_json_invalid');
  }
}

/** Validate persisted request shape without capturing sources or constructing any Provider. */
export function persistedModelRequest(value: Json): ModelRequest {
  const object = (item: unknown): item is Record<string, Json> =>
    !!item && typeof item === 'object' && !Array.isArray(item);
  const keys = (item: Record<string, Json>, allowed: string[]) =>
    Object.keys(item).every((key) => allowed.includes(key));
  const text = (item: unknown): item is string => typeof item === 'string';
  if (
    !object(value) ||
    !keys(value, ['modelId', 'requestId', 'messages', 'tools']) ||
    !text(value.modelId) ||
    !value.modelId ||
    !text(value.requestId) ||
    !value.requestId ||
    !Array.isArray(value.messages) ||
    !Array.isArray(value.tools)
  )
    throw new AgentError('model_body_invalid');
  for (const message of value.messages) {
    if (
      !object(message) ||
      !keys(message, ['role', 'content', 'toolCalls', 'toolCallId', 'sourceIds']) ||
      !['system', 'user', 'assistant', 'tool'].includes(String(message.role)) ||
      !text(message.content) ||
      (message.toolCallId !== undefined && !text(message.toolCallId)) ||
      (message.sourceIds !== undefined &&
        (!Array.isArray(message.sourceIds) || !message.sourceIds.every(text))) ||
      (message.toolCalls !== undefined &&
        (!Array.isArray(message.toolCalls) ||
          !message.toolCalls.every(
            (call) =>
              object(call) &&
              keys(call, ['id', 'name', 'arguments']) &&
              text(call.id) &&
              text(call.name) &&
              text(call.arguments),
          )))
    )
      throw new AgentError('model_body_invalid');
  }
  for (const tool of value.tools) {
    if (
      !object(tool) ||
      !keys(tool, ['id', 'definitionVersion', 'description', 'inputSchema']) ||
      !text(tool.id) ||
      !tool.id ||
      !text(tool.definitionVersion) ||
      !tool.definitionVersion ||
      !object(tool.inputSchema) ||
      (tool.description !== undefined && !text(tool.description))
    )
      throw new AgentError('model_body_invalid');
  }
  return value as unknown as ModelRequest;
}
