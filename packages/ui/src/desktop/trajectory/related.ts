import { parseDecimal64, type TrajectoryProjection } from '@kite-ai/trajectory';
import { buildTrajectoryTree, type TrajectoryTreeNode } from './tree';

export interface RelatedTrajectoryScope {
  /** The original verified carrier/child node, never an inferred latest child execution. */
  parentNodeId: string;
  projection: TrajectoryProjection;
}

/** One current, owner-sealed carrier target. Persisted UI choices alone are never read admission. */
export function trajectoryChildScopeTarget(
  parentProjection: TrajectoryProjection | null,
  tree: { byId: ReadonlyMap<string, TrajectoryTreeNode> },
  parentNodeId: string,
): { parentNodeId: string; sessionId: string; runId: string; carrierExecutionId: string } | null {
  const parent = tree.byId.get(parentNodeId),
    step = parent?.step;
  if (
    !parentProjection ||
    !parent ||
    !['job', 'child'].includes(parent.kind) ||
    step?.identityConfidence !== 'verified_origin' ||
    !step.childSessionId ||
    step.childSessionId === step.sessionId ||
    !(step.carrierExecutionId ?? step.executionId) ||
    !step.executionOriginStoreId
  )
    return null;
  const carrierOrigin = step.executionOriginStoreId,
    childSessionId = step.childSessionId;
  const upper = parseDecimal64(parentProjection.atCursor),
    ownFacts = new Set(parent.sourceEventIds);
  const sealedOrigins = new Set(
    (parentProjection.eventIndex ?? [])
      .filter(
        (event) =>
          ownFacts.has(event.eventId) &&
          event.executionOriginStoreId !== undefined &&
          parseDecimal64(event.sequence) <= upper,
      )
      .map((event) => event.executionOriginStoreId),
  );
  if (
    sealedOrigins.size !== 1 ||
    !sealedOrigins.has(carrierOrigin) ||
    (step.display?.targetSessionId !== undefined &&
      step.display.targetSessionId !== childSessionId) ||
    (step.display?.targetExecutionOriginStoreId !== undefined &&
      step.display.targetExecutionOriginStoreId !== carrierOrigin) ||
    (step.display?.targetExecutionId !== undefined &&
      step.display.targetExecutionId !== (step.carrierExecutionId ?? step.executionId))
  )
    return null;
  const exactRuns = new Set<string>();
  if (step.childRunId) exactRuns.add(step.childRunId);
  if (step.display?.targetRunId) exactRuns.add(step.display.targetRunId);
  if (step.executionId)
    for (const node of tree.byId.values()) {
      const child = node.step;
      if (
        child?.kind === 'child' &&
        child.carrierExecutionId === step.executionId &&
        child.sessionId === step.sessionId &&
        child.childSessionId === childSessionId &&
        child.executionOriginStoreId === carrierOrigin &&
        child.childRunId
      )
        exactRuns.add(child.childRunId);
    }
  return exactRuns.size === 1
    ? {
        parentNodeId,
        sessionId: childSessionId,
        runId: [...exactRuns][0]!,
        carrierExecutionId: (step.carrierExecutionId ?? step.executionId)!,
      }
    : null;
}

/** Joins already-authorized, fixed-prefix scope reads for display. It performs no reads. */
export function composeTrajectoryScopes(
  parentProjection: TrajectoryProjection | null,
  related: readonly RelatedTrajectoryScope[] = [],
): { projection: TrajectoryProjection | null; tree: ReturnType<typeof buildTrajectoryTree> } {
  const tree = buildTrajectoryTree(parentProjection, []);
  if (!parentProjection || !related.length) return { projection: parentProjection, tree };
  const upper = parseDecimal64(parentProjection.atCursor);
  const notices = (node: TrajectoryTreeNode | undefined, reason: string) => {
    if (node) node.relationNotice = [node.relationNotice, reason].filter(Boolean).join(' ');
  };
  const events = new Map(
    (parentProjection.eventIndex ?? []).map((event) => [event.eventId, event]),
  );
  const steps = [...parentProjection.steps],
    openStepIds = [...parentProjection.openStepIds];
  const accepted: TrajectoryProjection[] = [],
    seenScopes = new Map<string, string>();
  const candidates = related.map((entry) => {
    const parent = tree.byId.get(entry.parentNodeId),
      step = parent?.step;
    const target = trajectoryChildScopeTarget(parentProjection, tree, entry.parentNodeId);
    const childSessionId = target?.sessionId;
    const carrierOrigin = step?.executionOriginStoreId;
    const run = target?.runId;
    const projection = entry.projection;
    const validPrefix =
      projection.atCursor === parentProjection.atCursor &&
      projection.projectorVersion === parentProjection.projectorVersion &&
      (projection.eventIndex !== undefined || projection.sourceEventIds.length === 0) &&
      (parentProjection.eventIndex !== undefined || parentProjection.sourceEventIds.length === 0);
    const validScope =
      target !== null &&
      step !== undefined &&
      projection.steps.every(
        (value) =>
          value.sessionId === childSessionId &&
          value.workspaceId === step.workspaceId &&
          (value.runId === undefined ||
            (value.runId === run && value.runOriginStoreId === carrierOrigin)),
      ) &&
      (projection.eventIndex ?? []).every(
        (event) =>
          event.sessionId === childSessionId &&
          event.workspaceId === step.workspaceId &&
          (event.runId === undefined ||
            (event.runId === run && event.runOriginStoreId === carrierOrigin)) &&
          parseDecimal64(event.sequence) <= upper,
      );
    return {
      entry,
      parent,
      run,
      childSessionId,
      carrierOrigin,
      carrierExecutionId: target?.carrierExecutionId,
      valid: !!validPrefix && !!validScope,
      key: JSON.stringify([carrierOrigin ?? null, childSessionId ?? null, run ?? null]),
    };
  });
  const owners = new Map<string, Set<string>>(),
    fingerprints = new Map<string, Set<string>>();
  for (const candidate of candidates)
    if (candidate.valid) {
      const value = owners.get(candidate.key) ?? new Set<string>();
      value.add(candidate.entry.parentNodeId);
      owners.set(candidate.key, value);
      const fingerprintsForScope = fingerprints.get(candidate.key) ?? new Set<string>();
      fingerprintsForScope.add(JSON.stringify(candidate.entry.projection.sourceEventIds));
      fingerprints.set(candidate.key, fingerprintsForScope);
    }
  for (const candidate of candidates) {
    const { entry, parent } = candidate;
    if (!candidate.valid) {
      notices(parent ?? tree.root, '子执行范围、固定位置或准确轮次关联尚未核实，未拼接内部记录。');
      continue;
    }
    if ((owners.get(candidate.key)?.size ?? 0) > 1) {
      notices(parent, '同一子执行对应多个承载节点，未选择任意父级。');
      continue;
    }
    if ((fingerprints.get(candidate.key)?.size ?? 0) > 1) {
      notices(parent, '同一子执行的固定位置记录冲突，未拼接内部记录。');
      continue;
    }
    const fingerprint = JSON.stringify(entry.projection.sourceEventIds);
    const previous = seenScopes.get(candidate.key);
    if (previous !== undefined) {
      if (previous !== fingerprint)
        notices(parent, '同一子执行的固定位置记录冲突，保留首次核实范围。');
      continue;
    }
    const childEvents = entry.projection.eventIndex ?? [];
    const ids = new Set(childEvents.map((event) => event.eventId)),
      sequences = new Set(childEvents.map((event) => event.sequence));
    const occupied = new Set([...events.values()].map((event) => event.sequence));
    if (
      ids.size !== childEvents.length ||
      sequences.size !== childEvents.length ||
      childEvents.some((event) => events.has(event.eventId) || occupied.has(event.sequence))
    ) {
      notices(parent, '子执行与已有范围的记录身份冲突，未拼接重复记录。');
      continue;
    }
    const childTree = buildTrajectoryTree(entry.projection, []);
    const localExecutions = new Set(
      [...childTree.byId.values()].flatMap((node) =>
        node.step?.executionId && ['model', 'tool', 'job'].includes(node.step.kind)
          ? [JSON.stringify([node.step.executionOriginStoreId, node.step.executionId])]
          : [],
      ),
    );
    const childRootId = childTree.root.id;
    const prefix = `scope:${JSON.stringify([candidate.key, entry.parentNodeId])}:`;
    const nodeIds = new Map([...childTree.byId.keys()].map((id) => [id, prefix + id]));
    if ([...nodeIds.values()].some((id) => tree.byId.has(id))) {
      notices(parent, '子执行的展示身份冲突，未覆盖已有节点。');
      continue;
    }
    for (const node of childTree.byId.values()) {
      const originalId = node.id;
      const step = node.step;
      // A separately read child scope cannot contain its parent-Session carrier.
      // Only the already-verified external boundary resolves this one missing-parent notice.
      if (
        step?.identityConfidence === 'verified_origin' &&
        ['model', 'tool', 'job'].includes(step.kind) &&
        step.parentExecutionId === candidate.carrierExecutionId &&
        step.parentExecutionOriginStoreId === candidate.carrierOrigin &&
        step.sessionId === candidate.childSessionId &&
        step.runId === candidate.run &&
        step.runOriginStoreId === candidate.carrierOrigin &&
        !localExecutions.has(
          JSON.stringify([candidate.carrierOrigin, candidate.carrierExecutionId]),
        )
      ) {
        const notice = node.relationNotice
          ?.replace('原关联执行不在当前范围内或关联不唯一。', '')
          .trim();
        node.relationNotice = notice || undefined;
      }
      node.id = nodeIds.get(originalId)!;
      node.parentId =
        originalId === childRootId
          ? entry.parentNodeId
          : node.parentId
            ? nodeIds.get(node.parentId)!
            : entry.parentNodeId;
      if (originalId === childRootId) node.label = '子 Agent 执行';
      tree.byId.set(node.id, node);
    }
    parent!.children.push(childTree.root);
    for (const step of entry.projection.steps)
      steps.push({ ...step, stepId: nodeIds.get(step.stepId) ?? prefix + step.stepId });
    for (const id of entry.projection.openStepIds) openStepIds.push(nodeIds.get(id) ?? prefix + id);
    for (const event of childEvents) events.set(event.eventId, event);
    seenScopes.set(candidate.key, fingerprint);
    accepted.push(entry.projection);
  }
  if (!accepted.length) return { projection: parentProjection, tree };
  const eventIndex = [...events.values()].sort((a, b) => {
    const left = parseDecimal64(a.sequence),
      right = parseDecimal64(b.sequence);
    return left < right ? -1 : left > right ? 1 : a.eventId.localeCompare(b.eventId);
  });
  const sourceEventIds = eventIndex.map((event) => event.eventId);
  for (const node of tree.byId.values()) node.eventOrder = sourceEventIds;
  const integrity = {
    ...parentProjection.integrity,
    reasons: [...parentProjection.integrity.reasons],
  };
  for (const projection of accepted) {
    if (projection.integrity.facts !== 'complete') integrity.facts = projection.integrity.facts;
    if (projection.integrity.identityConfidence === 'legacy_local')
      integrity.identityConfidence = 'legacy_local';
    for (const reason of projection.integrity.reasons)
      if (!integrity.reasons.includes(reason)) integrity.reasons.push(reason);
  }
  return {
    tree,
    projection: {
      ...parentProjection,
      steps,
      openStepIds,
      eventIndex,
      sourceEventIds,
      integrity,
      completePrefix:
        parentProjection.completePrefix === true &&
        accepted.every((value) => value.completePrefix === true),
    },
  };
}
