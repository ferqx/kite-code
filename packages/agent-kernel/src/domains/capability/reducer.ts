import type { KernelEvent } from '../../events';
import {
  asJsonObject,
  eventRecord,
  nonEmptyStringField,
  numberField,
  recordField,
  stringField,
} from '../../reducer-utils';
import type {
  AgentCapabilityBindingState,
  AgentCapabilityDisclosureState,
  AgentCapabilityInvocationState,
  AgentFilesystemPreimageArtifactRef,
  AgentLoadedCapabilityState,
  AgentSandboxPreparationArtifactRef,
  AgentState,
  AgentSubagentHandleArtifactRef,
  AgentSubagentTaskArtifactRef,
} from '../../state';

function keyedBindings(value: unknown): Readonly<Record<string, AgentCapabilityBindingState>> {
  const entries = Array.isArray(value)
    ? value
    : Object.values(recordField({ value }, 'value') ?? {});
  const result: Record<string, AgentCapabilityBindingState> = {};
  for (const entry of entries) {
    const candidate = recordField({ entry }, 'entry');
    const bindingId = nonEmptyStringField(candidate ?? {}, 'bindingId');
    const capabilityId = nonEmptyStringField(candidate ?? {}, 'capabilityId');
    const capabilityRevision = nonEmptyStringField(candidate ?? {}, 'capabilityRevision');
    const exposedToolName = nonEmptyStringField(candidate ?? {}, 'exposedToolName');
    const schemaDigest = nonEmptyStringField(candidate ?? {}, 'schemaDigest');
    const issuedForTurnId = nonEmptyStringField(candidate ?? {}, 'issuedForTurnId');
    if (
      !bindingId ||
      !capabilityId ||
      !capabilityRevision ||
      !exposedToolName ||
      !schemaDigest ||
      !issuedForTurnId
    )
      continue;
    result[bindingId] = {
      bindingId,
      capabilityId,
      capabilityRevision,
      exposedToolName,
      schemaDigest,
      issuedForTurnId,
    };
  }
  return result;
}

function keyedDisclosures(
  value: unknown,
): Readonly<Record<string, AgentCapabilityDisclosureState>> {
  const entries = Array.isArray(value)
    ? value
    : Object.values(recordField({ value }, 'value') ?? {});
  const result: Record<string, AgentCapabilityDisclosureState> = {};
  for (const entry of entries) {
    const candidate = recordField({ entry }, 'entry');
    const capabilityId = nonEmptyStringField(candidate ?? {}, 'capabilityId');
    const capabilityRevision = nonEmptyStringField(candidate ?? {}, 'capabilityRevision');
    const issuedForTurnId = nonEmptyStringField(candidate ?? {}, 'issuedForTurnId');
    if (!capabilityId || !capabilityRevision || !issuedForTurnId) continue;
    result[capabilityId] = { capabilityId, capabilityRevision, issuedForTurnId };
  }
  return result;
}

function keyedLoadedCapabilities(
  value: unknown,
): Readonly<Record<string, AgentLoadedCapabilityState>> {
  const entries = Array.isArray(value)
    ? value
    : Object.values(recordField({ value }, 'value') ?? {});
  const result: Record<string, AgentLoadedCapabilityState> = {};
  for (const entry of entries) {
    const candidate = recordField({ entry }, 'entry');
    const capabilityId = nonEmptyStringField(candidate ?? {}, 'capabilityId');
    const capabilityRevision = nonEmptyStringField(candidate ?? {}, 'capabilityRevision');
    const firstLoadedAtTurnId = nonEmptyStringField(candidate ?? {}, 'firstLoadedAtTurnId');
    if (!capabilityId || !capabilityRevision || !firstLoadedAtTurnId) continue;
    result[capabilityId] = { capabilityId, capabilityRevision, firstLoadedAtTurnId };
  }
  return result;
}

function eventValue<T>(payload: ReturnType<typeof eventRecord>, field: string): T {
  return payload[field] as T;
}

function isCapabilityEvent(type: KernelEvent['type']): boolean {
  switch (type) {
    case 'capability.bindings_issued':
    case 'capability.search_completed':
    case 'capability.invocation_recorded':
    case 'capability.execution_started':
    case 'capability.filesystem_intent_recorded':
    case 'capability.filesystem_mutation_ready':
    case 'capability.sandbox_preparation_intent_recorded':
    case 'capability.sandbox_preparation_ready':
    case 'capability.sandbox_execution_dispatch_intent_recorded':
    case 'capability.sandbox_execution_supervisor_started':
    case 'capability.sandbox_disposal_started':
    case 'capability.sandbox_disposal_completed':
    case 'capability.sandbox_preparation_abandonment_started':
    case 'capability.sandbox_preparation_abandonment_completed':
    case 'capability.subagent_dispatch_intent_recorded':
    case 'capability.subagent_handle_recorded':
    case 'capability.subagent_observation_recorded':
    case 'capability.subagent_cleanup_started':
    case 'capability.subagent_cleanup_completed':
    case 'capability.execution_result_recorded':
    case 'capability.execution_succeeded':
    case 'capability.execution_failed':
    case 'capability.execution_unknown':
    case 'capability.reconciliation_resolved':
      return true;
    default:
      return false;
  }
}

function updateCapabilityInvocation(
  state: AgentState,
  invocationId: string,
  update: (invocation: AgentCapabilityInvocationState) => AgentCapabilityInvocationState,
): AgentState {
  const invocation = state.capabilities.invocations[invocationId];
  if (!invocation) return state;
  return {
    ...state,
    capabilities: asJsonObject({
      ...state.capabilities,
      invocations: {
        ...state.capabilities.invocations,
        [invocationId]: update(invocation),
      },
    }),
  };
}

/** Capability intent/receipt facts are reduced by this fixed domain owner. */
export function reduceCapabilityState(state: AgentState, event: KernelEvent): AgentState {
  const payload = eventRecord(event);
  if (!isCapabilityEvent(event.type)) return state;

  if (event.type === 'capability.bindings_issued') {
    const catalogRevision = stringField(payload, 'catalogRevision');
    if (!catalogRevision) return state;
    const pendingSearch = state.capabilities.pendingSearch;
    const loadedCapabilities =
      payload.loadedCapabilities == null
        ? state.capabilities.loadedCapabilities
        : keyedLoadedCapabilities(payload.loadedCapabilities);
    return {
      ...state,
      capabilities: asJsonObject({
        catalogRevision,
        bindings: keyedBindings(payload.bindings),
        disclosures: keyedDisclosures(payload.disclosures),
        loadedCapabilities,
        ...(stringField(payload, 'searchId') === pendingSearch?.searchId
          ? {}
          : pendingSearch
            ? { pendingSearch }
            : {}),
        invocations: state.capabilities.invocations,
      }),
    };
  }

  if (event.type === 'capability.search_completed') {
    return {
      ...state,
      capabilities: asJsonObject({
        ...state.capabilities,
        pendingSearch: payload.result,
      }),
    };
  }

  if (event.type === 'capability.invocation_recorded') {
    const invocationId = nonEmptyStringField(payload, 'invocationId');
    if (!invocationId || state.capabilities.invocations[invocationId]) return state;
    const invocation = {
      invocationId,
      toolCallId: eventValue<string>(payload, 'toolCallId'),
      capabilityId: eventValue<string>(payload, 'capabilityId'),
      capabilityRevision: eventValue<string>(payload, 'capabilityRevision'),
      ...(eventValue<string | undefined>(payload, 'taskId')
        ? { taskId: eventValue<string>(payload, 'taskId') }
        : {}),
      ...(eventValue<string | undefined>(payload, 'planId')
        ? { planId: eventValue<string>(payload, 'planId') }
        : {}),
      ...(eventValue<string | undefined>(payload, 'planStepId')
        ? { planStepId: eventValue<string>(payload, 'planStepId') }
        : {}),
      argumentsDigest: eventValue<string>(payload, 'argumentsDigest'),
      authorizationDigest: eventValue<string>(payload, 'authorizationDigest'),
      ...(eventValue<string | undefined>(payload, 'admissionDigest')
        ? { admissionDigest: eventValue<string>(payload, 'admissionDigest') }
        : {}),
      effectiveEffectsDigest: eventValue<string>(payload, 'effectiveEffectsDigest'),
      ...(eventValue<AgentCapabilityInvocationState['receiptRequirement']>(
        payload,
        'receiptRequirement',
      )
        ? {
            receiptRequirement: eventValue<
              NonNullable<AgentCapabilityInvocationState['receiptRequirement']>
            >(payload, 'receiptRequirement'),
          }
        : {}),
      ...(eventValue<AgentCapabilityInvocationState['retryEligibility']>(
        payload,
        'retryEligibility',
      )
        ? {
            retryEligibility: eventValue<
              NonNullable<AgentCapabilityInvocationState['retryEligibility']>
            >(payload, 'retryEligibility'),
          }
        : {}),
      status: 'recorded' as const,
      recordedAt: eventValue<string>(payload, 'recordedAt'),
      ...(eventValue<string | undefined>(payload, 'idempotencyKey')
        ? { idempotencyKey: eventValue<string>(payload, 'idempotencyKey') }
        : {}),
    } as AgentCapabilityInvocationState;
    return {
      ...state,
      capabilities: asJsonObject({
        ...state.capabilities,
        invocations: { ...state.capabilities.invocations, [invocationId]: invocation },
      }),
    };
  }

  const invocationId = nonEmptyStringField(payload, 'invocationId');
  if (!invocationId) return state;

  switch (event.type) {
    case 'capability.execution_started': {
      const eventAttempt = numberField(payload, 'attempt');
      return updateCapabilityInvocation(state, invocationId, (invocation) => {
        if (invocation.status !== 'recorded' && invocation.status !== 'running') return invocation;
        if (
          (invocation.sandboxPreparationReady &&
            invocation.sandboxDisposal?.status !== 'completed') ||
          (invocation.sandboxPreparationIntent &&
            !invocation.sandboxPreparationReady &&
            invocation.sandboxPreparationAbandonment?.status !== 'completed') ||
          (invocation.subagentProviderLifecycle &&
            invocation.subagentProviderLifecycle.status !== 'cleanup_completed')
        )
          return invocation;
        const priorAttempt = invocation.attemptsStarted ?? 0;
        const attemptsStarted =
          eventAttempt === undefined ? priorAttempt : Math.max(priorAttempt, eventAttempt);
        const attemptAdvanced = attemptsStarted > priorAttempt;
        return {
          ...invocation,
          status: 'running',
          startedAt: invocation.startedAt ?? eventValue<string>(payload, 'startedAt'),
          ...(eventAttempt !== undefined ? { attemptsStarted } : {}),
          ...(attemptAdvanced
            ? {
                filesystemIntent: undefined,
                filesystemMutationReady: undefined,
                sandboxPreparationIntent: undefined,
                sandboxPreparationReady: undefined,
                sandboxExecutionDispatch: undefined,
                sandboxDisposal: undefined,
                sandboxPreparationAbandonment: undefined,
                subagentProviderLifecycle: undefined,
              }
            : {}),
        };
      });
    }

    case 'capability.filesystem_intent_recorded': {
      const attempt = numberField(payload, 'attempt');
      if (attempt === undefined) return state;
      return updateCapabilityInvocation(state, invocationId, (invocation) =>
        invocation.status === 'running' && invocation.attemptsStarted === attempt
          ? {
              ...invocation,
              filesystemIntent: {
                attempt,
                capabilityRevision: eventValue<string>(payload, 'capabilityRevision'),
                argumentsDigest: eventValue<string>(payload, 'argumentsDigest'),
                admissionDigest: eventValue<string>(payload, 'admissionDigest'),
                operationDigest: eventValue<string>(payload, 'operationDigest'),
                searchBoundaryDigest: eventValue<string | null>(payload, 'searchBoundaryDigest'),
                lexicalTargetDigest: eventValue<string>(payload, 'lexicalTargetDigest'),
                canonicalWorkspaceDigest: eventValue<string>(payload, 'canonicalWorkspaceDigest'),
                protectedPathRevision: eventValue<string>(payload, 'protectedPathRevision'),
                approvalSummaryDigest: eventValue<string>(payload, 'approvalSummaryDigest'),
                effectiveEffectsDigest: eventValue<string>(payload, 'effectiveEffectsDigest'),
                intentDigest: eventValue<string>(payload, 'intentDigest'),
                recordedAt: eventValue<string>(payload, 'recordedAt'),
              },
              filesystemMutationReady: undefined,
            }
          : invocation,
      );
    }

    case 'capability.filesystem_mutation_ready': {
      const attempt = numberField(payload, 'attempt');
      if (attempt === undefined) return state;
      return updateCapabilityInvocation(state, invocationId, (invocation) =>
        invocation.status === 'running' &&
        invocation.attemptsStarted === attempt &&
        invocation.filesystemIntent?.attempt === attempt &&
        invocation.filesystemIntent.intentDigest === eventValue<string>(payload, 'intentDigest')
          ? {
              ...invocation,
              filesystemMutationReady: {
                attempt,
                intentDigest: eventValue<string>(payload, 'intentDigest'),
                operationDigest: eventValue<string>(payload, 'operationDigest'),
                targetIdentityDigest: eventValue<string>(payload, 'targetIdentityDigest'),
                preimageDigest: eventValue<string | null>(payload, 'preimageDigest'),
                preimageArtifact: eventValue<AgentFilesystemPreimageArtifactRef>(
                  payload,
                  'preimageArtifact',
                ),
                readyDigest: eventValue<string>(payload, 'readyDigest'),
                readyAt: eventValue<string>(payload, 'readyAt'),
              },
            }
          : invocation,
      );
    }

    case 'capability.sandbox_preparation_intent_recorded': {
      const attempt = numberField(payload, 'attempt');
      if (attempt === undefined) return state;
      return updateCapabilityInvocation(state, invocationId, (invocation) =>
        invocation.status === 'running' &&
        invocation.capabilityId === 'builtin:shell_execute' &&
        invocation.attemptsStarted === attempt &&
        invocation.toolCallId === eventValue<string>(payload, 'toolCallId') &&
        invocation.capabilityId === eventValue<string>(payload, 'capabilityId') &&
        invocation.capabilityRevision === eventValue<string>(payload, 'capabilityRevision') &&
        invocation.effectiveEffectsDigest ===
          eventValue<string>(payload, 'effectiveEffectsDigest') &&
        invocation.admissionDigest === eventValue<string>(payload, 'admissionDigest')
          ? {
              ...invocation,
              sandboxPreparationIntent: {
                attempt,
                toolCallId: eventValue<string>(payload, 'toolCallId'),
                capabilityId: eventValue<string>(payload, 'capabilityId'),
                capabilityRevision: eventValue<string>(payload, 'capabilityRevision'),
                canonicalWorkspace: eventValue<string>(payload, 'canonicalWorkspace'),
                effectiveEffectsDigest: eventValue<string>(payload, 'effectiveEffectsDigest'),
                admissionDigest: eventValue<string>(payload, 'admissionDigest'),
                preparationDigest: eventValue<string>(payload, 'preparationDigest'),
                commandDigest: eventValue<string>(payload, 'commandDigest'),
                executionBoundaryDigest: eventValue<string>(payload, 'executionBoundaryDigest'),
                resourceSemantics: eventValue<'allocating'>(payload, 'resourceSemantics'),
                intentDigest: eventValue<string>(payload, 'intentDigest'),
                recordedAt: eventValue<string>(payload, 'recordedAt'),
              },
              sandboxPreparationReady: undefined,
            }
          : invocation,
      );
    }

    case 'capability.sandbox_preparation_ready': {
      const attempt = numberField(payload, 'attempt');
      if (attempt === undefined) return state;
      return updateCapabilityInvocation(state, invocationId, (invocation) =>
        invocation.status === 'running' &&
        invocation.capabilityId === 'builtin:shell_execute' &&
        invocation.attemptsStarted === attempt &&
        invocation.sandboxPreparationIntent?.intentDigest ===
          eventValue<string>(payload, 'intentDigest')
          ? {
              ...invocation,
              sandboxPreparationReady: {
                attempt,
                intentDigest: eventValue<string>(payload, 'intentDigest'),
                preparationDigest: eventValue<string>(payload, 'preparationDigest'),
                commandDigest: eventValue<string>(payload, 'commandDigest'),
                planDigest: eventValue<string>(payload, 'planDigest'),
                backend: eventValue<
                  NonNullable<AgentCapabilityInvocationState['sandboxPreparationReady']>['backend']
                >(payload, 'backend'),
                backendCapabilitiesDigest: eventValue<string>(payload, 'backendCapabilitiesDigest'),
                enforcement: eventValue<
                  NonNullable<
                    AgentCapabilityInvocationState['sandboxPreparationReady']
                  >['enforcement']
                >(payload, 'enforcement'),
                resourceSemantics: eventValue<
                  NonNullable<
                    AgentCapabilityInvocationState['sandboxPreparationReady']
                  >['resourceSemantics']
                >(payload, 'resourceSemantics'),
                cleanupDigest: eventValue<string>(payload, 'cleanupDigest'),
                preparationArtifact: eventValue<AgentSandboxPreparationArtifactRef>(
                  payload,
                  'preparationArtifact',
                ),
                readyDigest: eventValue<string>(payload, 'readyDigest'),
                readyAt: eventValue<string>(payload, 'readyAt'),
              },
            }
          : invocation,
      );
    }

    case 'capability.sandbox_execution_dispatch_intent_recorded': {
      const attempt = numberField(payload, 'attempt');
      if (attempt === undefined) return state;
      return updateCapabilityInvocation(state, invocationId, (invocation) =>
        invocation.status === 'running' &&
        invocation.attemptsStarted === attempt &&
        invocation.sandboxPreparationReady?.readyDigest ===
          eventValue<string>(payload, 'readyDigest') &&
        invocation.sandboxPreparationReady.planDigest ===
          eventValue<string>(payload, 'planDigest') &&
        invocation.sandboxExecutionDispatch === undefined
          ? {
              ...invocation,
              sandboxExecutionDispatch: {
                attempt,
                readyDigest: eventValue<string>(payload, 'readyDigest'),
                planDigest: eventValue<string>(payload, 'planDigest'),
                dispatchId: eventValue<string>(payload, 'dispatchId'),
                supervisorNonce: eventValue<string>(payload, 'supervisorNonce'),
                dispatchIntentDigest: eventValue<string>(payload, 'dispatchIntentDigest'),
                status: 'intent_recorded' as const,
                recordedAt: eventValue<string>(payload, 'recordedAt'),
              },
            }
          : invocation,
      );
    }

    case 'capability.sandbox_execution_supervisor_started': {
      const attempt = numberField(payload, 'attempt');
      if (attempt === undefined) return state;
      return updateCapabilityInvocation(state, invocationId, (invocation) =>
        invocation.sandboxExecutionDispatch?.status === 'intent_recorded' &&
        invocation.sandboxExecutionDispatch.attempt === attempt &&
        invocation.sandboxExecutionDispatch.dispatchId ===
          eventValue<string>(payload, 'dispatchId') &&
        invocation.sandboxExecutionDispatch.dispatchIntentDigest ===
          eventValue<string>(payload, 'dispatchIntentDigest')
          ? {
              ...invocation,
              sandboxExecutionDispatch: {
                ...invocation.sandboxExecutionDispatch,
                status: 'supervisor_started' as const,
                supervisorPid: eventValue<number>(payload, 'supervisorPid'),
                processGroupId: eventValue<number>(payload, 'processGroupId'),
                processStartIdentity: eventValue<string>(payload, 'processStartIdentity'),
                supervisorStartedAt: eventValue<string>(payload, 'startedAt'),
              },
            }
          : invocation,
      );
    }

    case 'capability.sandbox_disposal_started': {
      const attempt = numberField(payload, 'attempt');
      if (attempt === undefined) return state;
      return updateCapabilityInvocation(state, invocationId, (invocation) =>
        invocation.sandboxPreparationReady?.readyDigest ===
          eventValue<string>(payload, 'readyDigest') &&
        invocation.sandboxPreparationReady.attempt === attempt &&
        invocation.sandboxDisposal === undefined
          ? {
              ...invocation,
              sandboxDisposal: {
                attempt,
                readyDigest: eventValue<string>(payload, 'readyDigest'),
                lifecycleIntentDigest: eventValue<string>(payload, 'lifecycleIntentDigest'),
                status: 'pending' as const,
                startedAt: eventValue<string>(payload, 'startedAt'),
                attempts: 0,
              },
            }
          : invocation,
      );
    }

    case 'capability.sandbox_disposal_completed': {
      const attempt = numberField(payload, 'attempt');
      const cleanupAttempt = numberField(payload, 'cleanupAttempt');
      if (attempt === undefined || cleanupAttempt === undefined) return state;
      const disposed = eventValue<boolean>(payload, 'disposed');
      return updateCapabilityInvocation(state, invocationId, (invocation) =>
        invocation.sandboxDisposal?.status === 'pending' &&
        invocation.sandboxDisposal.readyDigest === eventValue<string>(payload, 'readyDigest') &&
        invocation.sandboxDisposal.attempt === attempt &&
        invocation.sandboxDisposal.lifecycleIntentDigest ===
          eventValue<string>(payload, 'lifecycleIntentDigest') &&
        cleanupAttempt === invocation.sandboxDisposal.attempts + 1
          ? {
              ...invocation,
              sandboxDisposal: {
                ...invocation.sandboxDisposal,
                status: disposed ? ('completed' as const) : ('pending' as const),
                attempts: invocation.sandboxDisposal.attempts + 1,
                ...(disposed
                  ? {
                      disposedAt: eventValue<string>(payload, 'disposedAt'),
                      lastFailureAt: undefined,
                    }
                  : {
                      disposedAt: undefined,
                      lastFailureAt: eventValue<string>(payload, 'disposedAt'),
                    }),
              },
            }
          : invocation,
      );
    }

    case 'capability.sandbox_preparation_abandonment_started': {
      const attempt = numberField(payload, 'attempt');
      if (attempt === undefined) return state;
      return updateCapabilityInvocation(state, invocationId, (invocation) =>
        invocation.sandboxPreparationIntent?.intentDigest ===
          eventValue<string>(payload, 'intentDigest') &&
        invocation.sandboxPreparationIntent.attempt === attempt &&
        invocation.sandboxPreparationReady === undefined &&
        invocation.sandboxPreparationAbandonment === undefined
          ? {
              ...invocation,
              sandboxPreparationAbandonment: {
                attempt,
                intentDigest: eventValue<string>(payload, 'intentDigest'),
                lifecycleIntentDigest: eventValue<string>(payload, 'lifecycleIntentDigest'),
                status: 'pending' as const,
                startedAt: eventValue<string>(payload, 'startedAt'),
                attempts: 0,
              },
            }
          : invocation,
      );
    }

    case 'capability.sandbox_preparation_abandonment_completed': {
      const attempt = numberField(payload, 'attempt');
      const cleanupAttempt = numberField(payload, 'cleanupAttempt');
      if (attempt === undefined || cleanupAttempt === undefined) return state;
      const disposed = eventValue<boolean>(payload, 'disposed');
      return updateCapabilityInvocation(state, invocationId, (invocation) =>
        invocation.sandboxPreparationAbandonment?.status === 'pending' &&
        invocation.sandboxPreparationAbandonment.intentDigest ===
          eventValue<string>(payload, 'intentDigest') &&
        invocation.sandboxPreparationAbandonment.attempt === attempt &&
        invocation.sandboxPreparationAbandonment.lifecycleIntentDigest ===
          eventValue<string>(payload, 'lifecycleIntentDigest') &&
        cleanupAttempt === invocation.sandboxPreparationAbandonment.attempts + 1
          ? {
              ...invocation,
              sandboxPreparationAbandonment: {
                ...invocation.sandboxPreparationAbandonment,
                status: disposed ? ('completed' as const) : ('pending' as const),
                attempts: invocation.sandboxPreparationAbandonment.attempts + 1,
                ...(disposed
                  ? {
                      disposedAt: eventValue<string>(payload, 'disposedAt'),
                      lastFailureAt: undefined,
                    }
                  : {
                      disposedAt: undefined,
                      lastFailureAt: eventValue<string>(payload, 'disposedAt'),
                    }),
              },
            }
          : invocation,
      );
    }

    case 'capability.subagent_dispatch_intent_recorded': {
      const attempt = numberField(payload, 'attempt');
      if (attempt === undefined) return state;
      return updateCapabilityInvocation(state, invocationId, (invocation) =>
        invocation.status === 'running' &&
        invocation.attemptsStarted === attempt &&
        (invocation.capabilityId === 'builtin:task' ||
          invocation.capabilityId === 'builtin:activate_skill') &&
        invocation.subagentProviderLifecycle === undefined
          ? {
              ...invocation,
              subagentProviderLifecycle: {
                attempt,
                purpose: eventValue<
                  NonNullable<
                    AgentCapabilityInvocationState['subagentProviderLifecycle']
                  >['purpose']
                >(payload, 'purpose'),
                childInvocationId: eventValue<string>(payload, 'childInvocationId'),
                taskArtifact: eventValue<AgentSubagentTaskArtifactRef>(payload, 'taskArtifact'),
                dispatchIntentDigest: eventValue<string>(payload, 'dispatchIntentDigest'),
                status: 'intent_recorded' as const,
                recordedAt: eventValue<string>(payload, 'recordedAt'),
              },
            }
          : invocation,
      );
    }

    case 'capability.subagent_handle_recorded': {
      const attempt = numberField(payload, 'attempt');
      if (attempt === undefined) return state;
      return updateCapabilityInvocation(state, invocationId, (invocation) =>
        invocation.subagentProviderLifecycle?.status === 'intent_recorded' &&
        invocation.subagentProviderLifecycle.attempt === attempt &&
        invocation.subagentProviderLifecycle.dispatchIntentDigest ===
          eventValue<string>(payload, 'dispatchIntentDigest')
          ? {
              ...invocation,
              subagentProviderLifecycle: {
                ...invocation.subagentProviderLifecycle,
                status: 'handle_recorded' as const,
                handleArtifact: eventValue<AgentSubagentHandleArtifactRef>(
                  payload,
                  'handleArtifact',
                ),
                handleIntegrityIdentifier: eventValue<string>(payload, 'handleIntegrityIdentifier'),
                handleRecordedAt: eventValue<string>(payload, 'recordedAt'),
              },
            }
          : invocation,
      );
    }

    case 'capability.subagent_observation_recorded': {
      const attempt = numberField(payload, 'attempt');
      if (attempt === undefined) return state;
      return updateCapabilityInvocation(state, invocationId, (invocation) =>
        invocation.subagentProviderLifecycle?.status === 'handle_recorded' &&
        invocation.subagentProviderLifecycle.attempt === attempt &&
        invocation.subagentProviderLifecycle.dispatchIntentDigest ===
          eventValue<string>(payload, 'dispatchIntentDigest')
          ? {
              ...invocation,
              subagentProviderLifecycle: {
                ...invocation.subagentProviderLifecycle,
                status: 'observed' as const,
                observationStatus: eventValue<
                  NonNullable<
                    AgentCapabilityInvocationState['subagentProviderLifecycle']
                  >['observationStatus']
                >(payload, 'status'),
                observedAt: eventValue<string>(payload, 'observedAt'),
              },
            }
          : invocation,
      );
    }

    case 'capability.subagent_cleanup_started': {
      const attempt = numberField(payload, 'attempt');
      const cleanupAttempt = numberField(payload, 'cleanupAttempt');
      if (attempt === undefined || cleanupAttempt === undefined) return state;
      return updateCapabilityInvocation(state, invocationId, (invocation) =>
        invocation.subagentProviderLifecycle &&
        invocation.subagentProviderLifecycle.attempt === attempt &&
        invocation.subagentProviderLifecycle.dispatchIntentDigest ===
          eventValue<string>(payload, 'dispatchIntentDigest') &&
        cleanupAttempt === (invocation.subagentProviderLifecycle.cleanupAttempt ?? 0) + 1
          ? {
              ...invocation,
              subagentProviderLifecycle: {
                ...invocation.subagentProviderLifecycle,
                status: 'cleanup_pending' as const,
                cleanupAttempt,
                cleanupKind: eventValue<
                  NonNullable<
                    AgentCapabilityInvocationState['subagentProviderLifecycle']
                  >['cleanupKind']
                >(payload, 'cleanupKind'),
                cleanupStartedAt: eventValue<string>(payload, 'startedAt'),
                cleanupConfirmed: undefined,
                cleanupCompletedAt: undefined,
              },
            }
          : invocation,
      );
    }

    case 'capability.subagent_cleanup_completed': {
      const attempt = numberField(payload, 'attempt');
      const cleanupAttempt = numberField(payload, 'cleanupAttempt');
      if (attempt === undefined || cleanupAttempt === undefined) return state;
      const cleanupConfirmed = eventValue<boolean>(payload, 'cleanupConfirmed');
      return updateCapabilityInvocation(state, invocationId, (invocation) =>
        invocation.subagentProviderLifecycle?.status === 'cleanup_pending' &&
        invocation.subagentProviderLifecycle.attempt === attempt &&
        invocation.subagentProviderLifecycle.dispatchIntentDigest ===
          eventValue<string>(payload, 'dispatchIntentDigest') &&
        invocation.subagentProviderLifecycle.cleanupAttempt === cleanupAttempt &&
        invocation.subagentProviderLifecycle.cleanupKind ===
          eventValue<
            NonNullable<AgentCapabilityInvocationState['subagentProviderLifecycle']>['cleanupKind']
          >(payload, 'cleanupKind')
          ? {
              ...invocation,
              subagentProviderLifecycle: {
                ...invocation.subagentProviderLifecycle,
                status: cleanupConfirmed
                  ? ('cleanup_completed' as const)
                  : ('cleanup_pending' as const),
                cleanupConfirmed,
                cleanupCompletedAt: eventValue<string>(payload, 'completedAt'),
              },
            }
          : invocation,
      );
    }

    case 'capability.execution_result_recorded':
      return updateCapabilityInvocation(state, invocationId, (invocation) =>
        invocation.status === 'running'
          ? {
              ...invocation,
              resultDigest: eventValue<string>(payload, 'resultDigest'),
              evidenceDigest: eventValue<string>(payload, 'evidenceDigest'),
              artifact: eventValue<AgentCapabilityInvocationState['artifact']>(payload, 'artifact'),
              ...(eventValue<readonly string[] | undefined>(payload, 'externalReferences')
                ? {
                    externalReferences: eventValue<readonly string[]>(
                      payload,
                      'externalReferences',
                    ),
                  }
                : {}),
            }
          : invocation,
      );

    case 'capability.execution_succeeded':
      return updateCapabilityInvocation(state, invocationId, (invocation) => {
        const { error: _error, ...withoutError } = invocation;
        const artifact = eventValue<AgentCapabilityInvocationState['artifact']>(
          payload,
          'artifact',
        );
        const externalReferences = eventValue<readonly string[] | undefined>(
          payload,
          'externalReferences',
        );
        const filesystemObservation = eventValue<
          AgentCapabilityInvocationState['filesystemObservation']
        >(payload, 'filesystemObservation');
        return {
          ...withoutError,
          status: 'succeeded',
          finishedAt: eventValue<string>(payload, 'finishedAt'),
          resultDigest: eventValue<string>(payload, 'resultDigest'),
          evidenceDigest: eventValue<string>(payload, 'evidenceDigest'),
          ...(artifact ? { artifact } : {}),
          ...(externalReferences ? { externalReferences } : {}),
          ...(filesystemObservation ? { filesystemObservation } : {}),
        };
      });

    case 'capability.execution_failed':
      return updateCapabilityInvocation(state, invocationId, (invocation) => {
        const resultDigest = eventValue<string | undefined>(payload, 'resultDigest');
        const evidenceDigest = eventValue<string | undefined>(payload, 'evidenceDigest');
        const artifact = eventValue<AgentCapabilityInvocationState['artifact']>(
          payload,
          'artifact',
        );
        return {
          ...invocation,
          status: 'failed',
          finishedAt: eventValue<string>(payload, 'finishedAt'),
          error: eventValue<string>(payload, 'error'),
          ...(resultDigest ? { resultDigest } : {}),
          ...(evidenceDigest ? { evidenceDigest } : {}),
          ...(artifact ? { artifact } : {}),
        };
      });

    case 'capability.execution_unknown':
      return updateCapabilityInvocation(state, invocationId, (invocation) => ({
        ...invocation,
        status: 'unknown',
        finishedAt: eventValue<string>(payload, 'finishedAt'),
        error: eventValue<string>(payload, 'reason'),
      }));

    case 'capability.reconciliation_resolved': {
      const decision = eventValue<NonNullable<AgentCapabilityInvocationState['reconciliation']>>(
        payload,
        'decision',
      );
      const reason = eventValue<string | undefined>(payload, 'reason');
      return updateCapabilityInvocation(state, invocationId, (invocation) => ({
        ...invocation,
        status: decision === 'confirmed_success' ? 'succeeded' : 'failed',
        finishedAt: eventValue<string>(payload, 'reconciledAt'),
        reconciliation: decision,
        reconciledAt: eventValue<string>(payload, 'reconciledAt'),
        ...(decision === 'confirmed_success'
          ? { error: undefined }
          : { error: reason ?? 'External invocation outcome was not confirmed.' }),
      }));
    }

    default:
      return state;
  }
}
