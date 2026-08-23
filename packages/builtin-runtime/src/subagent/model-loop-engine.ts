import type { ToolSet } from 'ai';
import type { ModelRuntimeConfig } from '../model/config';
import { estimateContextTokens } from '../model/context-budget';
import { serializeToolDescriptors } from '../model/context-projection';
import type { BuiltinModelEffectCoordinator } from '../model/effect-coordinator';
import type { SupportedChatModel } from '../model/factory';
import type {
  BuiltinModelEvent,
  ModelInvocationPersistence,
  ModelInvocationStateView,
} from '../model/invocation-gateway';
import type { AIMessage, BaseMessage, ToolCall, ToolMessage } from '../model/messages';
import { isSystemMessage } from '../model/messages';
import type { ProviderDataAdmissionGate } from '../model/provider-data-admission';
import type {
  BuiltinSubagentModelStepProvenance,
  BuiltinSubagentModelStepResult,
} from '../model/subagent-effect';

/**
 * A deliberately narrow view of the Builtin model coordinator.  The loop
 * engine never receives the Gateway, response source, registry, or any
 * transport port.  Production supplies the App-created coordinator; tests
 * may provide a deterministic implementation of this same method.
 */
export type BuiltinSubagentModelLoopCoordinator = Pick<
  BuiltinModelEffectCoordinator,
  'executeSubagentModelStep'
>;

export interface BuiltinSubagentModelLoopProvenanceContext {
  readonly modelInvocationOrdinal: number;
  readonly transcript: readonly BaseMessage[];
}

export type BuiltinSubagentModelLoopProvenanceFactory = (
  input: BuiltinSubagentModelLoopProvenanceContext,
) => BuiltinSubagentModelStepProvenance | Promise<BuiltinSubagentModelStepProvenance>;

export interface BuiltinSubagentModelLoopResourceContext {
  /** Parent-owned reservation consumed by each child model step. */
  readonly parentReservationId?: string;
  /** Resolve the current output ceiling after this round's input estimate. */
  readonly maxOutputTokens?: (
    input: BuiltinSubagentModelLoopProvenanceContext & {
      readonly estimatedInputTokens: number;
    },
  ) => number | undefined | Promise<number | undefined>;
}

export interface BuiltinSubagentModelLoopConsumerInput {
  /** Deep-frozen snapshot; neither the array nor any nested message is mutable. */
  readonly transcript: readonly BaseMessage[];
  /** The last message in `transcript`, also deeply frozen. */
  readonly response: Readonly<AIMessage>;
  readonly invocationId: string;
  readonly modelInvocationOrdinal: number;
  /** Committed cache facts for this exact model step. */
  readonly cacheMetrics: BuiltinSubagentModelStepResult['cacheMetrics'];
  /**
   * Append only the ToolMessages admitted for this response.  The engine
   * clones and freezes every accepted message before the next model step.
   */
  readonly append: (messages: readonly ToolMessage[]) => void;
}

export type BuiltinSubagentModelLoopConsumerDecision<TTerminal> =
  | Readonly<{ kind: 'continue' }>
  | Readonly<{ kind: 'terminal'; value: TTerminal }>;

export interface BuiltinSubagentModelLoopConsumerPort<TTerminal> {
  consume(
    input: BuiltinSubagentModelLoopConsumerInput,
  ):
    | BuiltinSubagentModelLoopConsumerDecision<TTerminal>
    | Promise<BuiltinSubagentModelLoopConsumerDecision<TTerminal>>;
}

export interface BuiltinSubagentModelLoopInput<
  State extends ModelInvocationStateView = ModelInvocationStateView,
  Event extends BuiltinModelEvent = BuiltinModelEvent,
  TTerminal = never,
> {
  readonly coordinator: BuiltinSubagentModelLoopCoordinator;
  readonly initialMessages: readonly BaseMessage[];
  /** Last completed ordinal. The first model step is this value plus one. */
  readonly startModelInvocationOrdinal: number;
  readonly model: SupportedChatModel;
  readonly config: ModelRuntimeConfig;
  readonly tools: ToolSet;
  readonly persistence?: ModelInvocationPersistence<State, Event>;
  readonly provenance:
    | BuiltinSubagentModelStepProvenance
    | BuiltinSubagentModelLoopProvenanceFactory;
  readonly resource?: BuiltinSubagentModelLoopResourceContext;
  readonly providerDataAdmission: ProviderDataAdmissionGate;
  readonly consumer?: BuiltinSubagentModelLoopConsumerPort<TTerminal>;
  readonly signal?: AbortSignal;
}

export interface BuiltinSubagentModelLoopCompleted {
  readonly kind: 'completed';
  readonly invocationId: string;
  readonly message: Readonly<AIMessage>;
  readonly summary: string;
  readonly cacheMetrics: BuiltinSubagentModelStepResult['cacheMetrics'];
  readonly modelInvocationOrdinal: number;
  /** Deep-frozen transcript through the terminal assistant response. */
  readonly messages: readonly BaseMessage[];
}

export type BuiltinSubagentModelLoopResult<TTerminal> =
  | BuiltinSubagentModelLoopCompleted
  | Readonly<{ kind: 'terminal'; value: TTerminal }>;

export class BuiltinSubagentModelLoopError extends Error {
  readonly code: 'aborted' | 'invalid_input' | 'consumer_protocol';

  constructor(code: BuiltinSubagentModelLoopError['code'], message: string) {
    super(message);
    this.name = 'BuiltinSubagentModelLoopError';
    this.code = code;
  }
}

/**
 * Construct the Builtin-owned child model loop.  The returned engine is
 * single-use: each call to `run()` consumes the supplied transcript and
 * performs one live child journey through the injected coordinator.
 */
export function createBuiltinSubagentModelLoopEngine<
  State extends ModelInvocationStateView = ModelInvocationStateView,
  Event extends BuiltinModelEvent = BuiltinModelEvent,
  TTerminal = never,
>(
  input: BuiltinSubagentModelLoopInput<State, Event, TTerminal>,
): {
  run(): Promise<BuiltinSubagentModelLoopResult<TTerminal>>;
} {
  validateLoopInput(input);
  let used = false;

  return Object.freeze({
    run: async (): Promise<BuiltinSubagentModelLoopResult<TTerminal>> => {
      if (used) {
        throw new BuiltinSubagentModelLoopError(
          'invalid_input',
          'Builtin subagent model loop engine is single-use.',
        );
      }
      used = true;
      return runLoop(input);
    },
  });
}

async function runLoop<
  State extends ModelInvocationStateView,
  Event extends BuiltinModelEvent,
  TTerminal,
>(
  input: BuiltinSubagentModelLoopInput<State, Event, TTerminal>,
): Promise<BuiltinSubagentModelLoopResult<TTerminal>> {
  const messages = input.initialMessages.map(cloneAndFreezeMessage);
  let modelInvocationOrdinal = input.startModelInvocationOrdinal;

  while (true) {
    throwIfAborted(input.signal);
    const transcript = freezeTranscript(messages);
    const estimatedInputTokens = estimateInputTokens(transcript, input.tools);
    const nextOrdinal = modelInvocationOrdinal + 1;
    const provenance = await resolveProvenance(input.provenance, {
      modelInvocationOrdinal: nextOrdinal,
      transcript,
    });
    const maxOutputTokens = await resolveMaxOutputTokens(input.resource, {
      modelInvocationOrdinal: nextOrdinal,
      transcript,
      estimatedInputTokens,
    });
    throwIfAborted(input.signal);

    const modelStep = await input.coordinator.executeSubagentModelStep({
      config: input.config,
      model: input.model,
      tools: input.tools,
      messages: transcript,
      ...(input.persistence ? { persistence: input.persistence } : {}),
      provenance,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      estimatedInputTokens,
      providerDataAdmission: input.providerDataAdmission,
      ...(input.resource?.parentReservationId
        ? { parentReservationId: input.resource.parentReservationId }
        : {}),
      signal: input.signal,
    });

    // A response may have been produced and committed before cancellation was
    // observed. Never pass that response to a consumer in the cancelled path.
    throwIfAborted(input.signal);
    modelInvocationOrdinal = nextOrdinal;
    const response = cloneAndFreezeMessage(modelStep.message);
    messages.push(response);

    if (!response.tool_calls || response.tool_calls.length === 0) {
      return Object.freeze({
        kind: 'completed',
        invocationId: modelStep.invocationId,
        message: response,
        summary: extractText(response.content),
        cacheMetrics: modelStep.cacheMetrics,
        modelInvocationOrdinal,
        messages: freezeTranscript(messages),
      });
    }

    if (!input.consumer) {
      throw new BuiltinSubagentModelLoopError(
        'consumer_protocol',
        'Builtin subagent model loop requires a consumer for tool calls.',
      );
    }

    const responseToolCalls = response.tool_calls;
    const appendedToolCallIds = new Set<string>();
    let appendOpen = true;
    const append = (toolMessages: readonly ToolMessage[]): void => {
      if (!appendOpen || input.signal?.aborted) {
        throw new BuiltinSubagentModelLoopError(
          'consumer_protocol',
          'Subagent tool transcript append is no longer available.',
        );
      }
      if (!Array.isArray(toolMessages)) {
        throw new BuiltinSubagentModelLoopError(
          'consumer_protocol',
          'Subagent consumer append requires ToolMessage values.',
        );
      }
      const expectedIds = new Set(
        responseToolCalls
          .map((call) => call.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      );
      const clones = toolMessages.map((toolMessage) => {
        if (!isToolMessageValue(toolMessage)) {
          throw new BuiltinSubagentModelLoopError(
            'consumer_protocol',
            'Subagent consumer append accepts only ToolMessage values.',
          );
        }
        if (!toolMessage.tool_call_id) {
          throw new BuiltinSubagentModelLoopError(
            'consumer_protocol',
            'Subagent ToolMessage requires a tool_call_id.',
          );
        }
        if (expectedIds.size > 0 && !expectedIds.has(toolMessage.tool_call_id)) {
          throw new BuiltinSubagentModelLoopError(
            'consumer_protocol',
            'Subagent ToolMessage does not match the current model tool call.',
          );
        }
        if (appendedToolCallIds.has(toolMessage.tool_call_id)) {
          throw new BuiltinSubagentModelLoopError(
            'consumer_protocol',
            'Subagent ToolMessage duplicates the current model tool call.',
          );
        }
        appendedToolCallIds.add(toolMessage.tool_call_id);
        return cloneAndFreezeMessage(toolMessage);
      });
      messages.push(...clones);
    };

    let decision: BuiltinSubagentModelLoopConsumerDecision<TTerminal>;
    try {
      decision = await awaitWithAbort(
        input.consumer.consume({
          transcript: freezeTranscript(messages),
          response,
          invocationId: modelStep.invocationId,
          modelInvocationOrdinal,
          cacheMetrics: modelStep.cacheMetrics,
          append,
        }),
        input.signal,
      );
    } finally {
      appendOpen = false;
    }
    throwIfAborted(input.signal);

    if (!decision || (decision.kind !== 'continue' && decision.kind !== 'terminal')) {
      throw new BuiltinSubagentModelLoopError(
        'consumer_protocol',
        'Subagent consumer returned an invalid decision.',
      );
    }
    if (decision.kind === 'terminal') return decision as BuiltinSubagentModelLoopResult<TTerminal>;

    assertToolTranscriptComplete(responseToolCalls, appendedToolCallIds);
  }
}

function validateLoopInput<
  State extends ModelInvocationStateView,
  Event extends BuiltinModelEvent,
  TTerminal,
>(input: BuiltinSubagentModelLoopInput<State, Event, TTerminal>): void {
  if (!input || typeof input !== 'object') {
    throw new BuiltinSubagentModelLoopError('invalid_input', 'Subagent loop input is invalid.');
  }
  if (
    !Number.isSafeInteger(input.startModelInvocationOrdinal) ||
    input.startModelInvocationOrdinal < 0
  ) {
    throw new BuiltinSubagentModelLoopError(
      'invalid_input',
      'Subagent model invocation ordinal is invalid.',
    );
  }
  if (!Array.isArray(input.initialMessages)) {
    throw new BuiltinSubagentModelLoopError(
      'invalid_input',
      'Subagent initial messages are invalid.',
    );
  }
}

function estimateInputTokens(messages: readonly BaseMessage[], tools: ToolSet): number {
  return estimateContextTokens({
    systemMessages: messages.filter(isSystemMessage),
    transcriptMessages: messages.filter((message) => !isSystemMessage(message)),
    dynamicRuntimeMessages: [],
    serializedTools: serializeToolDescriptors(tools as unknown as Record<string, unknown>),
  }).totalInputTokens;
}

async function resolveProvenance(
  provenance: BuiltinSubagentModelStepProvenance | BuiltinSubagentModelLoopProvenanceFactory,
  context: BuiltinSubagentModelLoopProvenanceContext,
): Promise<BuiltinSubagentModelStepProvenance> {
  const resolved = typeof provenance === 'function' ? await provenance(context) : provenance;
  if (!resolved || typeof resolved !== 'object') {
    throw new BuiltinSubagentModelLoopError(
      'invalid_input',
      'Subagent model provenance is unavailable.',
    );
  }
  return resolved;
}

async function resolveMaxOutputTokens(
  resource: BuiltinSubagentModelLoopResourceContext | undefined,
  context: BuiltinSubagentModelLoopProvenanceContext & {
    readonly estimatedInputTokens: number;
  },
): Promise<number | undefined> {
  const value = resource?.maxOutputTokens ? await resource.maxOutputTokens(context) : undefined;
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new BuiltinSubagentModelLoopError(
      'invalid_input',
      'Subagent maxOutputTokens resource ceiling is invalid.',
    );
  }
  return value;
}

function assertToolTranscriptComplete(
  toolCalls: readonly ToolCall[],
  appendedToolCallIds: ReadonlySet<string>,
): void {
  const expectedIds = toolCalls
    .map((call) => call.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (
    expectedIds.length !== toolCalls.length ||
    expectedIds.some((id) => !appendedToolCallIds.has(id))
  ) {
    throw new BuiltinSubagentModelLoopError(
      'consumer_protocol',
      'Subagent consumer must append one ToolMessage for every model tool call before continuing.',
    );
  }
}

function isToolMessageValue(value: unknown): value is ToolMessage {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { readonly type?: unknown }).type === 'tool' &&
    typeof (value as { readonly tool_call_id?: unknown }).tool_call_id === 'string'
  );
}

function cloneAndFreezeMessage<T extends BaseMessage>(message: T): Readonly<T> {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    throw new BuiltinSubagentModelLoopError(
      'invalid_input',
      'Subagent transcript contains an invalid message.',
    );
  }
  let clone: T;
  try {
    clone = structuredClone(message);
  } catch {
    throw new BuiltinSubagentModelLoopError(
      'invalid_input',
      'Subagent transcript message is not cloneable.',
    );
  }
  return deepFreeze(clone);
}

function freezeTranscript(messages: readonly BaseMessage[]): readonly BaseMessage[] {
  return Object.freeze([...messages]);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part && typeof part === 'object' && 'text' in part
        ? String((part as { readonly text?: unknown }).text ?? '')
        : '',
    )
    .join('');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new BuiltinSubagentModelLoopError('aborted', 'Subagent model loop was aborted.');
  }
}

async function awaitWithAbort<T>(
  value: T | Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return value;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new BuiltinSubagentModelLoopError('aborted', 'Subagent model loop was aborted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}
