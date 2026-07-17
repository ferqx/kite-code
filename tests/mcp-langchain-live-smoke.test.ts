import { expect, test } from 'bun:test';
import { McpManager } from '@/core/mcp';

const liveSmoke = process.env.KITE_RUN_LIVE_MCP_SMOKE === '1' ? test : test.skip;
const endpoint = 'https://docs.langchain.com/mcp';
const searchTool = 'search_docs_by_lang_chain';

liveSmoke(
  'connects to the public LangChain docs MCP and executes a read-only search',
  async () => {
    const manager = new McpManager();
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
      expect(state?.health).toBe('ready');
      expect(state?.tools.some((tool) => tool.name === searchTool)).toBe(true);

      const descriptor = manager
        .getCapabilitySnapshot()
        .descriptors.find(
          (candidate) => candidate.capabilityId === `mcp:langchain-docs-live/${searchTool}`,
        );
      expect(descriptor?.availability).toBe('available');

      const result = await manager.callTool('langchain-docs-live', searchTool, {
        query: 'Model Context Protocol MCP server',
      });
      expect(result.isError).not.toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(
        result.content.some(
          (item) => item.type === 'text' && item.text.toLowerCase().includes('langchain'),
        ),
      ).toBe(true);
    } finally {
      await manager.disconnectAll();
    }
  },
  45_000,
);
