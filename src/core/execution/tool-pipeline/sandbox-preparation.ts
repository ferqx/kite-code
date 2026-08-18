import { digestCapability } from '@/core/capabilities/catalog';
import {
  sandboxAbandonmentLifecycleIntentDigestV1,
  sandboxDisposalLifecycleIntentDigestV1,
  sandboxPreparationIntentDigestV1,
  sandboxPreparationReadyDigestV1,
} from '@/core/capabilities/sandbox-preparation-evidence';
import type { SandboxPreparationArtifactStoreV1 } from '@/core/persistence/sandbox-preparation-artifacts';
import type { RuntimeEvent } from '@/core/runtime/events';
import type { RuntimeState } from '@/core/runtime/state';
import type {
  PreparedSandboxExecutionV1,
  SandboxPreparationArtifactRefV1,
  SandboxPreparationV1,
} from '@/protocol/sandbox-execution-provider';
import type { SandboxPreparationLifecycleV1 } from '../sandbox-execution';
import { sandboxPreparationDigestV1, sandboxPreparedPlanDigestV1 } from '../sandbox-execution';
import type { RecordedInvocationV1 } from './types';

export interface SandboxPreparationPersistenceV1 {
  getState(): Readonly<RuntimeState>;
  persistEvents(events: RuntimeEvent[]): Promise<boolean>;
}

/** Pipeline-owned allocating preparation lifecycle. Provider receives no Store/Event authority. */
export function createSandboxPreparationLifecycleV1(input: {
  readonly recorded: Readonly<RecordedInvocationV1>;
  readonly persistence: SandboxPreparationPersistenceV1;
  readonly artifacts: SandboxPreparationArtifactStoreV1 | undefined;
  readonly now?: () => Date;
}): SandboxPreparationLifecycleV1 {
  let intentDigest: string | undefined;
  let acknowledgedReadyDigest: string | undefined;
  let acknowledgedDispatch:
    | { readonly dispatchId: string; readonly dispatchIntentDigest: string }
    | undefined;
  return Object.freeze({
    recordPreparationIntent: async (preparation: Readonly<SandboxPreparationV1>) => {
      if (intentDigest) throw new Error('Sandbox preparation intent was already recorded.');
      assertPreparationMatchesRecorded(preparation, input.recorded);
      const now = input.now?.() ?? new Date();
      const body = {
        attempt: input.recorded.attempt,
        toolCallId: preparation.toolCallId,
        capabilityId: preparation.capabilityId,
        capabilityRevision: preparation.capabilityRevision,
        canonicalWorkspace: preparation.canonicalWorkspace,
        effectiveEffectsDigest: preparation.effectiveEffectsDigest,
        admissionDigest: preparation.admissionDigest,
        preparationDigest: sandboxPreparationDigestV1(preparation),
        commandDigest: preparation.commandDigest,
        executionBoundaryDigest: preparation.executionBoundaryDigest,
        resourceSemantics: 'allocating' as const,
      };
      const nextIntentDigest = sandboxPreparationIntentDigestV1(body);
      const event: RuntimeEvent = {
        type: 'capability.sandbox_preparation_intent_recorded',
        invocationId: input.recorded.invocationId,
        ...body,
        intentDigest: nextIntentDigest,
        recordedAt: now.toISOString(),
      };
      if (!(await input.persistence.persistEvents([event]))) {
        throw new Error('Sandbox preparation intent acknowledgement failed.');
      }
      const acknowledged =
        input.persistence.getState().capabilities.invocations[input.recorded.invocationId]
          ?.sandboxPreparationIntent;
      if (
        !acknowledged ||
        acknowledged.attempt !== input.recorded.attempt ||
        acknowledged.intentDigest !== nextIntentDigest ||
        acknowledged.preparationDigest !== body.preparationDigest ||
        acknowledged.commandDigest !== body.commandDigest
      ) {
        throw new Error('Sandbox preparation intent was not reflected in Runtime state.');
      }
      intentDigest = nextIntentDigest;
      return Object.freeze({ intentDigest: nextIntentDigest });
    },
    recordPreparationReady: async (prepared: Readonly<PreparedSandboxExecutionV1>) => {
      if (!intentDigest) return false;
      if (!input.artifacts) return false;
      try {
        assertPreparedMatchesRecorded(prepared, input.recorded);
      } catch {
        return false;
      }
      let preparationArtifact: SandboxPreparationArtifactRefV1;
      try {
        preparationArtifact = input.artifacts.write(prepared);
      } catch {
        return false;
      }
      const body = {
        attempt: input.recorded.attempt,
        intentDigest,
        preparationDigest: prepared.preparationDigest,
        commandDigest: prepared.commandDigest,
        planDigest: sandboxPreparedPlanDigestV1(prepared),
        backend: prepared.backend,
        backendCapabilitiesDigest: digestCapability(prepared.backendCapabilities),
        enforcement: prepared.enforcement,
        resourceSemantics: prepared.resourceSemantics,
        cleanupDigest: digestCapability(prepared.cleanup),
        preparationArtifact,
      };
      const readyDigest = sandboxPreparationReadyDigestV1(body);
      const readyAt = (input.now?.() ?? new Date()).toISOString();
      if (
        !(await input.persistence.persistEvents([
          {
            type: 'capability.sandbox_preparation_ready',
            invocationId: input.recorded.invocationId,
            ...body,
            readyDigest,
            readyAt,
          },
        ]))
      ) {
        return false;
      }
      const acknowledged =
        input.persistence.getState().capabilities.invocations[input.recorded.invocationId]
          ?.sandboxPreparationReady;
      const accepted =
        acknowledged?.readyDigest === readyDigest &&
        acknowledged.preparationArtifact.artifactId === preparationArtifact.artifactId;
      if (accepted) acknowledgedReadyDigest = readyDigest;
      return accepted;
    },
    recordExecutionDispatchIntent: async (
      prepared: Readonly<PreparedSandboxExecutionV1>,
      dispatch: { readonly dispatchId: string; readonly supervisorNonce: string },
    ) => {
      if (!acknowledgedReadyDigest || acknowledgedDispatch) {
        throw new Error('Sandbox execution dispatch is not eligible for consumption.');
      }
      assertPreparedMatchesRecorded(prepared, input.recorded);
      const body = {
        attempt: input.recorded.attempt,
        readyDigest: acknowledgedReadyDigest,
        planDigest: sandboxPreparedPlanDigestV1(prepared),
        dispatchId: dispatch.dispatchId,
        supervisorNonce: dispatch.supervisorNonce,
      };
      const dispatchIntentDigest = digestCapability({
        kind: 'sandbox_execution_dispatch_intent_v1',
        invocationId: input.recorded.invocationId,
        ...body,
      });
      const recordedAt = (input.now?.() ?? new Date()).toISOString();
      if (
        !(await input.persistence.persistEvents([
          {
            type: 'capability.sandbox_execution_dispatch_intent_recorded',
            invocationId: input.recorded.invocationId,
            ...body,
            dispatchIntentDigest,
            recordedAt,
          },
        ]))
      ) {
        throw new Error('Sandbox execution dispatch intent acknowledgement failed.');
      }
      const recorded =
        input.persistence.getState().capabilities.invocations[input.recorded.invocationId]
          ?.sandboxExecutionDispatch;
      if (
        recorded?.status !== 'intent_recorded' ||
        recorded.dispatchId !== dispatch.dispatchId ||
        recorded.dispatchIntentDigest !== dispatchIntentDigest ||
        recorded.planDigest !== body.planDigest
      ) {
        throw new Error('Sandbox execution dispatch intent was not reflected in Runtime state.');
      }
      acknowledgedDispatch = { dispatchId: dispatch.dispatchId, dispatchIntentDigest };
      return Object.freeze({ dispatchIntentDigest });
    },
    recordExecutionSupervisorStarted: async (
      prepared: Readonly<PreparedSandboxExecutionV1>,
      supervisor: {
        readonly dispatchId: string;
        readonly dispatchIntentDigest: string;
        readonly supervisorPid: number;
        readonly processGroupId: number;
        readonly processStartIdentity: string;
      },
    ) => {
      if (
        !acknowledgedDispatch ||
        acknowledgedDispatch.dispatchId !== supervisor.dispatchId ||
        acknowledgedDispatch.dispatchIntentDigest !== supervisor.dispatchIntentDigest ||
        !preparedMatchesRecorded(prepared, input.recorded)
      ) {
        return false;
      }
      const startedAt = (input.now?.() ?? new Date()).toISOString();
      if (
        !(await input.persistence.persistEvents([
          {
            type: 'capability.sandbox_execution_supervisor_started',
            invocationId: input.recorded.invocationId,
            attempt: input.recorded.attempt,
            ...supervisor,
            startedAt,
          },
        ]))
      ) {
        return false;
      }
      const recorded =
        input.persistence.getState().capabilities.invocations[input.recorded.invocationId]
          ?.sandboxExecutionDispatch;
      return (
        recorded?.status === 'supervisor_started' &&
        recorded.dispatchId === supervisor.dispatchId &&
        recorded.supervisorPid === supervisor.supervisorPid &&
        recorded.processStartIdentity === supervisor.processStartIdentity
      );
    },
    recordDisposalIntent: async (prepared: Readonly<PreparedSandboxExecutionV1> | null) => {
      if (!intentDigest) return null;
      if (!acknowledgedReadyDigest) {
        const intent =
          input.persistence.getState().capabilities.invocations[input.recorded.invocationId]
            ?.sandboxPreparationIntent;
        if (!intent || intent.intentDigest !== intentDigest) return null;
        const lifecycleIntentDigest = sandboxAbandonmentLifecycleIntentDigestV1({
          invocationId: input.recorded.invocationId,
          attempt: input.recorded.attempt,
          intentDigest,
          preparationDigest: intent.preparationDigest,
        });
        let abandonment =
          input.persistence.getState().capabilities.invocations[input.recorded.invocationId]
            ?.sandboxPreparationAbandonment;
        if (!abandonment) {
          const accepted = await input.persistence.persistEvents([
            {
              type: 'capability.sandbox_preparation_abandonment_started',
              invocationId: input.recorded.invocationId,
              attempt: input.recorded.attempt,
              intentDigest,
              lifecycleIntentDigest,
              startedAt: (input.now?.() ?? new Date()).toISOString(),
            },
          ]);
          if (!accepted) return null;
          abandonment =
            input.persistence.getState().capabilities.invocations[input.recorded.invocationId]
              ?.sandboxPreparationAbandonment;
        }
        return abandonment?.status === 'pending' &&
          abandonment.lifecycleIntentDigest === lifecycleIntentDigest
          ? {
              purpose: 'reconcile_preparation_intent' as const,
              lifecycleIntentDigest,
              cleanupAttempt: abandonment.attempts + 1,
            }
          : null;
      }
      if (!prepared || !preparedMatchesRecorded(prepared, input.recorded)) return null;
      const lifecycleIntentDigest = sandboxDisposalLifecycleIntentDigestV1({
        invocationId: input.recorded.invocationId,
        attempt: input.recorded.attempt,
        readyDigest: acknowledgedReadyDigest,
        planDigest: sandboxPreparedPlanDigestV1(prepared),
        cleanupDigest: digestCapability(prepared.cleanup),
      });
      let disposal =
        input.persistence.getState().capabilities.invocations[input.recorded.invocationId]
          ?.sandboxDisposal;
      if (!disposal) {
        const startedAt = (input.now?.() ?? new Date()).toISOString();
        const accepted = await input.persistence.persistEvents([
          {
            type: 'capability.sandbox_disposal_started',
            invocationId: input.recorded.invocationId,
            attempt: input.recorded.attempt,
            readyDigest: acknowledgedReadyDigest,
            lifecycleIntentDigest,
            startedAt,
          },
        ]);
        if (!accepted) return null;
        disposal =
          input.persistence.getState().capabilities.invocations[input.recorded.invocationId]
            ?.sandboxDisposal;
      }
      return disposal?.status === 'pending' &&
        disposal.lifecycleIntentDigest === lifecycleIntentDigest
        ? {
            purpose: 'dispose' as const,
            lifecycleIntentDigest,
            cleanupAttempt: disposal.attempts + 1,
          }
        : null;
    },
    recordDisposalReceipt: async ({
      prepared,
      purpose,
      lifecycleIntentDigest,
      cleanupAttempt,
      disposed,
    }: {
      prepared: Readonly<PreparedSandboxExecutionV1> | null;
      purpose: 'dispose' | 'reconcile_preparation_intent';
      lifecycleIntentDigest: string;
      cleanupAttempt: number;
      disposed: boolean;
    }) => {
      if (prepared && !preparedMatchesRecorded(prepared, input.recorded)) return false;
      const disposedAt = (input.now?.() ?? new Date()).toISOString();
      if (purpose === 'reconcile_preparation_intent') {
        if (!intentDigest) return false;
        const accepted = await input.persistence.persistEvents([
          {
            type: 'capability.sandbox_preparation_abandonment_completed',
            invocationId: input.recorded.invocationId,
            attempt: input.recorded.attempt,
            intentDigest,
            lifecycleIntentDigest,
            cleanupAttempt,
            disposed,
            disposedAt,
          },
        ]);
        return (
          accepted &&
          input.persistence.getState().capabilities.invocations[input.recorded.invocationId]
            ?.sandboxPreparationAbandonment?.status === (disposed ? 'completed' : 'pending')
        );
      }
      if (!acknowledgedReadyDigest) return false;
      if (!prepared) return false;
      const accepted = await input.persistence.persistEvents([
        {
          type: 'capability.sandbox_disposal_completed',
          invocationId: input.recorded.invocationId,
          attempt: input.recorded.attempt,
          readyDigest: acknowledgedReadyDigest,
          lifecycleIntentDigest,
          cleanupAttempt,
          disposed,
          disposedAt,
        },
      ]);
      return (
        accepted &&
        input.persistence.getState().capabilities.invocations[input.recorded.invocationId]
          ?.sandboxDisposal?.status === (disposed ? 'completed' : 'pending')
      );
    },
  });
}

function assertPreparationMatchesRecorded(
  preparation: Readonly<SandboxPreparationV1>,
  recorded: Readonly<RecordedInvocationV1>,
): void {
  if (
    preparation.invocationId !== recorded.invocationId ||
    preparation.attempt !== recorded.attempt ||
    preparation.toolCallId !== recordedToolCallId(recorded) ||
    preparation.capabilityId !== recordedCapability(recorded).capabilityId ||
    preparation.capabilityRevision !== recordedCapability(recorded).revision ||
    preparation.effectiveEffectsDigest !== recordedEffectiveEffectsDigest(recorded) ||
    preparation.admissionDigest !== recorded.admitted.admissionDigest
  ) {
    throw new Error('Sandbox preparation does not match the acknowledged Tool attempt.');
  }
}

function assertPreparedMatchesRecorded(
  prepared: Readonly<PreparedSandboxExecutionV1>,
  recorded: Readonly<RecordedInvocationV1>,
): void {
  if (!preparedMatchesRecorded(prepared, recorded)) {
    throw new Error('Prepared sandbox plan does not match the acknowledged Tool attempt.');
  }
}

function preparedMatchesRecorded(
  prepared: Readonly<PreparedSandboxExecutionV1>,
  recorded: Readonly<RecordedInvocationV1>,
): boolean {
  const capability = recordedCapability(recorded);
  return (
    prepared.invocationId === recorded.invocationId &&
    prepared.attempt === recorded.attempt &&
    prepared.toolCallId === recordedToolCallId(recorded) &&
    prepared.capabilityId === capability.capabilityId &&
    prepared.capabilityRevision === capability.revision &&
    prepared.effectiveEffectsDigest === recordedEffectiveEffectsDigest(recorded) &&
    prepared.admissionDigest === recorded.admitted.admissionDigest
  );
}

function recordedCapability(recorded: Readonly<RecordedInvocationV1>) {
  return recorded.admitted.authorized.policy.classified.validated.resolved.target.descriptor;
}

function recordedToolCallId(recorded: Readonly<RecordedInvocationV1>): string {
  return recorded.admitted.authorized.policy.classified.validated.resolved.call.toolCallId;
}

function recordedEffectiveEffectsDigest(recorded: Readonly<RecordedInvocationV1>): string {
  return recorded.admitted.authorized.policy.classified.effectiveEffectsDigest;
}
