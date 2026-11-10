import type { WorkbenchRow, WorkbenchSummary } from './workbench';

const empty = (): WorkbenchSummary => ({
  model: 0,
  tool: 0,
  child: 0,
  approval: 0,
  compression: 0,
  actions: 0,
  userMessages: 0,
  assistantMessages: 0,
});

/** Scope membership comes from the original entity, not its display parent or fold state. */
export function attachWorkbenchSummaries(rows: WorkbenchRow[]): void {
  const byRun = new Map<string, WorkbenchSummary>();
  for (const row of rows)
    if (row.kind === 'run' && !row.event && row.runKey) byRun.set(row.runKey, empty());
  for (const row of rows) {
    if (
      !row.matched ||
      row.virtualPart ||
      (row.kind === 'message' && row.outputSuppressed) ||
      !row.runKey ||
      ['structure', 'administrative'].includes(row.category)
    )
      continue;
    const summary = byRun.get(row.runKey);
    if (!summary) continue;
    if (row.category === 'message') {
      if (row.step?.messageRole === 'user') summary.userMessages++;
      else if (row.step?.messageRole === 'assistant') summary.assistantMessages++;
    } else if (row.operation?.type === 'child' || row.kind === 'child') {
      summary.child++;
      summary.actions++;
    } else if (['model', 'tool', 'approval', 'compression'].includes(row.category)) {
      summary[row.category as 'model' | 'tool' | 'approval' | 'compression']++;
      summary.actions++;
    }
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const children = new Map<string, WorkbenchRow[]>();
  for (const row of rows) {
    row.summary =
      row.kind === 'run' && !row.event && row.runKey ? byRun.get(row.runKey) : undefined;
    if (!row.parentId) continue;
    const group = children.get(row.parentId) ?? [];
    group.push(row);
    children.set(row.parentId, group);
  }
  const childFor = new Map<string, WorkbenchRow>();
  const pending = rows.filter((row) => !row.parentId || !byId.has(row.parentId));
  for (let position = 0; position < pending.length; position++) {
    const row = pending[position]!;
    const inherited = row.parentId ? childFor.get(row.parentId) : undefined;
    const owner = row.operation?.type === 'child' || row.kind === 'child' ? row : inherited;
    if (owner) childFor.set(row.id, owner);
    if (row.kind === 'run' && !row.event && row.summary && inherited) {
      const keys = new Set<string>();
      let conflicting = false;
      for (const member of inherited.operation?.members ?? [inherited]) {
        const step = member.step;
        if (
          step?.identityConfidence !== 'verified_origin' ||
          !step.childSessionId ||
          !step.executionOriginStoreId
        )
          continue;
        const display = step.display;
        if (
          (display?.targetSessionId && display.targetSessionId !== step.childSessionId) ||
          (display?.targetExecutionOriginStoreId &&
            display.targetExecutionOriginStoreId !== step.executionOriginStoreId) ||
          (display?.targetExecutionId &&
            display.targetExecutionId !== step.executionId &&
            display.targetExecutionId !== step.carrierExecutionId)
        )
          conflicting = true;
        for (const runId of [step.childRunId, display?.targetRunId])
          if (runId)
            keys.add(JSON.stringify([step.executionOriginStoreId, step.childSessionId, runId]));
      }
      if (!conflicting && keys.size === 1 && keys.has(row.runKey!))
        inherited.summary = { ...row.summary };
    }
    for (const child of children.get(row.id) ?? []) pending.push(child);
  }
}
