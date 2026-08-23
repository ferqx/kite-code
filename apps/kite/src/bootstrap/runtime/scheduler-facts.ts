import type { BuiltinToolCatalogProjection } from '@kite/builtin-runtime';
import { getAgentPhase } from '@kite/runtime-contract';
import type {
  StateExecutionTraits as ExecutionTraits,
  StateRuntimeState as RuntimeState,
  StateRuntimeSchedulerFacts as SchedulerFacts,
} from '@kite/runtime-host';
import { runtimeHostStateActivePlanning } from '@kite/runtime-host';

type ToolCallRecord = RuntimeState['tools']['calls'][string];

const DEFAULT_RUNTIME_SCOPE_ = Object.freeze([
  Object.freeze({ kind: 'runtime' as const, key: 'capability' }),
]);

/**
 * Project non-persisted scheduler facts from the one frozen Builtin catalog.
 * State 25 remains unchanged; dynamic MCP and malformed calls receive only the
 * generic exclusive fallback and never create another per-name traits table.
 */
export function projectRuntimeSchedulerFacts(
  state: Readonly<RuntimeState>,
  catalog: BuiltinToolCatalogProjection,
): SchedulerFacts {
  const traits: Record<string, ExecutionTraits> = {};
  const approval: Record<string, { allowed: boolean; requiresApproval: boolean }> = {};
  const modelEntries = new Map(
    catalog.entries.flatMap((entry) =>
      entry.visibility === 'model' ? ([[entry.name, entry]] as const) : [],
    ),
  );
  for (const call of Object.values(state.tools.calls)) {
    const entry = modelEntries.get(call.name);
    const phase = getAgentPhase(runtimeHostStateActivePlanning(state));
    const context = Object.freeze({
      workspace: state.session.workspace,
      threadId: state.session.threadId,
      turnId: state.turn.turnId,
      taskId: call.taskId ?? state.activeTaskId ?? undefined,
      modelMessageId: call.modelMessageId,
      toolCallId: call.toolCallId,
      phase,
    });
    const parsed = entry?.parse(call.args, context);
    const invocationEffects =
      entry && parsed?.success ? entry.classifyEffects(parsed.data, context) : undefined;
    const canonicalFacts =
      invocationEffects !== undefined &&
      call.effectClass === invocationEffects.effectClass &&
      call.sideEffect === invocationEffects.sideEffect &&
      (call.classificationReason === undefined ||
        call.classificationReason === invocationEffects.classificationReason);
    traits[call.toolCallId] =
      canonicalFacts && entry && parsed?.success
        ? entry.projectExecutionTraits(parsed.data, context)
        : genericExecutionTraits(state, call);
    const policy =
      canonicalFacts && entry && parsed?.success
        ? entry.compilePolicy(parsed.data, context)
        : undefined;
    approval[call.toolCallId] = Object.freeze({
      allowed: policy?.allowed === true,
      requiresApproval: policy?.requiresApproval !== false,
    });
  }
  return Object.freeze({
    traits: Object.freeze(traits),
    approval: Object.freeze(approval),
  });
}

function genericExecutionTraits(
  state: Readonly<RuntimeState>,
  call: Readonly<ToolCallRecord>,
): ExecutionTraits {
  const access =
    call.effectClass === 'read_only' && call.sideEffect === false
      ? ('read' as const)
      : call.effectClass === 'workspace_write' || call.sideEffect === true
        ? ('write' as const)
        : ('unknown' as const);
  return Object.freeze({
    resourceScopes: DEFAULT_RUNTIME_SCOPE_,
    access,
    conflictKeys: Object.freeze(access === 'read' ? [] : ['workspace']),
    isolation: access === 'read' ? 'shared' : 'exclusive_workspace',
    causalGroup: `${call.taskId ?? state.activeTaskId ?? ''}\0${
      call.modelMessageId ?? call.toolCallId
    }`,
    interactionBarrier: true,
    leaseFenceRequired: true,
  });
}
