import type {
  NativeUserMcpFacts,
  NativeUserMcpRequest,
  NativeUserMcpResult,
  NativeUserMcpSubmission,
} from '../src/mcp-bridge';

/** In-memory UI fixture only. No credentials, browser authorization or production switch. */
export function mcpSettingsBridgeFixture(mode: 'normal' | 'errors' = 'normal') {
  let observationId = 0,
    sequence = 0;
  const sources: NativeUserMcpFacts['sources'][number][] = [
    {
      id: `mcp-${'a'.repeat(64)}`,
      name: 'Knowledge',
      transport: 'http',
      address: 'https://example.com/mcp',
      enabled: true,
      configured: true,
      diagnostics: [],
      authentication: { policy: 'none', status: 'none', loginAllowed: false },
      connection: { state: 'ready', generation: 1, toolCount: 2 },
    },
    {
      id: `mcp-${'b'.repeat(64)}`,
      name: 'Research',
      transport: 'http',
      address: 'https://research.example.com/mcp',
      enabled: true,
      configured: true,
      diagnostics: [],
      authentication: { policy: 'oauth', status: 'missing', loginAllowed: true },
      connection: { state: 'disconnected', generation: null, toolCount: null },
    },
    {
      id: `mcp-${'c'.repeat(64)}`,
      name: 'Local tools',
      transport: 'stdio',
      address: 'C:\\Tools\\mcp-server.exe',
      enabled: false,
      configured: true,
      diagnostics: [],
      authentication: { policy: 'none', status: 'none', loginAllowed: false },
      connection: { state: 'disconnected', generation: null, toolCount: null },
    },
  ];
  const operations = new Map<string, { row: NativeUserMcpSubmission; polls: number }>();
  if (mode === 'errors')
    for (const [index, source] of sources.entries()) {
      source.authentication = { policy: 'none', status: 'none', loginAllowed: false };
      source.connection = { state: 'failed', generation: null, toolCount: null };
      source.enabled = true;
      if (index === 1) source.address = 'https://tools.service.test/mcp';
    }
  function apply(row: NativeUserMcpSubmission) {
    const op = row.operation;
    if (op.kind === 'add')
      sources.push({
        id: `mcp-${(++sequence).toString(16).padStart(64, '0')}`,
        name: op.name,
        transport: op.entry.type,
        address: op.entry.type === 'http' ? op.entry.url : op.entry.command,
        enabled: true,
        configured: true,
        diagnostics: [],
        authentication: { policy: 'auto', status: 'unknown', loginAllowed: false },
        connection: { state: 'disconnected', generation: null, toolCount: null },
      });
    else {
      const source = sources.find((source) => source.id === op.serverId)!;
      if (op.kind === 'remove') sources.splice(sources.indexOf(source), 1);
      else if (op.kind === 'enabled') source.enabled = op.enabled;
      else if (op.kind === 'login')
        source.authentication = { ...source.authentication, status: 'present' };
      else if (op.kind === 'clear' || op.kind === 'revoke')
        source.authentication = { ...source.authentication, status: 'missing' };
      else if (op.kind === 'disconnect')
        source.connection = { state: 'disconnected', generation: null, toolCount: null };
      else if (op.kind === 'connect' || op.kind === 'reconnect')
        source.connection = { state: 'ready', generation: 1, toolCount: 2 };
    }
  }
  return async (input: NativeUserMcpRequest): Promise<NativeUserMcpResult | undefined> => {
    if (input.method === 'settings.userMcp.read')
      return {
        kind: 'settings.userMcp',
        storeId: 'store',
        observationId: ++observationId,
        canWrite: true,
        errors: [],
        sources: structuredClone(sources),
      };
    if (input.method === 'settings.userMcp.submit') {
      const row: NativeUserMcpSubmission = {
        kind: 'settings.userMcp.submission',
        commandId: `fixture-operation-${++sequence}`,
        storeId: 'store',
        operation: input.operation,
        phase:
          input.operation.kind === 'login' ||
          input.operation.kind === 'connect' ||
          input.operation.kind === 'add' ||
          input.operation.kind === 'remove' ||
          input.operation.kind === 'enabled'
            ? 'pending'
            : 'completed',
        association: 'current',
      };
      if (mode === 'errors' && ['connect', 'reconnect'].includes(input.operation.kind)) {
        row.phase = 'failed';
        row.error = 'mcp_http_not_found';
      }
      operations.set(row.commandId, { row, polls: 0 });
      if (row.phase === 'completed') apply(row);
      return { ...row };
    }
    if (input.method === 'settings.userMcp.clear') {
      const row = operations.get(input.commandId)?.row;
      if (row?.phase !== 'failed') throw Error('mcp_clear_unconfirmed');
      operations.delete(input.commandId);
      return undefined;
    }
    if (input.method === 'settings.userMcp.lookup' || input.method === 'settings.userMcp.cancel') {
      const entry = operations.get(input.commandId)!;
      if (input.method === 'settings.userMcp.cancel') entry.row.phase = 'cancelled';
      else if (++entry.polls >= 5 && entry.row.phase === 'pending') {
        apply(entry.row);
        entry.row.phase = 'completed';
      }
      return { ...entry.row };
    }
    if (input.method === 'settings.userMcp.tools')
      return {
        kind: 'settings.userMcp.tools',
        observationId: input.observationId,
        page: {
          scope: 'user',
          storeId: 'store',
          serverId: input.serverId,
          generation: input.connectionGeneration,
          entries: [
            {
              index: 0,
              definitionId: 'fixture-search',
              definitionVersion: '1'.repeat(64),
              descriptor: {
                name: 'search_knowledge',
                description: '搜索知识库中的文档与参考资料。',
                inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
              },
            },
            {
              index: 1,
              definitionId: 'fixture-read',
              definitionVersion: '1'.repeat(64),
              descriptor: {
                name: 'read_document',
                description: '读取文档的完整内容。',
                inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
              },
            },
          ],
          nextAfterIndex: null,
          complete: true,
        },
      };
    return undefined;
  };
}
