import assert from 'node:assert/strict';
import { McpManager } from '@/core/mcp';

const endpoint = 'https://docs.langchain.com/mcp';
const searchTool = 'search_docs_by_lang_chain';
const LIVE_SMOKE_TIMEOUT_MS = 45_000;

if (process.env.KITE_RUN_LIVE_MCP_SMOKE !== '1') {
  throw new Error('Set KITE_RUN_LIVE_MCP_SMOKE=1 to run the public MCP live smoke.');
}

const manager = new McpManager();
const deadline = setTimeout(() => {
  console.error(`LangChain MCP live smoke exceeded ${LIVE_SMOKE_TIMEOUT_MS}ms.`);
  process.exit(1);
}, LIVE_SMOKE_TIMEOUT_MS);
try {
  await manager.connect('langchain-docs-live', {
    type: 'http',
    url: endpoint,
    timeout: 20_000,
    enabledTools: [searchTool],
    tools: {
      [searchTool]: {
        effects: { filesystem: 'none', network: 'read', externalState: 'read' },
        minimumApproval: 'none',
        retry: 'safe_read',
      },
    },
  });

  const state = manager.getServerStates().get('langchain-docs-live');
  assert.equal(state?.health, 'ready');
  assert.equal(
    state?.tools.some((tool) => tool.name === searchTool),
    true,
  );

  const descriptor = manager
    .getCapabilitySnapshot()
    .descriptors.find(
      (candidate) => candidate.capabilityId === `mcp:langchain-docs-live/${searchTool}`,
    );
  assert.equal(descriptor?.availability, 'available');

  const result = await manager.callTool('langchain-docs-live', searchTool, {
    query: 'Model Context Protocol MCP server',
  });
  assert.notEqual(result.isError, true);
  assert.ok(result.content.length > 0);
  assert.equal(
    result.content.some(
      (item) => item.type === 'text' && item.text.toLowerCase().includes('langchain'),
    ),
    true,
  );
  console.log(
    JSON.stringify({
      ok: true,
      provider: 'langchain-docs-live',
      tool: searchTool,
    }),
  );
} finally {
  await manager.disconnectAll();
  clearTimeout(deadline);
}
