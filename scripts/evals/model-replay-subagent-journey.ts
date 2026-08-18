import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentConfig } from '@/core/config';
import { executeRuntimeTools } from '@/core/controllers/tool-controller';
import { createPipelineSubagentRuntimeV1 } from '@/core/execution/tool-pipeline/subagent-runtime';
import { createChatModel, type SupportedChatModel } from '@/core/model/factory';
import {
  ModelInvocationGatewayV1,
  type ModelInvocationPersistenceV1,
} from '@/core/model/invocation-gateway';
import { loadOrCreateModelArtifactIntegrityKeyV1 } from '@/core/model/model-artifact-key';
import { ModelArtifactStoreV1 } from '@/core/model/model-artifacts';
import {
  createModelReplayAttemptRecordV1,
  parseModelReplayCatalogV1,
  StrictModelReplayCatalogV1,
} from '@/core/model/replay-catalog';
import {
  createReplayModelResponseSourceV1,
  type ModelResponseSourceV1,
} from '@/core/model/response-source';
import {
  canonicalModelJsonV1,
  computeModelSurfaceDigestV1,
} from '@/core/model/surface-canonicalizer';
import {
  CapabilityArtifactStore,
  readBoundCapabilityArtifactV1,
} from '@/core/persistence/capability-artifacts';
import { SubagentContinuationArtifactStoreV1 } from '@/core/persistence/subagent-continuation-artifacts';
import { SubagentLifecycleArtifactStoreV1 } from '@/core/persistence/subagent-lifecycle-artifacts';
import {
  SubagentTaskArtifactStoreV1,
  SubagentTaskRequestArtifactStoreV1,
} from '@/core/persistence/subagent-task-artifacts';
import type { RuntimeEvent } from '@/core/runtime/events';
import { createDeterministicRuntimeIdSourceV1 } from '@/core/runtime/id-source';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { createInitialRuntimeState, type RuntimeState } from '@/core/runtime/state';
import { normalizeTerminalRuntimeEventV1 } from '@/core/runtime/terminal-outcome';
import { normalizeCurrentToolOutcomeEventV1 } from '@/core/runtime/tool-outcome-events';
import { ChildRuntimeDriverV1 } from '@/core/subagent/child-runtime-driver';
import { SubagentGrantAuthorityV1 } from '@/core/subagent/grant-authority';
import { LocalSubagentProviderV1 } from '@/core/subagent/local-provider';
import {
  MODEL_RESPONSE_RECORD_SCHEMA_V1,
  MODEL_SURFACE_SCHEMA_V1,
  type ModelAttemptOutcomeV1,
  type ModelReplayAttemptRecordV1,
  type ModelReplayCatalogV1,
  type ModelResponseRecordV1,
  type ModelSurfaceV1,
  type PrivateArtifactRefV1,
} from '@/protocol/model-surface';
import type {
  DurableSuspendedSubagentV1,
  PrivateSuspendedSubagentRecordV1,
} from '@/protocol/subagent';
import { canonicalJsonBytes, sha256Digest } from '../release/canonical-json';

/**
 * PS-03 qualification identity. This is an in-memory synthetic record/replay
 * contract; it is not an approved RP-03 cassette or a production replay suite.
 */
export const PS03_LOCAL_SUBAGENT_QUALIFICATION_SUITE_ID_V1 =
  'ps-03-local-subagent-start-blocked-resume-qualification-v1' as const;
export const PS03_LOCAL_SUBAGENT_QUALIFICATION_SUITE_REVISION_V1 = 1 as const;
export const PS03_LOCAL_SUBAGENT_QUALIFICATION_FIXTURE_DIGEST_V1 = sha256Digest(
  canonicalJsonBytes({
    schema: 'kite.ps-03-local-subagent-qualification-fixture.v1',
    workspace: '/qualification/workspace',
    task: 'Run the approved local continuation contract and report its bounded result.',
    role: 'code',
    blockedTool: 'shell_execute',
  }),
);

const QUALIFICATION_WORKSPACE = '/qualification/workspace';
const PARENT_INVOCATION_ID = 'ps03-parent-invocation';
const PARENT_TOOL_CALL_ID = 'ps03-parent-task';
const CHILD_TASK = 'Run the approved local continuation contract and report its bounded result.';
const SOURCE_WORKTREE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface Ps03ModelArtifactReadbackRefV1 {
  attemptOrdinal: number;
  invocationId: string;
  surface: PrivateArtifactRefV1 & { kind: 'model_surface' };
  response: PrivateArtifactRefV1 & { kind: 'model_response' };
}

interface Ps03PrivateArtifactStoresV1 {
  integrityKey: Uint8Array;
  taskArtifacts: SubagentTaskArtifactStoreV1;
  taskRequestArtifacts: SubagentTaskRequestArtifactStoreV1;
  lifecycleArtifacts: SubagentLifecycleArtifactStoreV1;
  continuationArtifacts: SubagentContinuationArtifactStoreV1;
  capabilityArtifacts: CapabilityArtifactStore;
  modelArtifacts: ModelArtifactStoreV1;
}

export interface Ps03LocalSubagentJourneyReportV1 {
  schema: 'Ps03LocalSubagentJourneyReportV1';
  mode: ModelResponseSourceV1['mode'];
  status: 'journey_passed' | 'fresh_replay_passed';
  lifecycle: {
    started: true;
    blocked: true;
    resumed: true;
    startStatus: 'blocked';
    resumeStatus: 'completed';
  };
  modelAttemptCount: 2;
  actorCursor: {
    startOrdinal: 1;
    resumeOrdinal: 2;
    continuationBound: true;
  };
  /** Actual calls into the wrapped live/record or strict replay Source. */
  providerSourceAttempts: number;
  keyless: boolean;
  liveFallback: false;
  artifactReadback: {
    modelSurfaces: number;
    modelResponses: number;
    capabilityReceipt: true;
    exactOwner: true;
    exactSchema: true;
    exactContent: true;
    refs: readonly Ps03ModelArtifactReadbackRefV1[];
  };
  allRecordsConsumed: boolean | null;
}

export interface Ps03LocalSubagentQualificationReportV1 {
  schema: 'Ps03LocalSubagentQualificationReportV1';
  status: 'qualification_passed';
  source: 'deterministic_synthetic_in_memory';
  providerTransport: 'not_invoked_by_closed_source';
  providerTransportAttempts: 0;
  credentialPresent: false;
  liveFallback: false;
  recordCount: 2;
  records: readonly ModelReplayAttemptRecordV1[];
  recorded: Ps03LocalSubagentJourneyReportV1;
  replayed: Ps03LocalSubagentJourneyReportV1;
}

export interface Ps03LocalSubagentJourneyInputV1 {
  config: AgentConfig;
  model?: import('@/core/model/factory').SupportedChatModel;
  source: ModelResponseSourceV1;
  suiteRevision?: number;
  /** Owner-only, worktree-external root for all private journey artifacts. */
  artifactRoot?: string;
}

export interface Ps03LocalSubagentQualificationCatalogInputV1 {
  records: readonly ModelReplayAttemptRecordV1[];
  suiteRevision?: number;
}

/** Build the in-memory strict catalog used by the PS-03 qualification journey. */
export function createPs03LocalSubagentQualificationCatalogV1(
  input: Ps03LocalSubagentQualificationCatalogInputV1,
): ModelReplayCatalogV1 {
  const suiteRevision = input.suiteRevision ?? PS03_LOCAL_SUBAGENT_QUALIFICATION_SUITE_REVISION_V1;
  if (!Number.isSafeInteger(suiteRevision) || suiteRevision < 1) {
    throw new Error('PS03_LOCAL_SUBAGENT_QUALIFICATION_REVISION_INVALID');
  }
  if (input.records.length !== 2) {
    throw new Error('PS03_LOCAL_SUBAGENT_QUALIFICATION_RECORD_COUNT_INVALID');
  }
  const catalog: ModelReplayCatalogV1 = {
    schema: {
      name: 'kite.model-replay-catalog',
      version: 1,
      canonicalizerVersion: 'kite.model-surface.canonical-json.v1',
    },
    catalogRevision: `ps-03-local-subagent-qualification-v${suiteRevision}`,
    suite: {
      suiteId: PS03_LOCAL_SUBAGENT_QUALIFICATION_SUITE_ID_V1,
      suiteRevision,
      fixtureDigest: PS03_LOCAL_SUBAGENT_QUALIFICATION_FIXTURE_DIGEST_V1,
    },
    records: input.records,
  };
  // Qualification input must satisfy the same strict parser before replay.
  parseModelReplayCatalogV1(canonicalJsonBytes(catalog));
  return catalog;
}

/**
 * Run the Local Provider start → blocked → resume contract through the real
 * Runtime Tool Pipeline. The qualification harness has no external shell effect,
 * but outer intent/attempt acknowledgement, continuation Artifact storage,
 * approval, Provider lifecycle and terminal receipt all use production paths.
 * This is qualification evidence only; it is not production replay authority.
 */
export async function runPs03LocalSubagentJourneyV1(
  input: Ps03LocalSubagentJourneyInputV1,
): Promise<Ps03LocalSubagentJourneyReportV1> {
  if (input.source.mode === 'record' && !input.model) {
    throw new Error('PS03_LOCAL_SUBAGENT_RECORD_MODEL_REQUIRED');
  }
  if (input.source.mode === 'replay' && input.config.apiKey !== '') {
    throw new Error('PS03_LOCAL_SUBAGENT_REPLAY_CREDENTIAL_FORBIDDEN');
  }
  const suiteRevision = input.suiteRevision ?? PS03_LOCAL_SUBAGENT_QUALIFICATION_SUITE_REVISION_V1;
  const ownRoot = input.artifactRoot == null;
  const artifactRootInput = input.artifactRoot ?? mkdtempSync(join(tmpdir(), 'kite-ps03-local-'));
  let artifactRoot = resolve(artifactRootInput);
  let state: RuntimeState;
  const persistedEvents: RuntimeEvent[] = [];
  let sourceAttemptCount = 0;
  const observedAttempts: Array<{
    attemptOrdinal: number;
    surface: ModelSurfaceV1;
    response: ModelResponseRecordV1['response'];
    nativeReplayState: ModelResponseRecordV1['nativeReplayState'];
    surfaceDigest: string;
  }> = [];
  try {
    artifactRoot = preparePs03PrivateArtifactRootV1(artifactRoot);
    const stores = createPs03PrivateArtifactStoresV1(artifactRoot);
    const {
      integrityKey,
      taskArtifacts,
      taskRequestArtifacts,
      lifecycleArtifacts,
      continuationArtifacts,
      capabilityArtifacts,
      modelArtifacts,
    } = stores;
    const grantIds = createCounter('ps03-grant');
    const handleIds = createCounter('ps03-handle');
    const grants = new SubagentGrantAuthorityV1({
      key: integrityKey,
      now: () => 1_700_000_000_000,
      ttlMs: 60_000,
      idSource: grantIds,
    });
    const idSource = createDeterministicRuntimeIdSourceV1({
      seed: 'ps03-local-subagent-journey',
      epochMs: Date.UTC(2020, 0, 1),
    });
    state = createInitialRuntimeState({
      threadId: 'ps03-local-subagent-thread',
      userId: 'ps03-local-subagent',
      workspace: QUALIFICATION_WORKSPACE,
      runtimeIdSource: idSource,
    });
    const taskRequest = taskRequestArtifacts.write({
      parentModelInvocationId: PARENT_INVOCATION_ID,
      parentToolCallId: PARENT_TOOL_CALL_ID,
      role: 'code',
      task: CHILD_TASK,
    });
    state = {
      ...reduceRuntimeState(state, {
        type: 'tool.queued',
        toolCallId: PARENT_TOOL_CALL_ID,
        modelInvocationId: PARENT_INVOCATION_ID,
        modelMessageId: 'ps03-parent-model-message',
        name: 'task',
        args: { subagent_type: 'code', taskArtifact: taskRequest },
        ordinal: 0,
        effectClass: 'workspace_write',
        sideEffect: true,
        classificationReason: 'PS-03 local continuation qualification contract.',
      }),
      revision: state.revision + 1,
    };
    const persistence: ModelInvocationPersistenceV1 = {
      getState: () => state,
      persistEvents: async (batch) => {
        applyRuntimeEvents(state, batch, persistedEvents, (next) => {
          state = next;
        });
        return true;
      },
    };
    const source: ModelResponseSourceV1 = Object.freeze({
      mode: input.source.mode,
      attempt: async (attemptInput: Parameters<ModelResponseSourceV1['attempt']>[0]) => {
        sourceAttemptCount += 1;
        if (input.source.mode === 'replay' && attemptInput.model) {
          throw new Error('PS03_LOCAL_SUBAGENT_REPLAY_MODEL_HANDLE_PRESENT');
        }
        const outcome = await input.source.attempt(attemptInput);
        if (outcome.kind === 'success') {
          observedAttempts.push({
            attemptOrdinal: attemptInput.attemptOrdinal,
            surface: attemptInput.surface,
            response: outcome.response,
            nativeReplayState: outcome.nativeReplayState,
            surfaceDigest: attemptInput.context.surfaceDigest,
          });
        }
        return outcome;
      },
      ...(input.source.failureError ? { failureError: input.source.failureError } : {}),
    });
    const gateway = new ModelInvocationGatewayV1({
      artifacts: modelArtifacts,
      source,
      runtimeIdSource: idSource,
      sleep: async () => {},
    });
    const runtimeFactory = createPipelineSubagentRuntimeV1(() => {
      const driver = new ChildRuntimeDriverV1({ now: () => 1_700_000_000_000 });
      const provider = new LocalSubagentProviderV1(
        grants.verifier(),
        driver,
        taskArtifacts,
        handleIds,
        3_000,
        { now: () => 1_700_000_000_000 },
      );
      return { grants, driver, provider, taskArtifacts, lifecycleArtifacts };
    });
    let continuationId: string | null = null;
    let childInvocationId: string | undefined;
    const replayBinding = (logicalInvocationOrdinal: number) => {
      childInvocationId =
        state.suspendedSubagents[PARENT_TOOL_CALL_ID]?.subagentId ??
        childInvocationId ??
        grants.issueChildInvocationId({
          parentModelInvocationId: PARENT_INVOCATION_ID,
          parentToolCallId: PARENT_TOOL_CALL_ID,
          parentAttempt: 1,
          role: 'code',
        });
      return {
        suiteId: PS03_LOCAL_SUBAGENT_QUALIFICATION_SUITE_ID_V1,
        suiteRevision,
        fixtureDigest: PS03_LOCAL_SUBAGENT_QUALIFICATION_FIXTURE_DIGEST_V1,
        actor: {
          kind: 'subagent' as const,
          parentToolCallId: PARENT_TOOL_CALL_ID,
          subagentId: childInvocationId,
          continuationId,
        },
        logicalInvocationOrdinal,
        replayDigest: null,
      };
    };
    const persistRuntimeEvents = async (batch: RuntimeEvent[]) => {
      applyRuntimeEvents(state, batch, persistedEvents, (next) => {
        state = next;
      });
      return true;
    };
    const execute = () =>
      executeRuntimeTools({
        state,
        toolCallIds: [PARENT_TOOL_CALL_ID],
        taskConfig: input.config,
        ...(input.model ? { taskModel: input.model } : {}),
        modelInvocationGateway: gateway,
        modelInvocationPersistence: persistence,
        subagentRuntimeFactory: () => runtimeFactory,
        subagentContinuationArtifacts: continuationArtifacts,
        subagentTaskRequests: taskRequestArtifacts,
        capabilityArtifactStore: capabilityArtifacts,
        modelReplayBinding: replayBinding,
        persistRuntimeEvents,
        getRuntimeState: () => state,
        subagentEventSink: () => {},
      });
    const firstEvents = await execute();
    applyRuntimeEvents(state, firstEvents, persistedEvents, (next) => {
      state = next;
    });
    const approval = firstEvents.find(
      (event): event is Extract<RuntimeEvent, { type: 'approval.requested' }> =>
        event.type === 'approval.requested',
    );
    const suspended = state.suspendedSubagents[PARENT_TOOL_CALL_ID];
    const suspensionEvent = firstEvents.find(
      (event): event is Extract<RuntimeEvent, { type: 'subagent.suspended' }> =>
        event.type === 'subagent.suspended',
    );
    const privateSuspension = suspensionEvent?.snapshot;
    if (
      !approval ||
      !suspended ||
      !suspensionEvent ||
      !isPrivateSuspension(privateSuspension) ||
      state.tools.calls[PARENT_TOOL_CALL_ID]?.status !== 'awaiting_approval'
    ) {
      throw new Error('PS03_LOCAL_SUBAGENT_START_NOT_BLOCKED');
    }
    childInvocationId = privateSuspension.subagentId;
    continuationId = privateSuspension.continuationId;
    if (
      !(await persistence.persistEvents([
        {
          type: 'approval.granted',
          interactionId: approval.interactionId,
          toolCallId: PARENT_TOOL_CALL_ID,
          grant: 'approve_once',
        },
      ]))
    ) {
      throw new Error('PS03_LOCAL_SUBAGENT_APPROVAL_ACK_INVALID');
    }
    const secondEvents = await execute();
    applyRuntimeEvents(state, secondEvents, persistedEvents, (next) => {
      state = next;
    });
    const modelAttemptCount = persistedEvents.filter(
      (event) => event.type === 'model.invocation_attempt_started',
    ).length;
    const resumedCall = state.tools.calls[PARENT_TOOL_CALL_ID];
    if (
      modelAttemptCount !== 2 ||
      state.suspendedSubagents[PARENT_TOOL_CALL_ID] ||
      resumedCall?.status !== 'succeeded'
    ) {
      throw new Error('PS03_LOCAL_SUBAGENT_RESUME_NOT_COMPLETED');
    }
    if (sourceAttemptCount !== modelAttemptCount) {
      throw new Error('PS03_LOCAL_SUBAGENT_SOURCE_ATTEMPT_COUNT_INVALID');
    }
    const modelInvocationRecords = Object.values(state.modelInvocations);
    if (modelInvocationRecords.length !== 2 || observedAttempts.length !== modelAttemptCount) {
      throw new Error('PS03_LOCAL_SUBAGENT_MODEL_INVOCATION_RECORD_COUNT_INVALID');
    }
    const modelArtifactRefs: Ps03ModelArtifactReadbackRefV1[] = [];
    for (const [index, invocation] of modelInvocationRecords.entries()) {
      if (invocation.status !== 'completed' || !invocation.responseArtifact) {
        throw new Error('PS03_LOCAL_SUBAGENT_MODEL_ARTIFACT_RECEIPT_INVALID');
      }
      const observed = observedAttempts[index];
      if (!observed) throw new Error('PS03_LOCAL_SUBAGENT_MODEL_ARTIFACT_ATTEMPT_MISSING');
      const surface = modelArtifacts.readSurface(invocation.surfaceArtifact);
      const response = modelArtifacts.readResponse(invocation.responseArtifact);
      if (
        canonicalModelJsonV1(surface.schema) !== canonicalModelJsonV1(MODEL_SURFACE_SCHEMA_V1) ||
        canonicalModelJsonV1(response.schema) !==
          canonicalModelJsonV1(MODEL_RESPONSE_RECORD_SCHEMA_V1) ||
        canonicalModelJsonV1(surface) !== canonicalModelJsonV1(observed.surface) ||
        computeModelSurfaceDigestV1(surface) !== observed.surfaceDigest ||
        response.invocationId !== invocation.invocationId ||
        response.surfaceIntegrityIdentifier !== invocation.surfaceIntegrityIdentifier ||
        response.surfaceIntegrityIdentifier !== invocation.surfaceArtifact.integrityIdentifier ||
        response.route.routeFingerprint !== invocation.routeFingerprint ||
        canonicalModelJsonV1(response.route) !== canonicalModelJsonV1(surface.route) ||
        canonicalModelJsonV1(response.route.replayOwner) !==
          canonicalModelJsonV1(observed.surface.route.replayOwner) ||
        canonicalModelJsonV1(response.response) !== canonicalModelJsonV1(observed.response) ||
        canonicalModelJsonV1(response.nativeReplayState) !==
          canonicalModelJsonV1(observed.nativeReplayState)
      ) {
        throw new Error('PS03_LOCAL_SUBAGENT_MODEL_ARTIFACT_READBACK_INVALID');
      }
      modelArtifactRefs.push({
        attemptOrdinal: observed.attemptOrdinal,
        invocationId: invocation.invocationId,
        surface: invocation.surfaceArtifact,
        response: invocation.responseArtifact,
      });
    }
    const outerInvocation = Object.values(state.capabilities.invocations).find(
      (invocation) => invocation.toolCallId === PARENT_TOOL_CALL_ID,
    );
    if (!outerInvocation) {
      throw new Error('PS03_LOCAL_SUBAGENT_CAPABILITY_RECEIPT_INVALID');
    }
    if (
      outerInvocation.status !== 'succeeded' ||
      !outerInvocation.artifact ||
      !outerInvocation.resultDigest ||
      !outerInvocation.evidenceDigest
    ) {
      throw new Error('PS03_LOCAL_SUBAGENT_CAPABILITY_RECEIPT_INVALID');
    }
    const capabilityResult = readBoundCapabilityArtifactV1(
      capabilityArtifacts,
      outerInvocation.artifact,
      {
        invocationId: outerInvocation.invocationId,
        resultDigest: outerInvocation.resultDigest,
        evidenceDigest: outerInvocation.evidenceDigest,
        ...(outerInvocation.filesystemObservation
          ? { filesystemObservation: outerInvocation.filesystemObservation }
          : {}),
      },
    );
    const outerResultRecorded = persistedEvents.some(
      (event) =>
        event.type === 'capability.execution_result_recorded' &&
        event.invocationId === outerInvocation.invocationId,
    );
    const outerSucceeded = persistedEvents.some(
      (event) =>
        event.type === 'capability.execution_succeeded' &&
        event.invocationId === outerInvocation.invocationId,
    );
    if (capabilityResult.status !== 'success' || !outerResultRecorded || !outerSucceeded) {
      throw new Error('PS03_LOCAL_SUBAGENT_CAPABILITY_RECEIPT_READBACK_INVALID');
    }
    if (input.source.mode === 'replay' && input.model) {
      throw new Error('PS03_LOCAL_SUBAGENT_REPLAY_MODEL_HANDLE_PRESENT');
    }
    return {
      schema: 'Ps03LocalSubagentJourneyReportV1' as const,
      mode: input.source.mode,
      status:
        input.source.mode === 'replay'
          ? ('fresh_replay_passed' as const)
          : ('journey_passed' as const),
      lifecycle: {
        started: true as const,
        blocked: true as const,
        resumed: true as const,
        startStatus: 'blocked' as const,
        resumeStatus: 'completed' as const,
      },
      modelAttemptCount: modelAttemptCount as 2,
      actorCursor: {
        startOrdinal: 1 as const,
        resumeOrdinal: 2 as const,
        continuationBound: true as const,
      },
      providerSourceAttempts: sourceAttemptCount,
      keyless: input.source.mode === 'replay',
      liveFallback: false as const,
      artifactReadback: {
        modelSurfaces: modelArtifactRefs.length,
        modelResponses: modelArtifactRefs.length,
        capabilityReceipt: true as const,
        exactOwner: true as const,
        exactSchema: true as const,
        exactContent: true as const,
        refs: modelArtifactRefs,
      },
      allRecordsConsumed: null,
    };
  } finally {
    if (ownRoot) rmSync(artifactRoot, { recursive: true, force: true });
  }
}

/**
 * Closed PS-03 qualification: a deterministic in-memory Source creates exactly
 * two ModelAttemptOutcomeV1 records, then a fresh strict catalog consumes them.
 * The synthetic Source owns no transport callback and cannot reach a Provider.
 */
export async function runPs03LocalSubagentReplayQualificationV1(input: {
  config: AgentConfig;
  recordArtifactRoot?: string;
  replayArtifactRoot?: string;
}): Promise<Ps03LocalSubagentQualificationReportV1> {
  if (input.config.apiKey !== '') {
    throw new Error('PS03_LOCAL_SUBAGENT_QUALIFICATION_CREDENTIAL_FORBIDDEN');
  }
  const records: ModelReplayAttemptRecordV1[] = [];
  const transportObserver = createPs03ObservedQualificationModelV1(input.config);
  const syntheticSource: ModelResponseSourceV1 = Object.freeze({
    mode: 'record' as const,
    attempt: async (attemptInput: Parameters<ModelResponseSourceV1['attempt']>[0]) => {
      if (!attemptInput.context.replayBinding || !attemptInput.model) {
        throw new Error('PS03_LOCAL_SUBAGENT_QUALIFICATION_BINDING_INVALID');
      }
      const firstAttempt =
        attemptInput.context.replayBinding.logicalInvocationOrdinal === 1 &&
        attemptInput.context.replayBinding.actor.kind === 'subagent' &&
        attemptInput.context.replayBinding.actor.continuationId === null;
      const outcome = createPs03DeterministicSyntheticOutcomeV1(firstAttempt);
      records.push(
        createModelReplayAttemptRecordV1({
          context: attemptInput.context,
          attemptOrdinal: attemptInput.attemptOrdinal,
          outcome,
        }),
      );
      return outcome;
    },
  });
  const recorded = await runPs03LocalSubagentJourneyV1({
    config: input.config,
    model: transportObserver.model,
    source: syntheticSource,
    suiteRevision: PS03_LOCAL_SUBAGENT_QUALIFICATION_SUITE_REVISION_V1,
    ...(input.recordArtifactRoot ? { artifactRoot: input.recordArtifactRoot } : {}),
  });
  if (
    recorded.status !== 'journey_passed' ||
    recorded.modelAttemptCount !== 2 ||
    recorded.providerSourceAttempts !== 2 ||
    records.length !== 2 ||
    transportObserver.attempts() !== 0
  ) {
    throw new Error('PS03_LOCAL_SUBAGENT_QUALIFICATION_RECORD_INVALID');
  }
  const catalog = createPs03LocalSubagentQualificationCatalogV1({ records });
  const replayed = await runFreshPs03LocalSubagentReplayV1({
    config: input.config,
    catalog,
    ...(input.replayArtifactRoot ? { artifactRoot: input.replayArtifactRoot } : {}),
  });
  if (
    replayed.status !== 'fresh_replay_passed' ||
    replayed.providerSourceAttempts !== 2 ||
    replayed.allRecordsConsumed !== true
  ) {
    throw new Error('PS03_LOCAL_SUBAGENT_QUALIFICATION_REPLAY_INVALID');
  }
  return {
    schema: 'Ps03LocalSubagentQualificationReportV1',
    status: 'qualification_passed',
    source: 'deterministic_synthetic_in_memory',
    providerTransport: 'not_invoked_by_closed_source',
    providerTransportAttempts: 0,
    credentialPresent: false,
    liveFallback: false,
    recordCount: 2,
    records,
    recorded,
    replayed,
  };
}

function createPs03ObservedQualificationModelV1(config: AgentConfig): {
  model: SupportedChatModel;
  attempts: () => number;
} {
  const base = createChatModel(config);
  if (typeof base.model !== 'object' || base.model === null) {
    throw new Error('PS03_LOCAL_SUBAGENT_QUALIFICATION_MODEL_INVALID');
  }
  let attempts = 0;
  const observedLanguageModel = new Proxy(base.model, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if ((property === 'doGenerate' || property === 'doStream') && typeof value === 'function') {
        return (...args: unknown[]) => {
          attempts += 1;
          return Reflect.apply(value, target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as typeof base.model;
  return {
    model: { ...base, model: observedLanguageModel },
    attempts: () => attempts,
  };
}

/** Fresh, keyless replay entry point for one in-memory qualification catalog. */
export async function runFreshPs03LocalSubagentReplayV1(input: {
  catalog: ModelReplayCatalogV1 | string | Uint8Array;
  config: AgentConfig;
  artifactRoot?: string;
}): Promise<Ps03LocalSubagentJourneyReportV1> {
  if (input.config.apiKey !== '')
    throw new Error('PS03_LOCAL_SUBAGENT_REPLAY_CREDENTIAL_FORBIDDEN');
  const parsed = parseModelReplayCatalogV1(
    typeof input.catalog === 'string' || input.catalog instanceof Uint8Array
      ? input.catalog
      : canonicalJsonBytes(input.catalog),
  );
  const strict = new StrictModelReplayCatalogV1(parsed);
  const source = createReplayModelResponseSourceV1(strict);
  const report = await runPs03LocalSubagentJourneyV1({
    config: input.config,
    source,
    suiteRevision: parsed.suite.suiteRevision,
    ...(input.artifactRoot ? { artifactRoot: input.artifactRoot } : {}),
  });
  strict.assertConsumed();
  return { ...report, allRecordsConsumed: true };
}

function createPs03DeterministicSyntheticOutcomeV1(firstAttempt: boolean): ModelAttemptOutcomeV1 {
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
        content: firstAttempt
          ? [
              {
                type: 'tool_call',
                toolCallId: 'cassette-tool-call-ps03-qualification-1',
                toolName: 'shell_execute',
                input: { command: 'bun run typecheck' },
              },
            ]
          : [{ type: 'text', text: 'Approved local continuation completed.' }],
      },
      finishReason: firstAttempt ? 'tool_calls' : 'stop',
      usage: {
        inputTokens: 8,
        outputTokens: 4,
        totalTokens: 12,
        cacheReadTokens: 0,
      },
      providerMetadata: {
        responseId: `cassette-response-ps03-qualification-${firstAttempt ? 1 : 2}`,
        rawFinishReason: null,
      },
    },
  };
}

/**
 * Create the real Model Artifact writer used by record staging. The root is
 * deliberately caller-owned so record output can never be placed in a
 * checkout, and the key is persisted next to that private evidence root.
 */
export function createPs03ModelArtifactStoreV1(artifactRoot: string): ModelArtifactStoreV1 {
  const root = preparePs03PrivateArtifactRootV1(artifactRoot);
  const modelRoot = join(root, 'model-artifacts');
  mkdirSync(modelRoot, { recursive: true, mode: 0o700 });
  const integrityKey = loadOrCreateModelArtifactIntegrityKeyV1({
    keyPath: join(root, 'model-artifacts.key'),
    artifactRoot: modelRoot,
    additionalArtifactRoots: [
      join(root, 'subagent-tasks'),
      join(root, 'subagent-lifecycles'),
      join(root, 'subagent-continuations'),
      join(root, 'capability-artifacts'),
    ],
  });
  return new ModelArtifactStoreV1({ root: modelRoot, integrityKey });
}

function preparePs03PrivateArtifactRootV1(input: string): string {
  const requested = resolve(input);
  const worktreeRoot = resolvePs03GitWorktreeRootV1(SOURCE_WORKTREE_ROOT);
  if (isWithin(worktreeRoot, requested)) {
    throw new Error('PS03_LOCAL_SUBAGENT_ARTIFACT_ROOT_WORKTREE_INVALID');
  }
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const stats = lstatSync(requested);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('PS03_LOCAL_SUBAGENT_ARTIFACT_ROOT_INVALID');
  }
  const canonical = realpathSync.native(requested);
  const canonicalExpected = join(realpathSync.native(dirname(requested)), basename(requested));
  if (canonical !== canonicalExpected) {
    throw new Error('PS03_LOCAL_SUBAGENT_ARTIFACT_ROOT_WORKTREE_INVALID');
  }
  if (isWithin(worktreeRoot, canonical)) {
    throw new Error('PS03_LOCAL_SUBAGENT_ARTIFACT_ROOT_WORKTREE_INVALID');
  }
  if (
    process.platform !== 'win32' &&
    typeof process.getuid === 'function' &&
    stats.uid !== process.getuid()
  ) {
    throw new Error('PS03_LOCAL_SUBAGENT_ARTIFACT_ROOT_OWNER_INVALID');
  }
  if (process.platform !== 'win32' && (stats.mode & 0o777) !== 0o700) {
    throw new Error('PS03_LOCAL_SUBAGENT_ARTIFACT_ROOT_PERMISSIONS_INVALID');
  }
  return canonical;
}

/** Resolve a real Git worktree root without changing process.cwd or spawning a child. */
export function resolvePs03GitWorktreeRootV1(startDirectory: string): string {
  let candidate = realpathSync.native(resolve(startDirectory));
  let previous: string | undefined;
  while (candidate !== previous) {
    const marker = join(candidate, '.git');
    try {
      const stats = lstatSync(marker);
      if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
        throw new Error('PS03_LOCAL_SUBAGENT_WORKTREE_ROOT_INVALID');
      }
      return candidate;
    } catch (error) {
      if (isMissingPathError(error)) {
        previous = candidate;
        candidate = dirname(candidate);
        continue;
      }
      throw new Error('PS03_LOCAL_SUBAGENT_WORKTREE_ROOT_INVALID');
    }
  }
  throw new Error('PS03_LOCAL_SUBAGENT_WORKTREE_ROOT_INVALID');
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function isWithin(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

function createPs03PrivateArtifactStoresV1(artifactRoot: string): Ps03PrivateArtifactStoresV1 {
  const taskRoot = join(artifactRoot, 'subagent-tasks');
  const lifecycleRoot = join(artifactRoot, 'subagent-lifecycles');
  const continuationRoot = join(artifactRoot, 'subagent-continuations');
  const capabilityRoot = join(artifactRoot, 'capability-artifacts');
  const modelRoot = join(artifactRoot, 'model-artifacts');
  for (const root of [taskRoot, lifecycleRoot, continuationRoot, capabilityRoot, modelRoot]) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  const integrityKey = loadOrCreateModelArtifactIntegrityKeyV1({
    keyPath: join(artifactRoot, 'model-artifacts.key'),
    artifactRoot: modelRoot,
    additionalArtifactRoots: [taskRoot, lifecycleRoot, continuationRoot, capabilityRoot],
  });
  return {
    integrityKey,
    taskArtifacts: new SubagentTaskArtifactStoreV1({
      root: taskRoot,
      integrityKey,
    }),
    taskRequestArtifacts: new SubagentTaskRequestArtifactStoreV1({
      root: taskRoot,
      integrityKey,
    }),
    lifecycleArtifacts: new SubagentLifecycleArtifactStoreV1({
      root: lifecycleRoot,
      integrityKey,
    }),
    continuationArtifacts: new SubagentContinuationArtifactStoreV1({
      root: continuationRoot,
      integrityKey,
    }),
    capabilityArtifacts: new CapabilityArtifactStore({
      root: capabilityRoot,
      integrityKey,
    }),
    modelArtifacts: new ModelArtifactStoreV1({ root: modelRoot, integrityKey }),
  };
}

function applyRuntimeEvents(
  current: Readonly<RuntimeState>,
  batch: readonly RuntimeEvent[],
  retained: RuntimeEvent[],
  setState: (next: RuntimeState) => void,
): void {
  let next = current;
  for (const event of batch) {
    if (retained.includes(event)) {
      throw new Error(`PS03_LOCAL_SUBAGENT_DUPLICATE_RUNTIME_EVENT:${event.type}`);
    }
    const normalized = normalizeCurrentToolOutcomeEventV1(
      normalizeTerminalRuntimeEventV1(event),
      next,
      '2020-01-01T00:00:00.000Z',
    );
    next = {
      ...reduceRuntimeState(next, normalized),
      revision: next.revision + 1,
    };
    retained.push(normalized);
  }
  setState(next);
}

function isPrivateSuspension(
  value: DurableSuspendedSubagentV1 | undefined,
): value is PrivateSuspendedSubagentRecordV1 {
  return (
    value != null &&
    typeof value === 'object' &&
    'storage' in value &&
    value.storage === 'private_artifact_v1' &&
    'continuationId' in value &&
    typeof value.continuationId === 'string'
  );
}

function createCounter(prefix: string): () => string {
  let ordinal = 0;
  return () => `${prefix}-${++ordinal}`;
}
