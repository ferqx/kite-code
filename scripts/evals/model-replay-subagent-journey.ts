import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '@/core/config';
import { executeRuntimeTools } from '@/core/controllers/tool-controller';
import { createPipelineSubagentRuntimeV1 } from '@/core/execution/tool-pipeline/subagent-runtime';
import {
  ModelInvocationGatewayV1,
  type ModelInvocationPersistenceV1,
} from '@/core/model/invocation-gateway';
import { ModelArtifactStoreV1 } from '@/core/model/model-artifacts';
import { parseModelReplayCatalogV1, StrictModelReplayCatalogV1 } from '@/core/model/replay-catalog';
import {
  createReplayModelResponseSourceV1,
  type ModelResponseSourceV1,
} from '@/core/model/response-source';
import {
  CapabilityArtifactStore,
  capabilityResultDigestV1,
  capabilityResultEvidenceDigestV1,
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
import type { ModelReplayAttemptRecordV1, ModelReplayCatalogV1 } from '@/protocol/model-surface';
import type {
  DurableSuspendedSubagentV1,
  PrivateSuspendedSubagentRecordV1,
} from '@/protocol/subagent';
import { canonicalJsonBytes, sha256Digest } from '../release/canonical-json';

/**
 * Candidate-only PS-03 journey identity. The implementation is qualification-
 * bound because the trusted record runner depends on it, but this suite is not
 * admitted by the approved RP-03 manifest or any committed cassette.
 */
export const PS03_LOCAL_SUBAGENT_CANDIDATE_SUITE_ID_V1 =
  'ps-03-local-subagent-start-blocked-resume-candidate-v1' as const;
export const PS03_LOCAL_SUBAGENT_CANDIDATE_SUITE_REVISION_V1 = 1 as const;
export const PS03_LOCAL_SUBAGENT_CANDIDATE_FIXTURE_DIGEST_V1 = sha256Digest(
  canonicalJsonBytes({
    schema: 'kite.ps-03-local-subagent-candidate-fixture.v1',
    workspace: '/candidate/workspace',
    task: 'Run the approved local continuation contract and report its bounded result.',
    role: 'code',
    blockedTool: 'shell_execute',
  }),
);

const CANDIDATE_WORKSPACE = '/candidate/workspace';
const PARENT_INVOCATION_ID = 'ps03-parent-invocation';
const PARENT_TOOL_CALL_ID = 'ps03-parent-task';
const CHILD_TASK = 'Run the approved local continuation contract and report its bounded result.';
const INTEGRITY_KEY = new Uint8Array(32).fill(23);

export interface Ps03LocalSubagentJourneyReportV1 {
  schema: 'Ps03LocalSubagentJourneyReportV1';
  mode: ModelResponseSourceV1['mode'];
  status: 'candidate_preflight_passed' | 'fresh_replay_passed';
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
  providerTransportAttempts: number;
  keyless: boolean;
  liveFallback: false;
  artifactReadback: {
    modelSurfaces: 2;
    modelResponses: 2;
    capabilityReceipt: true;
  };
  allRecordsConsumed: boolean | null;
}

export interface Ps03LocalSubagentJourneyInputV1 {
  config: AgentConfig;
  model?: import('@/core/model/factory').SupportedChatModel;
  source: ModelResponseSourceV1;
  suiteRevision?: number;
  /** Private temporary root for task/handle artifacts; never candidate staging. */
  artifactRoot?: string;
}

export interface Ps03LocalSubagentCandidateCatalogInputV1 {
  records: readonly ModelReplayAttemptRecordV1[];
  suiteRevision?: number;
}

/** Build an unapproved, candidate-only catalog from a completed record journey. */
export function createPs03LocalSubagentCandidateCatalogV1(
  input: Ps03LocalSubagentCandidateCatalogInputV1,
): ModelReplayCatalogV1 {
  const suiteRevision = input.suiteRevision ?? PS03_LOCAL_SUBAGENT_CANDIDATE_SUITE_REVISION_V1;
  if (!Number.isSafeInteger(suiteRevision) || suiteRevision < 1) {
    throw new Error('PS03_LOCAL_SUBAGENT_CANDIDATE_REVISION_INVALID');
  }
  if (input.records.length !== 2) {
    throw new Error('PS03_LOCAL_SUBAGENT_CANDIDATE_RECORD_COUNT_INVALID');
  }
  const catalog: ModelReplayCatalogV1 = {
    schema: {
      name: 'kite.model-replay-catalog',
      version: 1,
      canonicalizerVersion: 'kite.model-surface.canonical-json.v1',
    },
    catalogRevision: `ps-03-local-subagent-candidate-v${suiteRevision}`,
    suite: {
      suiteId: PS03_LOCAL_SUBAGENT_CANDIDATE_SUITE_ID_V1,
      suiteRevision,
      fixtureDigest: PS03_LOCAL_SUBAGENT_CANDIDATE_FIXTURE_DIGEST_V1,
    },
    records: input.records,
  };
  // A candidate must satisfy the same strict parser before it can be staged.
  parseModelReplayCatalogV1(canonicalJsonBytes(catalog));
  return catalog;
}

/**
 * Run the Local Provider start → blocked → resume contract through the real
 * Runtime Tool Pipeline. The candidate harness has no external shell effect,
 * but outer intent/attempt acknowledgement, continuation Artifact storage,
 * approval, Provider lifecycle and terminal receipt all use production paths.
 * This remains candidate/preflight evidence only.
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
  const suiteRevision = input.suiteRevision ?? PS03_LOCAL_SUBAGENT_CANDIDATE_SUITE_REVISION_V1;
  const ownRoot = input.artifactRoot == null;
  const artifactRoot = input.artifactRoot ?? mkdtempSync(join(tmpdir(), 'kite-ps03-local-'));
  const taskRoot = join(artifactRoot, 'subagent-tasks');
  const lifecycleRoot = join(artifactRoot, 'subagent-lifecycles');
  const continuationRoot = join(artifactRoot, 'subagent-continuations');
  const capabilityRoot = join(artifactRoot, 'capability-artifacts');
  const modelRoot = join(artifactRoot, 'model-artifacts');
  let state: RuntimeState;
  const persistedEvents: RuntimeEvent[] = [];
  let sourceAttemptCount = 0;
  let providerTransportAttemptCount = 0;
  try {
    mkdirSync(taskRoot, { recursive: true, mode: 0o700 });
    mkdirSync(lifecycleRoot, { recursive: true, mode: 0o700 });
    mkdirSync(continuationRoot, { recursive: true, mode: 0o700 });
    mkdirSync(capabilityRoot, { recursive: true, mode: 0o700 });
    mkdirSync(modelRoot, { recursive: true, mode: 0o700 });
    const taskArtifacts = new SubagentTaskArtifactStoreV1({
      root: taskRoot,
      integrityKey: INTEGRITY_KEY,
    });
    const taskRequestArtifacts = new SubagentTaskRequestArtifactStoreV1({
      root: taskRoot,
      integrityKey: INTEGRITY_KEY,
    });
    const lifecycleArtifacts = new SubagentLifecycleArtifactStoreV1({
      root: lifecycleRoot,
      integrityKey: INTEGRITY_KEY,
    });
    const continuationArtifacts = new SubagentContinuationArtifactStoreV1({
      root: continuationRoot,
      integrityKey: INTEGRITY_KEY,
    });
    const capabilityArtifacts = new CapabilityArtifactStore({
      root: capabilityRoot,
      integrityKey: INTEGRITY_KEY,
    });
    const modelArtifacts = new ModelArtifactStoreV1({
      root: modelRoot,
      integrityKey: INTEGRITY_KEY,
    });
    const grantIds = createCounter('ps03-grant');
    const handleIds = createCounter('ps03-handle');
    const grants = new SubagentGrantAuthorityV1({
      key: INTEGRITY_KEY,
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
      workspace: CANDIDATE_WORKSPACE,
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
        classificationReason: 'PS-03 candidate local continuation contract.',
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
        if (attemptInput.model) providerTransportAttemptCount += 1;
        if (input.source.mode === 'replay' && attemptInput.model) {
          throw new Error('PS03_LOCAL_SUBAGENT_REPLAY_MODEL_HANDLE_PRESENT');
        }
        return input.source.attempt(attemptInput);
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
      const parentInvocation = Object.values(state.capabilities.invocations).find(
        (invocation) => invocation.toolCallId === PARENT_TOOL_CALL_ID,
      );
      const parentInvocationId = parentInvocation?.invocationId ?? PARENT_INVOCATION_ID;
      const parentAttempt = parentInvocation?.attemptsStarted ?? 1;
      childInvocationId =
        state.suspendedSubagents[PARENT_TOOL_CALL_ID]?.subagentId ??
        childInvocationId ??
        grants.issueChildInvocationId({
          parentInvocationId,
          parentToolCallId: PARENT_TOOL_CALL_ID,
          parentAttempt,
          role: 'code',
        });
      return {
        suiteId: PS03_LOCAL_SUBAGENT_CANDIDATE_SUITE_ID_V1,
        suiteRevision,
        fixtureDigest: PS03_LOCAL_SUBAGENT_CANDIDATE_FIXTURE_DIGEST_V1,
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
    if (modelInvocationRecords.length !== 2) {
      throw new Error('PS03_LOCAL_SUBAGENT_MODEL_INVOCATION_RECORD_COUNT_INVALID');
    }
    for (const invocation of modelInvocationRecords) {
      if (invocation.status !== 'completed' || !invocation.responseArtifact) {
        throw new Error('PS03_LOCAL_SUBAGENT_MODEL_ARTIFACT_RECEIPT_INVALID');
      }
      const surface = modelArtifacts.readSurface(invocation.surfaceArtifact);
      const response = modelArtifacts.readResponse(invocation.responseArtifact);
      if (
        response.invocationId !== invocation.invocationId ||
        response.surfaceIntegrityIdentifier !== invocation.surfaceIntegrityIdentifier ||
        surface.route.routeFingerprint !== invocation.routeFingerprint
      ) {
        throw new Error('PS03_LOCAL_SUBAGENT_MODEL_ARTIFACT_READBACK_INVALID');
      }
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
    const capabilityResult = capabilityArtifacts.read(outerInvocation.artifact);
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
    if (
      capabilityResultDigestV1(capabilityResult) !== outerInvocation.resultDigest ||
      capabilityResultEvidenceDigestV1(capabilityResult) !== outerInvocation.evidenceDigest ||
      !outerResultRecorded ||
      !outerSucceeded
    ) {
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
          : ('candidate_preflight_passed' as const),
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
      providerTransportAttempts: providerTransportAttemptCount,
      keyless: input.source.mode === 'replay',
      liveFallback: false as const,
      artifactReadback: {
        modelSurfaces: 2 as const,
        modelResponses: 2 as const,
        capabilityReceipt: true as const,
      },
      allRecordsConsumed: null,
    };
  } finally {
    if (ownRoot) rmSync(artifactRoot, { recursive: true, force: true });
  }
}

/** Fresh, keyless replay entry point for one candidate catalog. */
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

function applyRuntimeEvents(
  current: Readonly<RuntimeState>,
  batch: readonly RuntimeEvent[],
  retained: RuntimeEvent[],
  setState: (next: RuntimeState) => void,
): void {
  let next = current;
  for (const event of batch) {
    const normalized = normalizeCurrentToolOutcomeEventV1(
      normalizeTerminalRuntimeEventV1(event),
      next,
      '2020-01-01T00:00:00.000Z',
    );
    next = { ...reduceRuntimeState(next, normalized), revision: next.revision + 1 };
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
