import {
  type KnownTrajectoryPhase,
  parseDecimal64,
  projectTrajectory,
  type TrajectoryEvent,
  type TrajectoryProjection,
  type TrajectoryStep,
} from '@kite-ai/trajectory';

export interface TrajectoryTreeNode {
  id: string;
  parentId: string | null;
  kind: TrajectoryEvent['kind'] | 'session';
  label: string;
  phase?: KnownTrajectoryPhase;
  step?: TrajectoryStep;
  children: TrajectoryTreeNode[];
  /** Only this object's facts. Descendant facts remain owned by their original nodes. */
  sourceEventIds: string[];
  firstSequence: string;
  lastSequence: string;
  relationNotice?: string;
  /** Display classification proved from the exact saved check Command and parent target. */
  approvalCheck?: boolean;
  /** Shared immutable source order, not another retained copy of raw event bodies. */
  eventOrder: readonly string[];
}

const labels: Record<TrajectoryEvent['kind'], string> = {
  command: '命令',
  run: '执行轮次',
  message: '消息',
  model: '模型调用',
  tool: '工具调用',
  job: '后台执行',
  interaction: '授权与交互',
  child: '子 Agent 会话',
  context: '上下文',
  recovery: '恢复记录',
  artifact: '产物',
  verification: '结果核验',
  unknown: '未识别事件',
};
const isExecution = (step: TrajectoryStep) =>
  ['model', 'tool', 'job'].includes(step.kind) && step.executionId !== undefined;
const scopeKey = (origin: string | undefined, session: string, id: string) =>
  JSON.stringify([origin ?? null, session, id]);

function label(step: TrajectoryStep): string {
  if (step.kind === 'message')
    return step.messageRole === 'user'
      ? '用户消息'
      : step.messageRole === 'assistant'
        ? 'Agent 回复'
        : labels.message;
  if (step.kind === 'unknown' && step.sourceEventType)
    return `${step.identityConfidence === 'legacy_local' ? '旧记录' : labels.unknown} · ${step.sourceEventType}`;
  if (step.kind === 'model')
    return `${step.compressionTrigger === 'automatic' ? '自动压缩' : labels.model}${step.attempt === undefined ? '' : ` · 尝试 ${step.attempt}`}`;
  if (step.kind === 'context' && step.sourceEventType === 'context.compressed') return '压缩结果';
  if (step.kind === 'interaction' && step.interactionKind === 'approval') return '审批';
  if (step.kind === 'interaction' && step.interactionKind === 'plan_review') return '计划审批';
  if (step.kind === 'tool' || step.kind === 'job') {
    const name = step.definitionId?.split('/').at(-1);
    if (step.kind === 'job' && step.childSessionId) return `子 Agent${name ? ` · ${name}` : ''}`;
    return name || labels[step.kind];
  }
  if (step.kind === 'command' && step.commandType) return `命令 · ${step.commandType}`;
  return labels[step.kind];
}

/** All facts of this object and its descendants, in the original Decimal64 source order. */
export function trajectoryNodeEventIds(node: TrajectoryTreeNode): string[] {
  const members = new Set<string>();
  const pending = [node];
  while (pending.length) {
    const current = pending.pop()!;
    for (const eventId of current.sourceEventIds) members.add(eventId);
    for (const child of current.children) pending.push(child);
  }
  return node.eventOrder.filter((eventId) => members.has(eventId));
}

export interface TrajectoryTreeFilter {
  visibleNodeIds: ReadonlySet<string>;
  structuralNodeIds: ReadonlySet<string>;
  eventIds: ReadonlySet<string>;
}

function businessNode(node: TrajectoryTreeNode): boolean {
  if (['model', 'tool', 'job', 'child', 'message'].includes(node.kind)) return true;
  if (node.kind === 'interaction')
    return (
      node.step?.interactionKind === 'approval' || node.step?.interactionKind === 'plan_review'
    );
  return (
    node.kind === 'context' &&
    node.step?.sourceEventType === 'context.compressed' &&
    node.step.compressionTrigger === 'automatic'
  );
}

function verifiedParent(
  node: TrajectoryTreeNode,
  nodes: ReadonlyMap<string, TrajectoryTreeNode>,
): TrajectoryStep | undefined {
  const step = node.step;
  const parent = node.parentId ? nodes.get(node.parentId)?.step : undefined;
  if (
    step?.identityConfidence !== 'verified_origin' ||
    node.relationNotice ||
    parent?.identityConfidence !== 'verified_origin' ||
    !['tool', 'job'].includes(parent.kind) ||
    !step.parentExecutionId ||
    !step.parentExecutionOriginStoreId ||
    step.parentExecutionId !== parent.executionId ||
    step.parentExecutionOriginStoreId !== (parent.executionOriginStoreId ?? parent.originStoreId) ||
    step.sessionId !== parent.sessionId ||
    (step.executionOriginStoreId ?? step.originStoreId) !==
      (parent.executionOriginStoreId ?? parent.originStoreId)
  )
    return;
  return parent;
}

function markApprovalChecks(nodes: ReadonlyMap<string, TrajectoryTreeNode>): void {
  const commands = new Map<string, TrajectoryTreeNode | null>();
  for (const node of nodes.values()) {
    const step = node.step;
    if (
      step?.kind === 'command' &&
      step.identityConfidence === 'verified_origin' &&
      step.originStoreId &&
      step.commandId
    ) {
      const key = scopeKey(step.originStoreId, step.sessionId, step.commandId);
      commands.set(key, commands.has(key) ? null : node);
    }
  }
  for (const node of nodes.values()) {
    const step = node.step;
    if (
      step?.kind === 'model' &&
      !step.runId &&
      step.originStoreId &&
      verifiedParent(node, nodes) &&
      ((step.display?.kind === 'model' && step.display.operation === 'review') ||
        (step.commandId &&
          commands.get(scopeKey(step.originStoreId, step.sessionId, step.commandId))?.step
            ?.commandType === 'authorization.check'))
    )
      node.approvalCheck = true;
  }
}

/** Only sealed public ownership can classify auxiliary work; names alone are not proof. */
function auxiliaryNodes(root: TrajectoryTreeNode): Set<string> {
  const nodes = new Map<string, TrajectoryTreeNode>();
  const pending = [root];
  for (const node of pending) {
    nodes.set(node.id, node);
    for (const child of node.children) pending.push(child);
  }
  const result = new Set<string>();
  for (const node of nodes.values()) {
    const step = node.step;
    const parent = verifiedParent(node, nodes);
    if (
      step?.kind !== 'job' ||
      parent?.kind !== 'tool' ||
      step.childSessionId ||
      !step.runId ||
      !step.runOriginStoreId ||
      step.phase !== 'completed' ||
      step.recordedStatus !== 'succeeded' ||
      parent.phase !== 'completed' ||
      parent.recordedStatus !== 'succeeded' ||
      step.definitionVersion !== '1' ||
      parent.definitionVersion !== '1' ||
      step.runId !== parent.runId ||
      step.runOriginStoreId !== parent.runOriginStoreId
    )
      continue;
    const worktree =
      parent.definitionId === 'git.worktree' &&
      parent.display?.kind === 'worktree' &&
      step.definitionId === 'shell.command';
    const browser =
      parent.display?.kind === 'browser' &&
      ((parent.definitionId === 'browser.open' && step.definitionId === 'browser.session') ||
        (parent.definitionId === 'browser.execute' &&
          step.definitionId === 'browser.code_session'));
    if (worktree || browser) result.add(node.id);
  }
  return result;
}

/** A display index only. The original tree and each object's complete lifecycle stay unchanged. */
export function filterTrajectoryTree(
  root: TrajectoryTreeNode,
  mode: 'key_steps' | 'all_events',
): TrajectoryTreeFilter {
  const full = mode === 'all_events';
  const auxiliary = full ? new Set<string>() : auxiliaryNodes(root);
  const visibleNodeIds = new Set<string>(),
    structuralNodeIds = new Set<string>(),
    businessEvents = new Set<string>();
  const ordered: TrajectoryTreeNode[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (
      !full &&
      (node.step?.definitionId === 'builtin.session-title/generate' ||
        node.step?.definitionId === 'builtin.session-title/fallback')
    )
      continue;
    ordered.push(node);
    if (full || (businessNode(node) && !auxiliary.has(node.id)))
      for (const eventId of node.sourceEventIds) businessEvents.add(eventId);
    for (let index = node.children.length - 1; index >= 0; index--)
      pending.push(node.children[index]!);
  }
  for (let index = ordered.length - 1; index >= 0; index--) {
    const node = ordered[index]!;
    const business = businessNode(node) && !auxiliary.has(node.id);
    if (
      full ||
      node === root ||
      (!auxiliary.has(node.id) &&
        (business || node.children.some((child) => visibleNodeIds.has(child.id))))
    ) {
      visibleNodeIds.add(node.id);
      if (node.kind === 'session' || (!full && !business)) structuralNodeIds.add(node.id);
    }
  }
  return {
    visibleNodeIds,
    structuralNodeIds,
    eventIds: new Set(root.eventOrder.filter((eventId) => businessEvents.has(eventId))),
  };
}

/**
 * A complete prefix index builds the same tree regardless of which raw event page is loaded.
 * Relations come only from stored identities. Missing or cyclic links remain visible facts.
 */
export function buildTrajectoryTree(
  projection: TrajectoryProjection | null,
  events: readonly TrajectoryEvent[],
): { root: TrajectoryTreeNode; byId: Map<string, TrajectoryTreeNode> } {
  const at = projection?.atCursor ?? events.at(-1)?.sequence ?? '0';
  const visible = events.filter((event) => parseDecimal64(event.sequence) <= parseDecimal64(at));
  const indexed = projection ?? projectTrajectory(visible, { atCursor: at });
  const eventOrder = [...indexed.sourceEventIds];
  const knownEvents = new Set(eventOrder);
  for (const event of visible)
    if (!knownEvents.has(event.eventId)) {
      eventOrder.push(event.eventId);
      knownEvents.add(event.eventId);
    }
  const firstSequence = indexed.steps[0]?.firstSequence ?? visible[0]?.sequence ?? '0';
  const root: TrajectoryTreeNode = {
    id: 'session',
    parentId: null,
    kind: 'session',
    label: '当前会话',
    children: [],
    sourceEventIds: [],
    firstSequence,
    lastSequence: at,
    eventOrder,
  };
  const byId = new Map<string, TrajectoryTreeNode>([[root.id, root]]);
  const owners = new Set<string>();
  const steps = [...indexed.steps];
  const indexedFacts = new Set(steps.flatMap((step) => step.sourceEventIds));
  // A host can deliver raw records while rebuilding its index. Preserve these records as
  // independent nodes until the corresponding complete projection arrives.
  for (const event of visible)
    if (!indexedFacts.has(event.eventId))
      steps.push(...projectTrajectory([event], { atCursor: at }).steps);
  const rawById = new Map(visible.map((event) => [event.eventId, event]));
  for (const source of steps) {
    const raw = source.sourceEventIds
      .map((id) => rawById.get(id))
      .find((event) => event !== undefined);
    const step: TrajectoryStep = {
      ...source,
      ...(source.sourceEventType === undefined && raw
        ? { sourceEventType: raw.sourceEventType }
        : {}),
      ...(source.identityConfidence === undefined && raw
        ? { identityConfidence: raw.identityConfidence }
        : {}),
      ...(source.messageId === undefined && raw?.kind === 'message'
        ? { messageId: raw.attributes.messageId }
        : {}),
      ...(source.messageOriginStoreId === undefined &&
      raw?.kind === 'message' &&
      raw.messageOriginStoreId
        ? { messageOriginStoreId: raw.messageOriginStoreId }
        : {}),
      ...(source.messageRole === undefined && raw?.kind === 'message'
        ? { messageRole: raw.attributes.role }
        : {}),
      ...(source.messageSeq === undefined && raw?.kind === 'message'
        ? { messageSeq: raw.attributes.messageSeq }
        : {}),
      ...(source.messageRevision === undefined && raw?.kind === 'message'
        ? { messageRevision: raw.attributes.revision }
        : {}),
      ...(source.messageStatus === undefined && raw?.kind === 'message'
        ? { messageStatus: raw.attributes.status }
        : {}),
      ...(source.interactionKind === undefined &&
      raw?.kind === 'interaction' &&
      'interactionKind' in raw.attributes &&
      (raw.attributes.interactionKind === 'approval' ||
        raw.attributes.interactionKind === 'question' ||
        raw.attributes.interactionKind === 'plan_review')
        ? { interactionKind: raw.attributes.interactionKind }
        : {}),
      ...(source.compressionId === undefined &&
      raw &&
      'compressionId' in raw.attributes &&
      typeof raw.attributes.compressionId === 'string'
        ? { compressionId: raw.attributes.compressionId }
        : {}),
      ...(source.compressionTrigger === undefined &&
      raw &&
      'compressionTrigger' in raw.attributes &&
      (raw.attributes.compressionTrigger === 'automatic' ||
        raw.attributes.compressionTrigger === 'manual')
        ? { compressionTrigger: raw.attributes.compressionTrigger }
        : {}),
      ...(source.originStoreId === undefined && raw ? { originStoreId: raw.origin.storeId } : {}),
      ...(source.executionOriginStoreId === undefined && raw?.executionId
        ? { executionOriginStoreId: raw.executionOriginStoreId ?? raw.origin.storeId }
        : {}),
      ...(source.runOriginStoreId === undefined && raw?.runId
        ? { runOriginStoreId: raw.runOriginStoreId ?? raw.origin.storeId }
        : {}),
      ...(source.parentExecutionOriginStoreId === undefined && raw?.parentExecutionId
        ? { parentExecutionOriginStoreId: raw.parentExecutionOriginStoreId ?? raw.origin.storeId }
        : {}),
    };
    const sourceEventIds = step.sourceEventIds.filter((id) => {
      if (owners.has(id)) return false;
      owners.add(id);
      return true;
    });
    if (!sourceEventIds.length) continue;
    let id = step.stepId;
    while (byId.has(id)) id = `event:${sourceEventIds[0]}:${id}`;
    byId.set(id, {
      id,
      parentId: root.id,
      kind: step.kind,
      label: label(step),
      phase: step.phase,
      step,
      children: [],
      sourceEventIds,
      firstSequence: step.firstSequence,
      lastSequence: step.lastSequence,
      eventOrder,
    });
  }
  // Do not silently drop source IDs when an older/incomplete host index omitted their step.
  for (const eventId of eventOrder)
    if (!owners.has(eventId)) {
      const id = `unloaded:${eventId}`;
      byId.set(id, {
        id,
        parentId: root.id,
        kind: 'unknown',
        label: '原事件尚未载入',
        children: [],
        sourceEventIds: [eventId],
        firstSequence: '0',
        lastSequence: '0',
        relationNotice: '缺少此记录的对象索引，关联尚未核实。',
        eventOrder,
      });
    }
  const executions = new Map<string, TrajectoryTreeNode[]>();
  const runs = new Map<string, TrajectoryTreeNode[]>();
  const add = (index: Map<string, TrajectoryTreeNode[]>, key: string, node: TrajectoryTreeNode) => {
    const members = index.get(key) ?? [];
    members.push(node);
    index.set(key, members);
  };
  for (const node of byId.values()) {
    const step = node.step;
    if (!step) continue;
    if (isExecution(step))
      add(
        executions,
        scopeKey(
          step.executionOriginStoreId ?? step.originStoreId,
          step.sessionId,
          step.executionId!,
        ),
        node,
      );
    if (step.kind === 'run' && step.runId)
      add(
        runs,
        scopeKey(step.runOriginStoreId ?? step.originStoreId, step.sessionId, step.runId),
        node,
      );
  }
  const notice = (node: TrajectoryTreeNode, text: string) => {
    node.relationNotice = node.relationNotice ? `${node.relationNotice} ${text}` : text;
  };
  const one = (index: Map<string, TrajectoryTreeNode[]>, key: string) => {
    const matches = index.get(key);
    return matches?.length === 1 ? matches[0] : undefined;
  };
  const runFor = (step: TrajectoryStep) => {
    if (!step.runId) return root;
    const key = scopeKey(step.runOriginStoreId ?? step.originStoreId, step.sessionId, step.runId);
    const existing = one(runs, key);
    if (existing) return existing;
    if (runs.has(key)) return root;
    const id = `group:run:${key}`;
    const group: TrajectoryTreeNode = {
      id,
      parentId: root.id,
      kind: 'run',
      label: '执行轮次',
      children: [],
      sourceEventIds: [],
      firstSequence: step.firstSequence,
      lastSequence: step.lastSequence,
      relationNotice: '已记录所属轮次，轮次自身的生命周期尚未载入或未保存。',
      eventOrder,
    };
    byId.set(id, group);
    add(runs, key, group);
    return group;
  };
  for (const node of [...byId.values()]) {
    const step = node.step;
    if (!step || step.kind === 'run') continue;
    const fallback = runFor(step);
    node.parentId = fallback.id;
    const linkedExecution =
      step.kind === 'child'
        ? step.carrierExecutionId
        : step.kind === 'message'
          ? step.messageRole === 'assistant'
            ? step.executionId
            : undefined
          : isExecution(step)
            ? step.parentExecutionId
            : (step.executionId ?? step.parentExecutionId);
    if (linkedExecution) {
      const origin =
        isExecution(step) || (!step.executionId && step.parentExecutionId)
          ? (step.parentExecutionOriginStoreId ?? step.originStoreId)
          : (step.executionOriginStoreId ?? step.originStoreId);
      const parent = one(executions, scopeKey(origin, step.sessionId, linkedExecution));
      if (parent && (step.kind !== 'message' || parent.kind === 'model')) node.parentId = parent.id;
      else notice(node, '原关联执行不在当前范围内或关联不唯一。');
    } else if (!step.runId) notice(node, '所属轮次未记录，保留在会话下。');
  }
  // A child Session/Run is nested only under a recorded carrier relationship. An explicit
  // childRunId wins over a session-wide Job link, avoiding duplicate carrier/child branches.
  const bridges = [...byId.values()].filter(
    (node) => node.step?.childSessionId && ['job', 'child'].includes(node.step.kind),
  );
  const exactBridges = new Map<string, TrajectoryTreeNode[]>(),
    sessionBridges = new Map<string, TrajectoryTreeNode[]>();
  for (const bridge of bridges) {
    const step = bridge.step!;
    if (step.childRunId)
      add(
        exactBridges,
        scopeKey(step.originStoreId, step.childSessionId!, step.childRunId),
        bridge,
      );
    if (step.kind === 'job')
      add(sessionBridges, scopeKey(step.originStoreId, step.childSessionId!, ''), bridge);
  }
  for (const [key, candidates] of runs) {
    const [origin, sessionId, runId] = JSON.parse(key) as [string | null, string, string];
    const exact = exactBridges.get(scopeKey(origin ?? undefined, sessionId, runId)) ?? [];
    const matching = exact.length
      ? exact
      : (sessionBridges.get(scopeKey(origin ?? undefined, sessionId, '')) ?? []);
    for (const run of candidates)
      if (matching.length === 1 && matching[0]!.id !== run.id) run.parentId = matching[0]!.id;
      else if (matching.length > 1) notice(run, '子会话的承载关系不唯一，保留在会话下。');
  }
  // Break every member of a cycle rather than losing an unreachable subtree or selecting an
  // arbitrary parent as truth. The exact source IDs remain on their original object nodes.
  const done = new Set<string>();
  for (const node of byId.values()) {
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current: TrajectoryTreeNode | undefined = node;
    while (current && current.id !== root.id && !done.has(current.id)) {
      const cycle = positions.get(current.id);
      if (cycle !== undefined) {
        for (const id of path.slice(cycle)) {
          const member = byId.get(id)!;
          member.parentId = root.id;
          notice(member, '原父子关系存在循环，按独立记录保留。');
        }
        break;
      }
      positions.set(current.id, path.length);
      path.push(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    for (const id of path) done.add(id);
  }
  for (const node of byId.values())
    if (node !== root) (byId.get(node.parentId ?? '') ?? root).children.push(node);
  const sourceOrder = new Map(eventOrder.map((id, index) => [id, index]));
  const nodeOrder = new Map<string, number>();
  const pending: { node: TrajectoryTreeNode; visited: boolean }[] = [
    { node: root, visited: false },
  ];
  while (pending.length) {
    const { node, visited } = pending.pop()!;
    if (!visited) {
      pending.push({ node, visited: true });
      for (const child of node.children) pending.push({ node: child, visited: false });
      continue;
    }
    let order = node.sourceEventIds.reduce(
      (minimum, id) => Math.min(minimum, sourceOrder.get(id) ?? Number.MAX_SAFE_INTEGER),
      Number.MAX_SAFE_INTEGER,
    );
    for (const child of node.children) {
      order = Math.min(order, nodeOrder.get(child.id)!);
      if (node.kind === 'session' || !node.step) {
        if (parseDecimal64(child.firstSequence) < parseDecimal64(node.firstSequence))
          node.firstSequence = child.firstSequence;
        if (parseDecimal64(child.lastSequence) > parseDecimal64(node.lastSequence))
          node.lastSequence = child.lastSequence;
      }
    }
    node.children.sort((left, right) => nodeOrder.get(left.id)! - nodeOrder.get(right.id)!);
    nodeOrder.set(node.id, order);
  }
  markApprovalChecks(byId);
  return { root, byId };
}
