import {
  createModelContextSummaryGenerator,
  createNarrativeContextCompactor,
} from './compaction-summary';
import type { ModelInvocationGateway } from './invocation-gateway';
import {
  type BuiltinPrimaryModelEffectInput,
  type BuiltinPrimaryModelEffectResult,
  type BuiltinPrimaryModelState,
  executeBuiltinPrimaryModelEffect,
} from './primary-effect';
import { type AutoReviewResult, createAutoReviewModel, reviewToolApproval } from './reviewer';
import {
  type BuiltinSubagentModelStepInput,
  type BuiltinSubagentModelStepResult,
  executeBuiltinSubagentModelStep,
} from './subagent-effect';

/**
 * The App composition root supplies the one Model Gateway used by every
 * Builtin model effect. Callers receive no gateway injection point of their
 * own, so review semantics cannot silently create a second execution owner.
 */
export type BuiltinToolApprovalReviewInput = Omit<
  Parameters<typeof reviewToolApproval>[0],
  'gateway'
>;

type ContextSummaryGeneratorInput = Parameters<typeof createModelContextSummaryGenerator>[0];
type NarrativeContextCompactorOptions = Parameters<typeof createNarrativeContextCompactor>[0];

export type BuiltinContextCompactorInput = Omit<ContextSummaryGeneratorInput, 'gateway'> &
  Omit<NarrativeContextCompactorOptions, 'generate'>;

export class BuiltinModelEffectCoordinator {
  readonly #gateway: ModelInvocationGateway;

  constructor(gateway: ModelInvocationGateway) {
    this.#gateway = gateway;
  }

  executePrimaryModelEffect<
    State extends BuiltinPrimaryModelState,
    Event extends import('./invocation-gateway').BuiltinModelEvent,
    Value,
  >(
    input: BuiltinPrimaryModelEffectInput<State, Event, Value>,
  ): Promise<BuiltinPrimaryModelEffectResult<Value>> {
    return executeBuiltinPrimaryModelEffect(this.#gateway, input);
  }

  executeSubagentModelStep<
    State extends import('./invocation-gateway').ModelInvocationStateView,
    Event extends import('./invocation-gateway').BuiltinModelEvent,
  >(input: BuiltinSubagentModelStepInput<State, Event>): Promise<BuiltinSubagentModelStepResult> {
    return executeBuiltinSubagentModelStep(this.#gateway, input);
  }

  reviewToolApproval(input: BuiltinToolApprovalReviewInput): Promise<AutoReviewResult> {
    return reviewToolApproval({
      ...input,
      ...(input.model || !input.config ? {} : { model: createAutoReviewModel(input.config) }),
      gateway: this.#gateway,
    });
  }

  createContextCompactor(
    input: BuiltinContextCompactorInput,
  ): ReturnType<typeof createNarrativeContextCompactor> {
    const generate = createModelContextSummaryGenerator({
      config: input.config,
      model: input.model,
      persistence: input.persistence,
      state: input.state,
      projectionEnvironmentDigest: input.projectionEnvironmentDigest,
      signal: input.signal,
      gateway: this.#gateway,
    });
    return createNarrativeContextCompactor({
      generate,
      maxSummaryTokens: input.maxSummaryTokens,
      maxSummaryInputTokens: input.maxSummaryInputTokens,
      maxNarrativeTokens: input.maxNarrativeTokens,
      modelContextWindowTokens: input.modelContextWindowTokens,
      modelMaxOutputTokens: input.modelMaxOutputTokens,
    });
  }
}
