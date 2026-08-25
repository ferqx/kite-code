import { sha256Hex } from './hash';
import { jsonRecord } from './reducer-utils';
import type {
  AgentApprovalCommandIdentity,
  AgentApprovalStatus,
  AgentPendingApproval,
  AgentState,
  AgentToolApprovalPayload,
} from './state';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function requiredString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}

/** Full same_command subject; every field is security relevant. */
export function approvalCommandGrantKey(input: AgentApprovalCommandIdentity): string {
  return sha256Hex(
    `same_command:v2:${stableJson({
      sessionId: input.sessionId,
      threadId: input.threadId,
      workspace: input.workspace,
      canonicalWorkspaceIdentity: input.canonicalWorkspaceIdentity,
      cwd: input.cwd,
      executor: input.executor,
      environment: input.environment,
      scope: input.scope,
      effects: input.effects,
      parserRevision: input.parserRevision,
      executorRevision: input.executorRevision ?? '',
      commandDigest: input.commandDigest,
    })}`,
  );
}

function digestCommand(command: string): string {
  return `sha256:${sha256Hex(command.trim())}`;
}

export function commandIdentityFromApproval(
  state: AgentState,
  approval: UnknownRecord,
): AgentApprovalCommandIdentity {
  const supplied =
    record(approval.commandIdentity) ??
    (typeof approval.sessionId === 'string' ? approval : undefined);
  const expectedEffects = Array.isArray(approval.expectedEffects)
    ? approval.expectedEffects.map(String).sort().join(',')
    : String(approval.effects ?? 'unknown');
  return {
    sessionId: requiredString(supplied?.sessionId ?? approval.threadId, state.session.threadId),
    threadId: requiredString(supplied?.threadId ?? approval.threadId, state.session.threadId),
    workspace: requiredString(supplied?.workspace, state.session.workspace),
    canonicalWorkspaceIdentity: requiredString(
      supplied?.canonicalWorkspaceIdentity ?? state.session.canonicalWorkspaceDigest,
      state.session.workspace,
    ),
    cwd: requiredString(supplied?.cwd ?? approval.cwd, state.session.workspace),
    executor: requiredString(supplied?.executor ?? approval.tool, 'unknown'),
    environment: requiredString(supplied?.environment, 'unknown'),
    scope: requiredString(supplied?.scope ?? approval.scope, 'unknown'),
    effects: requiredString(supplied?.effects ?? expectedEffects, 'unknown'),
    parserRevision: requiredString(supplied?.parserRevision, 'unknown'),
    ...(typeof supplied?.executorRevision === 'string'
      ? { executorRevision: supplied.executorRevision }
      : {}),
    commandDigest: requiredString(
      supplied?.commandDigest,
      digestCommand(String(approval.command ?? '')),
    ),
  };
}

export function pendingNeedsFocus(status: AgentApprovalStatus): boolean {
  return (
    status === 'queued_auto' ||
    status === 'auto_reviewing' ||
    status === 'queued_user' ||
    status === 'awaiting_user' ||
    status === 'approving'
  );
}

export function chooseApprovalFocus(
  pendingApprovals: ReadonlyMap<string, AgentPendingApproval>,
): string | null {
  let selected: AgentPendingApproval | undefined;
  for (const pending of pendingApprovals.values()) {
    if (!pendingNeedsFocus(pending.status)) continue;
    if (!selected || pending.sequence < selected.sequence) selected = pending;
  }
  return selected?.interactionId ?? null;
}

export function focusedInteraction(
  pendingApprovals: ReadonlyMap<string, AgentPendingApproval>,
  activeApprovalId: string | null,
): AgentState['interactions'] {
  if (!activeApprovalId) return { kind: 'idle' };
  const pending = pendingApprovals.get(activeApprovalId);
  if (!pending || !pendingNeedsFocus(pending.status)) return { kind: 'idle' };
  const approval = pending.approval as unknown as UnknownRecord;
  if (pending.route === 'auto') {
    return jsonRecord({
      kind: 'awaiting_auto_review',
      interactionId: pending.interactionId,
      toolCallId: pending.toolCallId,
      toolName: requiredString(approval.tool ?? approval.toolName, 'shell_execute'),
      reason: requiredString(approval.reason, 'auto-review'),
      approval,
    }) as AgentState['interactions'];
  }
  return jsonRecord({
    kind: 'awaiting_tool_approval',
    interactionId: pending.interactionId,
    toolCallId: pending.toolCallId,
    approval,
  }) as AgentState['interactions'];
}

export function pendingWithStatus(
  pending: AgentPendingApproval,
  status: AgentApprovalStatus,
  extras: Partial<AgentPendingApproval> = {},
): AgentPendingApproval {
  return { ...pending, ...extras, status, state: status };
}

export function approvalPayloadFromEvent(event: unknown): UnknownRecord {
  return record(record(event)?.approval) ?? {};
}

export function normalizeApprovalPayload(value: UnknownRecord): AgentToolApprovalPayload {
  const riskValues = [
    'read',
    'plan',
    'write_file',
    'execute_code',
    'destructive',
    'network',
    'vcs_mutation',
    'mcp',
    'unknown',
  ] as const;
  const risk = riskValues.includes(value.risk as (typeof riskValues)[number])
    ? (value.risk as (typeof riskValues)[number])
    : 'unknown';
  const command = requiredString(value.command, '');
  const grantOptions = Array.isArray(value.grantOptions)
    ? value.grantOptions.filter(
        (grant): grant is 'approve_once' | 'same_command' =>
          grant === 'approve_once' || grant === 'same_command',
      )
    : [];
  const normalizedGrants: readonly ('approve_once' | 'same_command')[] =
    grantOptions.length > 0 ? grantOptions : ['approve_once'];
  const recommendedGrant = normalizedGrants.includes(
    value.recommendedGrant as 'approve_once' | 'same_command',
  )
    ? (value.recommendedGrant as 'approve_once' | 'same_command')
    : 'approve_once';
  return {
    scope: 'once',
    ...(typeof value.callId === 'string' ? { callId: value.callId } : {}),
    cwd: requiredString(value.cwd, ''),
    threadId: requiredString(value.threadId, ''),
    tool: requiredString(value.tool ?? value.toolName, 'shell_execute'),
    command,
    risk,
    approvalHash: requiredString(value.approvalHash, digestCommand(command)),
    summary: requiredString(value.summary, command),
    reason: requiredString(value.reason, 'approval required'),
    expectedEffects: Array.isArray(value.expectedEffects)
      ? value.expectedEffects.filter((effect): effect is string => typeof effect === 'string')
      : [],
    grantOptions: normalizedGrants,
    recommendedGrant,
    ...(value.plan !== undefined ? { plan: value.plan as AgentToolApprovalPayload['plan'] } : {}),
    ...(typeof value.subagentId === 'string' ? { subagentId: value.subagentId } : {}),
    ...(typeof value.reviewFailure === 'string' ? { reviewFailure: value.reviewFailure } : {}),
  };
}

export function eventRecord(value: unknown): UnknownRecord {
  return record(value) ?? {};
}

export function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function selectPendingApprovals(
  state: AgentState,
): ReadonlyMap<string, AgentPendingApproval> {
  return state.pendingApprovals;
}

export function selectSessionCommandGrants(state: AgentState) {
  return state.sessionCommandGrants;
}
