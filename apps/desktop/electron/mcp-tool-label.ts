import { createHash } from 'node:crypto';
import {
  type AgentClient,
  decodeMcpToolsPage,
  decodeMcpToolsSnapshots,
  type Execution,
  readMcpToolDescriptor,
} from '@kite-ai/client';

/** Read saved local metadata only; never connect to or invoke an MCP server. */
export async function nativeMcpToolLabel(
  client: AgentClient,
  execution: Execution,
  storeId: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const proxy = /^mcp\.([A-Za-z0-9_-]{1,128})\.([a-f0-9]{32})$/.exec(execution.definitionId);
  if (
    !proxy ||
    execution.kind !== 'tool' ||
    execution.originStoreId !== storeId ||
    execution.sessionId !== sessionId ||
    typeof client.queryExtension !== 'function'
  )
    return;
  let afterKey: string | undefined;
  do {
    signal.throwIfAborted();
    const snapshots = decodeMcpToolsSnapshots(
      await client.queryExtension(
        sessionId,
        'builtin.mcp',
        'mcp.tools.snapshots',
        { serverId: proxy[1]!, limit: 32, ...(afterKey ? { afterKey } : {}) },
        { signal },
      ),
    );
    signal.throwIfAborted();
    if (snapshots.sessionId !== sessionId) return;
    for (const snapshot of snapshots.items) {
      if (
        snapshot.availability !== 'available' ||
        snapshot.origin.originStoreId !== storeId ||
        snapshot.origin.sessionId !== sessionId ||
        snapshot.origin.serverId !== proxy[1] ||
        (afterKey && snapshot.recordKey <= afterKey)
      )
        continue;
      let afterIndex = 0;
      for (;;) {
        const page = decodeMcpToolsPage(
          await client.queryExtension(
            sessionId,
            'builtin.mcp',
            'mcp.tools',
            {
              recordKey: snapshot.recordKey,
              generation: snapshot.origin.generation,
              ...(snapshot.index ? { indexDigest: snapshot.index.hash } : {}),
              afterIndex,
              limit: 32,
            },
            { signal },
          ),
        );
        signal.throwIfAborted();
        if (
          page.recordKey !== snapshot.recordKey ||
          page.toolCount !== snapshot.toolCount ||
          page.startIndex !== afterIndex ||
          page.binding.indexDigest !== (snapshot.index?.hash ?? null) ||
          Object.entries(snapshot.origin).some(
            ([key, value]) => page.binding[key as keyof typeof page.binding] !== value,
          )
        )
          return;
        if (page.availability !== 'available') break;
        for (const entry of page.entries) {
          if (
            entry.definitionId !== execution.definitionId ||
            entry.definitionVersion !== execution.definitionVersion
          )
            continue;
          const name = entry.labelComplete
            ? entry.label
            : (
                await readMcpToolDescriptor({
                  currentStoreId: storeId,
                  sessionId,
                  binding: page.binding,
                  entry,
                  signal,
                  readArtifact: client.readArtifact.bind(client),
                })
              ).name;
          signal.throwIfAborted();
          if (
            createHash('sha256').update(JSON.stringify(name)).digest('hex').slice(0, 32) !==
            proxy[2]
          )
            return;
          const points = [...name];
          return `MCP · ${points.slice(0, 256).join('')}${points.length > 256 ? '…' : ''}`;
        }
        if (page.nextIndex === null) break;
        afterIndex = page.nextIndex;
      }
    }
    const next = snapshots.nextAfterKey;
    if (next === null || next <= (afterKey ?? '')) return;
    afterKey = next;
  } while (afterKey);
  return undefined;
}
