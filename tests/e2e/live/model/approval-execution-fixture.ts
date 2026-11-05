import { isDeepStrictEqual } from 'node:util';
import type { ExecutionRecord, SessionLogPage, Store } from '@kite-ai/agent/storage';

/** Fresh live Stores append these creation events in the same order as Execution rowid.
 * Policy/dispatch/status logs are not new Executions. Membership is fixed at upperCursor;
 * full records are current observations fetched after the complete directory is collected.
 */
export async function* readLiveSessionLogPages(
  store: Pick<Store, 'getSessionLogs'>,
  input: {
    expectedStoreId: string;
    sessionId: string;
    subjectId: string;
    upperCursor?: string;
    signal?: AbortSignal;
  },
): AsyncGenerator<SessionLogPage> {
  let afterCursor = '0';
  let upperCursor = input.upperCursor;
  const cursor = (value: string) => {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) throw Error('live_execution_directory_cursor_invalid');
    return BigInt(value);
  };
  for (;;) {
    input.signal?.throwIfAborted();
    const page = await store.getSessionLogs({
      expectedStoreId: input.expectedStoreId,
      sessionId: input.sessionId,
      subjectId: input.subjectId,
      afterCursor,
      ...(upperCursor === undefined ? {} : { upperCursor }),
      limit: 200,
    });
    input.signal?.throwIfAborted();
    upperCursor ??= page.upperCursor;
    if (
      page.storeId !== input.expectedStoreId ||
      page.sessionId !== input.sessionId ||
      page.upperCursor !== upperCursor ||
      cursor(page.snapshotCursor) < cursor(upperCursor) ||
      cursor(page.replayFloor) > 0n
    )
      throw Error('live_execution_directory_snapshot_incomplete');
    let previous = cursor(afterCursor);
    for (const entry of page.entries) {
      const current = cursor(entry.cursor);
      if (
        entry.sessionId !== input.sessionId ||
        current <= previous ||
        current > cursor(upperCursor)
      )
        throw Error('live_execution_directory_page_invalid');
      previous = current;
    }
    yield page;
    if (page.complete) {
      if (page.nextAfterCursor !== null) throw Error('live_execution_directory_page_invalid');
      break;
    }
    if (
      page.nextAfterCursor === null ||
      cursor(page.nextAfterCursor) <= cursor(afterCursor) ||
      page.nextAfterCursor !== page.entries.at(-1)?.cursor
    )
      throw Error('live_execution_directory_cursor_stalled');
    afterCursor = page.nextAfterCursor;
  }
}

export async function readLiveExecutionDirectory(
  store: Pick<Store, 'getSessionLogs' | 'getExecution'>,
  input: Parameters<typeof readLiveSessionLogPages>[1],
): Promise<{ upperCursor: string; executions: ExecutionRecord[] }> {
  let upperCursor = input.upperCursor ?? '0';
  const ids = new Set<string>();
  for await (const page of readLiveSessionLogPages(store, input)) {
    upperCursor = page.upperCursor;
    for (const entry of page.entries) {
      if (!['execution.planned', 'action.planned'].includes(entry.type)) continue;
      if (
        entry.category !== 'execution' ||
        entry.objectId === 'unavailable' ||
        entry.details.executionId !== entry.objectId
      )
        throw Error('live_execution_directory_creation_unavailable');
      ids.add(entry.objectId);
    }
  }
  const executions: ExecutionRecord[] = [];
  for (const id of ids) {
    input.signal?.throwIfAborted();
    const execution = await store.getExecution(id);
    input.signal?.throwIfAborted();
    if (
      !execution ||
      execution.id !== id ||
      execution.sessionId !== input.sessionId ||
      execution.originStoreId !== input.expectedStoreId
    )
      throw Error(`live_execution_directory_original_missing:${id}`);
    executions.push(execution);
  }
  return { upperCursor, executions };
}

/** An observed diagnostic line, not the same text quoted by inspecting the script. */
export function hasValidatorDiagnostic(
  output: { stdout: string; stderr: string },
  code: 'INPUT_NOT_READY' | 'SNAPSHOT_MISSING',
): boolean {
  return [output.stdout, output.stderr].some((stream) =>
    stream.split(/\r?\n/u).some((line) => line.startsWith(`${code}:`)),
  );
}

/** Core's recorded reviewer deadline abort is distinct from a Provider failure. */
export function approvalTimeoutRequestIds(
  executions: readonly {
    id: string;
    kind: string;
    status: string;
    parentExecutionId?: string | null;
    authorization?: { check?: { executionId: string } };
    result?: unknown;
  }[],
): Set<string> {
  const byId = new Map(executions.map((execution) => [execution.id, execution]));
  return new Set(
    executions
      .filter((execution) => {
        const target = execution.parentExecutionId ? byId.get(execution.parentExecutionId) : null;
        const result = execution.result as { code?: unknown } | null;
        return (
          execution.kind === 'model' &&
          execution.status === 'failed' &&
          result?.code === 'authorization_check_timeout' &&
          target?.authorization?.check?.executionId === execution.id
        );
      })
      .map((execution) => execution.id),
  );
}

export interface NaturalChildEvidence {
  id: string;
  sessionId: string;
  childSessionId: string | null;
  originCommandId: string;
  status: string;
  resultRevision: string;
  reference: { commandId?: unknown; runId?: unknown; childSessionId?: unknown };
  parent: {
    id: string;
    sessionId: string;
    kind: string;
    definitionId: string;
    input: unknown;
  } | null;
  operation: {
    parentExecutionId?: unknown;
    followUp?: {
      previousCommandId?: unknown;
      previousExecutionId?: unknown;
      childSessionId?: unknown;
      afterRunId?: unknown;
    };
  };
  childRun: { id: string; sessionId: string; status: string; isActive: boolean } | null;
  acceptance: {
    resultRevision: string;
    sourceId: string;
    run: { id: string; sessionId: string; status: string; isActive: boolean } | null;
    sourceObserved: boolean;
  } | null;
}

/** One collaborator may have several real turns; a second spawn is never a continuation. */
export function naturalChildIdentity(evidence: readonly NaturalChildEvidence[]): {
  childSessionId: string;
  spawnExecutionId: string;
} {
  const fail = (): never => {
    throw new Error('natural-child-original-and-successor-evidence');
  };
  if (!evidence.length) return fail();
  const children = new Set(evidence.map((row) => row.childSessionId));
  const childSessionId = evidence[0]!.childSessionId;
  if (!childSessionId || children.size !== 1) return fail();
  const originals = evidence.filter((row) => !row.operation.followUp);
  if (originals.length !== 1) return fail();
  const original = originals[0]!;
  const byId = new Map(evidence.map((row) => [row.id, row]));
  if (byId.size !== evidence.length) return fail();
  const successors = new Set<string>();
  for (const row of evidence) {
    if (
      row.sessionId !== 's' ||
      row.status !== 'succeeded' ||
      !row.parent ||
      row.parent.sessionId !== 's' ||
      row.parent.kind !== 'tool' ||
      row.operation.parentExecutionId !== row.parent.id ||
      row.reference.childSessionId !== childSessionId ||
      row.reference.commandId !== `child-start-${row.id}` ||
      row.childRun?.id !== row.reference.runId ||
      row.childRun?.sessionId !== childSessionId ||
      row.childRun?.status !== 'completed' ||
      row.childRun.isActive ||
      row.acceptance?.resultRevision !== row.resultRevision ||
      !row.acceptance?.sourceId ||
      !row.acceptance.sourceObserved ||
      row.acceptance.run?.sessionId !== 's' ||
      row.acceptance.run.status !== 'completed' ||
      row.acceptance.run.isActive
    )
      return fail();
    const followUp = row.operation.followUp;
    if (!followUp) {
      if (row.parent.definitionId !== 'task.spawn') return fail();
      continue;
    }
    const previous = byId.get(String(followUp.previousExecutionId));
    const input = row.parent.input as { agentId?: unknown } | null;
    if (
      row.parent.definitionId !== 'task.follow_up' ||
      input?.agentId !== childSessionId ||
      !previous ||
      previous.id === row.id ||
      followUp.previousCommandId !== previous.originCommandId ||
      followUp.afterRunId !== previous.childRun?.id ||
      followUp.childSessionId !== childSessionId ||
      successors.has(previous.id)
    )
      return fail();
    successors.add(previous.id);
    // Every continuation must lead to the original spawn, without a cycle.
    const visited = new Set([row.id]);
    let ancestor: NaturalChildEvidence | undefined = previous;
    while (ancestor && ancestor.id !== original.id) {
      if (visited.has(ancestor.id)) return fail();
      visited.add(ancestor.id);
      ancestor = byId.get(String(ancestor.operation.followUp?.previousExecutionId));
    }
    if (!ancestor) return fail();
  }
  return { childSessionId, spawnExecutionId: original.id };
}
/** Independent live-test oracle: display text is absent only from known Shell risk inputs. */
export function expectedShellRiskOperationInput(target: {
  kind: string;
  definitionId: string;
  definitionVersion: string;
  input: unknown;
}): unknown {
  if (
    target.kind !== 'tool' ||
    target.definitionVersion !== '1' ||
    !['shell.execute', 'shell.launch'].includes(target.definitionId) ||
    !target.input ||
    typeof target.input !== 'object' ||
    Array.isArray(target.input)
  )
    return target.input;
  const { description: _display, ...input } = target.input as Record<string, unknown>;
  return input;
}

export function approvalReviewerTimeoutMs(value?: string): number {
  if (value === undefined) return 30_000;
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 30_000)
    throw Error('live_approval_execution_review_timeout_invalid');
  return Number(value);
}

/** The adapter receives the production-projected public catalogue, not the internal registry. */
export function verifyUnifiedShellModelCatalogue(
  tools: readonly { id: string; inputSchema: unknown }[],
  requireComplete = false,
): boolean {
  const shell = tools.filter(
    (tool) => tool.id.startsWith('shell_') || tool.id.startsWith('shell.'),
  );
  if (!shell.length) return false;
  const names = shell.map((tool) => tool.id);
  const current = ['shell_execute', 'shell_read', 'shell_wait', 'shell_stop'];
  if (names.some((name) => !current.includes(name)) || new Set(names).size !== names.length)
    throw Error('live_shell_model_catalogue_not_unified');
  if (requireComplete && names.length !== current.length)
    throw Error('live_shell_root_catalogue_incomplete');
  const execute = shell.find((tool) => tool.id === 'shell_execute');
  if (!execute) return true;
  const schema = execute.inputSchema as Record<string, unknown>;
  const properties = schema?.properties;
  if (
    !properties ||
    typeof properties !== 'object' ||
    Array.isArray(properties) ||
    Object.keys(properties).sort().join(',') !==
      ['command', 'description', 'background', 'execution_timeout_ms', 'filesystem', 'network']
        .sort()
        .join(',') ||
    !Array.isArray(schema.required) ||
    schema.required.join(',') !== 'command' ||
    schema.additionalProperties !== false
  )
    throw Error('live_shell_model_parameters_not_current');
  return true;
}

/** Only the fixture's exact owned background receipt can authorize its stop card. */
export function lifecycleStopApprovalJobId(
  pending: unknown,
  executions: readonly unknown[],
): string | undefined {
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const target = object(pending),
    input = object(target?.input);
  if (
    target?.kind !== 'tool' ||
    target.definitionId !== 'shell.stop' ||
    target.definitionVersion !== '1' ||
    typeof target.id !== 'string' ||
    typeof input?.shellId !== 'string' ||
    typeof input.commandId !== 'string' ||
    !input.commandId
  )
    return;
  const scope = ['sessionId', 'originStoreId', 'rootWorkCommandId', 'rootWorkSeq'] as const;
  if (scope.some((field) => typeof target[field] !== 'string' || !target[field])) return;
  const sameScope = (record: Record<string, unknown>) =>
    scope.every((field) => record[field] === target[field]);
  const rows = executions.map(object).filter((row): row is Record<string, unknown> => !!row);
  for (const tool of rows) {
    const result = object(tool.result),
      details = object(result?.details),
      ref = object(details?.ref);
    if (
      tool.kind !== 'tool' ||
      tool.definitionId !== 'shell.execute' ||
      tool.definitionVersion !== '1' ||
      tool.status !== 'succeeded' ||
      !sameScope(tool) ||
      object(tool.input)?.background !== true ||
      details?.accepted !== true ||
      details.shell_id !== input.shellId ||
      ref?.key !== input.shellId ||
      ref.extensionId !== 'builtin.shell' ||
      ref.sessionId !== target.sessionId ||
      ref.originStoreId !== target.originStoreId ||
      typeof ref.executionId !== 'string'
    )
      continue;
    try {
      if (
        typeof result?.content !== 'string' ||
        !isDeepStrictEqual(JSON.parse(result.content), details)
      )
        continue;
    } catch {
      continue;
    }
    const job = rows.find((row) => row.id === ref.executionId);
    if (
      job?.kind === 'job' &&
      job.definitionId === 'shell.command' &&
      job.definitionVersion === '1' &&
      job.parentExecutionId === tool.id &&
      job.originCommandId === ref.commandId &&
      sameScope(job)
    )
      return String(job.id);
  }
  return undefined;
}

/** Only pre-refusal, unexecuted Files-entry failures are unrelated to a later human refusal.
 * Input order is this actor's original Store rowid order; later attempts remain forbidden.
 */
export function priorFilesScopeFailures(
  tools: readonly {
    id: string;
    definitionId: string;
    definitionVersion: string;
    status: string;
    authorization?: { dispatched?: boolean };
    result: unknown;
  }[],
  deniedToolId: string,
): Set<string> {
  const boundary = tools.findIndex((tool) => tool.id === deniedToolId);
  if (boundary < 0) throw Error('natural-original-denied-tool-missing');
  return new Set(
    tools
      .slice(0, boundary)
      .filter((tool) => {
        const result = tool.result as { details?: Record<string, unknown> } | null;
        return (
          ((tool.definitionId === 'files.write' && tool.definitionVersion === '3') ||
            (tool.definitionId === 'files.edit' && tool.definitionVersion === '2')) &&
          tool.status === 'failed' &&
          tool.authorization?.dispatched === false &&
          result?.details?.code === 'permission_denied' &&
          result.details.reason === 'file_full_access_required' &&
          result.details.dispatchCommitted === false &&
          result.details.adapterAttempted === false
        );
      })
      .map((tool) => tool.id),
  );
}
