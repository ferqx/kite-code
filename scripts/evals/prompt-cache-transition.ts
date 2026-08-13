import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ToolSet } from 'ai';
import {
  extractPromptCacheMetrics,
  PROMPT_CACHE_STANDARD_TARGET_HIT_RATE,
} from '@/core/cache-metrics';
import { getFeatureFlags } from '@/core/config';
import { createChatModel } from '@/core/model/factory';
import { invokeBoundModel } from '@/core/model/invoke';
import { createAgentTools, toolAvailabilityContext } from '@/core/tools/definitions';
import type { ToolAvailabilityContext } from '@/core/tools/registry/spec';
import { canonicalJson } from '../release/canonical-json';
import { resolveFormalEvaluationIdentityV1 } from './formal-eval-identity';
import { resolveOpenCodeGoConfig } from './live-provider-smoke';
import {
  buildPromptAbMessages,
  LIVE_EVAL_AUTHORIZATION_MODE,
  LIVE_EVAL_INTERACTION_MODE,
  type PromptAbCase,
} from './prompt-contract-ab';

const MINIMUM_MEASURED_INPUT_TOKENS = 8_000;
const PHASE_SEQUENCE = ['planning', 'building', 'planning', 'building'] as const;

interface CacheObservation {
  phase: (typeof PHASE_SEQUENCE)[number];
  isWarmup: boolean;
  inputTokens: number;
  cacheReadTokens: number;
  cacheMissTokens: number;
  hitRate: number;
}

export function assessPromptCacheTransition(input: {
  declarationsStable: boolean;
  observations: readonly CacheObservation[];
  targetHitRate?: number;
  minimumMeasuredInputTokens?: number;
}): {
  status: 'passed' | 'failed';
  measuredInputTokens: number;
  cacheReadTokens: number;
  hitRate: number;
  targetHitRate: number;
  minimumMeasuredInputTokens: number;
  failures: string[];
} {
  const targetHitRate = input.targetHitRate ?? PROMPT_CACHE_STANDARD_TARGET_HIT_RATE;
  const minimumMeasuredInputTokens =
    input.minimumMeasuredInputTokens ?? MINIMUM_MEASURED_INPUT_TOKENS;
  const measured = input.observations.filter((entry) => !entry.isWarmup);
  const measuredInputTokens = measured.reduce((sum, entry) => sum + entry.inputTokens, 0);
  const cacheReadTokens = measured.reduce((sum, entry) => sum + entry.cacheReadTokens, 0);
  const hitRate = measuredInputTokens > 0 ? cacheReadTokens / measuredInputTokens : 0;
  const failures: string[] = [];
  if (!input.declarationsStable) failures.push('phase_tool_declarations_changed');
  if (measured.length !== 2) failures.push('measured_call_count_mismatch');
  if (measuredInputTokens < minimumMeasuredInputTokens)
    failures.push('measured_tokens_insufficient');
  if (hitRate < targetHitRate) failures.push('cache_hit_rate_below_target');
  return {
    status: failures.length === 0 ? 'passed' : 'failed',
    measuredInputTokens,
    cacheReadTokens,
    hitRate,
    targetHitRate,
    minimumMeasuredInputTokens,
    failures,
  };
}

async function toolDeclarationSnapshot(tools: ToolSet): Promise<string> {
  const declarations = await Promise.all(
    Object.entries(tools).map(async ([name, tool]) => {
      const schema = tool.inputSchema as {
        jsonSchema?: unknown | PromiseLike<unknown>;
      };
      const jsonSchema = await schema.jsonSchema;
      return {
        name,
        description: tool.description ?? '',
        inputSchema: JSON.parse(JSON.stringify(jsonSchema)) as unknown,
      };
    }),
  );
  return canonicalJson(declarations.sort((left, right) => left.name.localeCompare(right.name)));
}

function cacheCase(phase: PromptAbCase['phase']): PromptAbCase {
  return {
    id: `cache-transition-${phase}`,
    category: 'prompt_cache_transition',
    prompt: 'Inspect the repository entry point and choose the safest next read-only inspection.',
    expectedTools: ['read_file', 'search_files', 'search_content'],
    phase,
  };
}

export async function runPromptCacheTransitionEval(input: {
  live: boolean;
  workspace?: string;
  formal?: boolean;
  candidateCommit?: string;
}): Promise<Record<string, unknown>> {
  const evaluationIdentity = resolveFormalEvaluationIdentityV1({
    formal: input.formal,
    expectedCandidateCommit: input.candidateCommit,
  });
  if (!input.live) {
    return {
      schema: 'PromptCacheTransitionEvalV1',
      status: 'live_eval_skipped',
      sequence: PHASE_SEQUENCE,
      targetHitRate: PROMPT_CACHE_STANDARD_TARGET_HIT_RATE,
      minimumMeasuredInputTokens: MINIMUM_MEASURED_INPUT_TOKENS,
      evaluationIdentity,
      contentLogged: false,
    };
  }
  const { config: baseConfig, credentialSource } = resolveOpenCodeGoConfig();
  const config = {
    ...baseConfig,
    features: { ...getFeatureFlags(baseConfig), promptContractV2: true },
  };
  const workspace = input.workspace ?? process.cwd();
  const model = createChatModel(config);
  const toolsByPhase = Object.fromEntries(
    await Promise.all(
      (['planning', 'building'] as const).map(async (phase) => {
        const toolInput = {
          workspace,
          phase,
          interactionMode: LIVE_EVAL_INTERACTION_MODE,
          authorization: {
            mode: LIVE_EVAL_AUTHORIZATION_MODE,
            modeSource: 'system' as const,
            modeGrantedAt: '1970-01-01T00:00:00.000Z',
            commandGrants: {},
          },
          config,
          toolSearch: getFeatureFlags(config).toolSearchV1,
          subagentEventSink: () => {},
        } as const;
        const context: ToolAvailabilityContext = toolAvailabilityContext(toolInput);
        return [phase, createAgentTools(toolInput, context) as ToolSet] as const;
      }),
    ),
  ) as Record<'planning' | 'building', ToolSet>;
  const planningDeclaration = await toolDeclarationSnapshot(toolsByPhase.planning);
  const buildingDeclaration = await toolDeclarationSnapshot(toolsByPhase.building);
  const declarationsStable = planningDeclaration === buildingDeclaration;
  const declarationHash = createHash('sha256').update(planningDeclaration).digest('hex');
  const observations: CacheObservation[] = [];
  const responseIds = new Set<string>();
  const seenPhases = new Set<'planning' | 'building'>();
  for (const phase of PHASE_SEQUENCE) {
    const response = await invokeBoundModel({
      model,
      tools: toolsByPhase[phase],
      messages: buildPromptAbMessages('v2_published', workspace, cacheCase(phase)),
      maxOutputTokens: 128,
      streaming: false,
      signal: AbortSignal.timeout(60_000),
    });
    const metrics = extractPromptCacheMetrics(response);
    if (!metrics) throw new Error('provider_cache_metrics_missing');
    if (response.id) responseIds.add(response.id);
    const isWarmup = !seenPhases.has(phase);
    seenPhases.add(phase);
    observations.push({
      phase,
      isWarmup,
      inputTokens: metrics.inputTokens,
      cacheReadTokens: metrics.cacheHitTokens,
      cacheMissTokens: metrics.cacheMissTokens,
      hitRate: metrics.hitRate,
    });
  }
  const acceptance = assessPromptCacheTransition({ declarationsStable, observations });
  return {
    schema: 'PromptCacheTransitionEvalV1',
    status: acceptance.status,
    provider: config.providerName,
    model: config.modelName,
    route: 'opencode_go_v1_chat_completions',
    credentialSource,
    interactionMode: LIVE_EVAL_INTERACTION_MODE,
    authorizationMode: LIVE_EVAL_AUTHORIZATION_MODE,
    evaluationIdentity,
    sequence: PHASE_SEQUENCE,
    declarationsStable,
    declarationHash,
    observations,
    providerEvidence: {
      responses: observations.length,
      responsesWithUsage: observations.length,
      responsesWithProviderId: responseIds.size,
      uniqueProviderResponseIds: responseIds.size,
    },
    acceptance,
    contentLogged: false,
  };
}

if (import.meta.main) {
  try {
    const outputArg = process.argv.find((value) => value.startsWith('--output='));
    const report = await runPromptCacheTransitionEval({
      live: process.env.KITE_RUN_PROMPT_CACHE_EVAL === '1',
    });
    if (outputArg) {
      const outputPath = resolve(outputArg.slice('--output='.length));
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'passed' && report.status !== 'live_eval_skipped') process.exitCode = 1;
  } catch {
    console.error(
      JSON.stringify({
        schema: 'PromptCacheTransitionEvalV1',
        status: 'provider_request_failed',
        reason: 'live_provider_request_failed',
        contentLogged: false,
      }),
    );
    process.exitCode = 1;
  }
}
