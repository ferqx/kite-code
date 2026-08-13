import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AgentConfig } from '@/core/config';
import { createChatModel } from '@/core/model/factory';
import type { RuntimeEvent } from '@/core/runtime/events';
import { createRuntimeEffectExecutor } from '@/core/runtime/executor';
import { AgentKernel } from '@/core/runtime/kernel';
import { runRuntimeLoop } from '@/core/runtime/runner';
import type { ToolCallStatus } from '@/core/runtime/state';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';
import type { SubAgentEventSink } from '@/core/subagent/types';
import {
  type FormalEvaluationIdentityV1,
  resolveFormalEvaluationIdentityV1,
} from './formal-eval-identity';
import { resolveOpenCodeGoConfig } from './live-provider-smoke';

/** Real end-to-end task journey. Unlike first-decision fixtures, the model sees tool errors/results. */
export const LIVE_TASK_JOURNEY_PROMPT =
  'Delegate a bounded read-only architecture diagnosis to a planning subagent. The subagent must not call tools: ask it to return one concise sentence about the delegation boundary and one risk based only on this instruction. When its result returns, answer the user directly without further tools.';

export const LIVE_TASK_INVALID_ARGS_JOURNEY_PROMPT =
  'Run a task parameter-recovery evaluation for an architecture diagnosis. First call task with subagent_type=plan and task exactly "x" so the Runtime returns its real schema error. After receiving that error, autonomously call task once more with valid arguments: ask a planning subagent, without calling tools, to return one concise sentence about the architecture delegation boundary and one risk. Then answer the user directly without further tools.';

export const LIVE_TASK_ALL_ROLES_JOURNEY_PROMPT =
  'Test all sub-agents. Call task exactly once for each role: explore, plan, code, and review. Give every child a bounded self-contained smoke task that requires no tool calls and asks it to return only its role name plus "ok"; do not perform the work locally. After all four task results return, answer with a concise pass/fail summary and no further tools.';

export type LiveTaskJourneyScenario =
  | 'natural'
  | 'invalid_args_recovery'
  | 'all_roles'
  | 'role_smoke';
export type LiveTaskJourneyArm = 'legacy' | 'v2';
export type LiveTaskJourneyRole = 'explore' | 'plan' | 'code' | 'review';

const MAX_OUTPUT_TOKENS = 1024;
const MAX_RUNTIME_EFFECTS = 40;

export interface LiveTaskJourneyProviderEvidence {
  modelRequests: number;
  modelResponses: number;
  httpRequests: number;
  httpResponses: number;
  http2xxResponses: number;
  httpTransportFailures: number;
  responsesWithUsage: number;
  responsesWithProviderId: number;
  uniqueProviderResponseIds: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  status: 'verified' | 'failed';
  failures: string[];
}

export interface LiveTaskJourneyReportV1 {
  schema: 'LiveTaskJourneyEvalV1';
  evaluationScope: 'runtime_task_recovery_journey';
  status:
    | 'completed'
    | 'journey_failed'
    | 'provider_evidence_failed'
    | 'live_eval_skipped'
    | 'provider_setup_failed';
  reason?: string;
  provider?: string;
  model?: string;
  route?: 'opencode_go_v1_chat_completions';
  credentialSource?: 'environment' | 'local_config';
  interactionMode: 'full';
  authorizationMode: 'full_access';
  promptContractV2: boolean;
  arm: LiveTaskJourneyArm;
  scenario: LiveTaskJourneyScenario;
  targetRole?: LiveTaskJourneyRole;
  maxOutputTokens: number;
  maxRuntimeEffects: number;
  evaluationIdentity: FormalEvaluationIdentityV1;
  journey?: {
    modelResponses: number;
    taskCalls: number;
    taskSucceeded: number;
    taskFailedOrRejected: number;
    invalidTaskCalls: number;
    modelCorrectionCalls: number;
    taskRoleCounts: Record<'explore' | 'plan' | 'code' | 'review' | 'unknown', number>;
    subagentStarted: number;
    subagentCompleted: number;
    subagentFailed: number;
    taskCallOutcomes: Array<{
      status: ToolCallStatus;
      started: boolean;
      recoveryLinked: boolean;
      recoveryAdmission?:
        | 'admitted'
        | 'recovery_not_allowed'
        | 'recovery_exhausted'
        | 'no_progress';
      failureKind?: string;
      detailCode?: string;
    }>;
    modelRespondedAfterFirstTaskOutcome: boolean;
    recoveredAfterTaskFailure: boolean;
    completed: boolean;
    blocked: boolean;
  };
  providerEvidence?: LiveTaskJourneyProviderEvidence;
  contentLogged: false;
}

export function isLiveTaskJourneyPassedV1(input: {
  scenario: LiveTaskJourneyScenario;
  targetRole?: LiveTaskJourneyRole;
  journey: NonNullable<LiveTaskJourneyReportV1['journey']>;
}): boolean {
  const { scenario, targetRole, journey } = input;
  if (!journey.completed || journey.blocked) return false;
  if (scenario === 'natural') {
    return (
      journey.taskCalls === 1 &&
      journey.taskSucceeded === 1 &&
      journey.taskFailedOrRejected === 0 &&
      journey.subagentCompleted === 1 &&
      journey.taskRoleCounts.plan === 1 &&
      journey.taskRoleCounts.explore === 0 &&
      journey.taskRoleCounts.code === 0 &&
      journey.taskRoleCounts.review === 0 &&
      journey.taskRoleCounts.unknown === 0
    );
  }
  if (scenario === 'all_roles') {
    return (
      journey.taskCalls === 4 &&
      journey.taskSucceeded === 4 &&
      journey.taskFailedOrRejected === 0 &&
      journey.subagentCompleted === 4 &&
      Object.entries(journey.taskRoleCounts).every(([role, count]) =>
        role === 'unknown' ? count === 0 : count === 1,
      )
    );
  }
  if (scenario === 'role_smoke') {
    return (
      targetRole !== undefined &&
      journey.taskCalls === 1 &&
      journey.taskSucceeded === 1 &&
      journey.taskFailedOrRejected === 0 &&
      journey.subagentCompleted === 1 &&
      journey.taskRoleCounts[targetRole] === 1 &&
      journey.taskRoleCounts.unknown === 0
    );
  }
  return (
    journey.taskCalls === 2 &&
    journey.taskSucceeded === 1 &&
    journey.taskFailedOrRejected === 1 &&
    journey.invalidTaskCalls === 1 &&
    journey.modelCorrectionCalls === 1 &&
    journey.subagentCompleted === 1 &&
    journey.recoveredAfterTaskFailure
  );
}

interface EvidenceAccumulator {
  modelRequests: number;
  modelResponses: number;
  httpRequests: number;
  httpResponses: number;
  http2xxResponses: number;
  httpTransportFailures: number;
  responsesWithUsage: number;
  responsesWithProviderId: number;
  responseIds: Set<string>;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  parsing: Promise<void>[];
}

function finiteToken(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): URL {
  return input instanceof Request ? new URL(input.url) : new URL(String(input));
}

function createEvidenceFetch(accumulator: EvidenceAccumulator): typeof globalThis.fetch {
  const transport = globalThis.fetch;
  const evidenceFetch = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => {
    const url = requestUrl(input);
    const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'opencode.ai' ||
      url.port !== '' ||
      url.pathname !== '/zen/go/v1/chat/completions' ||
      url.search ||
      url.hash ||
      method.toUpperCase() !== 'POST'
    ) {
      throw new Error('provider_route_mismatch');
    }
    accumulator.httpRequests++;
    accumulator.modelRequests++;
    try {
      const response = await transport(input, init);
      accumulator.httpResponses++;
      if (response.ok) {
        accumulator.http2xxResponses++;
        accumulator.modelResponses++;
      }
      if (response.ok) {
        accumulator.parsing.push(
          response
            .clone()
            .text()
            .then((body) => recordResponsePayload(accumulator, body))
            .catch(() => undefined),
        );
      }
      return response;
    } catch (error) {
      accumulator.httpTransportFailures++;
      throw error;
    }
  };
  evidenceFetch.preconnect = transport.preconnect.bind(transport);
  return evidenceFetch;
}

function recordResponseBody(accumulator: EvidenceAccumulator, body: unknown): void {
  if (!body || typeof body !== 'object') return;
  const record = body as Record<string, unknown>;
  if (typeof record.id === 'string' && record.id.trim()) accumulator.responseIds.add(record.id);
  const usage = record.usage;
  if (!usage || typeof usage !== 'object') return;
  const values = usage as Record<string, unknown>;
  const inputTokens = finiteToken(values.prompt_tokens ?? values.input_tokens);
  const outputTokens = finiteToken(values.completion_tokens ?? values.output_tokens);
  const totalTokens = finiteToken(values.total_tokens);
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) return;
  accumulator.responsesWithUsage++;
  accumulator.inputTokens += inputTokens;
  accumulator.outputTokens += outputTokens;
  accumulator.totalTokens += totalTokens;
}

/** OpenAI-compatible controller calls stream SSE; child calls use one JSON body. */
function recordResponsePayload(accumulator: EvidenceAccumulator, payload: string): void {
  try {
    recordResponseBody(accumulator, JSON.parse(payload));
    return;
  } catch {
    // Continue with the SSE parser. It retains only aggregate provider metadata.
  }
  for (const line of payload.split('\n')) {
    const data = line.startsWith('data:') ? line.slice('data:'.length).trim() : '';
    if (!data || data === '[DONE]') continue;
    try {
      recordResponseBody(accumulator, JSON.parse(data));
    } catch {
      // A malformed or non-JSON event cannot be evidence, but must not expose its body.
    }
  }
}

function snapshotEvidence(accumulator: EvidenceAccumulator): LiveTaskJourneyProviderEvidence {
  const failures: string[] = [];
  if (accumulator.modelRequests === 0) failures.push('no_model_requests');
  if (accumulator.modelResponses !== accumulator.modelRequests)
    failures.push('model_response_count_mismatch');
  if (accumulator.httpRequests !== accumulator.modelRequests)
    failures.push('http_dispatch_missing');
  if (accumulator.httpResponses !== accumulator.httpRequests)
    failures.push('http_response_count_mismatch');
  if (accumulator.http2xxResponses !== accumulator.modelResponses)
    failures.push('http_success_count_mismatch');
  if (accumulator.httpTransportFailures > 0) failures.push('http_transport_failure');
  if (accumulator.responsesWithUsage !== accumulator.modelResponses)
    failures.push('usage_coverage_mismatch');
  if (
    accumulator.inputTokens <= 0 ||
    accumulator.outputTokens <= 0 ||
    accumulator.totalTokens <= 0
  ) {
    failures.push('usage_total_zero');
  }
  if (accumulator.responseIds.size !== accumulator.modelResponses)
    failures.push('response_id_coverage_mismatch');
  return {
    modelRequests: accumulator.modelRequests,
    modelResponses: accumulator.modelResponses,
    httpRequests: accumulator.httpRequests,
    httpResponses: accumulator.httpResponses,
    http2xxResponses: accumulator.http2xxResponses,
    httpTransportFailures: accumulator.httpTransportFailures,
    responsesWithUsage: accumulator.responsesWithUsage,
    responsesWithProviderId: accumulator.responseIds.size,
    uniqueProviderResponseIds: accumulator.responseIds.size,
    inputTokens: accumulator.inputTokens,
    outputTokens: accumulator.outputTokens,
    totalTokens: accumulator.totalTokens,
    status: failures.length === 0 ? 'verified' : 'failed',
    failures,
  };
}

function journeyConfig(config: AgentConfig, arm: LiveTaskJourneyArm): AgentConfig {
  return {
    ...config,
    modelKwargs: { ...config.modelKwargs, maxOutputTokens: MAX_OUTPUT_TOKENS },
    features: { ...config.features, promptContractV2: arm === 'v2' },
  };
}

/**
 * A live evaluation must never send repository source to a provider merely to
 * measure task recovery. The names match the delegation fixture, while the
 * content is deliberately inert and disposable.
 */
function createSafeJourneyWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-live-task-journey-'));
  const files: Record<string, string> = {
    'src/core/model/runtime-context.ts':
      'export const runtimeContextBoundary = "safe live-eval fixture";\n',
    'src/core/tools/registry/builtins/task.ts':
      'export const taskBoundaryRisk = "delegation stays read-only";\n',
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(workspace, relativePath);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return workspace;
}

/** Runs one production Kernel + controller + ToolController + SubAgentRunner journey. */
export async function runLiveTaskJourneyEval(input: {
  live: boolean;
  workspace?: string;
  scenario?: LiveTaskJourneyScenario;
  arm?: LiveTaskJourneyArm;
  role?: LiveTaskJourneyRole;
  formal?: boolean;
  candidateCommit?: string;
}): Promise<LiveTaskJourneyReportV1> {
  const evaluationIdentity = resolveFormalEvaluationIdentityV1({
    formal: input.formal,
    expectedCandidateCommit: input.candidateCommit,
  });
  const scenario = input.scenario ?? 'natural';
  const arm = input.arm ?? 'v2';
  const targetRole = input.role;
  const shared = {
    schema: 'LiveTaskJourneyEvalV1' as const,
    evaluationScope: 'runtime_task_recovery_journey' as const,
    interactionMode: 'full' as const,
    authorizationMode: 'full_access' as const,
    promptContractV2: arm === 'v2',
    arm,
    scenario,
    ...(targetRole ? { targetRole } : {}),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxRuntimeEffects: MAX_RUNTIME_EFFECTS,
    evaluationIdentity,
    contentLogged: false as const,
  };
  if (!input.live) {
    return {
      ...shared,
      status: 'live_eval_skipped',
      reason: 'Set KITE_RUN_TASK_JOURNEY_EVAL=1 to use configured Provider credentials.',
    };
  }
  let resolved: ReturnType<typeof resolveOpenCodeGoConfig>;
  try {
    resolved = resolveOpenCodeGoConfig();
  } catch {
    return {
      ...shared,
      status: 'provider_setup_failed',
      reason: 'opencode_go_route_or_credentials_unavailable',
    };
  }
  const ownedWorkspace = input.workspace === undefined;
  const workspace = input.workspace ?? createSafeJourneyWorkspace();
  const config = journeyConfig(resolved.config, arm);
  const accumulator: EvidenceAccumulator = {
    modelRequests: 0,
    modelResponses: 0,
    httpRequests: 0,
    httpResponses: 0,
    http2xxResponses: 0,
    httpTransportFailures: 0,
    responsesWithUsage: 0,
    responsesWithProviderId: 0,
    responseIds: new Set(),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    parsing: [],
  };
  const model = createChatModel(config, { fetch: createEvidenceFetch(accumulator) });
  const store = createRuntimeStore(':memory:');
  if (scenario === 'role_smoke' && !targetRole) {
    return {
      ...shared,
      status: 'provider_setup_failed',
      reason: 'role_smoke_target_missing',
    };
  }
  const initialState = createInitialRuntimeState({
    threadId: `live-task-journey-${crypto.randomUUID()}`,
    userId: 'live-eval',
    workspace,
    phase: scenario === 'all_roles' || scenario === 'role_smoke' ? 'building' : 'planning',
    interactionMode: 'full',
    authorizationMode: 'full_access',
    authorizationSource: 'system',
  });
  const kernel = new AgentKernel({
    store,
    initialState,
    interactionMode: 'full',
    sandboxAvailable: true,
  });
  const subagentEvents: Parameters<SubAgentEventSink>[0][] = [];
  const production = createRuntimeEffectExecutor({
    config,
    model,
    runtimeStore: store,
    subagentEventSink: (event) => subagentEvents.push(event),
  });
  const emitted: RuntimeEvent[] = [];
  const roleSmokePrompt = targetRole
    ? `Test the ${targetRole} sub-agent. Call task exactly once with subagent_type=${targetRole}. Give the child a bounded self-contained smoke task that requires no tool calls and asks it to return only "${targetRole} ok"; do not perform the work locally. After its result returns, answer with a concise pass/fail summary and no further tools.`
    : '';
  kernel.processEvent({
    type: 'user.message_appended',
    messageId: 'live-task-journey-user',
    content:
      scenario === 'invalid_args_recovery'
        ? LIVE_TASK_INVALID_ARGS_JOURNEY_PROMPT
        : scenario === 'all_roles'
          ? LIVE_TASK_ALL_ROLES_JOURNEY_PROMPT
          : scenario === 'role_smoke'
            ? roleSmokePrompt
            : LIVE_TASK_JOURNEY_PROMPT,
    userGoal:
      scenario === 'invalid_args_recovery'
        ? LIVE_TASK_INVALID_ARGS_JOURNEY_PROMPT
        : scenario === 'all_roles'
          ? LIVE_TASK_ALL_ROLES_JOURNEY_PROMPT
          : scenario === 'role_smoke'
            ? roleSmokePrompt
            : LIVE_TASK_JOURNEY_PROMPT,
  });
  try {
    for await (const event of runRuntimeLoop(
      kernel,
      production,
      {
        requestAction: async (effect) => ({ type: 'cancel', interactionId: effect.interactionId }),
      },
      MAX_RUNTIME_EFFECTS,
    )) {
      emitted.push(event);
    }
  } finally {
    await Promise.all(accumulator.parsing);
    store.close();
    if (ownedWorkspace) rmSync(workspace, { recursive: true, force: true });
  }
  const calls = Object.values(kernel.getState().tools.calls).filter((call) => call.name === 'task');
  const taskOutcomeIndices = emitted
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        (event.type === 'tool.finished' ||
          event.type === 'tool.failed' ||
          event.type === 'tool.rejected') &&
        calls.some((call) => call.toolCallId === event.toolCallId),
    );
  const firstTaskOutcome = taskOutcomeIndices[0]?.index;
  const modelRespondedAfterFirstTaskOutcome =
    firstTaskOutcome !== undefined &&
    emitted.slice(firstTaskOutcome + 1).some((event) => event.type === 'model.responded');
  const taskSucceeded = calls.filter((call) => call.status === 'succeeded').length;
  const taskFailedOrRejected = calls.filter(
    (call) => call.status === 'failed' || call.status === 'rejected' || call.status === 'cancelled',
  ).length;
  const invalidTaskCalls = calls.filter(
    (call) => call.status === 'failed' && !call.startedAt,
  ).length;
  const modelCorrectionCalls = calls.filter(
    (call) => call.recoveryMode === 'model_correction' && call.recoveryOf,
  ).length;
  const taskRoleCounts = {
    explore: 0,
    plan: 0,
    code: 0,
    review: 0,
    unknown: 0,
  };
  for (const call of calls) {
    const role =
      call.args && typeof call.args === 'object' && !Array.isArray(call.args)
        ? (call.args as Record<string, unknown>).subagent_type
        : undefined;
    if (role === 'explore' || role === 'plan' || role === 'code' || role === 'review') {
      taskRoleCounts[role]++;
    } else {
      taskRoleCounts.unknown++;
    }
  }
  const completed = emitted.some((event) => event.type === 'run.completed');
  const blocked = emitted.some(
    (event) => event.type === 'run.error' || event.type === 'turn.aborted',
  );
  const evidence = snapshotEvidence(accumulator);
  const journey = {
    modelResponses: emitted.filter((event) => event.type === 'model.responded').length,
    taskCalls: calls.length,
    taskSucceeded,
    taskFailedOrRejected,
    invalidTaskCalls,
    modelCorrectionCalls,
    taskRoleCounts,
    subagentStarted: subagentEvents.filter((event) => event.type === 'start').length,
    subagentCompleted: subagentEvents.filter((event) => event.type === 'done').length,
    subagentFailed: subagentEvents.filter((event) => event.type === 'error').length,
    taskCallOutcomes: calls.map((call) => ({
      status: call.status,
      started: call.startedAt !== undefined,
      recoveryLinked: call.recoveryOf !== undefined,
      ...(call.recoveryAdmission ? { recoveryAdmission: call.recoveryAdmission } : {}),
      ...(call.failure?.kind ? { failureKind: call.failure.kind } : {}),
      ...(call.outcomeV1?.failure?.detailCode
        ? { detailCode: call.outcomeV1.failure.detailCode }
        : call.failure?.parseFailureCode
          ? { detailCode: call.failure.parseFailureCode }
          : {}),
    })),
    modelRespondedAfterFirstTaskOutcome,
    recoveredAfterTaskFailure:
      taskFailedOrRejected > 0 && modelRespondedAfterFirstTaskOutcome && taskSucceeded > 0,
    completed,
    blocked,
  };
  const journeyPassed = isLiveTaskJourneyPassedV1({ scenario, targetRole, journey });
  return {
    ...shared,
    status:
      evidence.status !== 'verified'
        ? 'provider_evidence_failed'
        : journeyPassed
          ? 'completed'
          : 'journey_failed',
    provider: config.providerName,
    model: config.modelName,
    route: 'opencode_go_v1_chat_completions',
    credentialSource: resolved.credentialSource,
    journey,
    providerEvidence: evidence,
  };
}

if (import.meta.main) {
  const scenarioArg = process.argv.find((value) => value.startsWith('--scenario='));
  const scenario = scenarioArg?.slice('--scenario='.length);
  const armArg = process.argv.find((value) => value.startsWith('--arm='));
  const arm = armArg?.slice('--arm='.length);
  const roleArg = process.argv.find((value) => value.startsWith('--role='));
  const role = roleArg?.slice('--role='.length);
  const outputArg = process.argv.find((value) => value.startsWith('--output='));
  if (
    scenario !== undefined &&
    scenario !== 'natural' &&
    scenario !== 'invalid_args_recovery' &&
    scenario !== 'all_roles' &&
    scenario !== 'role_smoke'
  ) {
    throw new Error('task_journey_scenario_invalid');
  }
  if (arm !== undefined && arm !== 'legacy' && arm !== 'v2') {
    throw new Error('task_journey_arm_invalid');
  }
  if (
    role !== undefined &&
    role !== 'explore' &&
    role !== 'plan' &&
    role !== 'code' &&
    role !== 'review'
  ) {
    throw new Error('task_journey_role_invalid');
  }
  runLiveTaskJourneyEval({
    live: process.env.KITE_RUN_TASK_JOURNEY_EVAL === '1',
    scenario: scenario as LiveTaskJourneyScenario | undefined,
    arm: arm as LiveTaskJourneyArm | undefined,
    role: role as LiveTaskJourneyRole | undefined,
  })
    .then((report) => {
      if (outputArg) {
        const outputPath = resolve(outputArg.slice('--output='.length));
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
      }
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.status !== 'completed' && report.status !== 'live_eval_skipped')
        process.exitCode = 1;
    })
    .catch(() => {
      process.stderr.write(
        `${JSON.stringify({
          schema: 'LiveTaskJourneyEvalV1',
          evaluationScope: 'runtime_task_recovery_journey',
          status: 'provider_request_failed',
          contentLogged: false,
        })}\n`,
      );
      process.exitCode = 1;
    });
}
