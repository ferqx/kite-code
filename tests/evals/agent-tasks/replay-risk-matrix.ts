import { readFileSync } from 'node:fs';
import type { AgentConfig } from '@/core/config';
import { humanMessage, systemMessage } from '@/core/messages';
import type { SupportedChatModel } from '@/core/model/factory';
import { StrictModelReplayCatalogV1 } from '@/core/model/replay-catalog';
import {
  createReplayModelResponseSourceV1,
  ModelAttemptFailureErrorV1,
} from '@/core/model/response-source';
import { canonicalModelJsonV1 } from '@/core/model/surface-canonicalizer';
import { type CompiledModelSurfaceV1, compileModelSurfaceV1 } from '@/core/model/surface-compiler';
import { createDeterministicRuntimeIdSourceV1 } from '@/core/runtime/id-source';
import type {
  ModelAttemptOutcomeV1,
  ModelInvocationPurposeV1,
  ModelReplayActorIdentityV1,
  ModelReplayCatalogV1,
} from '@/protocol/model-surface';
import {
  MODEL_REPLAY_REQUIRED_FIXTURE_DIGEST_V1,
  MODEL_REPLAY_REQUIRED_SUITE_ID_V1,
  MODEL_REPLAY_REQUIRED_SUITE_REVISION_V1,
  MODEL_REPLAY_RISK_CASES_V1,
  MODEL_REPLAY_RISK_CASSETTE_DIGEST_V1,
  MODEL_REPLAY_RISK_EXPECTED_REPORT_DIGEST_V1,
} from '../../../scripts/evals/contracts/model-replay-gate';
import { sha256Digest } from '../../../scripts/release/canonical-json';
import { createTestModelInvocationHarnessV1 } from '../../helpers/model-invocation';
import { createMockModel } from '../../mock-model';

const RISK_CONFIG: AgentConfig = {
  apiKey: '',
  baseURL: 'https://synthetic-replay-risk.invalid/v1',
  modelName: 'synthetic-replay-risk',
  providerName: 'synthetic-replay-risk',
  providerType: 'openai-compatible',
  sandbox: { enabled: false },
  features: {
    promptContractV2: false,
    capabilityCatalogV1: true,
    mcpRuntimeBindingV1: true,
    verificationV1: true,
    providerDataPolicyV1: false,
  },
};

export const MODEL_REPLAY_RISK_MODEL_V1 = createMockModel([]);
export interface ModelReplayRiskMatrixReportV1 {
  version: 1;
  cases: ReadonlyArray<{
    caseId: (typeof MODEL_REPLAY_RISK_CASES_V1)[number]['caseId'];
    purpose: ModelInvocationPurposeV1;
    observed: 'success_after_retry' | 'fatal_failure' | 'aborted' | 'success';
  }>;
  attemptOutcomes: readonly ['retryable_failure', 'success', 'fatal_failure', 'aborted'];
  allPurposesCovered: true;
  continuationCursorCovered: true;
  allRecordsConsumed: true;
  providerTransportAttempts: 0;
  apiKeyRead: false;
  canonicalDigest: `sha256:${string}`;
}

export function compileReplayRiskSurfaceV1(
  purpose: ModelInvocationPurposeV1,
  actor: ModelReplayActorIdentityV1,
  route?: { config: AgentConfig; model: SupportedChatModel },
): CompiledModelSurfaceV1 {
  return compileModelSurfaceV1({
    purpose,
    config: route?.config ?? RISK_CONFIG,
    model: route?.model ?? MODEL_REPLAY_RISK_MODEL_V1,
    messages: [
      systemMessage('Required keyless replay risk matrix. Return only synthetic content.'),
      humanMessage(
        canonicalModelJsonV1({
          version: 1,
          purpose,
          actor:
            actor.kind === 'parent'
              ? 'parent'
              : {
                  subagentId: actor.subagentId,
                  continuationId: actor.continuationId,
                },
        }),
      ),
    ],
    tools: {},
    maxOutputTokens: 64,
    transport: 'generate',
    estimatedInputTokens: 64,
  });
}

export function replayRiskBindingV1(input: {
  actor: ModelReplayActorIdentityV1;
  logicalInvocationOrdinal?: number;
}) {
  return Object.freeze({
    suiteId: MODEL_REPLAY_REQUIRED_SUITE_ID_V1,
    suiteRevision: MODEL_REPLAY_REQUIRED_SUITE_REVISION_V1,
    fixtureDigest: MODEL_REPLAY_REQUIRED_FIXTURE_DIGEST_V1,
    actor: input.actor,
    logicalInvocationOrdinal: input.logicalInvocationOrdinal ?? 1,
    replayDigest: null,
  });
}

export function readReplayRiskCatalogV1(): {
  catalog: ModelReplayCatalogV1;
  digest: `sha256:${string}`;
} {
  const bytes = readFileSync(new URL('./cassettes/required-risk-matrix-v1.jsonl', import.meta.url));
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) {
    throw new Error('Required replay risk cassette framing changed.');
  }
  const canonical = text.slice(0, -1);
  StrictModelReplayCatalogV1.parse(canonical);
  const digest = sha256Digest(bytes);
  if (digest !== MODEL_REPLAY_RISK_CASSETTE_DIGEST_V1) {
    throw new Error('Required replay risk cassette digest changed.');
  }
  return { catalog: JSON.parse(canonical) as ModelReplayCatalogV1, digest };
}

export async function runModelReplayRiskMatrixV1(): Promise<ModelReplayRiskMatrixReportV1> {
  const { catalog } = readReplayRiskCatalogV1();
  const strict = new StrictModelReplayCatalogV1(catalog);
  const replay = createReplayModelResponseSourceV1(strict);
  const attempts: Array<{
    purpose: ModelInvocationPurposeV1;
    actor: ModelReplayActorIdentityV1;
    attemptOrdinal: number;
    kind: ModelAttemptOutcomeV1['kind'];
  }> = [];
  let modelHandlesPresented = 0;
  let credentialFieldsPresented = 0;
  const source = {
    mode: 'replay' as const,
    attempt: async (input: Parameters<typeof replay.attempt>[0]) => {
      if (input.model) modelHandlesPresented += 1;
      if ('apiKey' in (input as unknown as Record<string, unknown>)) {
        credentialFieldsPresented += 1;
      }
      const outcome = await replay.attempt(input);
      const actor = input.context.replayBinding?.actor;
      if (!actor) throw new Error('Required replay risk actor binding is absent.');
      attempts.push({
        purpose: input.context.purpose,
        actor,
        attemptOrdinal: input.attemptOrdinal,
        kind: outcome.kind,
      });
      return outcome;
    },
  };
  const observed: ModelReplayRiskMatrixReportV1['cases'][number][] = [];

  for (const entry of MODEL_REPLAY_RISK_CASES_V1) {
    const before = attempts.length;
    const runtimeIdSource = createDeterministicRuntimeIdSourceV1({
      seed: entry.caseId.replaceAll('.', '-'),
      epochMs: Date.UTC(2000, 0, 1),
    });
    const harness = createTestModelInvocationHarnessV1({
      workspace: '<workspace>',
      source,
      runtimeIdSource,
      sleep: async () => {},
    });
    let terminalFailure: ModelAttemptFailureErrorV1 | undefined;
    try {
      const pending = await harness.gateway.invoke({
        compiled: compileReplayRiskSurfaceV1(entry.purpose, entry.actor),
        persistence: harness.persistence,
        provenance: riskProvenance(entry.purpose),
        providerDataPolicyRequired: false,
        resourceKind: entry.purpose === 'context_compaction' ? 'compaction' : 'model',
        replayBinding: replayRiskBindingV1({ actor: entry.actor }),
        limits: {
          maxAttempts: entry.maxAttempts,
          perAttemptTimeoutMs: 5_000,
          totalTimeBudgetMs: 10_000,
        },
      });
      await pending.commit();
    } catch (error) {
      if (!(error instanceof ModelAttemptFailureErrorV1)) throw error;
      terminalFailure = error;
    }
    const entryAttempts = attempts.slice(before);
    const expectedKinds =
      entry.expected === 'success_after_retry'
        ? ['retryable_failure', 'success']
        : entry.expected === 'fatal_failure'
          ? ['fatal_failure']
          : entry.expected === 'aborted'
            ? ['aborted']
            : ['success'];
    if (
      JSON.stringify(entryAttempts.map((attempt) => attempt.kind)) !==
        JSON.stringify(expectedKinds) ||
      entryAttempts.some(
        (attempt) =>
          attempt.purpose !== entry.purpose ||
          JSON.stringify(attempt.actor) !== JSON.stringify(entry.actor),
      ) ||
      (terminalFailure?.outcome.kind ?? null) !==
        (entry.expected === 'fatal_failure'
          ? 'fatal_failure'
          : entry.expected === 'aborted'
            ? 'aborted'
            : null)
    ) {
      throw new Error('Required replay risk outcome changed.');
    }
    observed.push({ caseId: entry.caseId, purpose: entry.purpose, observed: entry.expected });
  }
  strict.assertConsumed();
  const attemptOutcomes = [...new Set(attempts.map((attempt) => attempt.kind))];
  if (
    JSON.stringify(attemptOutcomes) !==
      JSON.stringify(['retryable_failure', 'success', 'fatal_failure', 'aborted']) ||
    new Set(attempts.map((attempt) => attempt.purpose)).size !== 5 ||
    !attempts.some(
      (attempt) => attempt.actor.kind === 'subagent' && Boolean(attempt.actor.continuationId),
    ) ||
    modelHandlesPresented !== 0 ||
    credentialFieldsPresented !== 0
  ) {
    throw new Error('Required replay risk coverage changed.');
  }
  const stable = {
    version: 1 as const,
    cases: observed,
    attemptOutcomes: attemptOutcomes as unknown as readonly [
      'retryable_failure',
      'success',
      'fatal_failure',
      'aborted',
    ],
    allPurposesCovered: true as const,
    continuationCursorCovered: true as const,
    allRecordsConsumed: true as const,
    providerTransportAttempts: 0 as const,
    apiKeyRead: false as const,
  };
  const canonicalDigest = sha256Digest(canonicalModelJsonV1(stable));
  if (canonicalDigest !== MODEL_REPLAY_RISK_EXPECTED_REPORT_DIGEST_V1) {
    throw new Error('Required replay risk report digest changed.');
  }
  return { ...stable, canonicalDigest };
}

export function riskProvenance(purpose: ModelInvocationPurposeV1) {
  return {
    promptContractVersion: 'required-replay-risk-v1',
    projectionEnvironmentDigest: sha256Digest(`risk-projection:${purpose}`),
    capabilityBindingDigest: sha256Digest(`risk-capability:${purpose}`),
  };
}

export function replayRiskOutcomeV1(input: {
  purpose: ModelInvocationPurposeV1;
  attemptOrdinal: number;
}): ModelAttemptOutcomeV1 {
  if (input.purpose === 'primary_agent' && input.attemptOrdinal === 1) {
    return {
      schema: {
        name: 'kite.model-attempt-outcome',
        version: 1,
        canonicalizerVersion: 'kite.model-surface.canonical-json.v1',
      },
      kind: 'retryable_failure',
      classification: 'provider_rate_limited',
      retryObservation: { providerStatusCode: 429, timedOut: false },
    };
  }
  if (input.purpose === 'context_compaction') {
    return {
      schema: {
        name: 'kite.model-attempt-outcome',
        version: 1,
        canonicalizerVersion: 'kite.model-surface.canonical-json.v1',
      },
      kind: 'fatal_failure',
      classification: 'provider_rejected',
      providerStatusCode: 400,
    };
  }
  if (input.purpose === 'auto_review') {
    return {
      schema: {
        name: 'kite.model-attempt-outcome',
        version: 1,
        canonicalizerVersion: 'kite.model-surface.canonical-json.v1',
      },
      kind: 'aborted',
      classification: 'cancelled',
    };
  }
  const suffix =
    input.purpose === 'primary_agent'
      ? 'primary-2'
      : input.purpose === 'verification_review'
        ? 'verification-1'
        : 'subagent-continuation-1';
  return {
    schema: {
      name: 'kite.model-attempt-outcome',
      version: 1,
      canonicalizerVersion: 'kite.model-surface.canonical-json.v1',
    },
    kind: 'success',
    nativeReplayState: null,
    response: {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `Synthetic ${input.purpose} replay outcome.` }],
      },
      finishReason: 'stop',
      usage: {
        inputTokens: 8,
        outputTokens: 4,
        totalTokens: 12,
        cacheReadTokens: 0,
      },
      providerMetadata: {
        responseId: `cassette-response-risk-${suffix}`,
        rawFinishReason: null,
      },
    },
  };
}
