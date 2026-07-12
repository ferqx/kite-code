import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
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
    blockedTool: {
      toolCallId: blockedTool.toolCallId,
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
    role: getRoleConfig(snapshot.role),
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
    blockedTool: {
      toolCallId: snapshot.blockedTool.toolCallId,
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
    content: toJsonValue(message.content, `${message.getType()}.content`),
    responseMetadata: toJsonObject(
      message.response_metadata,
      `${message.getType()}.responseMetadata`,
    ),
  };

  switch (message.getType()) {
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
        ...(toolMessage.status ? { status: toolMessage.status } : {}),
        ...(toolMessage.artifact === undefined
          ? {}
          : { artifact: toJsonValue(toolMessage.artifact, 'tool.artifact') }),
        ...(toolMessage.metadata === undefined
          ? {}
          : { metadata: toJsonObject(toolMessage.metadata, 'tool.metadata') }),
      };
    }
    default:
      throw new Error(`Unsupported sub-agent continuation message type: ${message.getType()}`);
  }
}

function deserializeMessage(message: PersistedSubagentMessage): BaseMessage {
  switch (message.type) {
    case 'system':
      return new SystemMessage({
        ...messageIdentity(message),
        content: cloneJsonValue(message.content) as string,
      });
    case 'human':
      return new HumanMessage({
        ...messageIdentity(message),
        content: cloneJsonValue(message.content) as string,
      });
    case 'ai':
      return new AIMessage({
        ...messageIdentity(message),
        content: cloneJsonValue(message.content) as string,
        additional_kwargs: cloneJsonObject(message.additionalKwargs),
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
      return new ToolMessage({
        ...messageIdentity(message),
        content: cloneJsonValue(message.content) as string,
        tool_call_id: message.toolCallId,
        ...(message.name === undefined ? {} : { name: message.name }),
        ...(message.status === undefined
          ? {}
          : { status: message.status as unknown as ToolMessage['status'] }),
        ...(message.artifact === undefined ? {} : { artifact: cloneJsonValue(message.artifact) }),
        ...(message.metadata === undefined ? {} : { metadata: cloneJsonObject(message.metadata) }),
      });
    default:
      throw new Error(
        `Unsupported persisted sub-agent continuation message type: ${String(message)}`,
      );
  }
}

function messageIdentity(message: { id?: string; name?: string; responseMetadata?: JsonObject }): {
  id?: string;
  name?: string;
  response_metadata: JsonObject;
} {
  return {
    ...(message.id === undefined ? {} : { id: message.id }),
    ...(message.name === undefined ? {} : { name: message.name }),
    response_metadata: cloneJsonObject(message.responseMetadata ?? {}),
  };
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
