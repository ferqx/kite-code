import { parseDecimal64 } from '@kite-ai/trajectory';
import type { WorkbenchOperation, WorkbenchOperationMember, WorkbenchRow } from './workbench';

const display = (row: WorkbenchRow) => row.step?.display;
const origin = (row: WorkbenchRow) => row.step?.executionOriginStoreId ?? row.step?.originStoreId;
const key = (store: string | undefined, session: string | undefined, execution: string) =>
  JSON.stringify([store ?? null, session ?? null, execution]);
const verified = (row: WorkbenchRow) => row.step?.identityConfidence === 'verified_origin';
const compare = (a: WorkbenchRow, b: WorkbenchRow) => {
  const left = parseDecimal64(a.firstSequence),
    right = parseDecimal64(b.firstSequence);
  return left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id);
};
const snapshot = (row: WorkbenchRow): WorkbenchOperationMember => ({
  id: row.id,
  nodeId: row.nodeId,
  parentId: row.parentId,
  kind: row.kind,
  label: row.label,
  category: row.category,
  step: row.step,
  phase: row.phase,
  events: row.events,
  firstSequence: row.firstSequence,
  lastSequence: row.lastSequence,
  interval: row.interval,
  ...(row.runKey ? { runKey: row.runKey } : {}),
});
const observer = (row: WorkbenchRow) => {
  const value = display(row);
  return (
    value &&
    ['shell', 'task'].includes(value.kind) &&
    ['read', 'wait', 'stop', 'events', 'list'].includes(value.operation ?? '')
  );
};

/** A display-only union. Original members, event owners and material identities remain intact. */
export function groupWorkbenchOperations(source: readonly WorkbenchRow[]): {
  rows: WorkbenchRow[];
  aliases: ReadonlyMap<string, string>;
} {
  const originals = new Map(source.map((row) => [row.id, row]));
  const union = new Map(source.map((row) => [row.id, row.id]));
  const find = (id: string): string => {
    let root = id;
    while (union.get(root) && union.get(root) !== root) root = union.get(root)!;
    while (union.get(id) && union.get(id) !== id) {
      const next = union.get(id)!;
      union.set(id, root);
      id = next;
    }
    return root;
  };
  const join = (a: WorkbenchRow, b: WorkbenchRow) => union.set(find(b.id), find(a.id));
  const executions = new Map<string, WorkbenchRow[]>();
  for (const row of source)
    if (
      ['model', 'tool', 'job'].includes(row.kind) &&
      row.step?.executionId &&
      verified(row) &&
      !row.event
    ) {
      const id = key(origin(row), row.step.sessionId, row.step.executionId);
      const group = executions.get(id) ?? [];
      group.push(row);
      executions.set(id, group);
    }
  const execution = (id: string) => {
    const matches = executions.get(id);
    return matches?.length === 1 ? matches[0] : undefined;
  };
  const retryParents = new Map<string, WorkbenchRow>(),
    retryChildren = new Map<string, number>();
  for (const row of source) {
    const step = row.step;
    if (
      row.kind !== 'model' ||
      !verified(row) ||
      !step?.previousExecutionId ||
      !step.previousExecutionOriginStoreId ||
      !row.runKey
    )
      continue;
    const previous = execution(
      key(step.previousExecutionOriginStoreId, step.sessionId, step.previousExecutionId),
    );
    if (
      previous?.kind !== 'model' ||
      previous.category !== row.category ||
      previous.runKey !== row.runKey ||
      compare(previous, row) >= 0
    )
      continue;
    retryParents.set(row.id, previous);
    retryChildren.set(previous.id, (retryChildren.get(previous.id) ?? 0) + 1);
  }
  // Source order above rejects cycles; a fork is not a linear transport retry history.
  for (const row of source) {
    const previous = retryParents.get(row.id);
    if (!previous || retryChildren.get(previous.id) !== 1) continue;
    join(previous, row);
  }
  // Compression generation/publication is one semantic operation, not two user steps.
  const compressions = new Map<string, WorkbenchRow[]>();
  for (const row of source)
    if (verified(row) && row.category === 'compression' && row.step?.compressionId) {
      const linked = row.step.executionId
        ? execution(key(origin(row), row.step.sessionId, row.step.executionId))
        : undefined;
      const id = JSON.stringify([
        origin(row) ?? null,
        row.step.sessionId,
        row.step.compressionId,
        linked ? find(linked.id) : null,
      ]);
      const group = compressions.get(id) ?? [];
      group.push(row);
      compressions.set(id, group);
    }
  for (const group of compressions.values()) {
    const models = group.filter((row) => row.kind === 'model');
    if (models.length && new Set(models.map((row) => find(row.id))).size === 1)
      for (const row of group) join(models[0]!, row);
  }
  // A Job is part of its original launch only when the sealed owner identifies the same kind.
  for (const row of source) {
    if (!verified(row)) continue;
    const info = display(row),
      step = row.step;
    if (
      row.kind === 'tool' &&
      info &&
      ['shell', 'task'].includes(info.kind) &&
      !observer(row) &&
      info.targetExecutionId
    ) {
      const target = execution(
        key(
          info.targetExecutionOriginStoreId ?? origin(row),
          step?.sessionId,
          info.targetExecutionId,
        ),
      );
      if (
        target?.kind === 'job' &&
        target.step?.parentExecutionId === step?.executionId &&
        target.step?.parentExecutionOriginStoreId === origin(row) &&
        display(target)?.kind === info.kind
      )
        join(row, target);
    }
    if (
      row.kind === 'job' &&
      step?.parentExecutionId &&
      info &&
      ['shell', 'task'].includes(info.kind)
    ) {
      const parent = execution(
        key(
          step.parentExecutionOriginStoreId ?? step.originStoreId,
          step.sessionId,
          step.parentExecutionId,
        ),
      );
      if (parent?.kind === 'tool' && display(parent)?.kind === info.kind && !observer(parent))
        join(parent, row);
    }
    if (row.kind === 'child' && step?.carrierExecutionId) {
      const carrier = execution(
        key(
          step.executionOriginStoreId ?? step.originStoreId,
          step.sessionId,
          step.carrierExecutionId,
        ),
      );
      if (carrier?.kind === 'job' && carrier.step?.childSessionId === step.childSessionId)
        join(carrier, row);
    }
  }
  // Read/wait/stop are observations of a sealed target, never inferred from command text.
  for (const row of source) {
    const info = display(row);
    if (!verified(row) || !observer(row) || !info?.targetExecutionId) continue;
    const target = execution(
      key(
        info.targetExecutionOriginStoreId ?? origin(row),
        row.step?.sessionId,
        info.targetExecutionId,
      ),
    );
    if (
      !target ||
      !['tool', 'job'].includes(target.kind) ||
      display(target)?.kind !== info.kind ||
      target.id === row.id
    )
      continue;
    join(target, row);
  }
  const groups = new Map<string, WorkbenchRow[]>();
  for (const row of source) {
    const id = find(row.id),
      group = groups.get(id) ?? [];
    group.push(row);
    groups.set(id, group);
  }
  const aliases = new Map<string, string>(),
    rows: WorkbenchRow[] = [];
  for (const members of groups.values()) {
    members.sort(compare);
    const models = members.filter((row) => row.kind === 'model');
    const shell = members.some((row) => display(row)?.kind === 'shell');
    const child = members.some(
      (row) => row.kind === 'child' || (row.kind === 'job' && row.step?.childSessionId),
    );
    const compression = members.some((row) => row.category === 'compression');
    const starters = members.filter((row) => row.kind === 'tool' && !observer(row));
    const anchor = models[0] ?? starters[0] ?? members[0]!;
    let primary = models.at(-1) ?? members.find((row) => row.kind === 'job') ?? anchor;
    if (!models.length && !shell && !child) primary = anchor;
    for (const member of members) {
      aliases.set(member.id, anchor.id);
      if (member.id === member.nodeId) aliases.set(member.nodeId, anchor.id);
    }
    const operationType: WorkbenchOperation['type'] | undefined = compression
      ? 'compression'
      : models.length
        ? 'model'
        : shell
          ? 'shell'
          : child
            ? 'child'
            : anchor.kind === 'tool' || anchor.kind === 'job'
              ? 'tool'
              : undefined;
    if (!operationType) {
      rows.push({ ...anchor });
      continue;
    }
    const snapshots = members.map(snapshot);
    const attempts = snapshots.filter((row) => row.kind === 'model');
    const lastRetry = primary.events
      .filter((event) => event.kind === 'model' && event.attributes.retryAttempt !== undefined)
      .at(-1);
    const retryAttempt =
      lastRetry?.kind === 'model' ? lastRetry.attributes.retryAttempt : undefined;
    const attemptsComplete = !models[0]?.step?.previousExecutionId;
    const reconnectCount =
      retryAttempt === undefined
        ? attemptsComplete
          ? Math.max(0, attempts.length - 1)
          : undefined
        : retryAttempt - 1;
    const events = members
      .flatMap((row) => row.events)
      .sort((a, b) => {
        const left = parseDecimal64(a.sequence),
          right = parseDecimal64(b.sequence);
        return left < right ? -1 : left > right ? 1 : 0;
      });
    const start = members
      .filter((row) => !observer(row))
      .find((row) => row.interval.startAt !== undefined);
    const interval =
      start &&
      primary.interval.endAt !== undefined &&
      start.interval.startAt !== undefined &&
      start.interval.originStoreId === primary.interval.originStoreId &&
      primary.interval.endAt >= start.interval.startAt
        ? {
            ...primary.interval,
            startAt: start.interval.startAt,
            startEventId: start.interval.startEventId,
            durationMs: primary.interval.endAt - start.interval.startAt,
          }
        : primary.interval;
    rows.push({
      ...anchor,
      step: primary.step,
      phase: primary.phase,
      interval,
      kind: child ? 'job' : compression && models.length ? 'model' : anchor.kind,
      category: compression ? 'compression' : child || shell ? 'tool' : anchor.category,
      events,
      lastSequence: events.at(-1)?.sequence ?? primary.lastSequence,
      relatedNodeIds: [...new Set(members.flatMap((row) => row.relatedNodeIds))],
      operation: {
        type: operationType,
        primaryNodeId: primary.nodeId,
        memberNodeIds: members.map((row) => row.nodeId),
        members: snapshots,
        attempts,
        observations: snapshots.filter((member) => observer(originals.get(member.id)!)),
        ...(models.length ? { reconnectCount, attemptsComplete } : {}),
      },
    });
  }
  const groupedById = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    let parent = row.parentId;
    const seen = new Set<string>();
    while (parent && aliases.get(parent) === row.id && !seen.has(parent)) {
      seen.add(parent);
      parent = originals.get(parent)?.parentId ?? null;
    }
    row.parentId = parent ? (aliases.get(parent) ?? parent) : null;
    row.relatedNodeIds = [...new Set(row.relatedNodeIds.map((id) => aliases.get(id) ?? id))].filter(
      (id) => id !== row.id,
    );
  }
  const children = new Map<string, WorkbenchRow[]>();
  for (const row of rows)
    if (row.parentId) {
      const group = children.get(row.parentId) ?? [];
      group.push(row);
      children.set(row.parentId, group);
    }
  const pending = rows.filter((row) => !row.parentId || !groupedById.has(row.parentId));
  for (const row of pending) row.depth = 0;
  for (let index = 0; index < pending.length; index++) {
    const parent = pending[index]!;
    for (const child of children.get(parent.id) ?? []) {
      child.depth = parent.depth + 1;
      pending.push(child);
    }
  }
  rows.sort(compare);
  return { rows, aliases };
}
