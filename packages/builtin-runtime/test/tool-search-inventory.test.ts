import { describe, expect, test } from 'bun:test';
import { createRuntimeModuleRegistry } from '@kite-ai/runtime-spi';
import {
  createToolSearchProviderFacts,
  createToolSearchRuntimeModule,
  isToolSearchExecutionValue,
  TOOL_SEARCH_CAPABILITY_ID_,
} from '../src/tool-search';

const facts = createToolSearchProviderFacts({
  threadId: 'thread',
  turnId: 'turn',
  toolCallId: 'search',
  mcpDescriptors: [
    {
      capabilityId: 'mcp:slack:send_message',
      revision: 'revision',
      kind: 'mcp_tool',
      displayName: 'slack_send_message',
      description: 'Send Slack messages',
      provider: { type: 'mcp', id: 'slack' },
      availability: 'available',
    },
  ],
});

async function search(query: string) {
  const registry = createRuntimeModuleRegistry([createToolSearchRuntimeModule()]);
  const executor = registry.executor(TOOL_SEARCH_CAPABILITY_ID_)!;
  try {
    const receipt = await executor.execute(
      {
        invocationId: 'invocation',
        capabilityId: executor.capabilityId,
        capabilityRevision: executor.capabilityRevision,
        input: { query },
        facts,
      },
      {
        attempt: { invocationId: 'invocation', attemptId: 'attempt' },
        grant: {
          grantId: 'grant',
          capabilityId: executor.capabilityId,
          capabilityRevision: executor.capabilityRevision,
          authority: {},
        },
        requestDigest: 'digest',
        signal: new AbortController().signal,
        environment: { environmentId: 'catalog', kind: 'catalog' },
      },
    );
    expect(receipt.status).toBe('succeeded');
    if (!isToolSearchExecutionValue(receipt.value)) throw new Error('Missing search value');
    return receipt.value;
  } finally {
    await registry.dispose();
  }
}

describe('tool_search inventory routing', () => {
  test('redirects only whole inventory requests', async () => {
    for (const query of [
      'mcp tools',
      'list available mcp tools',
      'what mcp tools are available?',
      'which mcp servers are configured?',
      '有哪些工具？',
      '当前可用的 MCP 工具有哪些？',
      '请列出 MCP 工具清单',
      '工具列表',
    ]) {
      const value = await search(query);
      expect(JSON.parse(value.stdout)).toMatchObject({
        ok: false,
        code: 'inventory_query',
        next_tool: 'list_mcp_tools',
      });
      expect(value.searchResult).toBeUndefined();
    }
  });

  test('searches concrete English and Chinese uses instead of redirecting them', async () => {
    for (const query of [
      'send Slack messages',
      'which mcp tools can send Slack messages',
      'what mcp tools support sending Slack messages?',
      '有哪些工具可以发送 Slack 消息',
      '查看支持发送 Slack 消息的工具',
      'Slack 工具有哪些消息发送能力',
    ]) {
      const value = await search(query);
      expect(JSON.parse(value.stdout)).toMatchObject({ ok: true, candidate_count: 1 });
      expect(value.searchResult?.candidates[0]?.capabilityId).toBe('mcp:slack:send_message');
    }
  });
});
