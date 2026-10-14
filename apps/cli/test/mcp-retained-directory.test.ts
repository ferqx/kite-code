import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mcpCanonical } from '../host/mcp-selection-intents';
import { createTuiMcpPort, decodeRetainedMcpDirectory } from '../host/tui-mcp';

const descriptor = {
  name: 'actual_prompt',
  description: 'Original description',
  arguments: [{ name: 'topic', required: true }],
};
const hash = createHash('sha256').update(mcpCanonical(descriptor)).digest('hex');
function result() {
  return [
    {
      extensionId: 'builtin.mcp',
      contentType: 'builtin.mcp.prompts',
      contentVersion: 1,
      summary: 'Retained data',
      actions: [],
      artifactRefs: [],
      payload: {
        items: [
          {
            key: 'prompts/exec',
            live: false,
            record: {
              kind: 'list',
              binding: {
                originalStoreId: 'store',
                sessionId: 's',
                executionId: 'exec',
                serverId: 'actual-server',
                configDigest: 'a'.repeat(64),
                generation: 1,
                connectionKey: 'connection/key',
                connectionExecutionId: 'connection',
                definitionId: 'builtin.mcp/mcp.prompts.list',
                definitionVersion: '1',
              },
              descriptors: [descriptor],
              descriptorDigests: [hash],
            },
          },
        ],
        nextAfterKey: null,
      },
    },
  ];
}
test('retained MCP directory preserves original prompt descriptor and rejects wrong hashes or bindings', () => {
  const page = decodeRetainedMcpDirectory(result(), 'prompts', 'store', 's', 'w');
  expect(page.items[0]?.descriptors).toEqual([descriptor]);
  expect(page.items[0]?.live).toBe(false);
  expect(page.items[0]?.configDigest).toBe('a'.repeat(64));
  const changed = result();
  changed[0]!.payload.items[0]!.record.descriptorDigests[0] = 'f'.repeat(64);
  expect(() => decodeRetainedMcpDirectory(changed, 'prompts', 'store', 's', 'w')).toThrow(
    'mcp_read_directory_invalid',
  );
  expect(decodeRetainedMcpDirectory(result(), 'prompts', 'other-store', 's', 'w').items).toEqual(
    [],
  );
  expect(
    decodeRetainedMcpDirectory(result(), 'prompts', 'store', 'other-session', 'w').items,
  ).toEqual([]);
  expect(() =>
    decodeRetainedMcpDirectory(result(), 'prompts', 'store', 's', 'w', { serverId: 'other' }),
  ).toThrow();
});
test('MCP directory port performs only original scoped public Query and cancels without dispatch', async () => {
  let posts = 0,
    queries = 0,
    reads = 0;
  const calls: unknown[] = [];
  const view = { storeId: 'store', session: { id: 's', workspaceId: 'w', deletedAt: null } };
  const port = createTuiMcpPort(
    {
      serverInfo: { storeId: 'store', subjectId: 'subject' },
      async getView() {
        reads++;
        return view;
      },
      async queryExtension(...args: unknown[]) {
        queries++;
        calls.push(args.slice(0, 4));
        return result();
      },
      async invokeExtension() {
        posts++;
        throw Error('no_dispatch');
      },
    } as never,
    'store',
  );
  expect(
    (await port.readDirectory!('s', 'prompts', new AbortController().signal)).items[0]
      ?.descriptors[0],
  ).toEqual(descriptor);
  expect(calls).toEqual([['s', 'builtin.mcp', 'mcp.prompts', { limit: 32 }]]);
  expect(reads).toBe(2);
  expect(queries).toBe(1);
  expect(posts).toBe(0);
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(port.readDirectory!('s', 'prompts', cancelled.signal)).rejects.toThrow();
  expect(reads).toBe(2);
  expect(queries).toBe(1);
  expect(posts).toBe(0);
});
