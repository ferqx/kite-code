import assert from 'node:assert/strict';
import type { createMcpAdapter, McpReadRequest } from '@kite-ai/agent/mcp';
import type { LoopbackMcpRequest } from './loopback-smoke';

type Adapter = ReturnType<typeof createMcpAdapter>;
type Scope = ReturnType<Adapter['scope']>;
type CapturedRead = ReturnType<Scope['captureRead']>;

/** Exercise alpha's already-connected adapter after the Runtime's final tool call. */
export async function verifyLoopbackReads(
  adapter: Adapter,
  scope: Scope,
  wire: readonly LoopbackMcpRequest[],
) {
  const signal = new AbortController().signal;
  const resourceUri = 'smoke://alpha/note';
  const resource = { uri: resourceUri, mimeType: 'text/plain', text: 'alpha:note' };
  const promptName = 'greeting';
  const promptArguments = { name: 'Kite' };

  async function checkRead(binding: CapturedRead, request: McpReadRequest, expected: unknown) {
    const start = wire.length;
    const result = await binding.execute(request, { signal });
    assert.equal(result.outcome, 'succeeded', request.method);
    assert.deepEqual(JSON.parse(result.content), expected);
    assert.deepEqual(
      wire.slice(start).map((rpc) => rpc.method),
      [request.method],
    );
  }

  async function checkRefused(binding: CapturedRead, code: string) {
    const start = wire.length;
    const result = await binding.execute(
      { method: 'resources/read', uri: resourceUri },
      { signal },
    );
    assert.equal(result.outcome, 'failed');
    assert.equal(result.content, code);
    assert(result.details && typeof result.details === 'object' && !Array.isArray(result.details));
    assert.equal(result.details.adapterAttempted, false);
    const calls = wire.length - start;
    assert.equal(calls, 0);
    return calls;
  }

  const start = wire.length;
  const generation = adapter.getCatalogue().generation;
  const read = scope.captureRead(generation);
  await checkRead(read, { method: 'resources/list' }, [
    { uri: resourceUri, name: 'note', mimeType: 'text/plain' },
  ]);
  await checkRead(read, { method: 'resources/read', uri: resourceUri }, { contents: [resource] });
  await checkRead(read, { method: 'prompts/list' }, [
    { name: promptName, arguments: [{ name: 'name', required: true }] },
  ]);
  await checkRead(
    read,
    { method: 'prompts/get', name: promptName, arguments: promptArguments },
    {
      messages: [{ role: 'user', content: { type: 'text', text: 'alpha:hello Kite' } }],
    },
  );
  const readMethods = wire.slice(start).map((rpc) => rpc.method);

  const beforeRefresh = wire.length;
  const refresh = await scope.captureRefresh(generation).execute({ signal });
  assert.equal(refresh.outcome, 'succeeded');
  assert.deepEqual(
    wire.slice(beforeRefresh).map((rpc) => rpc.method),
    ['tools/list'],
  );
  // The fixture's descriptors are unchanged. Explicit invalidation retires this generation.
  adapter.invalidateCatalogue();
  const staleWireCalls = await checkRefused(read, 'mcp_catalogue_stale');

  await scope.release();
  const reconnectStart = wire.length;
  const reopened = adapter.scope('loopback-smoke-reopened');
  try {
    await reopened.snapshotTools();
    assert.deepEqual(
      wire.slice(reconnectStart).map((rpc) => rpc.method),
      ['initialize', 'notifications/initialized', 'tools/list'],
    );
    const nextGeneration = adapter.getCatalogue().generation;
    assert(nextGeneration > generation);
    const releasedScopeWireCalls = await checkRefused(read, 'mcp_scope_released');
    await checkRead(
      reopened.captureRead(nextGeneration),
      { method: 'resources/read', uri: resourceUri },
      {
        contents: [resource],
      },
    );
    return {
      resourceUri,
      promptName,
      readMethods,
      generation,
      nextGeneration,
      staleWireCalls,
      releasedScopeWireCalls,
      reconnectMethods: wire.slice(reconnectStart).map((rpc) => rpc.method),
    };
  } finally {
    await reopened.release();
  }
}
