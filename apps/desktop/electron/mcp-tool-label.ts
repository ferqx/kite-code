import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import {
  type AgentClient,
  decodeMcpToolsPage,
  decodeMcpToolsSnapshots,
  type Execution,
  type Run,
  readMcpToolDescriptor,
} from '@kite-ai/client';

/** Optional names share one page budget; exhausting it never cancels receipt reads. */
export class NativeMcpToolLabelBudget {
  private readonly parent: AbortSignal;
  private readonly abort = new AbortController();
  private readonly forwardAbort = () => this.abort.abort(this.parent.reason);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reads = 0;
  private descriptorBytes = 256 * 1024;
  constructor(parent: AbortSignal) {
    this.parent = parent;
    if (parent.aborted) this.forwardAbort();
    else parent.addEventListener('abort', this.forwardAbort, { once: true });
  }
  get signal() {
    return this.abort.signal;
  }
  read<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    if (this.reads++ >= 32) {
      this.abort.abort(new Error('mcp_tool_label_budget_exhausted'));
      this.signal.throwIfAborted();
    }
    this.timer ??= setTimeout(() => this.abort.abort(new Error('mcp_tool_label_deadline')), 250);
    return operation(this.signal);
  }
  reserveDescriptor(bytes: string): boolean {
    this.signal.throwIfAborted();
    if (BigInt(bytes) > BigInt(this.descriptorBytes)) return false;
    this.descriptorBytes -= Number(bytes);
    return true;
  }
  close() {
    clearTimeout(this.timer);
    this.parent.removeEventListener('abort', this.forwardAbort);
    this.abort.abort();
  }
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Frozen display declarations only. Never inspect transport, credentials or today's settings. */
export function nativeMcpServerName(
  run: Run | undefined,
  execution: Execution,
  serverId: string,
  configDigest: string,
): string | undefined {
  if (
    !run ||
    run.id !== execution.runId ||
    run.originStoreId !== execution.originStoreId ||
    run.sessionId !== execution.sessionId
  )
    return;
  let snapshot = object(object(run.configuration)?.snapshot);
  if (!snapshot) return;
  if (['roleId', 'roleVersion', 'roleModelId', 'roleToolIds'].some((key) => key in snapshot!)) {
    // Only the actual public role wrapper is supported, not arbitrary nested objects.
    if (
      Object.keys(snapshot).some(
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
          snapshot.roleToolIds.some((id) => typeof id !== 'string')))
    )
      return;
    snapshot = object(snapshot.configuration);
  }
  const mcp = object(snapshot?.mcp),
    sources = object(mcp?.sources);
  if (mcp && 'sources' in mcp && (sources?.version !== 1 || !Array.isArray(sources.servers)))
    return;
  const matches = (values: unknown) =>
    Array.isArray(values) ? values.map(object).filter((value) => value?.id === serverId) : [];
  const selected = matches(mcp?.servers);
  if (selected.length !== 1 || selected[0]?.configDigest !== configDigest) return;
  const servers = matches(sources?.servers);
  if (servers.length) {
    const selection = object(sources?.selection)?.serverIds;
    if (
      sources?.version !== 1 ||
      servers.length !== 1 ||
      !Array.isArray(selection) ||
      selection.filter((id) => id === serverId).length !== 1 ||
      servers[0]?.configDigest !== configDigest ||
      typeof servers[0]?.name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(servers[0].name) ||
      /^invalid-[a-f0-9]{64}$/.test(servers[0].name)
    )
      return;
    return servers[0].name;
  }
  // Static declarations have only their public ID. Source-generated hashes are not names.
  if (
    (!sources || (sources.version === 1 && Array.isArray(sources.servers))) &&
    !/^mcp-[a-f0-9]{64}$/.test(serverId)
  )
    return serverId;
  return;
}

export function nativeMcpToolName(name: string): string | undefined {
  // Descriptor names are untrusted plain text: no terminal escapes, direction controls or lines.
  const clean = stripVTControlCharacters(name)
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!clean) return;
  const points = [...clean];
  return `${points.slice(0, 256).join('')}${points.length > 256 ? '…' : ''}`;
}

/** Read saved local metadata only; never connect to or invoke an MCP server. */
export async function nativeMcpToolLabel(
  client: AgentClient,
  execution: Execution,
  storeId: string,
  sessionId: string,
  budget: NativeMcpToolLabelBudget,
): Promise<string | undefined> {
  const signal = budget.signal;
  const proxy = /^mcp\.([A-Za-z0-9_-]{1,128})\.([a-f0-9]{32})$/.exec(execution.definitionId);
  if (
    !proxy ||
    execution.kind !== 'tool' ||
    execution.originStoreId !== storeId ||
    execution.sessionId !== sessionId ||
    typeof client.queryExtension !== 'function'
  )
    return;
  let run: Run | undefined;
  try {
    if (execution.runId && typeof client.getRun === 'function')
      run = await budget.read((signal) => client.getRun(execution.runId!, { signal }));
  } catch {
    signal.throwIfAborted();
  }
  let afterKey: string | undefined;
  do {
    signal.throwIfAborted();
    const snapshots = decodeMcpToolsSnapshots(
      await budget.read((signal) =>
        client.queryExtension(
          sessionId,
          'builtin.mcp',
          'mcp.tools.snapshots',
          { serverId: proxy[1]!, limit: 32, ...(afterKey ? { afterKey } : {}) },
          { signal },
        ),
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
          await budget.read((signal) =>
            client.queryExtension(
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
          if (!entry.labelComplete && !budget.reserveDescriptor(entry.descriptorBytes)) return;
          const name = entry.labelComplete
            ? entry.label
            : (
                await readMcpToolDescriptor({
                  currentStoreId: storeId,
                  sessionId,
                  binding: page.binding,
                  entry,
                  signal,
                  readArtifact: (sessionId, request, options) =>
                    budget.read((signal) =>
                      client.readArtifact(sessionId, request, { ...options, signal }),
                    ),
                })
              ).name;
          signal.throwIfAborted();
          if (
            createHash('sha256').update(JSON.stringify(name)).digest('hex').slice(0, 32) !==
            proxy[2]
          )
            return;
          const toolName = nativeMcpToolName(name);
          if (!toolName) return;
          const serverName = nativeMcpServerName(
            run,
            execution,
            proxy[1]!,
            snapshot.origin.configDigest,
          );
          return `MCP · ${serverName ?? '未知服务'} · ${toolName}`;
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
