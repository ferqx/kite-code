import { createHash } from 'node:crypto';
import type { Execution, McpToolsSnapshot, SessionView } from '@kite-ai/client';
import type { TuiPort } from '@kite-ai/ui/tui';

type Port = Pick<
  NonNullable<TuiPort['mcp']>,
  'read' | 'readToolsSnapshots' | 'readToolsPage' | 'readToolDescriptor'
>;
type Facts = Awaited<ReturnType<Port['read']>>;
export interface TuiToolLabel {
  readonly executionId: string;
  readonly originStoreId: string;
  readonly sessionId: string;
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
/** Display metadata only: no connect, authorize, Tool RPC or command invocation. */
export function createTuiToolLabelsReader(port: Port, storeId: string) {
  const cache = new Map<string, Cached>();
  let revision = 0;
  return {
    clear() {
      revision++;
      cache.clear();
    },
    async read(
      view: SessionView,
      signal: AbortSignal,
      suppliedFacts?: Facts,
    ): Promise<readonly TuiToolLabel[]> {
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
      let facts = suppliedFacts;
      if (!facts) {
        try {
          facts = await port.read(view.session.id, signal);
        } catch {
          check();
        }
        check();
      }
      return targets.flatMap((target) => {
        const cached = cache.get(key(target));
        if (!cached) return [];
        const current =
          facts?.storeId === storeId &&
          facts.sessionId === target.sessionId &&
          facts.items.some(
            (item) => item.id === cached.serverId && item.configDigest === cached.configDigest,
          );
        const serverName = current ? facts?.labels?.[cached.serverId] : undefined;
        return [{ ...cached.target, label: `${serverName || 'MCP'} · ${cached.name}` }];
      });
    },
  };
}
