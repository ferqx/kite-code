import type { VerificationReviewerResult } from '@kite/runtime-spi';
import {
  createModelContextSummaryGenerator,
  createNarrativeContextCompactor,
} from './compaction-summary';
import type { ModelInvocationGatewayV1 } from './invocation-gateway';
import {
  type BuiltinPrimaryModelEffectInputV1,
  type BuiltinPrimaryModelEffectResultV1,
  type BuiltinPrimaryModelStateV1,
  executeBuiltinPrimaryModelEffectV1,
} from './primary-effect';
import {
  type AutoReviewResult,
  createAutoReviewModel,
  reviewToolApproval as reviewToolApprovalV1,
  reviewVerificationEvidence as reviewVerificationEvidenceV1,
} from './reviewer';
import {
  type BuiltinSubagentModelStepInputV1,
  type BuiltinSubagentModelStepResultV1,
  executeBuiltinSubagentModelStepV1,
} from './subagent-effect';

/**
 * The App composition root supplies the one Model Gateway used by every
 * Builtin model effect. Callers receive no gateway injection point of their
 * own, so review semantics cannot silently create a second execution owner.
 */
export type BuiltinToolApprovalReviewInputV1 = Omit<
  Parameters<typeof reviewToolApprovalV1>[0],
  'gateway'
>;

export type BuiltinVerificationReviewInputV1 = Omit<
  Parameters<typeof reviewVerificationEvidenceV1>[0],
  'gateway'
>;

type ContextSummaryGeneratorInputV1 = Parameters<typeof createModelContextSummaryGenerator>[0];
type NarrativeContextCompactorOptionsV1 = Parameters<typeof createNarrativeContextCompactor>[0];

export type BuiltinContextCompactorInputV1 = Omit<ContextSummaryGeneratorInputV1, 'gateway'> &
  Omit<NarrativeContextCompactorOptionsV1, 'generate'>;

export class BuiltinModelEffectCoordinatorV1 {
  readonly #gateway: ModelInvocationGatewayV1;

  constructor(gateway: ModelInvocationGatewayV1) {
    this.#gateway = gateway;
  }

  executePrimaryModelEffectV1<
    State extends BuiltinPrimaryModelStateV1,
    Event extends import('./invocation-gateway').BuiltinModelEventV1,
    Value,
  >(
    input: BuiltinPrimaryModelEffectInputV1<State, Event, Value>,
  ): Promise<BuiltinPrimaryModelEffectResultV1<Value>> {
    return executeBuiltinPrimaryModelEffectV1(this.#gateway, input);
  }

  executeSubagentModelStepV1<
    State extends import('./invocation-gateway').ModelInvocationStateViewV1,
    Event extends import('./invocation-gateway').BuiltinModelEventV1,
  >(
    input: BuiltinSubagentModelStepInputV1<State, Event>,
  ): Promise<BuiltinSubagentModelStepResultV1> {
    return executeBuiltinSubagentModelStepV1(this.#gateway, input);
  }

  reviewToolApproval(input: BuiltinToolApprovalReviewInputV1): Promise<AutoReviewResult> {
    return reviewToolApprovalV1({
      ...input,
      ...(input.model || !input.config ? {} : { model: createAutoReviewModel(input.config) }),
      gateway: this.#gateway,
    });
  }

  reviewVerificationEvidence(
    input: BuiltinVerificationReviewInputV1,
  ): Promise<VerificationReviewerResult> {
    return reviewVerificationEvidenceV1({
      ...input,
      ...(input.model || !input.config ? {} : { model: createAutoReviewModel(input.config) }),
      gateway: this.#gateway,
    });
  }

  createContextCompactor(
    input: BuiltinContextCompactorInputV1,
  ): ReturnType<typeof createNarrativeContextCompactor> {
    const generate = createModelContextSummaryGenerator({
      config: input.config,
      model: input.model,
      persistence: input.persistence,
      state: input.state,
      projectionEnvironmentDigest: input.projectionEnvironmentDigest,
      signal: input.signal,
      providerDataAdmission: input.providerDataAdmission,
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
