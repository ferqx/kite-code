import { expect, test } from 'bun:test';
import type { McpToolMetadata, McpToolsPage, McpToolsSnapshot, SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import { TuiController, type TuiPort, TuiSession } from '../../src/tui';
import { mcpTextRows, mcpTextWindow } from '../../src/tui/mcp-tools';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const original = (generation = 1): McpToolsSnapshot => ({
  recordKey: `tools/${generation}`,
  sourceRecordKey: `connection/server/key-${generation}`,
  origin: {
    originStoreId: 'old-store',
    sessionId: 'a',
    serverId: `removed-server-${'x'.repeat(64)}`,
    configDigest: 'c'.repeat(64),
    connectionExecutionId: `connection-${generation}`,
    publisherExecutionId: `publisher-${generation}`,
    generation,
  },
  availability: 'available',
  reason: null,
  toolCount: 40,
  index: {
    id: `index-${generation}`,
    scope: { kind: 'execution', id: `publisher-${generation}` },
    size: '100',
    hash: `${generation}`.repeat(64),
    mediaType: 'application/json; charset=utf-8',
  },
});
function page(snapshot: McpToolsSnapshot, startIndex = 0): McpToolsPage {
  return {
    version: 1,
    recordKey: snapshot.recordKey,
    binding: { ...snapshot.origin, indexDigest: snapshot.index!.hash },
    availability: 'available',
    reason: null,
    toolCount: 40,
    startIndex,
    entries: Array.from({ length: Math.min(32, 40 - startIndex) }, (_, position) => ({
      index: startIndex + position,
      definitionId: `tool-${startIndex + position}`,
      definitionVersion: '1',
      label: `Tool ${startIndex + position + 1}`,
      labelComplete: false,
      descriptorHash: 'd'.repeat(64),
      descriptorBytes: '1000',
      manifest: {
        id: `manifest-${startIndex + position}`,
        scope: { kind: 'execution' as const, id: snapshot.origin.publisherExecutionId },
        size: '100',
        hash: 'e'.repeat(64),
        mediaType: 'application/json; charset=utf-8' as const,
      },
    })),
    nextIndex: startIndex === 0 ? 32 : null,
    complete: startIndex === 32,
    live: false,
    currentGeneration: 2,
  };
}
function fixture() {
  let business = 0;
  const readPages: number[] = [],
    descriptors: number[] = [],
    signals: AbortSignal[] = [];
  const port: TuiPort = {
    storeId: 'current-store',
    nextCommandId: () => {
      business++;
      throw Error('unexpected identity');
    },
    listSessions: async () => [],
    getCommand: async () => {
      business++;
      throw Error('unexpected command GET');
    },
    readSession: async (id) => ({
      storeId: 'current-store',
      view: {
        storeId: 'current-store',
        session: { id, workspaceId: `workspace-${id}` },
        runs: [],
        executions: [],
        messages: [],
      } as unknown as SessionView,
      messages: [],
      interactions: [],
    }),
    submit: async () => {
      business++;
      throw Error('unexpected submit');
    },
    answer: async () => {
      business++;
      throw Error('unexpected answer');
    },
    cancel: async () => {
      business++;
      throw Error('unexpected cancel');
    },
    mcp: {
      read: async () => {
        throw Error('empty current registry');
      },
      submit: async () => {
        business++;
        throw Error('unexpected selection');
      },
      lookup: async () => {
        business++;
        throw Error('unexpected command GET');
      },
      readToolsSnapshots: async (sessionId) => ({
        version: 1,
        sessionId,
        items: [original(), original(2)],
        nextAfterKey: null,
      }),
      readToolsPage: async (_session, snapshot, signal, options) => {
        signals.push(signal);
        readPages.push(options?.afterIndex ?? 0);
        return page(snapshot, options?.afterIndex ?? 0);
      },
      readToolDescriptor: async (_session, _binding, entry, signal) => {
        signals.push(signal);
        descriptors.push(entry.index);
        return {
          name: '完整名称😀'.repeat(80),
          description: 'original external description',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', description: 'large schema '.repeat(10000) } },
          },
          outputSchema: { type: 'object', properties: { actual: { type: 'boolean' } } },
          _meta: { tail: 'FULL_UNICODE_TAIL_终点😀' },
        } as McpToolMetadata;
      },
    },
  };
  return {
    port,
    controller: new TuiController(port),
    readPages,
    descriptors,
    signals,
    business: () => business,
  };
}

test('Ink opens cold removed snapshot through visible list, reaches later Tool page and full schema tail without business work', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.openMcp();
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    ui.stdin.write('\u001b[B');
    await tick();
    expect(ui.lastFrame()).toContain('› Saved tool snapshots');
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('Generation 1 · 40 tools · available');
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('Historical snapshot');
    expect(ui.lastFrame()).toContain('[name preview]');
    ui.stdin.write('\u001b[B'.repeat(32));
    await tick();
    expect(ui.lastFrame()).toContain('› Next tools');
    ui.stdin.write('\r');
    await tick();
    expect(f.readPages).toEqual([0, 32]);
    expect(ui.lastFrame()).toContain('33. Tool 33');
    ui.stdin.write('\r');
    await tick();
    expect(f.descriptors).toEqual([32]);
    expect(ui.lastFrame()).toContain('Complete metadata · EOF and hash verified');
    ui.stdin.write('\u001b[F');
    await tick();
    expect(ui.lastFrame()).toContain('FULL_UNICODE_TAIL_终点😀');
    expect(f.business()).toBe(0);
    ui.stdin.write('\u001b');
    await tick();
    expect(ui.lastFrame()).toContain('Tools 33');
    ui.stdin.write('\u0003');
    await tick();
    expect(f.controller.state.panel).toBeUndefined();
    expect(f.business()).toBe(0);
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
});

test('locale changes owned Tools labels without rereading or translating original metadata, and Chinese keys reach a later page and Unicode tail', async () => {
  const f = fixture();
  let locale: 'en-US' | 'zh-CN' = 'en-US',
    snapshots = 0;
  const metadata: McpToolMetadata = {
    name: 'Back',
    description: 'Next tools',
    inputSchema: {
      type: 'object',
      properties: { Rows: { type: 'string', description: 'Rows '.repeat(1500) } },
    },
    outputSchema: { type: 'object', properties: { Back: { type: 'boolean' } } },
    _meta: { tail: 'ORIGINAL_ROWS_NEXT_TOOLS_终点😀' },
  };
  const originalBytes = JSON.stringify(metadata);
  const readSnapshots = f.port.mcp!.readToolsSnapshots!;
  f.port.mcp!.readToolsSnapshots = async (...args) => {
    snapshots++;
    return readSnapshots(...args);
  };
  const readPage = f.port.mcp!.readToolsPage!;
  f.port.mcp!.readToolsPage = async (...args) => {
    const value = await readPage(...args);
    return {
      ...value,
      entries: value.entries.map((entry) =>
        entry.index === 32 ? { ...entry, label: 'Back' } : entry,
      ),
    };
  };
  f.port.mcp!.readToolDescriptor = async (_session, _binding, entry, signal) => {
    f.signals.push(signal);
    f.descriptors.push(entry.index);
    return metadata;
  };
  f.port.preferences = {
    read: async () => ({
      revision: 'a'.repeat(64),
      language: locale,
      resolvedLanguage: locale,
      colorPreset: 'teal',
      theme: 'dark',
    }),
    save: async () => {
      throw Error('unexpected preference write');
    },
  };
  await f.controller.refreshPreferences();
  await f.controller.select('a');
  await f.controller.openMcp();
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    ui.stdin.write('\u001b[B');
    await tick();
    ui.stdin.write('\r');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('MCP Tools · saved metadata');
    const before = { snapshots, pages: [...f.readPages], descriptors: [...f.descriptors] };
    locale = 'zh-CN';
    await f.controller.refreshPreferences();
    await tick();
    expect(ui.lastFrame()).toContain('MCP 工具 · 保存的描述');
    expect({ snapshots, pages: f.readPages, descriptors: f.descriptors }).toEqual(before);
    ui.stdin.write('\u001b[B'.repeat(32));
    await tick();
    expect(ui.lastFrame()).toContain('› 下一页工具');
    ui.stdin.write('\r');
    await tick();
    expect(f.readPages).toEqual([0, 32]);
    expect(ui.lastFrame()).toContain('33. Back');
    expect(ui.lastFrame()).toContain('[名称预览]');
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('完整工具描述 · 已核实 EOF 与摘要');
    expect(ui.lastFrame()).toContain('"name": "Back"');
    expect(ui.lastFrame()).toContain('"description": "Next tools"');
    expect(ui.lastFrame()).toContain('"Rows"');
    expect(f.controller.state.mcpTools?.metadata).toEqual(metadata);
    const observedMetadata = f.controller.state.mcpTools?.metadata;
    ui.stdin.write('\u001b[F');
    await tick();
    expect(ui.lastFrame()).toContain('ORIGINAL_ROWS_NEXT_TOOLS_终点😀');
    expect(ui.lastFrame()).toContain('行 ');
    const after = { snapshots, pages: [...f.readPages], descriptors: [...f.descriptors] };
    locale = 'en-US';
    await f.controller.refreshPreferences();
    await tick();
    expect(ui.lastFrame()).toContain('Complete metadata · EOF and hash verified');
    expect(ui.lastFrame()).toContain('ORIGINAL_ROWS_NEXT_TOOLS_终点😀');
    expect({ snapshots, pages: f.readPages, descriptors: f.descriptors }).toEqual(after);
    expect(JSON.stringify(metadata)).toBe(originalBytes);
    expect(f.controller.state.mcpTools?.metadata).toBe(observedMetadata);
    expect(f.business()).toBe(0);
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
});

test('descriptor reader abort and late reply cannot populate another Session or closed panel', async () => {
  const f = fixture();
  let resolve!: (metadata: McpToolMetadata) => void;
  let signal!: AbortSignal;
  f.port.mcp!.readToolDescriptor = async (_session, _binding, _entry, readSignal) => {
    signal = readSignal;
    return new Promise((done) => {
      resolve = done;
    });
  };
  await f.controller.select('a');
  await f.controller.openMcp();
  await f.controller.openMcpTools();
  await f.controller.selectMcpToolsSnapshot('tools/1');
  const pending = f.controller.selectMcpTool(0);
  expect(f.controller.state.mcpTools?.phase).toBe('reading');
  f.controller.closePanel();
  expect(signal.aborted).toBe(true);
  await f.controller.select('b');
  resolve({ name: 'late', inputSchema: {} } as McpToolMetadata);
  await pending;
  expect(f.controller.state.mcpTools).toBeUndefined();
  expect(f.business()).toBe(0);
  f.controller.dispose();
});

test('page cannot substitute another generation or index, and failed metadata is never marked complete', async () => {
  const f = fixture();
  f.port.mcp!.readToolsPage = async () => page(original(2));
  await f.controller.select('a');
  await f.controller.openMcp();
  await f.controller.openMcpTools();
  await f.controller.selectMcpToolsSnapshot('tools/1');
  expect(f.controller.state.mcpTools?.phase).toBe('failed');
  expect(f.controller.state.mcpTools?.error).toBe('mcp_tools_binding_mismatch');
  expect(f.controller.state.mcpTools?.metadata).toBeUndefined();
  expect(f.business()).toBe(0);
  f.controller.dispose();
});

test('text viewport preserves Unicode boundaries and complete long-line tail', () => {
  const text = `${'😀长'.repeat(1000)}\nORIGINAL_END`;
  const rows = mcpTextRows(text);
  expect(rows.map((start, index) => text.slice(start, rows[index + 1])).join('')).toBe(text);
  expect(mcpTextWindow(text, rows, rows.length - 1).join('')).toBe('ORIGINAL_END');
  expect(rows.every((start) => !/[\udc00-\udfff]/u.test(text[start] ?? ''))).toBe(true);
});

for (const forwards of [false, true])
  test(`Ink empty snapshot page ${forwards ? 'advances through its original cursor' : 'rejects a repeated original cursor'} without retrying automatically`, async () => {
    const f = fixture(),
      first = `tools/${'a'.repeat(64)}`,
      next = `tools/${'b'.repeat(64)}`;
    const cursors: (string | undefined)[] = [];
    f.port.mcp!.readToolsSnapshots = async (sessionId, _signal, options) => {
      cursors.push(options?.afterKey);
      return {
        version: 1,
        sessionId,
        items: [],
        nextAfterKey: options?.afterKey ? (forwards ? next : first) : first,
      };
    };
    await f.controller.select('a');
    await f.controller.openMcp();
    await f.controller.openMcpTools();
    const ui = render(<TuiSession controller={f.controller} />);
    try {
      await tick();
      expect(ui.lastFrame()).toContain('› Next saved snapshots');
      ui.stdin.write('\r');
      await tick();
      expect(cursors).toEqual([undefined, first]);
      expect(f.controller.state.mcpTools?.phase).toBe(forwards ? 'ready' : 'failed');
      if (forwards) expect(f.controller.state.mcpTools?.snapshots?.nextAfterKey).toBe(next);
      else expect(ui.lastFrame()).toContain('mcp_tools_cursor_stale');
      expect(f.business()).toBe(0);
    } finally {
      ui.unmount();
      f.controller.dispose();
    }
  });
