import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { jsonSchema, type ToolSet, tool } from 'ai';
import type { AgentConfig } from '@/core/config';
import { humanMessage, systemMessage } from '@/core/messages';
import {
  type ModelArtifactWriterV1,
  ModelInvocationGatewayV1,
  type ModelInvocationPersistenceV1,
  type NormalizedModelResponseV1,
} from '@/core/model/invocation-gateway';
import { StrictModelReplayCatalogV1 } from '@/core/model/replay-catalog';
import { createReplayModelResponseSourceV1 } from '@/core/model/response-source';
import { canonicalModelJsonV1 } from '@/core/model/surface-canonicalizer';
import { type CompiledModelSurfaceV1, compileModelSurfaceV1 } from '@/core/model/surface-compiler';
import type { RuntimeEvent } from '@/core/runtime/events';
import { createRuntimeEffectExecutor } from '@/core/runtime/executor';
import {
  createDeterministicRuntimeIdSourceV1,
  type RuntimeIdSourceV1,
} from '@/core/runtime/id-source';
import { AgentKernel, type RuntimeEffectExecutor } from '@/core/runtime/kernel';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { runRuntimeLoop } from '@/core/runtime/runner';
import {
  createInitialRuntimeState,
  getActivePlanning,
  type RuntimeState,
} from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';
import type {
  ModelInvocationPurposeV1,
  ModelReplayActorIdentityV1,
  ModelReplayCatalogV1,
  ModelReplayInvocationBindingV1,
  ModelResponseRecordV1,
  PrivateArtifactRefV1,
} from '@/protocol/model-surface';
import { APPROVED_AGENT_TASK_SUITE_V1 } from '../../../scripts/evals/contracts/agent-task-approved-suite';
import {
  createReplayWorkspaceNormalizerV1,
  MODEL_REPLAY_PILOT_AUTHORITY_DIGEST_V1,
  MODEL_REPLAY_PILOT_AUTHORITY_V1,
  MODEL_REPLAY_PILOT_CASE_ID_V1,
  MODEL_REPLAY_PILOT_CASSETTE_DIGEST_V1,
  MODEL_REPLAY_PILOT_CLOCK_EPOCH_MS_V1,
  MODEL_REPLAY_PILOT_FIXTURE_DIGEST_V1,
  MODEL_REPLAY_PILOT_FIXTURE_ID_V1,
} from '../../../scripts/evals/contracts/model-replay-pilot';
import { sha256Digest } from '../../../scripts/release/canonical-json';
import { testCapabilityArtifactWriterV1 } from '../../helpers/runtime-model';
import { createMockModel } from '../../mock-model';
import {
  cleanupFixtureRun,
  collectFixtureArtifact,
  createFixtureRun,
} from './fixtures/fixture-runner';
import { evaluateAgentTask, runRegisteredChecks } from './oracle';

const PILOT_CONFIG: AgentConfig = {
  apiKey: '',
  baseURL: 'https://synthetic-replay-pilot.invalid/v1',
  modelName: 'synthetic-replay-pilot',
  providerName: 'synthetic-replay-pilot',
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

const PILOT_MODEL = createMockModel([]);
const PILOT_TOOLS: ToolSet = {
  read_file: tool({
    description: 'Read one workspace-relative UTF-8 file.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    }),
  }),
  write_file: tool({
    description: 'Write one complete workspace-relative UTF-8 file.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    }),
  }),
};

const PARENT_ACTOR = Object.freeze({ kind: 'parent' as const });
const CHILD_A = Object.freeze({
  kind: 'subagent' as const,
  parentToolCallId: 'pilot-parent-tool-call',
  subagentId: 'pilot-child-a',
  continuationId: null,
});
const CHILD_B = Object.freeze({
  kind: 'subagent' as const,
  parentToolCallId: 'pilot-parent-tool-call',
  subagentId: 'pilot-child-b',
  continuationId: null,
});

export type ReplayPilotSemanticMutationV1 = 'prompt' | 'schema' | 'tool_output';

export interface ModelReplayPilotReportV1 {
  version: 1;
  authorityDigest: `sha256:${string}`;
  fixtureDigest: `sha256:${string}`;
  catalogDigest: `sha256:${string}`;
  actorCursor: {
    parentLogicalInvocations: 4;
    concurrentChildren: readonly ['pilot-child-a', 'pilot-child-b'];
    allRecordsConsumed: true;
  };
  runtime: {
    completed: boolean;
    modelAttempts: number;
    toolTerminals: number;
    recoveryObserved: boolean;
    verificationPassed: boolean;
    canonicalTerminals: unknown;
    canonicalReceipts: unknown;
  };
  oracle: { passed: boolean; digest: `sha256:${string}` };
  privacy: {
    apiKeyRead: false;
    providerTransportAttempts: 0;
    networkAttempts: 0;
    unboundHostPaths: 0;
  };
  cleanup: { ownedRootRemoved: boolean; residualProcesses: 0; residualWorktrees: 0 };
  canonicalDigest: `sha256:${string}`;
}

export function compileReplayPilotSurfaceV1(input: {
  actor: ModelReplayActorIdentityV1;
  logicalInvocationOrdinal: number;
  mutation?: ReplayPilotSemanticMutationV1;
}): CompiledModelSurfaceV1 {
  const purpose: ModelInvocationPurposeV1 =
    input.actor.kind === 'parent' ? 'primary_agent' : 'subagent';
  const frame = pilotFrame(input.actor, input.logicalInvocationOrdinal, input.mutation);
  const tools = input.actor.kind === 'parent' ? mutatedTools(input.mutation) : {};
  return compileModelSurfaceV1({
    purpose,
    config: PILOT_CONFIG,
    model: PILOT_MODEL,
    messages: [
      systemMessage(
        'Deterministic replay pilot. <workspace> is the only workspace token; never use an absolute path.',
      ),
      humanMessage(canonicalModelJsonV1(frame)),
    ],
    tools,
    maxOutputTokens: 512,
    transport: 'generate',
    estimatedInputTokens: 256,
  });
}

export function replayPilotBindingV1(input: {
  actor: ModelReplayActorIdentityV1;
  logicalInvocationOrdinal: number;
  fixtureDigest?: `sha256:${string}`;
}): ModelReplayInvocationBindingV1 {
  return Object.freeze({
    suiteId: MODEL_REPLAY_PILOT_AUTHORITY_V1.suiteId,
    suiteRevision: MODEL_REPLAY_PILOT_AUTHORITY_V1.suiteRevision,
    fixtureDigest: input.fixtureDigest ?? MODEL_REPLAY_PILOT_FIXTURE_DIGEST_V1,
    actor: input.actor,
    logicalInvocationOrdinal: input.logicalInvocationOrdinal,
    replayDigest: null,
  });
}

export function readReplayPilotCatalogV1(): {
  catalog: ModelReplayCatalogV1;
  digest: `sha256:${string}`;
} {
  const bytes = readFileSync(new URL('./cassettes/deterministic-pilot-v1.json', import.meta.url));
  const framed = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!framed.endsWith('\n') || framed.slice(0, -1).includes('\n')) {
    throw new Error('Replay pilot cassette must contain one canonical JSON line.');
  }
  const text = framed.slice(0, -1);
  StrictModelReplayCatalogV1.parse(text);
  const digest = sha256Digest(bytes);
  if (digest !== MODEL_REPLAY_PILOT_CASSETTE_DIGEST_V1) {
    throw new Error('Replay pilot cassette digest changed.');
  }
  const catalog = JSON.parse(text) as ModelReplayCatalogV1;
  if (
    catalog.catalogRevision !== MODEL_REPLAY_PILOT_AUTHORITY_V1.catalogRevision ||
    catalog.records.length !== MODEL_REPLAY_PILOT_AUTHORITY_V1.catalogRecordCount ||
    catalog.records.some((record) => record.replayDigest !== null)
  ) {
    throw new Error('Replay pilot catalog authority binding changed.');
  }
  return {
    catalog,
    digest,
  };
}

export async function runDeterministicModelReplayPilotV1(
  input: { childSchedule?: 'ab' | 'ba' } = {},
): Promise<ModelReplayPilotReportV1> {
  const task = APPROVED_AGENT_TASK_SUITE_V1.cases.find(
    (entry) => entry.caseId === MODEL_REPLAY_PILOT_CASE_ID_V1,
  );
  if (!task || task.fixtureId !== MODEL_REPLAY_PILOT_FIXTURE_ID_V1) {
    throw new Error('Replay pilot task/fixture identity is unavailable.');
  }
  const run = createFixtureRun(task);
  const normalizer = createReplayWorkspaceNormalizerV1({
    workspace: run.workspace,
    processCwd: process.cwd(),
  });
  let store: ReturnType<typeof createRuntimeStore> | undefined;
  let cleaned = false;
  try {
    if (run.fixtureDigest !== MODEL_REPLAY_PILOT_FIXTURE_DIGEST_V1) {
      throw new Error('Replay pilot fixture digest changed.');
    }
    const { catalog, digest: catalogDigest } = readReplayPilotCatalogV1();
    const strictCatalog = new StrictModelReplayCatalogV1(catalog);
    const source = createReplayModelResponseSourceV1(strictCatalog);
    const runtimeIdSource = pilotIdSource('pilot-parent');
    const gateway = new ModelInvocationGatewayV1({
      artifacts: pilotModelArtifacts(),
      source,
      runtimeIdSource,
      sleep: async () => {},
    });

    const childOrder = input.childSchedule === 'ba' ? [CHILD_B, CHILD_A] : [CHILD_A, CHILD_B];
    const childResults = await Promise.all(
      childOrder.map((actor) => runChildReplay(actor, source)),
    );
    const childIds = childResults.map((result) => result.subagentId).sort();
    if (childIds.join(',') !== 'pilot-child-a,pilot-child-b') {
      throw new Error('Replay pilot child actor identity changed.');
    }

    const initialState = createInitialRuntimeState({
      threadId: 'replay-pilot-thread',
      userId: 'replay-pilot',
      workspace: run.workspace,
      interactionMode: 'accept_edits',
      runtimeIdSource,
    });
    store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState,
      interactionMode: 'accept_edits',
      runtimeIdSource,
    });
    let parentLogicalInvocation = 0;
    let networkAttempts = 0;
    const production = createRuntimeEffectExecutor({
      config: PILOT_CONFIG,
      model: {} as never,
      runtimeStore: store,
      capabilityArtifactStore: testCapabilityArtifactWriterV1(),
      modelInvocationGateway: gateway,
      shellExecutor: async ({ command }) => {
        networkAttempts += 1;
        return { ok: false, command, exitCode: -1, stdout: '', stderr: 'disabled' };
      },
    });
    const executor: RuntimeEffectExecutor = async (effect, readonlyState, emit, context) => {
      if (effect.type !== 'call_model') return production(effect, readonlyState, emit, context);
      if (!context?.getState) throw new Error('Replay pilot persistence context is unavailable.');
      parentLogicalInvocation += 1;
      const ordinal = parentLogicalInvocation;
      const persistence: ModelInvocationPersistenceV1 = {
        getState: () => context.getState!() as RuntimeState,
        persistEvents: context.persistEvents,
      };
      const pending = await gateway.invoke({
        compiled: compileReplayPilotSurfaceV1({
          actor: PARENT_ACTOR,
          logicalInvocationOrdinal: ordinal,
        }),
        persistence,
        provenance: {
          promptContractVersion: 'replay-pilot-prompt-v1',
          projectionEnvironmentDigest: labelDigest('pilot-projection'),
          capabilityBindingDigest: labelDigest('pilot-capability-bindings'),
        },
        providerDataPolicyRequired: false,
        resourceKind: 'model',
        replayBinding: replayPilotBindingV1({
          actor: PARENT_ACTOR,
          logicalInvocationOrdinal: ordinal,
        }),
        limits: { maxAttempts: 1, perAttemptTimeoutMs: 5_000, totalTimeBudgetMs: 5_000 },
      });
      return pending.commitWith((response) => ({
        events: modelEvents(response, readonlyState as RuntimeState, ordinal, runtimeIdSource),
        value: [],
      }));
    };

    const emitted: RuntimeEvent[] = [];
    kernel.processEvent({
      type: 'user.message_appended',
      messageId: 'replay-pilot-user-message',
      content: 'Repair the bounded arithmetic bug after recovering from one missing-file read.',
    });
    for await (const event of runRuntimeLoop(
      kernel,
      executor,
      {
        requestAction: async (effect) => ({
          type: 'cancel' as const,
          interactionId: effect.interactionId,
        }),
      },
      48,
    )) {
      emitted.push(event);
    }

    if (parentLogicalInvocation !== 4) {
      throw new Error(
        `Replay pilot parent cursor consumed ${parentLogicalInvocation} logical invocations instead of four.`,
      );
    }
    strictCatalog.assertConsumed();
    const state = kernel.getState();
    const persistedEvents = store
      .loadEventsStrict(state.session.threadId)
      .map((entry) => entry.event);
    const artifact = collectFixtureArtifact(run);
    const checks = await runRegisteredChecks(task, async () => ({
      status: 'passed',
      exitCode: 0,
      durationMs: 0,
      reason: null,
      networkObserved: false,
    }));
    const toolCalls = Object.values(state.tools.calls);
    const verificationPassed = Object.values(state.verification.records).some(
      (record) => record.status === 'passed',
    );
    const oracle = evaluateAgentTask({
      version: 1,
      task,
      artifact,
      checks,
      interaction: {
        version: 1,
        entrypoint: 'headless_cli',
        planUsed: getActivePlanning(state) !== null,
        approvalCount: 0,
        verificationPerformed: verificationPassed,
        projectInstructionsFollowed: true,
        userCorrections: 0,
        durationMs: 0,
        modelCalls: parentLogicalInvocation,
        toolCalls: toolCalls.length,
        inputTokens: parentLogicalInvocation * 16,
        outputTokens: parentLogicalInvocation * 8,
      },
      externalSideEffects: [],
      claimedComplete: emitted.some((event) => event.type === 'run.completed'),
      disclosedUnrunChecks: [],
      reverted: false,
    });
    if (oracle.digest !== MODEL_REPLAY_PILOT_AUTHORITY_V1.expectedOracleDigest) {
      throw new Error(`Replay pilot oracle digest changed: ${oracle.digest}.`);
    }
    const canonicalTerminals = normalizer.normalize(projectTerminalEvents(persistedEvents));
    const canonicalReceipts = normalizer.normalize(projectKeyReceipts(persistedEvents));
    const recoveryObserved = persistedEvents.some(
      (event) =>
        'outcomeV1' in event &&
        event.outcomeV1?.status === 'failed' &&
        event.outcomeV1.recovery.disposition === 'alternative',
    );
    const cleanupArtifact = cleanupFixtureRun(run);
    cleaned = true;
    const stable = {
      version: 1 as const,
      authorityDigest: MODEL_REPLAY_PILOT_AUTHORITY_DIGEST_V1,
      fixtureDigest: artifact.fixtureDigest,
      catalogDigest,
      actorCursor: {
        parentLogicalInvocations: 4 as const,
        concurrentChildren: ['pilot-child-a', 'pilot-child-b'] as const,
        allRecordsConsumed: true as const,
      },
      runtime: {
        completed: emitted.some((event) => event.type === 'run.completed'),
        modelAttempts: persistedEvents.filter(
          (event) => event.type === 'model.invocation_attempt_started',
        ).length,
        toolTerminals: persistedEvents.filter((event) =>
          ['tool.finished', 'tool.failed', 'tool.rejected', 'tool.cancelled'].includes(event.type),
        ).length,
        recoveryObserved,
        verificationPassed,
        canonicalTerminals,
        canonicalReceipts,
      },
      oracle: { passed: oracle.passed, digest: oracle.digest },
      privacy: {
        apiKeyRead: false as const,
        providerTransportAttempts: 0 as const,
        networkAttempts: networkAttempts as 0,
        unboundHostPaths: 0 as const,
      },
      cleanup: {
        ownedRootRemoved: !existsSync(run.root),
        residualProcesses: cleanupArtifact.residualProcessIds.length as 0,
        residualWorktrees: cleanupArtifact.residualWorktrees.length as 0,
      },
    };
    if (networkAttempts !== 0) throw new Error('Replay pilot attempted a network/shell boundary.');
    const canonicalDigest = normalizer.digest(stable);
    return { ...stable, canonicalDigest };
  } finally {
    store?.close();
    if (!cleaned && existsSync(run.root)) cleanupFixtureRun(run);
  }
}

async function runChildReplay(
  actor: typeof CHILD_A | typeof CHILD_B,
  source: ReturnType<typeof createReplayModelResponseSourceV1>,
): Promise<{ subagentId: string; text: string }> {
  const runtimeIdSource = pilotIdSource(actor.subagentId);
  let state = createInitialRuntimeState({
    threadId: `replay-pilot-${actor.subagentId}`,
    userId: 'replay-pilot',
    workspace: '<workspace>',
    runtimeIdSource,
  });
  const persistence: ModelInvocationPersistenceV1 = {
    getState: () => state,
    persistEvents: async (events) => {
      for (const event of events) {
        state = { ...reduceRuntimeState(state, event), revision: state.revision + 1 };
      }
      return true;
    },
  };
  const gateway = new ModelInvocationGatewayV1({
    artifacts: pilotModelArtifacts(),
    source,
    runtimeIdSource,
    sleep: async () => {},
  });
  const pending = await gateway.invoke({
    compiled: compileReplayPilotSurfaceV1({ actor, logicalInvocationOrdinal: 1 }),
    persistence,
    provenance: {
      parentToolCallId: actor.parentToolCallId,
      promptContractVersion: 'replay-pilot-prompt-v1',
      projectionEnvironmentDigest: labelDigest('pilot-projection'),
      capabilityBindingDigest: labelDigest('pilot-capability-bindings'),
    },
    providerDataPolicyRequired: false,
    resourceKind: 'model',
    replayBinding: replayPilotBindingV1({ actor, logicalInvocationOrdinal: 1 }),
    limits: { maxAttempts: 1, perAttemptTimeoutMs: 5_000, totalTimeBudgetMs: 5_000 },
  });
  const response = await pending.commit();
  const text = response.message.content
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
  return { subagentId: actor.subagentId, text };
}

function modelEvents(
  response: Readonly<NormalizedModelResponseV1>,
  state: RuntimeState,
  ordinal: number,
  runtimeIdSource: RuntimeIdSourceV1,
): RuntimeEvent[] {
  const text = response.message.content
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
  const reasoningText = response.message.content
    .filter(
      (part): part is Extract<typeof part, { type: 'reasoning' }> => part.type === 'reasoning',
    )
    .map((part) => part.text)
    .join('');
  const toolCalls = response.message.content.flatMap((part) =>
    part.type === 'tool_call'
      ? [{ id: part.toolCallId, name: part.toolName, args: part.input as Record<string, unknown> }]
      : [],
  );
  const messageId =
    typeof response.providerMetadata.responseId === 'string'
      ? response.providerMetadata.responseId
      : response.invocationId;
  const events: RuntimeEvent[] = [
    {
      type: 'model.responded',
      invocationId: response.invocationId,
      messageId,
      durationMs: 0,
      text,
      reasoningText,
      toolCalls,
      ...(response.usage.inputTokens != null ? { inputTokens: response.usage.inputTokens } : {}),
      ...(response.usage.outputTokens != null ? { outputTokens: response.usage.outputTokens } : {}),
    },
  ];
  for (const [index, call] of toolCalls.entries()) {
    const write = call.name === 'write_file';
    events.push({
      type: 'tool.queued',
      toolCallId: call.id,
      modelInvocationId: response.invocationId,
      name: call.name,
      args: call.args,
      modelMessageId: messageId,
      ordinal: index,
      taskId: state.activeTaskId ?? undefined,
      effectClass: write ? 'workspace_write' : 'read_only',
      sideEffect: write,
      classificationReason: write
        ? 'Replay pilot workspace mutation.'
        : 'Replay pilot read-only observation.',
    });
  }
  if (ordinal === 3) {
    events.push({
      type: 'verification.requested',
      verificationId: 'replay-pilot-verification',
      taskId: state.activeTaskId ?? undefined,
      mode: 'required',
      requestedAt: new Date(runtimeIdSource.now()).toISOString(),
      spec: {
        schemaVersion: 1,
        verificationId: 'replay-pilot-verification',
        taskId: state.activeTaskId ?? undefined,
        subject: 'Replay pilot deterministic receipt check',
        checks: [
          {
            checkId: 'replay-pilot-schema-check',
            type: 'schema',
            description: 'Validate the fixed pilot receipt.',
            subject: { kind: 'literal', value: { recovered: true } },
            schema: {
              type: 'object',
              properties: { recovered: { type: 'boolean', const: true } },
              required: ['recovered'],
              additionalProperties: false,
            },
          },
        ],
        repair: { maxAttempts: 0 },
      },
    });
  }
  return events;
}

function pilotFrame(
  actor: ModelReplayActorIdentityV1,
  ordinal: number,
  mutation: ReplayPilotSemanticMutationV1 | undefined,
): Record<string, unknown> {
  const actorId = actor.kind === 'parent' ? 'parent' : actor.subagentId;
  const prior =
    actor.kind === 'parent' && ordinal === 2
      ? mutation === 'tool_output'
        ? 'missing_file_changed'
        : 'missing_file_observed'
      : actor.kind === 'parent' && ordinal === 3
        ? 'workspace_write_committed'
        : actor.kind === 'parent' && ordinal === 4
          ? 'verification_passed'
          : 'none';
  return {
    version: 1,
    fixture: '<workspace>',
    actor: actorId,
    logicalInvocationOrdinal: ordinal,
    priorObservation: prior,
    instruction:
      mutation === 'prompt'
        ? 'mutated replay pilot instruction'
        : 'Execute the next bounded recovery step.',
  };
}

function mutatedTools(mutation: ReplayPilotSemanticMutationV1 | undefined): ToolSet {
  if (mutation !== 'schema') return PILOT_TOOLS;
  return {
    ...PILOT_TOOLS,
    read_file: tool({
      description: 'Mutated replay pilot schema.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { path: { type: 'string' }, unexpected: { type: 'boolean' } },
        required: ['path'],
        additionalProperties: false,
      }),
    }),
  };
}

function pilotIdSource(seed: string): RuntimeIdSourceV1 {
  return createDeterministicRuntimeIdSourceV1({
    seed,
    epochMs: MODEL_REPLAY_PILOT_CLOCK_EPOCH_MS_V1,
  });
}

function pilotModelArtifacts(): ModelArtifactWriterV1 {
  const ref = <K extends 'model_surface' | 'model_response'>(
    kind: K,
    value: unknown,
  ): PrivateArtifactRefV1 & { kind: K } => {
    const bytes = Buffer.from(canonicalModelJsonV1(value), 'utf8');
    const identity = createHash('sha256').update(bytes).digest('hex');
    return {
      artifactId: `pilot-${kind}-${identity}`,
      kind,
      integrityIdentifier: `hmac-sha256:${identity}`,
      byteLength: bytes.byteLength,
    };
  };
  return {
    writeSurface: (surface) => ref('model_surface', surface),
    writeResponse: (response: ModelResponseRecordV1) => ref('model_response', response),
  };
}

function projectTerminalEvents(events: readonly RuntimeEvent[]): unknown {
  return events
    .filter((event) =>
      [
        'run.completed',
        'run.error',
        'turn.completed',
        'turn.aborted',
        'completion.blocked',
      ].includes(event.type),
    )
    .map((event) =>
      event.type === 'completion.blocked'
        ? { type: event.type, code: event.code, correctionAttempt: event.correctionAttempt }
        : { type: event.type },
    );
}

function projectKeyReceipts(events: readonly RuntimeEvent[]): unknown {
  const output: unknown[] = [];
  for (const event of events) {
    if (event.type === 'model.invocation_completed') {
      output.push({
        type: event.type,
        invocationId: event.invocationId,
        finishReason: event.finishReason,
        responseIntegrityIdentifier: event.responseArtifact.integrityIdentifier,
      });
      continue;
    }
    if (
      event.type === 'capability.execution_succeeded' ||
      event.type === 'capability.execution_failed'
    ) {
      output.push({
        type: event.type,
        invocationId: event.invocationId,
        resultDigest: event.resultDigest,
        evidenceDigest: event.evidenceDigest,
        artifactIntegrityIdentifier:
          event.artifact && 'integrityIdentifier' in event.artifact
            ? event.artifact.integrityIdentifier
            : null,
      });
      continue;
    }
    if ('outcomeV1' in event && event.outcomeV1) {
      output.push({
        type: event.type,
        toolCallId: 'toolCallId' in event ? event.toolCallId : null,
        status: event.outcomeV1.status,
        detailCode: event.outcomeV1.failure?.detailCode ?? null,
        recoveryDisposition: event.outcomeV1.recovery.disposition,
        dispatchState: event.outcomeV1.dispatchState,
        externalEffects: event.outcomeV1.externalEffects,
      });
      continue;
    }
    if (event.type === 'verification.completed') {
      output.push({
        type: event.type,
        verificationId: event.verificationId,
        outcome: event.outcome,
      });
    }
  }
  return output;
}

function labelDigest(value: string): `sha256:${string}` {
  return sha256Digest(value);
}
