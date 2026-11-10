import { type KnownTrajectoryPhase, parseDecimal64 } from '@kite-ai/trajectory';
import {
  trajectoryMessageOutputState,
  trajectoryModelOutputTarget,
  trajectoryOutputPresence,
  trajectoryOutputState,
} from './output-presence';
import type { WorkbenchOperationMember, WorkbenchRow } from './workbench';
import type { TrajectoryMaterialTarget } from './workbench-details';

export interface WorkbenchVirtualPart {
  kind: 'system' | 'input' | 'thinking' | 'reply';
  ownerId: string;
  source: 'model_input' | 'model_output';
  /** Exact public source references, not synthesized events or permission to read them. */
  targets: readonly TrajectoryMaterialTarget[];
}
const terminal = new Set<KnownTrajectoryPhase>([
  'completed',
  'failed',
  'cancelled',
  'outcome_unknown',
]);
const phasePriority: KnownTrajectoryPhase[] = [
  'outcome_unknown',
  'failed',
  'cancelled',
  'waiting_interaction',
  'cancelling',
  'waiting_execution',
  'dispatching',
  'running',
  'planned',
];
/** A background Job does not block a decision after its actual launch Tool has returned. */
function requestPhase(
  owner: WorkbenchRow,
  tools: readonly WorkbenchOperationMember[],
): KnownTrajectoryPhase | undefined {
  if (owner.phase !== 'completed') return owner.phase;
  const phases = tools.map((row) => row.phase);
  const pending = phases.filter((phase) => phase === undefined || !terminal.has(phase));
  if (pending.length)
    return phasePriority.find((phase) => pending.includes(phase)) ?? 'waiting_execution';
  return phasePriority.find((phase) => phases.includes(phase)) ?? 'completed';
}

/** An explicit older observation stays within that original attempt and never falls forward. */
export function trajectoryVirtualPartTargets(
  row: WorkbenchRow,
  observationId?: string | null,
  source?: 'model_input' | 'model_output',
): TrajectoryMaterialTarget[] {
  const part = row.virtualPart;
  if (!part) return [];
  const members = row.operation?.members;
  const selected = observationId
    ? row.events.find((event) => event.eventId === observationId)
    : undefined;
  if (observationId && !selected) return [];
  const member = observationId
    ? members?.find((value) => value.events.some((event) => event.eventId === observationId))
    : members?.find((value) => value.nodeId === row.operation?.primaryNodeId);
  const events = member?.events ?? row.events;
  const cutoff = parseDecimal64(selected?.sequence ?? events.at(-1)?.sequence ?? row.lastSequence);
  let target: TrajectoryMaterialTarget | undefined;
  for (const event of events) {
    if (event.kind !== 'model' || parseDecimal64(event.sequence) > cutoff) continue;
    for (const reference of event.evidenceRefs)
      if (reference.kind === (source ?? part.source)) target = { event, reference };
  }
  return target ? [target] : [];
}

/** Read-only presentation around the original logical model/tool/message graph. */
export function buildLoopPresentation(
  source: readonly WorkbenchRow[],
  parts: boolean,
  runNumbers: ReadonlyMap<string, number>,
): WorkbenchRow[] {
  const rows = source.map((row) => ({ ...row })),
    children = new Map<string, WorkbenchRow[]>();
  for (const row of rows)
    if (row.parentId) {
      const group = children.get(row.parentId) ?? [];
      group.push(row);
      children.set(row.parentId, group);
    }
  const modelAliases = new Map<string, string>(),
    receipts = new Map<string, WorkbenchOperationMember[]>();
  for (const row of rows)
    if (row.kind === 'model' && row.category === 'model') {
      modelAliases.set(row.id, row.id);
      for (const member of row.operation?.members ?? []) modelAliases.set(member.nodeId, row.id);
    }
  for (const row of rows)
    if (row.category === 'tool') {
      const calls = row.operation?.members.filter((member) => member.kind === 'tool') ?? [];
      for (const call of calls.length ? calls : [row]) {
        const ownerId = call.parentId ? modelAliases.get(call.parentId) : undefined;
        if (!ownerId) continue;
        const group = receipts.get(ownerId) ?? [];
        group.push(call);
        receipts.set(ownerId, group);
      }
    }
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const runOf = new Map<string, WorkbenchRow>();
  const pending = rows.filter((row) => !row.parentId || !rowById.has(row.parentId));
  for (let index = 0; index < pending.length; index++) {
    const row = pending[index]!;
    const run =
      row.kind === 'run' && !row.event ? row : row.parentId ? runOf.get(row.parentId) : undefined;
    if (run) runOf.set(row.id, run);
    for (const child of children.get(row.id) ?? []) pending.push(child);
  }
  const runProof = new Map<string, NonNullable<WorkbenchRow['step']>>();
  for (const row of rows) {
    const run = runOf.get(row.id);
    if (run && row.step?.runId && !runProof.has(run.id)) runProof.set(run.id, row.step);
  }
  for (const row of rows)
    if (row.kind === 'run' && !row.event) {
      const proof = row.step?.runId ? row.step : runProof.get(row.id);
      if (!proof) continue;
      const key = JSON.stringify([
        proof.runOriginStoreId ?? proof.originStoreId ?? null,
        proof.sessionId,
        proof.runId,
      ]);
      row.loop = runNumbers.get(key);
      row.loopPhase = row.step?.kind === 'run' ? row.phase : undefined;
    }
  const counters = new Map<string, number>();
  const userRuns = new Set(
    rows
      .filter(
        (row) =>
          row.kind === 'message' &&
          row.step?.messageRole === 'user' &&
          row.step.identityConfidence === 'verified_origin' &&
          row.runKey !== undefined,
      )
      .map((row) => row.runKey),
  );
  const order = new Map<string, { at: bigint; rank: number }>();
  const labels = {
    system: '系统指令',
    input: '本次请求上下文',
    thinking: 'Agent 思考',
    reply: '本次输出',
  };
  const virtual: WorkbenchRow[] = [];
  for (const owner of rows) {
    if (owner.kind !== 'model' || owner.category !== 'model' || owner.event) continue;
    const run = runOf.get(owner.id);
    if (run) {
      const number = (counters.get(run.id) ?? 0) + 1;
      counters.set(run.id, number);
      owner.requestIndex = number;
    }
    owner.loop = undefined;
    owner.loopPhase = undefined;
    const direct = children.get(owner.id) ?? [],
      tools = receipts.get(owner.id) ?? [];
    owner.requestPhase = requestPhase(owner, tools);
    if (!parts) continue;
    const primary =
      owner.operation?.members.find((member) => member.nodeId === owner.operation?.primaryNodeId) ??
      owner;
    const canonicalInput = owner.runKey !== undefined && userRuns.has(owner.runKey);
    const canonicalReplies = direct.filter(
      (row) =>
        row.kind === 'message' &&
        row.step?.messageRole === 'assistant' &&
        row.step.identityConfidence === 'verified_origin' &&
        row.step.executionId === primary.step?.executionId &&
        row.step.sessionId === primary.step?.sessionId &&
        row.step.executionOriginStoreId === primary.step?.executionOriginStoreId,
    );
    const canonicalReply = canonicalReplies.length > 0;
    // A stream Message can be committed before the Model's final material observation.
    // Its proved causal owner constrains phase placement, not the selected Evidence version.
    const replyBoundary =
      primary.step?.identityConfidence === 'verified_origin' &&
      primary.step.executionId !== undefined &&
      primary.step.executionOriginStoreId !== undefined &&
      primary.step.runId !== undefined &&
      primary.runKey !== undefined
        ? canonicalReplies.reduce<bigint | undefined>((earliest, message) => {
            if (message.runKey !== primary.runKey) return earliest;
            const at = parseDecimal64(message.firstSequence);
            if (at < parseDecimal64(primary.firstSequence)) return earliest;
            return earliest === undefined || at < earliest ? at : earliest;
          }, undefined)
        : undefined;
    for (const message of direct)
      if (
        ['tool_only', 'generating_empty'].includes(trajectoryMessageOutputState(message, owner))
      ) {
        message.outputSuppressed = true;
        message.presentationHidden = true;
      }
    const outputState = trajectoryOutputState(primary);
    const suppressOutput = outputState === 'tool_only' || outputState === 'generating_empty';
    const primaryTarget = trajectoryModelOutputTarget(primary);
    const historicalPrefix =
      suppressOutput &&
      primary.events.some(
        (event) =>
          event.kind === 'model' &&
          event.evidenceRefs.some((reference) => {
            if (
              reference.kind !== 'model_output' ||
              (reference.evidenceId === primaryTarget?.reference.evidenceId &&
                reference.contentVersion === primaryTarget.reference.contentVersion)
            )
              return false;
            const presence = trajectoryOutputPresence({ event, reference });
            return presence?.hasText === true;
          }),
      );
    const historicalOutput =
      historicalPrefix ||
      (owner.operation?.attempts ?? []).some(
        (member) =>
          member.nodeId !== primary.nodeId &&
          trajectoryModelOutputTarget(member) &&
          !['tool_only', 'generating_empty'].includes(trajectoryOutputState(member)),
      );
    const kinds: WorkbenchVirtualPart['kind'][] = [
      'system',
      ...(!canonicalInput ? ['input' as const] : []),
      'thinking',
      'reply',
    ];
    for (const [position, kind] of kinds.entries()) {
      const row: WorkbenchRow = {
        ...owner,
        id: `${owner.id}:part:${kind}`,
        parentId: owner.id,
        depth: owner.depth + 1,
        label: labels[kind],
        phase: 'observed',
        loop: undefined,
        loopPhase: undefined,
        requestIndex: undefined,
        requestPhase: undefined,
        interval: { basis: 'unknown', ongoing: false, unknownReason: 'not_a_call' },
        positionAt: undefined,
        clockDomain: undefined,
        relatedNodeIds: [],
        virtualPart: {
          kind,
          ownerId: owner.id,
          source: kind === 'system' || kind === 'input' ? 'model_input' : 'model_output',
          targets: [],
        },
      };
      row.virtualPart!.targets = trajectoryVirtualPartTargets(row);
      if (
        kind !== 'thinking' &&
        !row.virtualPart!.targets.length &&
        !(owner.operation?.attempts ?? []).some((member) =>
          member.events.some((event) =>
            event.evidenceRefs.some((ref) => ref.kind === row.virtualPart!.source),
          ),
        )
      )
        continue;
      if (kind === 'reply') {
        row.outputHistory = historicalOutput && (suppressOutput || canonicalReply);
        row.presentationHidden = !historicalOutput && (suppressOutput || canonicalReply);
        row.outputSuppressed = suppressOutput && !historicalOutput;
      }
      virtual.push(row);
      const materialAt = parseDecimal64(
        row.virtualPart!.targets[0]?.event.sequence ??
          (row.virtualPart!.source === 'model_output' ? owner.lastSequence : owner.firstSequence),
      );
      const beforeCanonicalReply =
        kind !== 'reply' && replyBoundary !== undefined && materialAt >= replyBoundary;
      order.set(row.id, {
        at: beforeCanonicalReply ? replyBoundary : materialAt,
        rank: beforeCanonicalReply ? position - kinds.length : position + 1,
      });
    }
  }
  if (!parts) return rows;
  // The source graph remains the material/causal owner. Only child-Agent boundaries
  // introduce nesting in the reading view; ordinary phases are siblings in their Run.
  const containers = new Map<string, WorkbenchRow>();
  for (const row of pending) {
    const originalParent = row.parentId;
    const container = originalParent ? containers.get(originalParent) : undefined;
    row.originalParentId = originalParent;
    if (container) row.parentId = container.id;
    if (
      row.kind === 'run' ||
      row.operation?.type === 'child' ||
      row.kind === 'child' ||
      (row.kind === 'session' && !container)
    )
      containers.set(row.id, row);
    else if (container) containers.set(row.id, container);
    if (row.kind === 'session' && container) row.presentationHidden = true;
    if (row.kind === 'model' && row.category === 'model' && !row.event) {
      row.presentationHidden = true;
      row.presentationRepresentativeId = `${row.id}:part:thinking`;
    }
  }
  for (const row of virtual) {
    const owner = rowById.get(row.virtualPart!.ownerId)!;
    row.originalParentId = owner.id;
    row.parentId = owner.parentId;
  }
  const flat = [...rows, ...virtual];
  const flatChildren = new Map<string, WorkbenchRow[]>();
  for (const row of flat)
    if (row.parentId) {
      const children = flatChildren.get(row.parentId) ?? [];
      children.push(row);
      flatChildren.set(row.parentId, children);
    }
  const roots = flat.filter((row) => !row.parentId || !rowById.has(row.parentId));
  for (let index = 0; index < roots.length; index++) {
    const row = roots[index]!;
    row.depth = row.parentId ? (rowById.get(row.parentId)?.depth ?? -1) + 1 : 0;
    for (const child of flatChildren.get(row.id) ?? []) roots.push(child);
  }
  return flat.sort((a, b) => {
    const left = order.get(a.id) ?? { at: parseDecimal64(a.firstSequence), rank: 0 },
      right = order.get(b.id) ?? { at: parseDecimal64(b.firstSequence), rank: 0 };
    return left.at < right.at
      ? -1
      : left.at > right.at
        ? 1
        : left.rank - right.rank || a.depth - b.depth || a.id.localeCompare(b.id);
  });
}
