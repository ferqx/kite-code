import { createHash } from 'node:crypto';
import type { Execution, McpToolsSnapshot, SessionView } from '@kite-ai/client';
import type { TuiPort } from '@kite-ai/ui/tui';

type Port = Pick<
  NonNullable<TuiPort['mcp']>,
  'readToolsSnapshots' | 'readToolsPage' | 'readToolDescriptor'
>;
export interface TuiToolLabel {
  readonly executionId: string;
  readonly originStoreId: string;
  readonly sessionId: string;
  readonly runId: string | null;
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly label: string;
}
type Cached = { target: TuiToolLabel; name: string; serverId: string; configDigest: string };
const key = (execution: Execution) =>
  JSON.stringify([
    execution.id,
    execution.originStoreId,
    execution.sessionId,
    execution.runId,
    execution.definitionId,
    execution.definitionVersion,
  ]);
const proxy = (execution: Execution) =>
  /^mcp\.([A-Za-z0-9_-]{1,128})\.([a-f0-9]{32})$/.exec(execution.definitionId);
const original = (
  snapshot: McpToolsSnapshot,
  page: { recordKey: string; binding: Record<string, unknown>; toolCount: number },
  sessionId: string,
  originStoreId: string,
) =>
  snapshot.origin.sessionId === sessionId &&
  snapshot.origin.originStoreId === originStoreId &&
  page.recordKey === snapshot.recordKey &&
  page.toolCount === snapshot.toolCount &&
  Object.entries(snapshot.origin).every(([key, value]) => page.binding[key] === value) &&
  page.binding.indexDigest === (snapshot.index?.hash ?? null);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
/** Use only this execution's frozen source, never today's mutable directory. */
function frozenServerName(
  view: SessionView,
  target: Execution,
  cached: Cached,
): string | undefined {
  const runs = view.runs.filter(
    (run) =>
      run.id === target.runId &&
      run.originStoreId === target.originStoreId &&
      run.sessionId === target.sessionId,
  );
  if (runs.length !== 1) return undefined;
  const run = runs[0]!;
  const snapshot = record(record(run.configuration)?.snapshot);
  if (!snapshot) return undefined;
  const wrapped = ['roleId', 'roleVersion', 'roleModelId', 'roleToolIds'].some((key) =>
    Object.hasOwn(snapshot, key),
  );
  if (
    wrapped &&
    (Object.keys(snapshot).some(
      (key) =>
        ![
          'skillSelection',
          'roleId',
          'roleVersion',
          'roleModelId',
          'roleToolIds',
          'configuration',
        ].includes(key),
    ) ||
      typeof snapshot.roleId !== 'string' ||
      !snapshot.roleId ||
      typeof snapshot.roleVersion !== 'string' ||
      !snapshot.roleVersion ||
      (snapshot.roleModelId !== null && typeof snapshot.roleModelId !== 'string') ||
      (snapshot.roleToolIds !== null &&
        (!Array.isArray(snapshot.roleToolIds) ||
          snapshot.roleToolIds.some((id) => typeof id !== 'string'))))
  )
    return undefined;
  const mcp = record((wrapped ? record(snapshot.configuration) : snapshot)?.mcp);
  // Static programmatic registrations have no friendly source row. Their exact
  // frozen selected ID is their name; never expose a source-generated hash as one.
  if (!/^mcp-[a-f0-9]{64}$/.test(cached.serverId)) {
    const selected = Array.isArray(mcp?.servers)
      ? mcp.servers.map(record).filter((server) => server?.id === cached.serverId)
      : [];
    return selected.length === 1 && selected[0]?.configDigest === cached.configDigest
      ? cached.serverId
      : undefined;
  }
  const sources = record(mcp?.sources);
  const scope = record(sources?.scope);
  if (
    sources?.version !== 1 ||
    !scope ||
    scope.storeId !== target.originStoreId ||
    scope.workspaceId !== view.session.workspaceId ||
    !Array.isArray(sources.servers) ||
    !Array.isArray(record(sources.selection)?.serverIds) ||
    (record(sources.selection)!.serverIds as unknown[]).filter((id) => id === cached.serverId)
      .length !== 1
  )
    return undefined;
  if (wrapped) {
    const inheritance = record(sources.inheritance);
    if (
      !view.session.parentSessionId ||
      scope.sessionId !== view.session.parentSessionId ||
      inheritance?.version !== 1 ||
      inheritance.parentSessionId !== view.session.parentSessionId ||
      inheritance.rootSessionId !== view.session.rootSessionId ||
      inheritance.rootWorkCommandId !== run.rootWorkCommandId ||
      inheritance.rootWorkSeq !== run.rootWorkSeq ||
      typeof inheritance.parentExecutionId !== 'string' ||
      !inheritance.parentExecutionId ||
      (run.carrierExecutionId !== inheritance.parentExecutionId &&
        !(
          run.carrierExecutionId === undefined &&
          run.originCommandId === `child-start-${inheritance.parentExecutionId}`
        ))
    )
      return undefined;
  } else if (scope.sessionId !== target.sessionId || sources.inheritance !== undefined)
    return undefined;
  const servers = sources.servers.map(record).filter((server) => server?.id === cached.serverId);
  const server = servers.length === 1 ? servers[0] : undefined;
  return server?.configDigest === cached.configDigest &&
    typeof server.name === 'string' &&
    server.name.trim()
    ? server.name
    : undefined;
}
/** Display metadata only: no connect, authorize, Tool RPC or command invocation. */
export function createTuiToolLabelsReader(port: Port, storeId: string) {
  const cache = new Map<string, Cached>();
  let revision = 0;
  return {
    clear() {
      revision++;
      cache.clear();
    },
    /** Child observations cannot supersede the parent label domain's in-flight read. */
    readChild(view: SessionView, signal: AbortSignal): Promise<readonly TuiToolLabel[]> {
      return createTuiToolLabelsReader(port, storeId).read(view, signal);
    },
    async read(view: SessionView, signal: AbortSignal): Promise<readonly TuiToolLabel[]> {
      signal.throwIfAborted();
      const readId = ++revision;
      if (view.storeId !== storeId) throw Error('tui_tool_label_store_mismatch');
      const targets = view.executions.filter(
        (execution) =>
          execution.kind === 'tool' &&
          execution.originStoreId === storeId &&
          execution.sessionId === view.session.id &&
          proxy(execution),
      );
      const retained = new Set(targets.map(key));
      for (const cached of cache.keys()) if (!retained.has(cached)) cache.delete(cached);
      if (!targets.length) return [];
      const check = () => {
        signal.throwIfAborted();
        if (readId !== revision) throw Error('tui_tool_label_read_superseded');
      };
      if (port.readToolsSnapshots && port.readToolsPage) {
        const missing = targets.filter((target) => !cache.has(key(target))),
          serverIds = new Set(missing.map((target) => proxy(target)![1]!));
        for (const serverId of serverIds) {
          let afterKey: string | undefined;
          const visited = new Set<string>();
          do {
            check();
            const snapshots = await port.readToolsSnapshots(view.session.id, signal, {
              serverId,
              ...(afterKey ? { afterKey } : {}),
            });
            check();
            if (snapshots.sessionId !== view.session.id)
              throw Error('tui_tool_label_snapshot_scope_mismatch');
            for (const snapshot of snapshots.items) {
              if (
                snapshot.origin.originStoreId !== storeId ||
                snapshot.origin.sessionId !== view.session.id ||
                snapshot.origin.serverId !== serverId ||
                snapshot.availability !== 'available'
              )
                continue;
              if (visited.has(snapshot.recordKey) || (afterKey && snapshot.recordKey <= afterKey))
                throw Error('tui_tool_label_snapshot_cursor_invalid');
              visited.add(snapshot.recordKey);
              let afterIndex = 0;
              do {
                check();
                const page = await port.readToolsPage(view.session.id, snapshot, signal, {
                  afterIndex,
                  ...(snapshot.index ? { indexDigest: snapshot.index.hash } : {}),
                });
                check();
                if (
                  !original(
                    snapshot,
                    page as unknown as Parameters<typeof original>[1],
                    view.session.id,
                    storeId,
                  ) ||
                  page.startIndex !== afterIndex ||
                  page.complete !== (page.nextIndex === null) ||
                  page.availability !== 'available'
                )
                  throw Error('tui_tool_label_page_scope_mismatch');
                for (const entry of page.entries) {
                  const matches = missing.filter(
                    (execution) =>
                      !cache.has(key(execution)) &&
                      execution.definitionId === entry.definitionId &&
                      execution.definitionVersion === entry.definitionVersion,
                  );
                  if (!matches.length) continue;
                  let name = entry.label;
                  if (!entry.labelComplete) {
                    if (!port.readToolDescriptor) continue;
                    name = (
                      await port.readToolDescriptor(view.session.id, page.binding, entry, signal)
                    ).name;
                    check();
                  }
                  if (
                    typeof name !== 'string' ||
                    createHash('sha256').update(JSON.stringify(name)).digest('hex').slice(0, 32) !==
                      proxy(matches[0]!)![2]
                  )
                    throw Error('tui_tool_label_name_identity_mismatch');
                  for (const target of matches)
                    cache.set(key(target), {
                      target: {
                        executionId: target.id,
                        originStoreId: target.originStoreId!,
                        sessionId: target.sessionId,
                        runId: target.runId,
                        definitionId: target.definitionId,
                        definitionVersion: target.definitionVersion,
                        label: '',
                      },
                      name,
                      serverId,
                      configDigest: snapshot.origin.configDigest,
                    });
                }
                if (page.nextIndex === null) break;
                if (
                  !page.entries.length ||
                  page.nextIndex <= afterIndex ||
                  page.nextIndex !== page.entries.at(-1)!.index + 1
                )
                  throw Error('tui_tool_label_page_cursor_invalid');
                afterIndex = page.nextIndex;
              } while (
                missing.some((target) => proxy(target)![1] === serverId && !cache.has(key(target)))
              );
              if (
                !missing.some((target) => proxy(target)![1] === serverId && !cache.has(key(target)))
              )
                break;
            }
            if (
              !missing.some((target) => proxy(target)![1] === serverId && !cache.has(key(target)))
            )
              break;
            if (snapshots.nextAfterKey === null) break;
            if (!snapshots.items.length || snapshots.nextAfterKey <= (afterKey ?? ''))
              throw Error('tui_tool_label_snapshot_cursor_invalid');
            afterKey = snapshots.nextAfterKey;
          } while (afterKey !== undefined);
        }
      }
      return targets.flatMap((target) => {
        const cached = cache.get(key(target));
        if (!cached) return [];
        const serverName = frozenServerName(view, target, cached);
        return [{ ...cached.target, label: `${serverName || 'MCP'} · ${cached.name}` }];
      });
    },
  };
}
