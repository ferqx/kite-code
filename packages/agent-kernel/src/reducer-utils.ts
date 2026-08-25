import type { KernelEvent } from './events';
import type {
  AgentInteractionState,
  AgentState,
  AgentTaskState,
  AgentToolCallState,
  JsonObject,
  JsonValue,
} from './state';

export type UnknownRecord = Readonly<Record<string, unknown>>;

type FieldContainer = object;

export function eventRecord(event: KernelEvent): UnknownRecord {
  return event as unknown as UnknownRecord;
}

/** State entries retain event facts, never the persisted discriminant itself. */
export function eventData(event: KernelEvent): UnknownRecord {
  const { type: _type, ...data } = eventRecord(event);
  return data;
}

export function stringField(value: FieldContainer, field: string): string | undefined {
  const candidate = (value as UnknownRecord)[field];
  return typeof candidate === 'string' ? candidate : undefined;
}

export function nonEmptyStringField(value: FieldContainer, field: string): string | undefined {
  const candidate = stringField(value, field);
  return candidate && candidate.length > 0 ? candidate : undefined;
}

export function numberField(value: FieldContainer, field: string): number | undefined {
  const candidate = (value as UnknownRecord)[field];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

export function booleanField(value: FieldContainer, field: string): boolean | undefined {
  const candidate = (value as UnknownRecord)[field];
  return typeof candidate === 'boolean' ? candidate : undefined;
}

export function recordField(value: FieldContainer, field: string): UnknownRecord | undefined {
  const candidate = (value as UnknownRecord)[field];
  return isRecord(candidate) ? candidate : undefined;
}

export function arrayField(value: FieldContainer, field: string): readonly unknown[] | undefined {
  const candidate = (value as UnknownRecord)[field];
  return Array.isArray(candidate) ? candidate : undefined;
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

export function asJsonObject<T extends object = JsonObject>(value: object): T {
  return value as T;
}

export function taskRecord(value: FieldContainer): AgentTaskState {
  return value as unknown as AgentTaskState;
}

export function toolCallRecord(value: FieldContainer): AgentToolCallState {
  return value as unknown as AgentToolCallState;
}

export function updateTasks(
  state: AgentState,
  taskId: string,
  update: (current: AgentTaskState | undefined) => AgentTaskState,
): AgentState {
  const current = state.tasks[taskId];
  const next = update(current);
  return { ...state, tasks: { ...state.tasks, [taskId]: next } };
}

export function updateInteractions(
  state: AgentState,
  interaction: AgentInteractionState,
): AgentState {
  return { ...state, interactions: interaction };
}

export function updateToolCall(
  state: AgentState,
  toolCallId: string,
  update: (current: AgentToolCallState | undefined) => AgentToolCallState | undefined,
): AgentState {
  const current = state.tools.calls[toolCallId];
  const next = update(current);
  if (!next) return state;
  return {
    ...state,
    tools: { ...state.tools, calls: { ...state.tools.calls, [toolCallId]: next } },
  };
}

export function replaceStringInList(values: readonly string[], value: string, present: boolean) {
  const next = values.filter((candidate) => candidate !== value);
  if (present) next.push(value);
  return next;
}

export function jsonRecord<T extends object = JsonObject>(value: unknown): T {
  return (isRecord(value) ? value : {}) as T;
}
