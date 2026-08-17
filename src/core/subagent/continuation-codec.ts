import type { AIMessage, BaseMessage, ToolMessage } from '@/core/messages';
import { aiMessage, humanMessage, systemMessage, toolMessage } from '@/core/messages';
import { normalizeToolRecoveryJournalV1 } from '@/core/runtime/tool-recovery-journal';
import type {
  JsonObject,
  JsonValue,
  PersistedExecutionJournalEntry,
  PersistedSubagentMessage,
  PersistedSubagentStep,
  SuspendedSubagentSnapshot,
} from '@/protocol/subagent';
import { getRoleConfig } from './roles';
import type {
  RestoredSubAgentContinuation,
  SubAgentBlockedTool,
  SubAgentContinuation,
  SubAgentStepSnapshot,
} from './types';

export function serializeSubagentContinuation(
  continuation: SubAgentContinuation,
  blockedTool: SubAgentBlockedTool,
): SuspendedSubagentSnapshot {
  return {
    subagentId: continuation.id,
    role: continuation.role.role,
    task: continuation.task,
    messages: continuation.messages.map(serializeMessage),
    toolCallCount: continuation.toolCallCount,
    steps: continuation.steps.map(serializeStep),
    ...(continuation.executionJournal
      ? { executionJournal: continuation.executionJournal.map(serializeJournalEntry) }
      : {}),
    ...(continuation.exhaustedFingerprints
      ? { exhaustedFingerprints: { ...continuation.exhaustedFingerprints } }
      : {}),
    toolRecovery: toJsonObject(
      normalizeToolRecoveryJournalV1(continuation.toolRecovery),
      'toolRecovery',
    ),
    ...(continuation.allowedTools ? { allowedTools: [...continuation.allowedTools] } : {}),
    ...(continuation.mcpBindingIds ? { mcpBindingIds: [...continuation.mcpBindingIds] } : {}),
    blockedTool: {
      reasonCode: blockedTool.reasonCode,
      toolCallId: blockedTool.toolCallId,
      ...(blockedTool.runtimeToolCallId
        ? { runtimeToolCallId: blockedTool.runtimeToolCallId }
        : {}),
      toolName: blockedTool.toolName,
      args: toJsonObject(blockedTool.args, 'blockedTool.args'),
      command: blockedTool.command,
    },
  };
}

export function deserializeSubagentContinuation(
  snapshot: SuspendedSubagentSnapshot,
): RestoredSubAgentContinuation {
  return {
    id: snapshot.subagentId,
    role: snapshot.allowedTools
      ? { ...getRoleConfig(snapshot.role), allowedTools: new Set(snapshot.allowedTools) }
      : getRoleConfig(snapshot.role),
    task: snapshot.task,
    messages: snapshot.messages.map(deserializeMessage),
    toolCallCount: snapshot.toolCallCount,
    steps: snapshot.steps.map(deserializeStep),
    ...(snapshot.executionJournal
      ? { executionJournal: snapshot.executionJournal.map(deserializeJournalEntry) }
      : {}),
    ...(snapshot.exhaustedFingerprints
      ? { exhaustedFingerprints: { ...snapshot.exhaustedFingerprints } }
      : {}),
    toolRecovery: normalizeToolRecoveryJournalV1(cloneJsonObject(snapshot.toolRecovery)),
    ...(snapshot.allowedTools ? { allowedTools: [...snapshot.allowedTools] } : {}),
    ...(snapshot.mcpBindingIds ? { mcpBindingIds: [...snapshot.mcpBindingIds] } : {}),
    blockedTool: {
      reasonCode: snapshot.blockedTool.reasonCode,
      toolCallId: snapshot.blockedTool.toolCallId,
      ...(snapshot.blockedTool.runtimeToolCallId
        ? { runtimeToolCallId: snapshot.blockedTool.runtimeToolCallId }
        : {}),
      toolName: snapshot.blockedTool.toolName,
      args: cloneJsonObject(snapshot.blockedTool.args),
      command: snapshot.blockedTool.command,
    },
  };
}

function serializeMessage(message: BaseMessage): PersistedSubagentMessage {
  const base = {
    ...(message.id === undefined ? {} : { id: message.id }),
    ...(message.name === undefined ? {} : { name: message.name }),
    content: toJsonValue(message.content, `${message.type}.content`),
    responseMetadata: toJsonObject(message.response_metadata, `${message.type}.responseMetadata`),
  };

  switch (message.type) {
    case 'system':
      return { type: 'system', ...base };
    case 'human':
      return { type: 'human', ...base };
    case 'ai': {
      const aiMessage = message as AIMessage;
      return {
        type: 'ai',
        ...base,
        toolCalls: (aiMessage.tool_calls ?? []).map((toolCall, index) => ({
          ...(toolCall.id ? { id: toolCall.id } : {}),
          name: toolCall.name,
          args: toJsonObject(toolCall.args, `ai.toolCalls[${index}].args`),
        })),
        additionalKwargs: toJsonObject(aiMessage.additional_kwargs, 'ai.additionalKwargs'),
        ...(aiMessage.invalid_tool_calls === undefined
          ? {}
          : {
              invalidToolCalls: aiMessage.invalid_tool_calls.map((toolCall, index) =>
                toJsonObject(toolCall, `ai.invalidToolCalls[${index}]`),
              ),
            }),
        ...(aiMessage.usage_metadata === undefined
          ? {}
          : { usageMetadata: toJsonObject(aiMessage.usage_metadata, 'ai.usageMetadata') }),
      };
    }
    case 'tool': {
      const toolMessage = message as ToolMessage;
      return {
        type: 'tool',
        ...base,
        toolCallId: toolMessage.tool_call_id,
        ...(toolMessage.name === undefined ? {} : { name: toolMessage.name }),
        ...(toolMessage.status
          ? { status: toolMessage.status as 'success' | 'error' | 'exhausted' }
          : {}),
        ...(toolMessage.artifact === undefined
          ? {}
          : { artifact: toJsonValue(toolMessage.artifact, 'tool.artifact') }),
        ...(toolMessage.metadata === undefined
          ? {}
          : { metadata: toJsonObject(toolMessage.metadata, 'tool.metadata') }),
      };
    }
    default:
      throw new Error(`Unsupported sub-agent continuation message type: ${message.type}`);
  }
}

function deserializeMessage(message: PersistedSubagentMessage): BaseMessage {
  return deserializeMessageImpl(message);
}

function deserializeMessageImpl(message: PersistedSubagentMessage): BaseMessage {
  const id = (message.id !== undefined ? cloneJsonValue(message.id) : undefined) as
    | string
    | undefined;
  const name = (message.name !== undefined ? cloneJsonValue(message.name) : undefined) as
    | string
    | undefined;
  const responseMetadata = cloneJsonObject(message.responseMetadata ?? {});

  switch (message.type) {
    case 'system':
      return systemMessage(cloneJsonValue(message.content) as string, {
        id,
        name,
        response_metadata: responseMetadata,
      });
    case 'human':
      return humanMessage({
        content: cloneJsonValue(message.content) as string,
        id,
        name,
        response_metadata: responseMetadata,
      });
    case 'ai':
      return aiMessage({
        id,
        name,
        content: cloneJsonValue(message.content) as string,
        additional_kwargs: cloneJsonObject(message.additionalKwargs),
        response_metadata: responseMetadata,
        tool_calls: message.toolCalls.map((toolCall) => ({
          ...(toolCall.id === undefined ? {} : { id: toolCall.id }),
          name: toolCall.name,
          args: cloneJsonObject(toolCall.args),
          type: 'tool_call' as const,
        })),
        ...(message.invalidToolCalls === undefined
          ? {}
          : {
              invalid_tool_calls: message.invalidToolCalls.map(
                cloneJsonObject,
              ) as AIMessage['invalid_tool_calls'],
            }),
        ...(message.usageMetadata === undefined
          ? {}
          : {
              usage_metadata: cloneJsonObject(message.usageMetadata) as AIMessage['usage_metadata'],
            }),
      });
    case 'tool':
      return toolMessage({
        id,
        name,
        content: cloneJsonValue(message.content) as string,
        tool_call_id: message.toolCallId,
        status: (message.status ?? 'success') as 'success' | 'error' | 'exhausted',
        response_metadata: responseMetadata,
        ...(message.artifact === undefined ? {} : { artifact: cloneJsonValue(message.artifact) }),
        ...(message.metadata === undefined ? {} : { metadata: cloneJsonObject(message.metadata) }),
      });
    default:
      throw new Error(
        `Unsupported persisted sub-agent continuation message type: ${String(message)}`,
      );
  }
}

function serializeStep(step: SubAgentStepSnapshot): PersistedSubagentStep {
  return {
    toolName: step.toolName,
    toolArgs: toJsonObject(step.toolArgs, `step.${step.toolName}.toolArgs`),
    status: step.status,
    ...(step.ok === undefined ? {} : { ok: step.ok }),
    ...(step.totalLines === undefined ? {} : { totalLines: step.totalLines }),
  };
}

function deserializeStep(step: PersistedSubagentStep): SubAgentStepSnapshot {
  return {
    toolName: step.toolName,
    toolArgs: cloneJsonObject(step.toolArgs),
    status: step.status,
    ...(step.ok === undefined ? {} : { ok: step.ok }),
    ...(step.totalLines === undefined ? {} : { totalLines: step.totalLines }),
  };
}

function serializeJournalEntry(
  entry: import('@/core/execution/journal').ExecutionJournalEntry,
): PersistedExecutionJournalEntry {
  return { ...entry };
}

function deserializeJournalEntry(
  entry: PersistedExecutionJournalEntry,
): import('@/core/execution/journal').ExecutionJournalEntry {
  return { ...entry };
}

function toJsonObject(value: unknown, path: string): JsonObject {
  const jsonValue = toJsonValue(value, path);
  if (!isJsonObject(jsonValue)) {
    throw new Error(`Expected JSON object at ${path}`);
  }
  return jsonValue;
}

function cloneJsonValue(value: JsonValue): JsonValue {
  return toJsonValue(value, 'snapshot');
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return toJsonObject(value, 'snapshot');
}

function toJsonValue(value: unknown, path: string, seen = new WeakSet<object>()): JsonValue {
  if (value === undefined) return null; // undefined → null (JSON-compatible)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new Error(`Non-JSON number at ${path}`);
  }
  if (typeof value !== 'object') {
    throw new Error(`Non-JSON value at ${path}: ${typeof value}`);
  }
  if (seen.has(value)) throw new Error(`Circular value at ${path}`);
  if (value instanceof Set || value instanceof Map || value instanceof Date) {
    throw new Error(`Non-JSON value at ${path}: ${value.constructor.name}`);
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => toJsonValue(entry, `${path}[${index}]`, seen));
    }
    if (!isPlainObject(value)) {
      throw new Error(`Non-JSON value at ${path}: ${value.constructor.name}`);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        toJsonValue(entry, `${path}.${key}`, seen),
      ]),
    );
  } finally {
    seen.delete(value);
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
