import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { AgentClient, Execution, Message, Run } from '@kite-ai/client';
import { decodeNativeRequest } from '../electron/native-ipc';
import { nativeLiveShellInputFact } from '../electron/tool-message-fact';
import { NativeToolMessages } from '../electron/tool-messages';
import {
  authorizationApproval,
  desktopToolMessage,
  desktopToolPresentation,
} from '../src/native-tool-messages';
import {
  type NativeToolMessageScope,
  nativeShellCommandChunkBytes,
  nativeToolMessagePageBytes,
} from '../src/tool-messages-bridge';

function fixture() {
  let scope: NativeToolMessageScope = {
    generation: 1,
    viewSelection: 2,
    historyEpoch: 0,
    storeId: 'store',
    sessionId: 's',
    workspaceId: 'w',
  };
  const messages = new Map<string, Message>(),
    executions = new Map<string, Execution>(),
    reads: string[] = [];
  const client = {
    verifyConnection: async () => {},
    getExecution: async (id: string) => {
      reads.push(id);
      return executions.get(id)!;
    },
  } as unknown as AgentClient;
  const manager = new NativeToolMessages(
    client,
    () => scope,
    () => messages,
  );
  const add = (
    id: string,
    status: Execution['status'],
    run = id,
    definitionId = 'shell.launch',
  ) => {
    messages.set(`call-${id}`, {
      id: `call-${id}`,
      seq: String(messages.size + 1),
      sessionId: 's',
      runId: run,
      role: 'assistant',
      status: 'complete',
      content: '',
      toolCalls: [
        {
          id: 'repeated',
          name: definitionId,
          arguments: JSON.stringify({ command: `${id} 雪🙂`, path: `${id}.txt` }),
        },
      ],
    });
    const message: Message = {
      id,
      seq: String(messages.size + 1),
      sessionId: 's',
      runId: run,
      role: 'tool',
      status: 'complete',
      content: `original-${id}`,
      toolCallId: 'repeated',
      sourceIds: [`execution-${id}`],
    };
    messages.set(id, message);
    executions.set(`execution-${id}`, {
      id: `execution-${id}`,
      originStoreId: 'store',
      sessionId: 's',
      runId: run,
      kind: 'tool',
      definitionId,
      definitionVersion: '1',
      status,
      result: { outcome: status, content: message.content },
      resultRevision: '1',
      cancelRequestedAt: null,
    });
  };
  const list = (messageIds: string[]) =>
    manager.list({
      method: 'toolMessages.list',
      generation: 1,
      viewSelection: scope.viewSelection,
      historyEpoch: scope.historyEpoch,
      readId: crypto.randomUUID(),
      messageIds,
    });
  return {
    client,
    messages,
    executions,
    reads,
    manager,
    add,
    list,
    get scope() {
      return scope;
    },
    set scope(value) {
      scope = value;
    },
  };
}

test('current and saved workspace write versions retain their known Native presentation', () => {
  for (const definitionVersion of ['2', '3'])
    expect(
      desktopToolPresentation({ definitionId: 'files.write', definitionVersion }),
    ).toMatchObject({ toolName: 'write_file', title: '写入' });
  expect(
    desktopToolPresentation({ definitionId: 'files.write', definitionVersion: 'future' }),
  ).toMatchObject({ title: '写入', toolName: undefined });
});

test('current and saved file discovery versions keep readable labels and exploration grouping', () => {
  for (const [definitionId, versions, toolName, title] of [
    ['files.glob', ['2', '3'], 'files.glob', '查找文件'],
    ['files.search', ['2', '3', '4', '5'], 'search_content', '搜索内容'],
  ] as const) {
    for (const definitionVersion of versions)
      expect(desktopToolPresentation({ definitionId, definitionVersion })).toMatchObject({
        toolName,
        title,
        presentation: 'exploration',
      });
    expect(desktopToolPresentation({ definitionId, definitionVersion: 'future' })).toEqual({
      toolName: undefined,
      title,
    });
  }
});

test('future known tools keep stable names without borrowing structured semantics', () => {
  for (const [definitionId, title] of [
    ['files.read', '读取'],
    ['files.edit', '修改'],
    ['files.list', '列出目录'],
    ['shell.execute', '运行命令'],
    ['ask_user', '询问用户'],
    ['task.spawn', '创建子 Agent'],
  ] as const)
    expect(desktopToolPresentation({ definitionId, definitionVersion: '999' })).toEqual({
      toolName: undefined,
      title,
    });
  expect(desktopToolPresentation({ definitionId: 'new.tool', definitionVersion: '999' })).toEqual({
    toolName: undefined,
    title: 'new.tool',
  });
});

test('plan, validation and MCP display names retain exact versions and generic MCP fallback', () => {
  for (const [definitionId, title] of [
    ['files.write_path', '写入用户文件'],
    ['files.edit_path', '修改用户文件'],
    ['planning.read', '读取计划'],
    ['planning.write', '编写计划'],
    ['planning.review', '请求计划审阅'],
    ['planning.update', '更新计划'],
    ['validation.define', '定义验证检查'],
    ['validation.check', '运行验证'],
    ['validation.rebind', '关联修复结果'],
    ['validation.request_waiver', '请求验证豁免'],
    ['validation.auto_check', '检查文件变更'],
    ['mcp.tools.search', '搜索 MCP 工具'],
    ['mcp.resources.list', '列出 MCP 资源'],
    ['mcp.resources.read', '读取 MCP 资源'],
  ]) {
    expect(
      desktopToolPresentation({ definitionId: definitionId!, definitionVersion: '1' }).title,
    ).toBe(title);
    expect(
      desktopToolPresentation({ definitionId: definitionId!, definitionVersion: 'future' }),
    ).toMatchObject({ title, toolName: undefined });
  }
  const definitionId = `mcp.docs.${'a'.repeat(32)}`;
  expect(desktopToolPresentation({ definitionId, definitionVersion: 'digest' }).title).toBe(
    'MCP 工具',
  );
  expect(
    desktopToolMessage(
      { definitionId, definitionVersion: 'digest', status: 'failed', label: 'MCP · search_docs' },
      'mcp',
      'actual failure',
    ),
  ).toMatchObject({ title: 'MCP · search_docs', status: 'failed', text: 'actual failure' });
});

test('Native MCP names come only from exact saved metadata; failed metadata never withdraws an original tool outcome', async () => {
  const f = fixture();
  const name = 'search_docs',
    hash = 'a'.repeat(64),
    version = 'b'.repeat(64);
  const definitionId = `mcp.docs.${createHash('sha256').update(JSON.stringify(name)).digest('hex').slice(0, 32)}`;
  f.add('mcp', 'failed', 'run', definitionId);
  f.executions.get('execution-mcp')!.definitionVersion = version;
  const origin = {
    originStoreId: 'store',
    sessionId: 's',
    serverId: 'docs',
    configDigest: hash,
    connectionExecutionId: 'connection',
    publisherExecutionId: 'publisher',
    generation: 1,
  };
  const ref = {
    id: 'index',
    hash,
    size: '100',
    mediaType: 'application/json; charset=utf-8',
    scope: { kind: 'execution', id: 'publisher' },
  };
  let pageVersion = version,
    label = name,
    foreign = false,
    unavailable = false;
  const queries: string[] = [];
  f.client.queryExtension = async (sessionId, extensionId, query) => {
    expect(sessionId).toBe('s');
    expect(extensionId).toBe('builtin.mcp');
    queries.push(query);
    if (unavailable) throw Error('metadata unavailable');
    return [
      {
        extensionId,
        contentType:
          query === 'mcp.tools.snapshots' ? 'builtin.mcp.tools.snapshots' : 'builtin.mcp.tools',
        contentVersion: 1,
        summary: 'saved metadata',
        actions: [],
        artifactRefs: [],
        payload:
          query === 'mcp.tools.snapshots'
            ? {
                version: 1,
                sessionId,
                items: [
                  {
                    recordKey: `tools/${hash}`,
                    sourceRecordKey: 'source/original',
                    origin: { ...origin, originStoreId: foreign ? 'foreign' : 'store' },
                    availability: 'available',
                    reason: null,
                    toolCount: 1,
                    index: ref,
                  },
                ],
                nextAfterKey: null,
              }
            : {
                version: 1,
                recordKey: `tools/${hash}`,
                binding: { ...origin, indexDigest: hash },
                availability: 'available',
                reason: null,
                toolCount: 1,
                startIndex: 0,
                entries: [
                  {
                    index: 0,
                    definitionId,
                    definitionVersion: pageVersion,
                    label,
                    labelComplete: true,
                    descriptorHash: hash,
                    descriptorBytes: '100',
                    manifest: ref,
                  },
                ],
                nextIndex: null,
                complete: true,
                live: false,
                currentGeneration: null,
              },
      },
    ] as Awaited<ReturnType<AgentClient['queryExtension']>>;
  };
  try {
    expect((await f.list(['mcp'])).entries[0]).toMatchObject({
      label: 'MCP · search_docs',
      status: 'failed',
    });
    expect(queries).toEqual(['mcp.tools.snapshots', 'mcp.tools']);
    for (const change of ['version', 'name', 'origin', 'unavailable']) {
      pageVersion = change === 'version' ? 'c'.repeat(64) : version;
      label = change === 'name' ? 'forged_name' : name;
      foreign = change === 'origin';
      unavailable = change === 'unavailable';
      const fact = (await f.list(['mcp'])).entries[0]!;
      expect(fact.status).toBe('failed');
      expect(fact.label).toBeUndefined();
    }
    unavailable = foreign = false;
    pageVersion = version;
    label = name;
    const originalQuery = f.client.queryExtension;
    let start!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.client.queryExtension = async (...args) => {
      start();
      await held;
      return originalQuery(...args);
    };
    const pending = f.list(['mcp']);
    await started;
    f.scope = { ...f.scope, viewSelection: 3 };
    release();
    await expect(pending).rejects.toMatchObject({ code: 'native_selection_changed' });
  } finally {
    f.manager.release();
  }
});

test('Web Fetch rows use the supported definition and only a unique original call supplies the URL', async () => {
  expect(
    desktopToolPresentation({ definitionId: 'web_fetch', definitionVersion: '1' }),
  ).toMatchObject({ toolName: 'web_fetch', title: '读取网页' });
  expect(
    desktopToolPresentation({ definitionId: 'web_fetch', definitionVersion: 'future' }),
  ).toMatchObject({ toolName: undefined, title: '读取网页' });
  const f = fixture();
  try {
    for (const id of ['verified', 'future', 'missing']) {
      f.add(id, 'failed', id, 'web_fetch');
      f.messages.get(`call-${id}`)!.toolCalls![0]!.arguments = JSON.stringify({
        url: 'https://github.com/AppFlowy-IO/AppFlowy',
      });
    }
    f.executions.get('execution-future')!.definitionVersion = 'future';
    f.messages.delete('call-missing');
    expect(
      (await f.list(['verified', 'future', 'missing'])).entries.map((fact) => fact.target),
    ).toEqual(['https://github.com/AppFlowy-IO/AppFlowy', undefined, undefined]);
    const duplicate = { ...f.messages.get('call-verified')!, id: 'duplicate', seq: '1' };
    f.messages.set('duplicate', duplicate);
    expect((await f.list(['verified'])).entries[0]!.target).toBeUndefined();
  } finally {
    f.manager.release();
  }
});

test('cache samples use immutable original Model receipts beyond the View, retain sealed origins and reject invented token pairs', async () => {
  const f = fixture();
  const add = (id: string, usage: unknown = { inputTokens: 100, cachedInputTokens: 40 }) => {
    const message: Message = {
      id,
      seq: String(f.messages.size + 1),
      sessionId: 's',
      runId: `run-${id}`,
      role: 'assistant',
      status: 'complete',
      content: `original-${id}`,
      sourceIds: [`model-${id}`],
    };
    f.messages.set(id, message);
    f.executions.set(`model-${id}`, {
      id: `model-${id}`,
      originStoreId: 'store',
      sessionId: 's',
      runId: message.runId,
      kind: 'model',
      definitionId: 'fixed',
      definitionVersion: '1',
      status: 'succeeded',
      result: { content: message.content, usage },
      resultRevision: '1',
      cancelRequestedAt: null,
    } as Execution);
    return message;
  };
  const read = (messageIds: string[]) =>
    f.manager.usage({
      method: 'toolMessages.usage',
      generation: 1,
      viewSelection: f.scope.viewSelection,
      historyEpoch: f.scope.historyEpoch,
      readId: crypto.randomUUID(),
      messageIds,
    });
  try {
    for (let i = 0; i < 241; i++) add(`usage-${i}`);
    expect((await read(['usage-240'])).entries).toEqual([
      {
        messageId: 'usage-240',
        executionId: 'model-usage-240',
        originStoreId: 'store',
        cacheHitTokens: 40,
        cacheMissTokens: 60,
      },
    ]);
    add('no-cache-field', { inputTokens: 100 });
    add('zero-input', { inputTokens: 0, cachedInputTokens: 0 });
    add('observed-zero', { inputTokens: 100, cachedInputTokens: 0 });
    expect((await read(['no-cache-field', 'zero-input', 'observed-zero'])).entries).toMatchObject([
      { messageId: 'observed-zero', cacheHitTokens: 0, cacheMissTokens: 100 },
    ]);
    const original = f.messages.get('usage-240')!;
    f.messages.set('copied-usage', {
      ...original,
      id: 'copied-usage',
      runId: null,
      originMessage: {
        storeId: 'store',
        sessionId: 's',
        messageId: original.id,
        runId: original.runId ?? null,
      },
    });
    expect((await read(['copied-usage'])).entries).toMatchObject([
      { messageId: 'copied-usage', executionId: 'model-usage-240', cacheHitTokens: 40 },
    ]);
    f.executions.get('model-usage-240')!.originStoreId = 'old-store';
    f.messages.get('copied-usage')!.originMessage!.storeId = 'old-store';
    f.client.getRun = async () => {
      throw new Error('sealed_source_run_state_must_not_be_read');
    };
    expect((await read(['copied-usage'])).entries).toMatchObject([
      {
        messageId: 'copied-usage',
        executionId: 'model-usage-240',
        originStoreId: 'old-store',
        cacheHitTokens: 40,
      },
    ]);
    const restored = add('restored');
    f.executions.get('model-restored')!.originStoreId = 'old-store';
    f.client.getRun = async () =>
      ({
        id: restored.runId,
        sessionId: 's',
        originStoreId: 'old-store',
        status: 'interrupted',
        isActive: false,
      }) as Run;
    expect((await read(['restored'])).entries[0]?.originStoreId).toBe('old-store');
    f.client.getRun = async () =>
      ({
        id: restored.runId,
        sessionId: 's',
        originStoreId: 'old-store',
        status: 'running',
        isActive: true,
      }) as Run;
    await expect(read(['restored'])).rejects.toMatchObject({
      code: 'model_usage_identity_mismatch',
    });
    for (const usage of [
      { inputTokens: null, cachedInputTokens: 1 },
      { inputTokens: 10, cachedInputTokens: 11 },
      { inputTokens: 10, cachedInputTokens: -1 },
      { inputTokens: 10.5, cachedInputTokens: 1 },
    ]) {
      add('invalid', usage);
      await expect(read(['invalid'])).rejects.toMatchObject({ code: 'model_usage_unavailable' });
    }
    add('wrong-source');
    f.executions.get('model-wrong-source')!.sessionId = 'other';
    await expect(read(['wrong-source'])).rejects.toMatchObject({
      code: 'model_usage_identity_mismatch',
    });
    expect(() =>
      decodeNativeRequest({
        method: 'toolMessages.usage',
        generation: 1,
        viewSelection: 2,
        historyEpoch: 0,
        readId: 'r',
        messageIds: ['usage-0'],
        executionId: 'unchecked',
      }),
    ).toThrow('invalid_native_request');
  } finally {
    f.manager.release();
  }
});

test('late cache metadata is confined to its original observed message and read scope', async () => {
  const f = fixture();
  const message: Message = {
    id: 'm',
    seq: '1',
    sessionId: 's',
    runId: 'r',
    role: 'assistant',
    status: 'complete',
    content: 'original',
    sourceIds: ['model'],
  };
  f.messages.set(message.id, message);
  let entered!: () => void, release!: (value: Execution) => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.client.getExecution = async () => {
    entered();
    return new Promise<Execution>((resolve) => {
      release = resolve;
    });
  };
  const execution = {
    id: 'model',
    originStoreId: 'store',
    sessionId: 's',
    runId: 'r',
    kind: 'model',
    definitionId: 'fixed',
    definitionVersion: '1',
    status: 'succeeded',
    result: { content: 'original', usage: { inputTokens: 10, cachedInputTokens: 5 } },
    resultRevision: '1',
    cancelRequestedAt: null,
  } as Execution;
  const read = f.manager.usage({
    method: 'toolMessages.usage',
    generation: 1,
    viewSelection: 2,
    historyEpoch: 0,
    readId: 'late-usage',
    messageIds: ['m'],
  });
  await started;
  f.scope = { ...f.scope, sessionId: 'other', viewSelection: 3 };
  release(execution);
  await expect(read).rejects.toMatchObject({ code: 'native_selection_changed' });
  f.scope = { ...f.scope, sessionId: 's', viewSelection: 2 };
  f.client.getExecution = async () => execution;
  let verified = 0;
  const verifyConnection = f.client.verifyConnection.bind(f.client);
  f.client.verifyConnection = async () => {
    if (++verified === 2) f.messages.set('m', { ...message, content: 'later body' });
    return verifyConnection();
  };
  await expect(
    f.manager.usage({
      method: 'toolMessages.usage',
      generation: 1,
      viewSelection: 2,
      historyEpoch: 0,
      readId: 'changed-usage',
      messageIds: ['m'],
    }),
  ).rejects.toMatchObject({ code: 'native_selection_changed' });
  f.manager.release();
});

test('tool receipts outside the bounded View retain exact outcomes and only unique original call targets; repeated call IDs never establish execution identity', async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 241; index++) f.add(`m${index}`, 'succeeded');
    f.add('failed', 'failed');
    f.add('cancelled', 'cancelled');
    f.add('unknown', 'outcome_unknown');
    f.executions.get('execution-m240')!.authorization = {
      dispatched: true,
      review: {
        executionId: 'original-review',
        status: 'succeeded',
        decision: 'approve_once',
        reason: '原批准原因 雪🙂',
        requireApproval: false,
      },
    };
    const page = await f.list(['m240', 'failed', 'cancelled', 'unknown']);
    expect(page.entries.map((entry) => entry.status)).toEqual([
      'succeeded',
      'failed',
      'cancelled',
      'outcome_unknown',
    ]);
    expect(page.entries.map((entry) => entry.target)).toEqual([
      'm240 雪🙂',
      'failed 雪🙂',
      'cancelled 雪🙂',
      'unknown 雪🙂',
    ]);
    expect(f.reads).toEqual([
      'execution-m240',
      'execution-failed',
      'execution-cancelled',
      'execution-unknown',
    ]);
    expect(page.scope).toEqual(f.scope);
    expect(page.entries[0]!.authorization).toEqual(
      f.executions.get('execution-m240')!.authorization,
    );
    f.add('first-same-run', 'succeeded', 'shared');
    f.add('second-same-run', 'failed', 'shared');
    expect((await f.list(['second-same-run'])).entries[0]).toMatchObject({
      executionId: 'execution-second-same-run',
      status: 'failed',
    });
    expect((await f.list(['second-same-run'])).entries[0]!.target).toBeUndefined();
    const execution = f.executions.get('execution-failed')!;
    execution.result = { outcome: 'succeeded', content: 'original-failed' };
    expect((await f.list(['failed'])).entries).toEqual([]);
    execution.result = { outcome: 'failed', content: 'later unrelated body' };
    expect((await f.list(['failed'])).entries).toEqual([]);
    execution.result = { outcome: 'failed', content: 'original-failed' };
    execution.runId = 'm240';
    await expect(f.list(['failed'])).rejects.toMatchObject({
      code: 'tool_message_identity_mismatch',
    });
    await expect(f.list(['unobserved'])).rejects.toMatchObject({
      code: 'tool_message_unavailable',
    });
  } finally {
    f.manager.release();
  }
});

test('incomplete or unsupported matching calls remain conflicts before original call readiness is checked', async () => {
  const f = fixture();
  f.add('command', 'succeeded', 'run', 'shell.execute');
  const original = f.messages.get('call-command')!;
  const duplicate: Message = { ...original, id: 'duplicate-call' };
  try {
    expect((await f.list(['command'])).entries[0]!.shellInput?.command).toBe('command 雪🙂');
    for (const state of [
      { status: 'incomplete' as const },
      { contentFormat: 'unsupported' as const },
    ]) {
      f.messages.set(duplicate.id, { ...duplicate, ...state });
      const fact = (await f.list(['command'])).entries[0]!;
      expect(fact.target).toBeUndefined();
      expect(fact.shellInput?.command).toBeUndefined();
      f.messages.delete(duplicate.id);
      expect((await f.list(['command'])).entries[0]!.shellInput?.command).toBe('command 雪🙂');
      f.messages.set(original.id, { ...original, ...state });
      expect((await f.list(['command'])).entries[0]!.shellInput?.command).toBeUndefined();
      f.messages.set(original.id, original);
    }
  } finally {
    f.manager.release();
  }
});

test('list_directory displays the known root default only for a unique verified original call', async () => {
  const f = fixture();
  try {
    for (const [id, input] of [
      ['omitted', { limit: 50 }],
      ['empty', { path: '' }],
      ['dot', { path: '.' }],
      ['absolute', { path: 'C:\\workspace\\project' }],
      ['invalid', { path: null }],
      ['future', {}],
    ] as const) {
      f.add(id, 'succeeded', id, 'files.list');
      f.messages.get(`call-${id}`)!.toolCalls![0]!.arguments = JSON.stringify(input);
    }
    f.executions.get('execution-future')!.definitionVersion = '9';
    expect(
      (await f.list(['omitted', 'empty', 'dot', 'absolute', 'invalid', 'future'])).entries.map(
        (entry) => entry.target,
      ),
    ).toEqual(['.', '.', '.', 'C:\\workspace\\project', undefined, undefined]);
    f.messages.delete('call-omitted');
    expect((await f.list(['omitted'])).entries[0]!.target).toBeUndefined();
    f.add('ambiguous-first', 'succeeded', 'shared', 'files.list');
    f.add('ambiguous-second', 'succeeded', 'shared', 'files.list');
    for (const id of ['ambiguous-first', 'ambiguous-second'])
      f.messages.get(`call-${id}`)!.toolCalls![0]!.arguments = '{}';
    expect((await f.list(['ambiguous-second'])).entries[0]!.target).toBeUndefined();
  } finally {
    f.manager.release();
  }
});

test('sealed Fork provenance is read-only, mismatched original Stores are rejected, unsupported results cause no Execution GET, and close/selection change abort only the owned metadata read', async () => {
  const f = fixture();
  try {
    f.add('fork', 'failed');
    const message = f.messages.get('fork')!;
    message.originMessage = {
      storeId: 'store',
      sessionId: 'source',
      runId: 'source-run',
      messageId: 'original',
    };
    const execution = f.executions.get('execution-fork')!;
    execution.sessionId = 'source';
    execution.runId = 'source-run';
    execution.authorization = {
      dispatched: false,
      review: {
        executionId: 'later-review',
        status: 'succeeded',
        decision: 'reject',
        reason: 'later source state',
        requireApproval: false,
      },
    };
    expect((await f.list(['fork'])).entries[0]).toMatchObject({
      executionId: execution.id,
      status: 'failed',
    });
    expect((await f.list(['fork'])).entries[0]!.authorization).toBeUndefined();
    f.reads.length = 0;
    message.originMessage.storeId = 'old-store';
    await expect(f.list(['fork'])).rejects.toMatchObject({
      code: 'tool_message_identity_mismatch',
    });
    expect(f.reads).toEqual([execution.id]);
    f.reads.length = 0;
    message.originMessage.storeId = 'store';
    message.originMessage.runId = null;
    expect((await f.list(['fork'])).entries).toEqual([]);
    expect(f.reads).toEqual([]);
    message.originMessage.runId = 'source-run';
    message.contentFormat = 'unsupported';
    expect((await f.list(['fork'])).entries).toEqual([]);
    expect(f.reads).toEqual([]);
    delete message.contentFormat;
    let release!: (value: Execution) => void, signal: AbortSignal | undefined;
    let started!: () => void;
    let ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.client.getExecution = (async (_id, options) => {
      signal = options?.signal;
      started();
      return new Promise<Execution>((resolve) => {
        release = resolve;
      });
    }) as AgentClient['getExecution'];
    const pending = f.manager.list({
      method: 'toolMessages.list',
      generation: 1,
      viewSelection: 2,
      historyEpoch: 0,
      readId: 'held',
      messageIds: ['fork'],
    });
    const rejection = pending.catch((error: unknown) => error);
    await ready;
    f.manager.close('held');
    expect(signal?.aborted).toBe(true);
    release(execution);
    expect(await rejection).toMatchObject({ code: 'native_selection_changed' });
    ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const next = f.manager.list({
      method: 'toolMessages.list',
      generation: 1,
      viewSelection: 2,
      historyEpoch: 0,
      readId: 'later',
      messageIds: ['fork'],
    });
    const changed = next.catch((error: unknown) => error);
    await ready;
    f.scope = { ...f.scope, historyEpoch: 1 };
    release(execution);
    expect(await changed).toMatchObject({ code: 'native_selection_changed' });
    expect(signal?.aborted).toBe(true);
  } finally {
    f.manager.release();
  }
});

test('tool metadata IPC has the same closed 32-message request and current reading scope', () => {
  const request = {
    method: 'toolMessages.list' as const,
    generation: 1,
    viewSelection: 2,
    historyEpoch: 0,
    readId: 'owned',
    messageIds: ['observed'],
  };
  expect(decodeNativeRequest(request)).toEqual(request);
  for (const change of [
    { executionId: 'arbitrary' },
    { messageIds: Array.from({ length: 33 }, (_, index) => `m${index}`) },
    { messageIds: ['same', 'same'] },
    { messageIds: ['../path'] },
    { viewSelection: 0 },
    { historyEpoch: -1 },
  ])
    expect(() => decodeNativeRequest({ ...request, ...change })).toThrow('invalid_native_request');
  expect(
    decodeNativeRequest({ method: 'toolMessages.close', generation: 1, readId: 'owned' }),
  ).toMatchObject({ method: 'toolMessages.close' });
});

test('observed Run history beyond the bounded View preserves restored terminal origins; sealed sources and foreign active Runs acquire no hot facts', async () => {
  const f = fixture(),
    reads: string[] = [];
  const run = (id: string): Run => ({
    id,
    originStoreId: 'store',
    originCommandId: `c-${id}`,
    sessionId: 's',
    status: 'completed',
    isActive: false,
    createdAt: 1000,
    finishedAt: 3000,
    reason: null,
  });
  f.client.getRun = async (id) => {
    reads.push(id);
    return run(id);
  };
  for (let index = 0; index < 241; index++)
    f.messages.set(`m-${index}`, {
      id: `m-${index}`,
      role: 'user',
      seq: String(index + 1),
      runId: `r-${index}`,
      sessionId: 's',
      status: 'complete',
      content: `exact ${index}`,
    });
  const request = (messageIds: string[], readId: string = crypto.randomUUID()) =>
    f.manager.runs({
      method: 'toolMessages.runs',
      generation: 1,
      viewSelection: 2,
      historyEpoch: 0,
      messageIds,
      readId,
    });
  const page = await request(['m-240']);
  expect(page.runs).toEqual([
    {
      id: 'r-240',
      originStoreId: 'store',
      sessionId: 's',
      status: 'completed',
      isActive: false,
      createdAt: 1000,
      finishedAt: 3000,
      reason: null,
    },
  ]);
  expect('configuration' in page.runs[0]!).toBe(false);
  await expect(request(['never-observed'])).rejects.toMatchObject({
    code: 'tool_message_unavailable',
  });
  expect(reads).toEqual(['r-240']);
  const original = f.messages.get('m-240')!;
  f.messages.set('copied', {
    ...original,
    id: 'copied',
    originMessage: {
      storeId: 'store',
      sessionId: 's',
      messageId: original.id,
      runId: original.runId,
    },
  });
  expect((await request(['copied'])).runs).toEqual([]);
  expect(reads).toEqual(['r-240']);
  f.client.getRun = async (id) => ({ ...run(id), originStoreId: 'foreign' });
  expect((await request(['m-239'])).runs).toMatchObject([
    { id: 'r-239', originStoreId: 'foreign', sessionId: 's', status: 'completed', isActive: false },
  ]);
  f.client.getRun = async (id) => ({
    ...run(id),
    originStoreId: 'foreign',
    status: 'running',
    isActive: true,
    finishedAt: null,
  });
  expect((await request(['m-239'])).runs).toEqual([]);
  f.client.getRun = async (id) => ({ ...run(id), id: 'other' });
  await expect(request(['m-238'])).rejects.toMatchObject({
    code: 'tool_message_identity_mismatch',
  });
  expect(() =>
    decodeNativeRequest({
      method: 'toolMessages.runs',
      generation: 1,
      viewSelection: 2,
      historyEpoch: 0,
      readId: 'r',
      messageIds: Array.from({ length: 33 }, (_, i) => `m-${i}`),
    }),
  ).toThrow('invalid_native_request');
  expect(() =>
    decodeNativeRequest({
      method: 'toolMessages.runs',
      generation: 1,
      viewSelection: 2,
      historyEpoch: 0,
      readId: 'r',
      messageIds: ['m-1'],
      runId: 'unchecked',
    }),
  ).toThrow('invalid_native_request');
  let entered!: () => void, release!: (value: Run) => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.client.getRun = async () => {
    entered();
    return new Promise<Run>((resolve) => {
      release = resolve;
    });
  };
  const pending = request(['m-237'], 'held').then(
    () => undefined,
    (cause: unknown) => cause,
  );
  await started;
  f.manager.close('held');
  release(run('r-237'));
  expect(await pending).toMatchObject({ code: 'native_selection_changed' });
});

test('restored source and sealed Fork ask_user receipts preserve the original questions and human answers as read-only facts', async () => {
  const f = fixture();
  f.add('restored-ask', 'succeeded', 'original-run', 'ask_user');
  const call = f.messages.get('call-restored-ask')!,
    message = f.messages.get('restored-ask')!,
    execution = f.executions.get('execution-restored-ask')!;
  const questions = [{ question: '保留哪个实现？', options: [{ label: '原PC界面' }] }];
  call.toolCalls![0]!.arguments = JSON.stringify({ questions });
  message.content = JSON.stringify({ answer: '原PC界面', answers: { q1: '原PC界面' } });
  execution.originStoreId = 'original-store';
  execution.result = { outcome: 'succeeded', content: message.content };
  f.client.getRun = async () => {
    throw Error('source_run_state_must_not_be_read');
  };
  try {
    const direct = await f.list([message.id]);
    expect(direct.entries[0]!.ask).toEqual({
      questions: [{ id: 'q1', question: questions[0]!.question }],
      summary: '原PC界面',
      answers: { q1: '原PC界面' },
    });
    for (const row of [call, message]) {
      row.originMessage = {
        storeId: 'original-store',
        sessionId: 'source',
        messageId: `original-${row.id}`,
        runId: 'original-run',
      };
      row.runId = null;
    }
    execution.sessionId = 'source';
    execution.authorization = { dispatched: false };
    const sealed = await f.list([message.id]);
    expect(sealed.entries[0]!.ask).toEqual(direct.entries[0]!.ask);
    expect(sealed.entries[0]!.authorization).toBeUndefined();
    expect(message.originMessage!.storeId).toBe('original-store');
    expect(f.reads).toEqual([execution.id, execution.id]);
  } finally {
    f.manager.release();
  }
});
test('known ask_user receipts keep the actual human answer and information cancellation; an ambiguous request or future version cannot invent question ownership', async () => {
  const f = fixture();
  const questions = [
    {
      question: '选择主线 雪🙂',
      options: [
        { label: '保留原代码', description: '完整迁入' },
        { label: '继续阅读', description: '查看源码' },
      ],
    },
    {
      question: '补充约束',
      options: [
        { label: 'macOS', description: '宿主优先' },
        { label: '等待', description: '暂缓' },
      ],
    },
  ];
  const set = (id: string, value: unknown) => {
    f.add(id, 'succeeded', `run-${id}`, 'ask_user');
    f.messages.get(`call-${id}`)!.toolCalls![0]!.arguments = JSON.stringify({ questions });
    const content = JSON.stringify(value);
    f.messages.get(id)!.content = content;
    f.executions.get(`execution-${id}`)!.result = { outcome: 'succeeded', content };
  };
  set('answered', {
    answer: '选择主线 雪🙂: 保留原代码\n补充约束:  原文 雪🙂\r\n',
    answers: { q1: '保留原代码', q2: ' 原文 雪🙂\r\n' },
  });
  const answered = (await f.list(['answered'])).entries[0]!;
  expect(answered.ask?.questions).toEqual([
    { id: 'q1', question: questions[0]!.question },
    { id: 'q2', question: questions[1]!.question },
  ]);
  expect(answered.ask?.answers).toEqual({ q1: '保留原代码', q2: ' 原文 雪🙂\r\n' });
  expect(answered.status).toBe('succeeded');
  set('cancelled-info', { cancelled: true });
  const cancelled = (await f.list(['cancelled-info'])).entries[0]!;
  expect(cancelled.ask?.cancelled).toBe(true);
  expect(cancelled.status).toBe('succeeded');
  f.messages
    .get('call-answered')!
    .toolCalls!.push({ ...f.messages.get('call-answered')!.toolCalls![0]! });
  expect((await f.list(['answered'])).entries[0]!.ask?.questions).toEqual([]);
  expect((await f.list(['answered'])).entries[0]!.ask?.summary).toBe(answered.ask?.summary);
  f.executions.get('execution-answered')!.definitionVersion = 'future';
  expect((await f.list(['answered'])).entries[0]!.ask).toBeUndefined();
});

test('only exact Core pre-dispatch freshness receipts gain neutral display facts, including cold original history', async () => {
  const f = fixture();
  const make = (id: string, code = 'context_refresh_required') => {
    f.add(id, 'failed', id, 'files.read');
    const message = f.messages.get(id)!,
      execution = f.executions.get(`execution-${id}`)!;
    message.content = code;
    execution.result = {
      outcome: 'failed',
      content: code,
      details: { code, adapterAttempted: false, dispatchCommitted: false },
    };
    execution.authorization = { dispatched: false };
    return { message, execution };
  };
  try {
    make('context');
    make('capability', 'capability_refresh_required');
    make('forged-dispatched').execution.authorization = { dispatched: true };
    delete make('missing-dispatch').execution.authorization;
    make('missing-adapter-proof').execution.result = {
      outcome: 'failed',
      content: 'context_refresh_required',
      details: { code: 'context_refresh_required', dispatchCommitted: false },
    };
    make('wrong-code', 'approval_denied');
    make('body-only').execution.result = { outcome: 'failed', content: 'context_refresh_required' };
    const inconsistent = make('inconsistent');
    inconsistent.execution.result = {
      outcome: 'failed',
      content: 'context_refresh_required',
      details: {
        code: 'capability_refresh_required',
        adapterAttempted: false,
        dispatchCommitted: false,
      },
    };
    const unknown = make('unknown');
    unknown.execution.status = 'outcome_unknown';
    unknown.execution.result = {
      outcome: 'outcome_unknown',
      content: unknown.message.content,
      details: {
        code: 'context_refresh_required',
        adapterAttempted: false,
        dispatchCommitted: false,
      },
    };
    const cancelled = make('cancelled-refresh');
    cancelled.execution.status = 'cancelled';
    cancelled.execution.result = {
      outcome: 'cancelled',
      content: cancelled.message.content,
      details: {
        code: 'context_refresh_required',
        adapterAttempted: false,
        dispatchCommitted: false,
      },
    };
    const success = make('successful-refresh');
    success.execution.status = 'succeeded';
    success.execution.result = {
      outcome: 'succeeded',
      content: success.message.content,
      details: {
        code: 'context_refresh_required',
        adapterAttempted: false,
        dispatchCommitted: false,
      },
    };
    for (const id of ['cancelled-refresh', 'successful-refresh'])
      expect((await f.list([id])).entries[0]?.decisionRefresh).toBeUndefined();
    const ids = [
      'context',
      'capability',
      'forged-dispatched',
      'missing-dispatch',
      'missing-adapter-proof',
      'wrong-code',
      'body-only',
      'inconsistent',
      'unknown',
    ];
    const original = structuredClone([...f.executions.values()]);
    const entries = (await f.list(ids)).entries;
    expect(entries.map((entry) => entry.decisionRefresh)).toEqual([
      'context_refresh_required',
      'capability_refresh_required',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(entries.map((entry) => entry.status)).toEqual([
      ...Array(8).fill('failed'),
      'outcome_unknown',
    ]);
    expect([...f.executions.values()]).toEqual(original);
    // A cold restored view proves the original Execution, without gaining current approval authority.
    f.scope = { ...f.scope, storeId: 'restored' };
    f.messages.get('context')!.originMessage = {
      storeId: 'store',
      sessionId: 's',
      messageId: 'original-context',
      runId: 'context',
    };
    const cold = (await f.list(['context'])).entries[0]!;
    expect(cold.decisionRefresh).toBe('context_refresh_required');
    expect(cold.status).toBe('failed');
    expect(cold.authorization).toBeUndefined();
    f.executions.get('execution-context')!.runId = 'unrelated-run';
    await expect(f.list(['context'])).rejects.toMatchObject({
      code: 'tool_message_identity_mismatch',
    });
  } finally {
    f.manager.release();
  }
});

test('current context uses the original request forecast and full window, independently of cached or cumulative usage', async () => {
  const f = fixture();
  const message: Message = {
    id: 'context-message',
    sessionId: 's',
    runId: 'run',
    seq: '1',
    role: 'assistant',
    status: 'complete',
    content: 'answer',
    sourceIds: ['model'],
  };
  f.messages.set(message.id, message);
  f.executions.set('model', {
    id: 'model',
    originStoreId: 'store',
    sessionId: 's',
    runId: 'run',
    kind: 'model',
    definitionId: 'route',
    definitionVersion: '1',
    resultRevision: '1',
    cancelRequestedAt: null,
    status: 'succeeded',
    result: { content: 'answer', usage: { inputTokens: 100000, cachedInputTokens: 99000 } },
  } as Execution);
  const reads: unknown[] = [];
  Object.assign(f.client, {
    getContextEstimate: async (sessionId: string, query: unknown) => {
      reads.push([sessionId, query]);
      return {
        storeId: 'store',
        sessionId: 's',
        runId: 'run',
        modelId: 'route',
        modelInputExecutionId: 'model',
        contextSelectionId: 'selected',
        totalInputTokens: 340,
        contextWindowTokens: 500,
        usableInputTokens: 100,
        utilization: 3.4,
        cumulativeUsage: { inputTokens: 1000000, cachedInputTokens: 990000 },
      };
    },
    getView: async () => ({
      storeId: 'store',
      session: { id: 's', workspaceId: 'w', contextSelectionId: 'selected', deletedAt: null },
    }),
  });
  const request = {
    method: 'toolMessages.contextUsage' as const,
    generation: 1,
    viewSelection: 2,
    historyEpoch: 0,
    readId: 'context-read',
    messageIds: [message.id],
  };
  const result = await f.manager.contextUsage({ ...request, messageIds: [...request.messageIds] });
  expect(reads).toEqual([['s', { storeId: 'store', executionId: 'model' }]]);
  expect(result.context).toEqual({
    modelId: 'route',
    contextSelectionId: 'selected',
    totalInputTokens: 340,
    contextWindowTokens: 500,
  });
  expect(JSON.stringify(result)).not.toContain('cachedInputTokens');
  expect(JSON.stringify(result)).not.toContain('answer');
  expect(decodeNativeRequest(request)).toEqual(request);
  for (const invalid of [
    { ...request, messageIds: [] },
    { ...request, messageIds: ['a', 'b'] },
    { ...request, viewSelection: 0 },
    { ...request, historyEpoch: -1 },
    { ...request, path: 'arbitrary' },
  ])
    expect(() => decodeNativeRequest(invalid)).toThrow();
});

test('context forecasts reject changed selections, departed reads, foreign receipts and invented counts', async () => {
  const f = fixture();
  const message: Message = {
    id: 'context-message',
    sessionId: 's',
    runId: 'run',
    seq: '1',
    role: 'assistant',
    status: 'complete',
    content: 'answer',
    sourceIds: ['model'],
  };
  f.messages.set(message.id, message);
  const execution = {
    id: 'model',
    originStoreId: 'store',
    sessionId: 's',
    runId: 'run',
    kind: 'model',
    definitionId: 'route',
    definitionVersion: '1',
    resultRevision: '1',
    cancelRequestedAt: null,
    status: 'succeeded',
    result: { content: 'answer' },
  } as Execution;
  f.executions.set('model', execution);
  const estimate = {
    storeId: 'store',
    sessionId: 's',
    runId: 'run',
    modelId: 'route',
    modelInputExecutionId: 'model',
    contextSelectionId: 'selected',
    totalInputTokens: 0,
    contextWindowTokens: 500,
  };
  let next: Record<string, unknown> = estimate;
  Object.assign(f.client, {
    getContextEstimate: async () => next,
    getView: async () => ({
      storeId: 'store',
      session: { id: 's', workspaceId: 'w', contextSelectionId: 'selected', deletedAt: null },
    }),
  });
  const read = () =>
    f.manager.contextUsage({
      method: 'toolMessages.contextUsage',
      generation: 1,
      viewSelection: 2,
      historyEpoch: 0,
      readId: 'context-read',
      messageIds: [message.id],
    });
  expect((await read()).context?.totalInputTokens).toBe(0);
  next = { ...estimate, contextWindowTokens: undefined };
  expect((await read()).context?.contextWindowTokens).toBeUndefined();
  for (const invalid of [
    { contextSelectionId: 'different' },
    { storeId: 'other' },
    { modelInputExecutionId: 'other' },
    { totalInputTokens: -1 },
    { totalInputTokens: Number.NaN },
    { contextWindowTokens: 0 },
  ]) {
    next = { ...estimate, ...invalid };
    await expect(read()).rejects.toBeDefined();
  }
  next = estimate;
  f.executions.set('model', { ...execution, originStoreId: 'other' });
  await expect(read()).rejects.toMatchObject({ code: 'model_usage_identity_mismatch' });
  f.executions.set('model', execution);
  let release!: () => void;
  let signal: AbortSignal | undefined;
  Object.assign(f.client, {
    getContextEstimate: async (
      _sessionId: string,
      _query: unknown,
      options: { signal: AbortSignal },
    ) => {
      signal = options.signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return estimate;
    },
  });
  const pending = read();
  while (!release) await Bun.sleep(1);
  f.manager.release();
  release();
  await expect(pending).rejects.toMatchObject({ code: 'native_selection_changed' });
  expect(signal?.aborted).toBe(true);
});

for (const field of ['check', 'review'] as const)
  test(`Native ${field} authorization produces checking state and preserves human precedence`, () => {
    for (const status of ['planned', 'dispatching', 'running'] as const) {
      const authorization = {
        dispatched: false,
        [field]: {
          executionId: 'check',
          status,
          decision: 'unavailable' as const,
          reason: 'exact check reason',
          requireApproval: false,
        },
      };
      expect(authorizationApproval(authorization)).toMatchObject({
        source: 'auto',
        state: 'checking',
        reason: 'exact check reason',
      });
      expect(
        authorizationApproval({
          ...authorization,
          human: {
            interactionId: 'human',
            state: 'pending',
            revision: '1',
            acceptedDecisionRevision: null,
            accepted: false,
            decision: null,
          },
        }),
      ).toMatchObject({ source: 'user', state: 'awaiting_user', reason: 'exact check reason' });
    }
  });

test('new check fact takes precedence over a conflicting legacy review observation', () => {
  expect(
    authorizationApproval({
      dispatched: false,
      check: {
        executionId: 'current',
        status: 'running',
        decision: 'unavailable',
        reason: 'current checker',
        requireApproval: false,
      },
      review: {
        executionId: 'old',
        status: 'succeeded',
        decision: 'approve_once',
        reason: 'historical review',
        requireApproval: false,
      },
    }),
  ).toMatchObject({ state: 'checking', reason: 'current checker' });
});

test('known Shell commands use Unicode-safe bounded metadata fragments without changing other metadata budgets', async () => {
  const f = fixture();
  const commands = new Map<string, string>();
  for (let index = 0; index < 32; index++) {
    const id = `command-${index}`;
    f.add(id, 'succeeded', id, index % 2 ? 'shell.execute' : 'shell.launch');
    const command = `printf '\\n'\n${'雪🙂\n\t'.repeat(3000)}\necho ${index}`;
    commands.set(id, command);
    const input = { key: id, command };
    f.messages.get(`call-${id}`)!.toolCalls![0]!.arguments = JSON.stringify(input);
    f.executions.get(`execution-${id}`)!.toolInput = input;
  }
  let offsets: Record<string, number> = {},
    rounds = 0;
  const complete = new Map<string, string>();
  let ids = [...commands.keys()];
  try {
    while (ids.length) {
      const page = await f.manager.list({
        method: 'toolMessages.list',
        generation: 1,
        viewSelection: 2,
        historyEpoch: 0,
        readId: crypto.randomUUID(),
        messageIds: ids,
        commandOffsets: offsets,
      });
      expect(
        Buffer.byteLength(JSON.stringify(page.entries.map((entry) => entry.shellInput?.command))),
      ).toBeLessThan(nativeToolMessagePageBytes);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(4 * 1048576);
      const next: Record<string, number> = {};
      for (const fact of page.entries) {
        const input = fact.shellInput!;
        expect(input.commandOffset).toBe(offsets[fact.messageId] ?? 0);
        expect(Buffer.byteLength(input.command!)).toBeLessThanOrEqual(nativeShellCommandChunkBytes);
        expect(Buffer.byteLength(JSON.stringify(input.command!)) - 2).toBeLessThanOrEqual(
          nativeShellCommandChunkBytes,
        );
        expect(input.command).not.toContain('\uFFFD');
        complete.set(fact.messageId, (complete.get(fact.messageId) ?? '') + input.command!);
        if (input.commandNextOffset !== null) next[fact.messageId] = input.commandNextOffset!;
        expect(fact.target).toEndWith('…');
      }
      offsets = next;
      ids = Object.keys(next);
      expect(++rounds).toBeLessThan(20);
    }
    expect(rounds).toBeGreaterThan(1);
    expect(complete).toEqual(commands);

    f.add('large-ask', 'succeeded', 'large-ask', 'ask_user');
    const input = { questions: [{ question: 'Question?' }] };
    f.messages.get('call-large-ask')!.toolCalls![0]!.arguments = JSON.stringify(input);
    const content = JSON.stringify({ answer: 'a'.repeat(600000), answers: { q1: 'yes' } });
    f.messages.get('large-ask')!.content = content;
    f.executions.get('execution-large-ask')!.result = { outcome: 'succeeded', content };
    const askPage = await f.list(['large-ask']);
    expect(Buffer.byteLength(JSON.stringify(askPage))).toBeGreaterThan(nativeToolMessagePageBytes);
    expect(askPage.entries[0]?.ask?.summary).toHaveLength(600000);

    const request = {
      method: 'toolMessages.list' as const,
      generation: 1,
      viewSelection: 2,
      historyEpoch: 0,
      readId: 'owned',
      messageIds: ['command-0'],
      commandOffsets: { 'command-0': 1 },
    };
    expect(decodeNativeRequest(request)).toEqual(request);
    for (const commandOffsets of [
      null,
      [],
      { other: 0 },
      { 'command-0': -1 },
      { 'command-0': 0.5 },
      { 'command-0': 524289 },
    ]) {
      expect(() => decodeNativeRequest({ ...request, commandOffsets })).toThrow(
        'invalid_native_request',
      );
      await expect(f.manager.list({ ...request, commandOffsets } as never)).rejects.toMatchObject({
        code: 'invalid_native_request',
      });
    }
    await expect(
      f.manager.list({ ...request, commandOffsets: { 'command-0': 99999 } }),
    ).rejects.toMatchObject({ code: 'tool_message_command_offset_invalid' });
    await expect(f.manager.list({ ...request, generation: 2 })).rejects.toMatchObject({
      code: 'native_selection_changed',
    });
    // A rejected read released its lease; the same ID remains reusable.
    expect(
      (await f.manager.list({ ...request, commandOffsets: { 'command-0': 0 } })).entries,
    ).toHaveLength(1);
  } finally {
    f.manager.release();
  }
});

test('Native Shell facts separate Tool acceptance, exact Job state, ordered output, stop requests and unverified original records', async () => {
  const f = fixture();
  const receipt = (
    operation: string,
    status: Execution['status'],
    extra: Record<string, unknown> = {},
  ) => {
    const id = `shell-${operation}-${f.executions.size}`;
    f.add(id, status, id, `shell.${operation}`);
    const input: Record<string, string> = ['execute', 'launch'].includes(operation)
      ? { key: id, command: 'printf first\nprintf second\n' }
      : { shellId: id };
    f.messages.get(`call-${id}`)!.toolCalls![0]!.arguments = JSON.stringify(input);
    const execution = f.executions.get(`execution-${id}`)!;
    execution.toolInput = input;
    const ref = {
      key: id,
      extensionId: 'builtin.shell',
      sessionId: 's',
      originStoreId: 'store',
      commandId: `cmd-${id}`,
      executionId: `job-${id}`,
    };
    const job = {
      id: ref.executionId,
      sessionId: 's',
      originStoreId: 'store',
      kind: 'job',
      definitionId: 'shell.command',
      definitionVersion: '1',
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'Shell succeeded', details: { exitCode: 0 } },
    };
    const details: Record<string, unknown> = { ref, execution: job, ...extra };
    const save = () => {
      const content = JSON.stringify(details);
      f.messages.get(id)!.content = content;
      execution.result = { outcome: status, content, details } as Execution['result'];
    };
    save();
    const read = async () => {
      const fact = (await f.list([id])).entries[0]!;
      return { fact, message: desktopToolMessage(fact, id, f.messages.get(id)!.content) };
    };
    return { id, execution, details, ref, job, save, read };
  };
  try {
    const foreground = receipt('execute', 'succeeded', {
      stdout: 'first\nsecond\n',
      stderr: 'warning\n',
      stdoutBytes: '13',
      stderrBytes: '8',
      droppedBytes: '0',
      truncated: false,
      timedOut: false,
    });
    expect((await foreground.read()).message).toMatchObject({
      toolName: 'shell_execute',
      status: 'completed',
      shell: {
        operation: 'execute',
        command: 'printf first\nprintf second\n',
        jobStatus: 'succeeded',
        exitCode: 0,
        stdout: 'first\nsecond\n',
        stderr: 'warning\n',
        outputComplete: true,
      },
    });
    foreground.details.droppedBytes = '2';
    foreground.save();
    expect((await foreground.read()).message.shell).toMatchObject({
      truncated: true,
      outputComplete: false,
    });

    const launch = receipt('launch', 'succeeded', { accepted: true, presentation: 'standalone' });
    launch.details.shellId = launch.id;
    delete (launch.details as Record<string, unknown>).execution;
    launch.save();
    expect((await launch.read()).message.shell).toEqual({
      operation: 'launch',
      accepted: true,
      shellId: launch.id,
      command: 'printf first\nprintf second\n',
    });

    const read = receipt('read', 'succeeded');
    read.job.status = 'running';
    read.job.result = null as never;
    read.details.output = {
      highWaterSeq: '4',
      items: [
        {
          executionId: read.ref.executionId,
          seq: '1',
          throughSeq: '1',
          stream: 'stdout',
          content: 'one\n',
          droppedBytes: null,
        },
        {
          executionId: read.ref.executionId,
          seq: '2',
          throughSeq: '2',
          stream: 'stderr',
          content: 'two\n',
          droppedBytes: null,
        },
        {
          executionId: read.ref.executionId,
          seq: '3',
          throughSeq: '3',
          stream: 'stdout',
          content: 'three\n',
          droppedBytes: null,
        },
      ],
    };
    read.save();
    expect((await read.read()).message).toMatchObject({
      status: 'completed',
      shell: {
        operation: 'read',
        jobStatus: 'running',
        stdout: 'one\nthree\n',
        stderr: 'two\n',
        output: 'one\ntwo\nthree\n',
        outputComplete: false,
      },
    });
    const wait = receipt('wait', 'succeeded', { timedOut: true });
    wait.job.status = 'running';
    wait.job.result = null as never;
    wait.save();
    expect((await wait.read()).message.shell).toMatchObject({
      operation: 'wait',
      jobStatus: 'running',
      timedOut: true,
      outputComplete: false,
    });
    const stop = receipt('stop', 'succeeded', { cancelRequested: true });
    stop.job.status = 'running';
    stop.job.result = null as never;
    stop.save();
    expect((await stop.read()).message.shell).toMatchObject({
      operation: 'stop',
      jobStatus: 'running',
      cancelRequested: true,
    });

    const timeout = receipt('execute', 'failed', {
      timedOut: true,
      stdout: '',
      stderr: 'deadline',
      stdoutBytes: '0',
      stderrBytes: '8',
      droppedBytes: '0',
      truncated: false,
    });
    timeout.job.status = 'cancelled';
    timeout.job.result = {
      outcome: 'cancelled',
      content: 'Shell cancelled',
      details: { exitCode: 143 },
    };
    timeout.save();
    expect((await timeout.read()).message).toMatchObject({
      status: 'failed',
      shell: { jobStatus: 'cancelled', timedOut: true, exitCode: 143 },
    });
    const observed = receipt('execute', 'cancelled', { cancellationObserved: true });
    observed.job.status = 'cancelled';
    observed.job.result = {
      outcome: 'cancelled',
      content: 'Shell cancelled',
      details: { exitCode: 143 },
    };
    observed.save();
    expect((await observed.read()).message.shell).toMatchObject({
      jobStatus: 'cancelled',
      outputComplete: false,
    });
    expect((await observed.read()).message.shell?.stdout).toBeUndefined();

    const unknown = receipt('execute', 'outcome_unknown', {
      stdout: 'partial\n',
      stderr: '',
      stdoutBytes: '8',
      stderrBytes: '0',
      droppedBytes: '0',
      truncated: false,
      timedOut: false,
    });
    unknown.job.status = 'outcome_unknown';
    unknown.job.result = {
      outcome: 'outcome_unknown',
      content: 'stop unconfirmed',
      details: { exitCode: 0 },
    };
    unknown.save();
    expect((await unknown.read()).message).toMatchObject({
      status: 'unknown',
      shell: { jobStatus: 'outcome_unknown', stdout: 'partial\n' },
    });
    const malformed = receipt('execute', 'succeeded', {
      stdout: '',
      stderr: '',
      stdoutBytes: '100',
      stderrBytes: '0',
      droppedBytes: '0',
      truncated: false,
      timedOut: false,
    });
    const invalid = await malformed.read();
    expect(invalid.message.shell?.jobStatus).toBeUndefined();
    expect(invalid.message.shell?.outputComplete).toBeUndefined();
    expect(invalid.message.text).toBe(f.messages.get(malformed.id)!.content);
    (malformed.execution.result as { details: unknown }).details = { different: true };
    expect((await malformed.read()).fact.shellResultVerified).toBeUndefined();

    for (const mutate of [
      () => {
        foreground.ref.originStoreId = 'foreign';
      },
      () => {
        foreground.ref.originStoreId = 'store';
        foreground.job.id = 'other-job';
      },
      () => {
        foreground.job.id = foreground.ref.executionId;
        foreground.job.definitionVersion = '9';
      },
      () => {
        foreground.job.definitionVersion = '1';
        foreground.job.result.outcome = 'failed';
      },
    ]) {
      mutate();
      foreground.save();
      const result = await foreground.read();
      expect(result.message.shell?.operation).toBe('execute');
      expect(result.message.shell?.jobStatus).toBeUndefined();
      expect(result.message.text).toBe(f.messages.get(foreground.id)!.content);
    }
    foreground.execution.definitionVersion = '9';
    foreground.save();
    expect((await foreground.read()).message.shell).toBeUndefined();
    expect((await foreground.read()).message.toolName).toBeUndefined();
  } finally {
    f.manager.release();
  }
});

test('large Shell input belongs to the exact saved Tool even before Model history completes; visible conflicts remain disqualifying', async () => {
  const f = fixture();
  const id = 'large-original';
  f.add(id, 'succeeded', id, 'shell.execute');
  const call = f.messages.get(`call-${id}`)!,
    execution = f.executions.get(`execution-${id}`)!;
  const command = `echo start\n${'雪🙂'.repeat(40000)}\necho end`;
  expect(Buffer.byteLength(command)).toBeGreaterThan(65536);
  call.toolCalls = [];
  call.sourceIds = ['model-original'];
  call.outputBody = {
    kind: 'model_output',
    executionId: 'model-original',
    complete: true,
    contentBytes: '0',
    reasoningBytes: '0',
    toolCallCount: 1,
  };
  // Ordinary Run Tools have no source-Model parentExecutionId.
  execution.parentExecutionId = null;
  execution.toolCallId = 'repeated';
  execution.toolInput = { key: id, command };
  const request = {
    method: 'toolMessages.list' as const,
    generation: 1,
    viewSelection: 2,
    historyEpoch: 0,
    readId: 'large',
    messageIds: [id],
  };
  try {
    let content = '',
      offset = 0;
    do {
      const fact = (await f.manager.list({ ...request, commandOffsets: { [id]: offset } }))
        .entries[0]!;
      expect(fact.shellInput?.commandOffset).toBe(offset);
      expect(fact.shellInput?.command).not.toContain('\uFFFD');
      content += fact.shellInput!.command;
      if (fact.shellInput!.commandNextOffset === null) break;
      offset = fact.shellInput!.commandNextOffset!;
    } while (offset < command.length);
    expect(content).toBe(command);
    const baseline = structuredClone({ call, execution });
    for (const mutate of [
      () => {
        call.outputBody!.complete = false;
      },
      () => {
        call.outputBody!.toolCallCount = 0;
      },
      () => {
        call.outputBody!.readAvailability = 'unsupported';
      },
      () => {
        call.outputBody!.executionId = 'another-model';
      },
      () => {
        call.status = 'incomplete';
      },
      () => {
        delete call.outputBody;
      },
    ]) {
      Object.assign(call, structuredClone(baseline.call));
      Object.assign(execution, structuredClone(baseline.execution));
      mutate();
      expect((await f.manager.list(request)).entries[0]!.shellInput?.command).toBeDefined();
    }
    for (const mutate of [
      () => {
        execution.toolCallId = 'another-call';
      },
      () => {
        call.toolCalls = [
          {
            id: 'repeated',
            name: 'shell.execute',
            arguments: JSON.stringify({ key: id, command: 'different' }),
          },
        ];
      },
      () => {
        call.toolCalls = [
          { id: 'repeated', name: 'shell.launch', arguments: JSON.stringify({ key: id, command }) },
        ];
      },
      () => {
        execution.definitionVersion = '9';
      },
    ]) {
      Object.assign(call, structuredClone(baseline.call));
      Object.assign(execution, structuredClone(baseline.execution));
      mutate();
      const fact = (await f.manager.list(request)).entries[0]!;
      expect(fact.shellInput?.command).toBeUndefined();
    }
    Object.assign(call, structuredClone(baseline.call));
    Object.assign(execution, structuredClone(baseline.execution));
    execution.parentExecutionId = 'child-job-carrier';
    expect((await f.manager.list(request)).entries[0]!.shellInput?.command).toBeDefined();
    f.messages.get(id)!.seq = '100';
    f.messages.set('later-model', {
      id: 'later-model',
      seq: '50',
      role: 'assistant',
      status: 'complete',
      sessionId: 's',
      runId: id,
      content: 'ordinary later prose',
    });
    expect((await f.manager.list(request)).entries[0]!.shellInput?.command).toBeDefined();
    f.messages.delete('later-model');
    const prefix = command.indexOf('🙂');
    await expect(
      f.manager.list({ ...request, commandOffsets: { [id]: prefix + 1 } }),
    ).rejects.toMatchObject({ code: 'tool_message_command_offset_invalid' });
  } finally {
    f.manager.release();
  }
});

test('live Shell request reads use only exact observed Tools and bounded command pages without outcome or authority projection', async () => {
  const f = fixture();
  f.add('live-input', 'planned', 'active-run', 'shell.execute');
  const execution = f.executions.get('execution-live-input')!;
  const command = `printf start\n${'雪🙂\n'.repeat(7000)}\nprintf end`;
  execution.toolCallId = 'actual-live-call';
  execution.toolInput = { command, key: 'work' };
  let observed: Execution[] = [execution];
  const manager = new NativeToolMessages(
    f.client,
    () => f.scope,
    () => f.messages,
    () => observed,
  );
  const request = {
    method: 'toolMessages.list' as const,
    generation: 1,
    viewSelection: 2,
    historyEpoch: 0,
    readId: 'live-read',
    messageIds: [],
    executionIds: [execution.id],
  };
  try {
    let text = '',
      offset = 0,
      pages = 0;
    do {
      const page = await manager.list({
        ...request,
        commandOffsets: { [`native-execution:${execution.id}`]: offset },
      });
      const fact = page.entries[0]!;
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(524288);
      expect(fact.messageId).toBe(`native-execution:${execution.id}`);
      expect(fact.inputSource).toEqual({
        storeId: 'store',
        sessionId: 's',
        runId: 'active-run',
        toolCallId: 'actual-live-call',
      });
      expect(fact.status).toBe('planned');
      expect(fact.authorization).toBeUndefined();
      expect(fact.shellResultVerified).toBeUndefined();
      expect(fact.shellInput?.commandOffset).toBe(offset);
      expect(fact.shellInput?.command).not.toContain('\uFFFD');
      expect(Buffer.byteLength(fact.shellInput!.command!)).toBeLessThanOrEqual(8192);
      text += fact.shellInput!.command;
      pages++;
      if (fact.shellInput!.commandNextOffset === null) break;
      offset = fact.shellInput!.commandNextOffset!;
    } while (pages < 20);
    expect(text).toBe(command);
    expect(pages).toBeGreaterThan(1);
    execution.status = 'running';
    execution.authorization = {
      dispatched: false,
      check: {
        executionId: 'check',
        status: 'running',
        decision: 'unavailable',
        reason: 'checking',
        requireApproval: true,
      },
    };
    expect((await manager.list(request)).entries[0]!.shellInput?.command).toBeDefined();
    expect((await manager.list(request)).entries[0]!.authorization).toBeUndefined();
    expect(decodeNativeRequest(request)).toEqual(request);
    for (const change of [
      { messageIds: ['receipt'] },
      { executionIds: [] },
      { executionIds: [execution.id, execution.id] },
      { executionIds: Array(33).fill('tool') },
      { commandOffsets: { [execution.id]: 0 } },
    ])
      expect(() => decodeNativeRequest({ ...request, ...change })).toThrow(
        'invalid_native_request',
      );
    const reads = f.reads.length;
    await expect(manager.list({ ...request, executionIds: ['foreign'] })).rejects.toMatchObject({
      code: 'tool_message_unavailable',
    });
    expect(f.reads).toHaveLength(reads);
    observed = [{ ...execution, definitionVersion: '9' }];
    expect((await manager.list(request)).entries).toEqual([]);
    expect(f.reads).toHaveLength(reads);
    expect(nativeLiveShellInputFact({ ...execution, kind: 'job' })).toBeUndefined();
    observed = [{ ...execution }];
    f.executions.set(execution.id, { ...execution, originStoreId: 'foreign' });
    await expect(manager.list(request)).rejects.toMatchObject({
      code: 'tool_message_identity_mismatch',
    });
    f.executions.set(execution.id, execution);
    let finish!: (value: Execution) => void, signal: AbortSignal | undefined;
    f.client.getExecution = async (_id, options) => {
      signal = options?.signal;
      return new Promise<Execution>((resolve) => {
        finish = resolve;
      });
    };
    const pending = manager.list({ ...request, readId: 'cancel-input' });
    const rejected = pending.catch((error: unknown) => error);
    await Promise.resolve();
    await Promise.resolve();
    manager.close('cancel-input');
    expect(signal?.aborted).toBe(true);
    finish(execution);
    expect(await rejected).toMatchObject({ code: 'native_selection_changed' });
  } finally {
    manager.release();
    f.manager.release();
  }
});
