import { expect, test } from 'bun:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolContext } from '../../../src/extensions';
import { createMcpAdapter } from '../../../src/mcp';
import { createMcpSchemaValidation } from '../../../src/mcp/schema-validation';

async function fixture(output = false) {
  const [client, peer] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: 'bounded-schema', version: '1' });
  let calls = 0;
  server.registerTool(
    'bounded',
    {
      inputSchema: { text: output ? z.string() : z.string().regex(/^(a+)+$/) },
      ...(output ? { outputSchema: { text: z.string().regex(/^(a+)+$/) } } : {}),
    },
    async () => {
      calls++;
      return {
        content: [{ type: 'text' as const, text: 'owned response' }],
        ...(output ? { structuredContent: { text: `${'a'.repeat(26)}!` } } : {}),
      };
    },
  );
  if (output)
    server.server.setRequestHandler(CallToolRequestSchema, async () => {
      calls++;
      return {
        content: [{ type: 'text', text: 'owned response' }],
        structuredContent: { text: `${'a'.repeat(26)}!` },
      };
    });
  await server.connect(peer);
  const adapter = createMcpAdapter({
    id: 'bounded',
    transport: { type: 'http', url: 'http://unused.invalid/mcp' },
    createTransport: async () => client,
  });
  const scope = adapter.scope('owned');
  const tool = (await scope.snapshotTools())[0]!;
  return {
    adapter,
    scope,
    tool,
    calls: () => calls,
    async close() {
      await scope.release();
      await adapter.close();
      await server.close();
    },
  };
}
const context = (signal = new AbortController().signal) => ({ signal }) as ToolContext;

for (const length of [24, 26]) {
  test(`actual MCP input schema validation yields to Service timers for bounded ${length} character rejection`, async () => {
    const f = await fixture();
    try {
      let timer = false;
      const heartbeat = new Promise<void>((resolve) =>
        setTimeout(() => {
          timer = true;
          resolve();
        }, 0),
      );
      const result = await f.tool.execute({ text: `${'a'.repeat(length)}!` }, context());
      expect(timer).toBe(true);
      await heartbeat;
      expect(result).toEqual({ outcome: 'failed', content: 'mcp_arguments_invalid' });
      expect(f.calls()).toBe(0);
      expect((await f.tool.execute({ text: 'aaa' }, context())).outcome).toBe('succeeded');
      expect(f.calls()).toBe(1);
    } finally {
      await f.close();
    }
  });
}

test('actual MCP validation cancellation settles before wire and never authorizes a late RPC', async () => {
  const f = await fixture();
  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20);
    const result = await f.tool.execute({ text: `${'a'.repeat(26)}!` }, context(abort.signal));
    clearTimeout(timer);
    expect(result.outcome).toBe('cancelled');
    expect(result.content).toBe('mcp_cancelled_before_call');
    expect(f.calls()).toBe(0);
    expect((await f.tool.execute({ text: 'aaa' }, context())).outcome).toBe('succeeded');
    expect(f.calls()).toBe(1);
  } finally {
    await f.close();
  }
});

test('catalogue invalidation terminates old validation and never sends its pending input', async () => {
  const f = await fixture();
  try {
    const timer = setTimeout(() => f.adapter.invalidateCatalogue(), 20);
    const result = await f.tool.execute({ text: `${'a'.repeat(26)}!` }, context());
    clearTimeout(timer);
    expect(result.outcome).toBe('failed');
    expect(result.content).toBe('mcp_catalogue_stale');
    expect(f.calls()).toBe(0);
    const fresh = (await f.scope.snapshotTools())[0]!;
    expect((await fresh.execute({ text: 'aaa' }, context())).outcome).toBe('succeeded');
    expect(f.calls()).toBe(1);
  } finally {
    await f.close();
  }
});

test('postwire output schema validation yields and preserves the actual invalid result as unknown', async () => {
  const f = await fixture(true);
  try {
    let timer = false;
    const heartbeat = new Promise<void>((resolve) =>
      setTimeout(() => {
        timer = true;
        resolve();
      }, 0),
    );
    const result = await f.tool.execute({ text: 'legal' }, context());
    expect(timer).toBe(true);
    await heartbeat;
    expect(result.outcome).toBe('outcome_unknown');
    expect(result.content).toBe('mcp_output_invalid');
    expect(result.details).toMatchObject({
      actualResult: { structuredContent: { text: `${'a'.repeat(26)}!` } },
    });
    expect(f.calls()).toBe(1);
  } finally {
    await f.close();
  }
});

test('postwire cancellation during output validation stays unknown with one original remote effect', async () => {
  const f = await fixture(true);
  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20);
    const result = await f.tool.execute({ text: 'legal' }, context(abort.signal));
    clearTimeout(timer);
    expect(result.outcome).toBe('outcome_unknown');
    expect(result.content).toBe('mcp_call_unconfirmed');
    expect(f.calls()).toBe(1);
  } finally {
    await f.close();
  }
});

test('one cancelled validation retires all same-scope queued work without replay and permits only a new call', async () => {
  const f = await fixture();
  try {
    const abort = new AbortController();
    const first = f.tool.execute({ text: `${'a'.repeat(26)}!` }, context(abort.signal));
    const second = f.tool.execute({ text: `${'a'.repeat(24)}!` }, context());
    const timer = setTimeout(() => abort.abort(), 20);
    const results = await Promise.all([first, second]);
    clearTimeout(timer);
    expect(results.map((result) => result.outcome)).toEqual(['cancelled', 'failed']);
    expect(results[1]!.content).toBe('mcp_catalogue_stale');
    expect(f.calls()).toBe(0);
    expect((await f.tool.execute({ text: 'aaa' }, context())).outcome).toBe('succeeded');
    expect(f.calls()).toBe(1);
  } finally {
    await f.close();
  }
});

for (const boundary of ['release', 'close'] as const) {
  test(`scope ${boundary} joins pending schema validation and never dispatches its original request`, async () => {
    const f = await fixture();
    try {
      const pending = f.tool.execute({ text: `${'a'.repeat(26)}!` }, context());
      const close = new Promise<void>((resolve, reject) =>
        setTimeout(() => {
          (boundary === 'release' ? f.scope.release() : f.adapter.close()).then(resolve, reject);
        }, 20),
      );
      const result = await pending;
      await close;
      expect(result.outcome).toBe('failed');
      expect(result.content).toBe('mcp_catalogue_stale');
      expect(f.calls()).toBe(0);
      expect((await f.tool.execute({ text: 'aaa' }, context())).content).toBe('mcp_scope_released');
    } finally {
      await f.close();
    }
  });
}

test('schema compilation obeys its timeout and confirms the original Worker cleanup before close', async () => {
  const validation = createMcpSchemaValidation([{ input: { type: 'object' } }], 1);
  try {
    await expect(validation.prepare()).rejects.toMatchObject({ code: 'mcp_admission_rejected' });
  } finally {
    await validation.close();
  }
});

test('invalid complete schema is rejected before catalogue publication, without a synchronous fallback', async () => {
  const validation = createMcpSchemaValidation([{ input: { type: 'unavailable-type' } }], 10000);
  try {
    await expect(validation.prepare()).rejects.toMatchObject({ code: 'mcp_arguments_invalid' });
  } finally {
    await validation.close();
  }
});

test('releasing one scope does not cancel another scope schema Worker on the same exact catalogue', async () => {
  const f = await fixture();
  const other = f.adapter.scope('other');
  try {
    const tool = (await other.snapshotTools())[0]!;
    const pending = f.tool.execute({ text: `${'a'.repeat(26)}!` }, context());
    const release = new Promise<void>((resolve, reject) =>
      setTimeout(() => {
        f.scope.release().then(resolve, reject);
      }, 20),
    );
    const legal = await tool.execute({ text: 'aaa' }, context());
    expect(legal.outcome).toBe('succeeded');
    const result = await pending;
    await release;
    expect(result.content).toBe('mcp_catalogue_stale');
    expect(f.calls()).toBe(1);
  } finally {
    await other.release();
    await f.close();
  }
});

test('idle pure Worker retirement preserves the original catalogue and validates a later new call', async () => {
  const f = await fixture();
  try {
    await Bun.sleep(1100);
    expect((await f.tool.execute({ text: 'aaa' }, context())).outcome).toBe('succeeded');
    expect(f.calls()).toBe(1);
  } finally {
    await f.close();
  }
});

test('complete asynchronous schema validation cannot turn a rejected Promise into permission to call', async () => {
  const validation = createMcpSchemaValidation(
    [{ input: { type: 'object', $async: true, required: ['present'] } }],
    10000,
  );
  try {
    await validation.prepare();
    expect(await validation.validate('input', 0, {}, new AbortController().signal)).toBe(false);
    expect(
      await validation.validate('input', 0, { present: true }, new AbortController().signal),
    ).toBe(true);
  } finally {
    await validation.close();
  }
});
