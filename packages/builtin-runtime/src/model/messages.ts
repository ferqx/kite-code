// Builtin Runtime model message values.
// Internal message types — lightweight plain-object message interfaces.
//
// Design:
// - Messages are plain objects discriminated by a `type` field ('human' | 'ai' | 'system' | 'tool').
// - Factory functions replace class constructors.
// - Type guard functions replace static .isInstance() methods.
// - After JSON round-trip (checkpoint serialization), the `type` field still discriminates correctly.
//
// API mapping:
//   new AIMessage({...})       → aiMessage({...})
//   new HumanMessage('text')   → humanMessage('text')
//   new HumanMessage({c, id})  → humanMessage({content: c, id})
//   new SystemMessage('text')  → systemMessage('text')
//   new ToolMessage({...})     → toolMessage({...})
//   AIMessage.isInstance(msg)  → isAIMessage(msg)
//   ToolMessage.isInstance(msg)→ isToolMessage(msg)
//   HumanMessage.isInstance(m) → isHumanMessage(msg)
//   SystemMessage.isInstance(m)→ isSystemMessage(msg)
//   type BaseMessage           → type BaseMessage (same name, interface)
//   type AIMessage             → type AIMessage (same name, interface)

// ── Content block type (subset of AI SDK content parts) ──

export type ContentBlock =
  | { type: 'text'; text: string; [key: string]: unknown }
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      [key: string]: unknown;
    }
  | {
      type: 'tool-result';
      toolCallId: string;
      toolName: string;
      output: unknown;
      [key: string]: unknown;
    }
  | { type: 'reasoning'; text: string; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

// ── Supplemental types ──

export interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
  type?: 'tool_call';
}

export interface UsageMetadata {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_token_details?: { cache_read?: number };
}

// ── Message interfaces ──

export interface BaseMessage {
  readonly type: 'human' | 'ai' | 'system' | 'tool';
  content: string | ContentBlock[];
  id?: string;
  name?: string;
  additional_kwargs: Record<string, unknown>;
  response_metadata: Record<string, unknown>;
}

export interface HumanMessage extends BaseMessage {
  readonly type: 'human';
}

export interface SystemMessage extends BaseMessage {
  readonly type: 'system';
}

export interface AIMessage extends BaseMessage {
  readonly type: 'ai';
  tool_calls?: ToolCall[];
  /** Invalid/unparseable tool calls (LangChain compatibility) */
  invalid_tool_calls?: Array<{ id?: string; name: string; args: string; error?: string }>;
  usage_metadata?: UsageMetadata;
}

export interface ToolMessage extends BaseMessage {
  readonly type: 'tool';
  tool_call_id: string;
  name?: string;
  /** 'success' | 'error' | 'exhausted' — typed as string to allow custom states */
  status: string;
  /** Arbitrary metadata attached to the tool result (LangChain compatibility) */
  metadata?: Record<string, unknown>;
  /** Arbitrary artifact attached to the tool result (LangChain compatibility) */
  artifact?: unknown;
}

// ── Factory functions ──

/** Create a HumanMessage from a string or fields object. */
export function humanMessage(content: string): HumanMessage;
export function humanMessage(fields: {
  content: string;
  id?: string;
  name?: string;
  response_metadata?: Record<string, unknown>;
}): HumanMessage;
export function humanMessage(
  input:
    | string
    | { content: string; id?: string; name?: string; response_metadata?: Record<string, unknown> },
): HumanMessage {
  const content = typeof input === 'string' ? input : input.content;
  const id = typeof input === 'string' ? undefined : input.id;
  const name = typeof input === 'string' ? undefined : input.name;
  const responseMetadata = typeof input === 'string' ? undefined : input.response_metadata;
  return {
    type: 'human' as const,
    content,
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    additional_kwargs: {},
    response_metadata: responseMetadata ?? {},
  };
}

/** Create a SystemMessage. */
export function systemMessage(
  content: string,
  fields?: { id?: string; name?: string; response_metadata?: Record<string, unknown> },
): SystemMessage {
  return {
    type: 'system' as const,
    content,
    ...(fields?.id ? { id: fields.id } : {}),
    ...(fields?.name ? { name: fields.name } : {}),
    additional_kwargs: {},
    response_metadata: fields?.response_metadata ?? {},
  };
}

/** Create an AIMessage. */
export function aiMessage(fields: {
  content?: string | ContentBlock[];
  id?: string;
  name?: string;
  tool_calls?: ToolCall[];
  invalid_tool_calls?: AIMessage['invalid_tool_calls'];
  additional_kwargs?: Record<string, unknown>;
  response_metadata?: Record<string, unknown>;
  usage_metadata?: UsageMetadata;
}): AIMessage {
  return {
    type: 'ai' as const,
    content: fields.content ?? '',
    ...(fields.id ? { id: fields.id } : {}),
    ...(fields.name ? { name: fields.name } : {}),
    ...(fields.tool_calls !== undefined ? { tool_calls: fields.tool_calls } : {}),
    ...(fields.invalid_tool_calls !== undefined
      ? { invalid_tool_calls: fields.invalid_tool_calls }
      : {}),
    additional_kwargs: fields.additional_kwargs ?? {},
    response_metadata: fields.response_metadata ?? {},
    ...(fields.usage_metadata !== undefined ? { usage_metadata: fields.usage_metadata } : {}),
  };
}

/** Create a ToolMessage. Defaults status to 'success'. */
export function toolMessage(fields: {
  content: string;
  tool_call_id: string;
  id?: string;
  name?: string;
  status?: string;
  response_metadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  artifact?: unknown;
}): ToolMessage {
  return {
    type: 'tool' as const,
    content: fields.content,
    tool_call_id: fields.tool_call_id,
    ...(fields.id !== undefined ? { id: fields.id } : {}),
    ...(fields.name !== undefined ? { name: fields.name } : {}),
    status: fields.status ?? 'success',
    additional_kwargs: {},
    response_metadata: fields.response_metadata ?? {},
    ...(fields.metadata !== undefined ? { metadata: fields.metadata } : {}),
    ...(fields.artifact !== undefined ? { artifact: fields.artifact } : {}),
  };
}

// ── Type guards ──

/** Internal: check whether an unknown value has the BaseMessage shape. */
function isMessage(msg: unknown): msg is Record<string, unknown> & { type: string } {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  return typeof m.type === 'string' && ['human', 'ai', 'system', 'tool'].includes(m.type);
}

/** Type guard: returns true if msg is an AIMessage (or checkpoint-deserialized equivalent). */
export function isAIMessage(msg: unknown): msg is AIMessage {
  return isMessage(msg) && msg.type === 'ai';
}

/** Type guard: returns true if msg is a HumanMessage (or checkpoint-deserialized equivalent). */
export function isHumanMessage(msg: unknown): msg is HumanMessage {
  return isMessage(msg) && msg.type === 'human';
}

/** Type guard: returns true if msg is a SystemMessage (or checkpoint-deserialized equivalent). */
export function isSystemMessage(msg: unknown): msg is SystemMessage {
  return isMessage(msg) && msg.type === 'system';
}

/** Type guard: returns true if msg is a ToolMessage (or checkpoint-deserialized equivalent). */
export function isToolMessage(msg: unknown): msg is ToolMessage {
  return isMessage(msg) && msg.type === 'tool';
}
