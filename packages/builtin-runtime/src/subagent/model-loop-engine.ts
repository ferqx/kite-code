import type { ToolSet } from 'ai';
import type { ModelRuntimeConfigV1 } from '../model/config';
import { estimateContextTokens } from '../model/context-budget';
import { serializeToolDescriptors } from '../model/context-projection';
import type { BuiltinModelEffectCoordinatorV1 } from '../model/effect-coordinator';
import type { SupportedChatModel } from '../model/factory';
import type {
  BuiltinModelEventV1,
  ModelInvocationPersistenceV1,
  ModelInvocationStateViewV1,
} from '../model/invocation-gateway';
import type { AIMessage, BaseMessage, ToolCall, ToolMessage } from '../model/messages';
import { isSystemMessage } from '../model/messages';
import type { ProviderDataAdmissionGateV1 } from '../model/provider-data-admission';
import type {
  BuiltinSubagentModelStepProvenanceV1,
  BuiltinSubagentModelStepResultV1,
} from '../model/subagent-effect';

/**
 * A deliberately narrow view of the Builtin model coordinator.  The loop
 * engine never receives the Gateway, response source, registry, or any
 * transport port.  Production supplies the App-created coordinator; tests
 * may provide a deterministic implementation of this same method.
 */
export type BuiltinSubagentModelLoopCoordinatorV1 = Pick<
  BuiltinModelEffectCoordinatorV1,
  'executeSubagentModelStepV1'
>;

export interface BuiltinSubagentModelLoopProvenanceContextV1 {
  readonly modelInvocationOrdinal: number;
  readonly transcript: readonly BaseMessage[];
}

export type BuiltinSubagentModelLoopProvenanceFactoryV1 = (
  input: BuiltinSubagentModelLoopProvenanceContextV1,
) => BuiltinSubagentModelStepProvenanceV1 | Promise<BuiltinSubagentModelStepProvenanceV1>;

export interface BuiltinSubagentModelLoopResourceContextV1 {
  /** Parent-owned reservation consumed by each child model step. */
  readonly parentReservationId?: string;
  /** Resolve the current output ceiling after this round's input estimate. */
  readonly maxOutputTokens?: (
    input: BuiltinSubagentModelLoopProvenanceContextV1 & {
      readonly estimatedInputTokens: number;
    },
  ) => number | undefined | Promise<number | undefined>;
}

export interface BuiltinSubagentModelLoopConsumerInputV1 {
  /** Deep-frozen snapshot; neither the array nor any nested message is mutable. */
  readonly transcript: readonly BaseMessage[];
  /** The last message in `transcript`, also deeply frozen. */
  readonly response: Readonly<AIMessage>;
  readonly invocationId: string;
  readonly modelInvocationOrdinal: number;
  /** Committed cache facts for this exact model step. */
  readonly cacheMetrics: BuiltinSubagentModelStepResultV1['cacheMetrics'];
  /**
   * Append only the ToolMessages admitted for this response.  The engine
   * clones and freezes every accepted message before the next model step.
   */
  readonly append: (messages: readonly ToolMessage[]) => void;
}

export type BuiltinSubagentModelLoopConsumerDecisionV1<TTerminal> =
  | Readonly<{ kind: 'continue' }>
  | Readonly<{ kind: 'terminal'; value: TTerminal }>;

export interface BuiltinSubagentModelLoopConsumerPortV1<TTerminal> {
  consume(
    input: BuiltinSubagentModelLoopConsumerInputV1,
  ):
    | BuiltinSubagentModelLoopConsumerDecisionV1<TTerminal>
    | Promise<BuiltinSubagentModelLoopConsumerDecisionV1<TTerminal>>;
}

export interface BuiltinSubagentModelLoopInputV1<
  State extends ModelInvocationStateViewV1 = ModelInvocationStateViewV1,
  Event extends BuiltinModelEventV1 = BuiltinModelEventV1,
  TTerminal = never,
> {
  readonly coordinator: BuiltinSubagentModelLoopCoordinatorV1;
  readonly initialMessages: readonly BaseMessage[];
  /** Last completed ordinal. The first model step is this value plus one. */
  readonly startModelInvocationOrdinal: number;
  readonly model: SupportedChatModel;
  readonly config: ModelRuntimeConfigV1;
  readonly tools: ToolSet;
  readonly persistence?: ModelInvocationPersistenceV1<State, Event>;
  readonly provenance:
    | BuiltinSubagentModelStepProvenanceV1
    | BuiltinSubagentModelLoopProvenanceFactoryV1;
  readonly resource?: BuiltinSubagentModelLoopResourceContextV1;
  readonly providerDataAdmission: ProviderDataAdmissionGateV1;
  readonly consumer?: BuiltinSubagentModelLoopConsumerPortV1<TTerminal>;
  readonly signal?: AbortSignal;
}

export interface BuiltinSubagentModelLoopCompletedV1 {
  readonly kind: 'completed';
  readonly invocationId: string;
  readonly message: Readonly<AIMessage>;
  readonly summary: string;
  readonly cacheMetrics: BuiltinSubagentModelStepResultV1['cacheMetrics'];
  readonly modelInvocationOrdinal: number;
  /** Deep-frozen transcript through the terminal assistant response. */
  readonly messages: readonly BaseMessage[];
}

export type BuiltinSubagentModelLoopResultV1<TTerminal> =
  | BuiltinSubagentModelLoopCompletedV1
  | Readonly<{ kind: 'terminal'; value: TTerminal }>;

export class BuiltinSubagentModelLoopErrorV1 extends Error {
  readonly code: 'aborted' | 'invalid_input' | 'consumer_protocol';

  constructor(code: BuiltinSubagentModelLoopErrorV1['code'], message: string) {
    super(message);
    this.name = 'BuiltinSubagentModelLoopErrorV1';
    this.code = code;
  }
}

/**
 * Construct the Builtin-owned child model loop.  The returned engine is
 * single-use: each call to `run()` consumes the supplied transcript and
 * performs one live child journey through the injected coordinator.
 */
export function createBuiltinSubagentModelLoopEngineV1<
  State extends ModelInvocationStateViewV1 = ModelInvocationStateViewV1,
  Event extends BuiltinModelEventV1 = BuiltinModelEventV1,
  TTerminal = never,
>(
  input: BuiltinSubagentModelLoopInputV1<State, Event, TTerminal>,
): {
  run(): Promise<BuiltinSubagentModelLoopResultV1<TTerminal>>;
} {
  validateLoopInputV1(input);
  let used = false;

  return Object.freeze({
    run: async (): Promise<BuiltinSubagentModelLoopResultV1<TTerminal>> => {
      if (used) {
        throw new BuiltinSubagentModelLoopErrorV1(
          'invalid_input',
          'Builtin subagent model loop engine is single-use.',
        );
      }
      used = true;
      return runLoopV1(input);
    },
  });
}

async function runLoopV1<
  State extends ModelInvocationStateViewV1,
  Event extends BuiltinModelEventV1,
  TTerminal,
>(
  input: BuiltinSubagentModelLoopInputV1<State, Event, TTerminal>,
): Promise<BuiltinSubagentModelLoopResultV1<TTerminal>> {
  const messages = input.initialMessages.map(cloneAndFreezeMessageV1);
  let modelInvocationOrdinal = input.startModelInvocationOrdinal;

  while (true) {
    throwIfAbortedV1(input.signal);
    const transcript = freezeTranscriptV1(messages);
    const estimatedInputTokens = estimatedInputTokensV1(transcript, input.tools);
    const nextOrdinal = modelInvocationOrdinal + 1;
    const provenance = await resolveProvenanceV1(input.provenance, {
      modelInvocationOrdinal: nextOrdinal,
      transcript,
    });
    const maxOutputTokens = await resolveMaxOutputTokensV1(input.resource, {
      modelInvocationOrdinal: nextOrdinal,
      transcript,
      estimatedInputTokens,
    });
    throwIfAbortedV1(input.signal);

    const modelStep = await input.coordinator.executeSubagentModelStepV1({
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
    throwIfAbortedV1(input.signal);
    modelInvocationOrdinal = nextOrdinal;
    const response = cloneAndFreezeMessageV1(modelStep.message);
    messages.push(response);

    if (!response.tool_calls || response.tool_calls.length === 0) {
      return Object.freeze({
        kind: 'completed',
        invocationId: modelStep.invocationId,
        message: response,
        summary: extractTextV1(response.content),
        cacheMetrics: modelStep.cacheMetrics,
        modelInvocationOrdinal,
        messages: freezeTranscriptV1(messages),
      });
    }

    if (!input.consumer) {
      throw new BuiltinSubagentModelLoopErrorV1(
        'consumer_protocol',
        'Builtin subagent model loop requires a consumer for tool calls.',
      );
    }

    const responseToolCalls = response.tool_calls;
    const appendedToolCallIds = new Set<string>();
    let appendOpen = true;
    const append = (toolMessages: readonly ToolMessage[]): void => {
      if (!appendOpen || input.signal?.aborted) {
        throw new BuiltinSubagentModelLoopErrorV1(
          'consumer_protocol',
          'Subagent tool transcript append is no longer available.',
        );
      }
      if (!Array.isArray(toolMessages)) {
        throw new BuiltinSubagentModelLoopErrorV1(
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
        if (!isToolMessageValueV1(toolMessage)) {
          throw new BuiltinSubagentModelLoopErrorV1(
            'consumer_protocol',
            'Subagent consumer append accepts only ToolMessage values.',
          );
        }
        if (!toolMessage.tool_call_id) {
          throw new BuiltinSubagentModelLoopErrorV1(
            'consumer_protocol',
            'Subagent ToolMessage requires a tool_call_id.',
          );
        }
        if (expectedIds.size > 0 && !expectedIds.has(toolMessage.tool_call_id)) {
          throw new BuiltinSubagentModelLoopErrorV1(
            'consumer_protocol',
            'Subagent ToolMessage does not match the current model tool call.',
          );
        }
        if (appendedToolCallIds.has(toolMessage.tool_call_id)) {
          throw new BuiltinSubagentModelLoopErrorV1(
            'consumer_protocol',
            'Subagent ToolMessage duplicates the current model tool call.',
          );
        }
        appendedToolCallIds.add(toolMessage.tool_call_id);
        return cloneAndFreezeMessageV1(toolMessage);
      });
      messages.push(...clones);
    };

    let decision: BuiltinSubagentModelLoopConsumerDecisionV1<TTerminal>;
    try {
      decision = await awaitWithAbortV1(
        input.consumer.consume({
          transcript: freezeTranscriptV1(messages),
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
    throwIfAbortedV1(input.signal);

    if (!decision || (decision.kind !== 'continue' && decision.kind !== 'terminal')) {
      throw new BuiltinSubagentModelLoopErrorV1(
        'consumer_protocol',
        'Subagent consumer returned an invalid decision.',
      );
    }
    if (decision.kind === 'terminal')
      return decision as BuiltinSubagentModelLoopResultV1<TTerminal>;

    assertToolTranscriptCompleteV1(responseToolCalls, appendedToolCallIds);
  }
}

function validateLoopInputV1<
  State extends ModelInvocationStateViewV1,
  Event extends BuiltinModelEventV1,
  TTerminal,
>(input: BuiltinSubagentModelLoopInputV1<State, Event, TTerminal>): void {
  if (!input || typeof input !== 'object') {
    throw new BuiltinSubagentModelLoopErrorV1('invalid_input', 'Subagent loop input is invalid.');
  }
  if (
    !Number.isSafeInteger(input.startModelInvocationOrdinal) ||
    input.startModelInvocationOrdinal < 0
  ) {
    throw new BuiltinSubagentModelLoopErrorV1(
      'invalid_input',
      'Subagent model invocation ordinal is invalid.',
    );
  }
  if (!Array.isArray(input.initialMessages)) {
    throw new BuiltinSubagentModelLoopErrorV1(
      'invalid_input',
      'Subagent initial messages are invalid.',
    );
  }
}

function estimatedInputTokensV1(messages: readonly BaseMessage[], tools: ToolSet): number {
  return estimateContextTokens({
    systemMessages: messages.filter(isSystemMessage),
    transcriptMessages: messages.filter((message) => !isSystemMessage(message)),
    dynamicRuntimeMessages: [],
    serializedTools: serializeToolDescriptors(tools as unknown as Record<string, unknown>),
  }).totalInputTokens;
}

async function resolveProvenanceV1(
  provenance: BuiltinSubagentModelStepProvenanceV1 | BuiltinSubagentModelLoopProvenanceFactoryV1,
  context: BuiltinSubagentModelLoopProvenanceContextV1,
): Promise<BuiltinSubagentModelStepProvenanceV1> {
  const resolved = typeof provenance === 'function' ? await provenance(context) : provenance;
  if (!resolved || typeof resolved !== 'object') {
    throw new BuiltinSubagentModelLoopErrorV1(
      'invalid_input',
      'Subagent model provenance is unavailable.',
    );
  }
  return resolved;
}

async function resolveMaxOutputTokensV1(
  resource: BuiltinSubagentModelLoopResourceContextV1 | undefined,
  context: BuiltinSubagentModelLoopProvenanceContextV1 & {
    readonly estimatedInputTokens: number;
  },
): Promise<number | undefined> {
  const value = resource?.maxOutputTokens ? await resource.maxOutputTokens(context) : undefined;
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new BuiltinSubagentModelLoopErrorV1(
      'invalid_input',
      'Subagent maxOutputTokens resource ceiling is invalid.',
    );
  }
  return value;
}

function assertToolTranscriptCompleteV1(
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
    throw new BuiltinSubagentModelLoopErrorV1(
      'consumer_protocol',
      'Subagent consumer must append one ToolMessage for every model tool call before continuing.',
    );
  }
}

function isToolMessageValueV1(value: unknown): value is ToolMessage {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { readonly type?: unknown }).type === 'tool' &&
    typeof (value as { readonly tool_call_id?: unknown }).tool_call_id === 'string'
  );
}

function cloneAndFreezeMessageV1<T extends BaseMessage>(message: T): Readonly<T> {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    throw new BuiltinSubagentModelLoopErrorV1(
      'invalid_input',
      'Subagent transcript contains an invalid message.',
    );
  }
  let clone: T;
  try {
    clone = structuredClone(message);
  } catch {
    throw new BuiltinSubagentModelLoopErrorV1(
      'invalid_input',
      'Subagent transcript message is not cloneable.',
    );
  }
  return deepFreezeV1(clone);
}

function freezeTranscriptV1(messages: readonly BaseMessage[]): readonly BaseMessage[] {
  return Object.freeze([...messages]);
}

function deepFreezeV1<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeV1(child, seen);
  }
  return Object.freeze(value);
}

function extractTextV1(content: unknown): string {
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

function throwIfAbortedV1(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new BuiltinSubagentModelLoopErrorV1('aborted', 'Subagent model loop was aborted.');
  }
}

async function awaitWithAbortV1<T>(
  value: T | Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  throwIfAbortedV1(signal);
  if (!signal) return value;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new BuiltinSubagentModelLoopErrorV1('aborted', 'Subagent model loop was aborted.'));
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
