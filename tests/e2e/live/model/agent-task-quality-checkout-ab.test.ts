import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createFileTools, createWorkspaceFiles } from '@kite-ai/agent/files';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createTaskExtension, defaultTaskRoles } from '@kite-ai/agent/task';
import { createFixedModel, type ModelRequest } from '@kite-ai/ai';
import { createChildConfiguration } from '../../../../apps/service/src/child-configuration';
import { formatFileReadResult } from '../../../../packages/agent/src/tools/files/model-result';
import {
  assertCheckoutIdentity,
  assertCheckoutModelBinding,
  assertCheckoutToolCatalog,
  checkoutControls,
  checkoutHarnessProvenance,
  checkoutProvenance,
} from './agent-task-quality-checkout-ab.live';
import {
  taskQualityPresentedRead,
  taskQualityReadMessageMatches,
} from './agent-task-quality-fixture';
import {
  comparisonDigest,
  presentationComparisonPlan,
} from './agent-task-quality-presentation-ab-fixture';
import { saveLiveCanonicalModelEvidence } from './live-canonical-evidence';

const baselineRoot = process.env.KITE_TEST_QUALITY_BASELINE_ROOT;
test('dual checkout controls hold system/task/model while tool declarations are treatment', () => {
  const request = {
    modelId: 'live',
    requestId: 'one',
    messages: [
      { role: 'system', content: 'fixed' },
      { role: 'user', content: '任务 🪁' },
    ],
    tools: [],
  } as ModelRequest;
  const binding = {
    model: 'synthetic',
    protocol: 'chat-completions',
    settings: { reasoning: 'medium' },
  };
  const controls = checkoutControls(request, binding);
  expect(
    checkoutControls(
      {
        ...request,
        tools: [
          {
            id: 'new_tool',
            definitionVersion: '1',
            description: 'treatment',
            inputSchema: { type: 'object' },
          },
        ],
      },
      binding,
    ),
  ).toEqual(controls);
  expect(
    checkoutControls({ ...request, messages: [{ role: 'user', content: 'different' }] }, binding),
  ).not.toEqual(controls);
  expect(checkoutControls(request, { ...binding, model: 'different' })).not.toEqual(controls);
  expect(
    presentationComparisonPlan.map(
      ([task, profile, variant]) =>
        `${task}/${profile}/${variant === 'raw' ? 'baseline' : 'candidate'}`,
    ),
  ).toEqual([
    'current-chain/1/baseline',
    'current-chain/1/candidate',
    'claim-adoption/1/candidate',
    'claim-adoption/1/baseline',
    'current-chain/2/candidate',
    'current-chain/2/baseline',
    'claim-adoption/2/baseline',
    'claim-adoption/2/candidate',
  ]);
});

test('provenance resolves local real production modules and rejects another checkout', () => {
  const root = process.cwd();
  const provenance = checkoutProvenance(root);
  expect(provenance.entries.serviceChild!.path).toBe(
    join(root, 'apps/service/src/child-configuration.ts'),
  );
  expect(provenance.sha256).toBe(comparisonDigest(provenance.sources));
  expect(Object.keys(provenance.resolved)).toHaveLength(8);
  const outside = mkdtempSync(join(tmpdir(), 'quality-resolution-'));
  try {
    expect(() => assertCheckoutIdentity(outside, provenance.resolved)).toThrow(
      'cross_checkout_resolution',
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test.skipIf(!baselineRoot || !existsSync(baselineRoot))(
  'actual baseline and candidate Read producers satisfy strict parser, including original execution identity',
  async () => {
    // This imports the committed baseline producer itself, not a hand-maintained old-format mock.
    const old = await import(
      pathToFileURL(join(baselineRoot!, 'packages/agent/src/tools/files/model-result.ts')).href
    );
    const content = '真正来源 🪁\n';
    const raw = JSON.stringify({
      path: 'entry.ts',
      content,
      executionId: 'read-original',
      runId: 'run-original',
      baseline: {
        hash: createHash('sha256').update(content).digest('hex'),
        size: Buffer.byteLength(content),
        device: '1',
        inode: '2',
      },
      selection: { fromLine: 1, toLine: 1, totalLines: 1, nextOffset: null },
    });
    for (const producer of [old.formatFileReadResult, formatFileReadResult] as const) {
      const display = producer({ result: { outcome: 'succeeded', content: raw } });
      expect(display).toBeDefined();
      expect(taskQualityReadMessageMatches(display!, raw)).toBe(true);
      expect(taskQualityPresentedRead(display!)?.evidenceRef).toBeUndefined();
      expect(display).not.toContain('read-original');
      expect(display).not.toContain('run-original');
      expect(taskQualityReadMessageMatches(`${display}extra`, raw)).toBe(false);
      expect(taskQualityReadMessageMatches(display!.replace('真正来源', '错误来源'), raw)).toBe(
        false,
      );
    }
  },
);

test('fixed study binding refuses unplanned model or reasoning before provider dispatch', () => {
  const binding = {
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    protocol: 'chat-completions',
    settings: { reasoningEffort: 'medium', maxOutputTokens: 4096 },
  };
  expect(() => assertCheckoutModelBinding(binding)).not.toThrow();
  expect(() => assertCheckoutModelBinding({ ...binding, model: 'different' })).toThrow(
    'prespecified_model_binding_required',
  );
  expect(() =>
    assertCheckoutModelBinding({
      ...binding,
      settings: { ...binding.settings, reasoningEffort: 'high' },
    }),
  ).toThrow('prespecified_model_binding_required');
});

test('frozen harness digest catches grader/prompt and root compiler-control drift independently of production', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-harness-freeze-'));
  const live = join(root, 'tests/e2e/live/model');
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, 'grader.ts'), 'original grader');
  writeFileSync(join(root, 'tsconfig.json'), '{}');
  try {
    const original = checkoutHarnessProvenance(root);
    writeFileSync(join(live, 'grader.ts'), 'changed grader');
    expect(checkoutHarnessProvenance(root).sha256).not.toBe(original.sha256);
    writeFileSync(join(live, 'grader.ts'), 'original grader');
    expect(checkoutHarnessProvenance(root).sha256).toBe(original.sha256);
    writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{}}');
    expect(checkoutHarnessProvenance(root).sha256).not.toBe(original.sha256);
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    writeFileSync(join(live, 'new-prompt.ts'), 'additional control');
    expect(checkoutHarnessProvenance(root).sha256).not.toBe(original.sha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real SQLite sealed Model inputs exactly match dispatched requests and reject text/role/tool/request corruption', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'quality-canonical-live-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'read-call', name: 'fixture.read', arguments: '{}' },
      { type: 'finish', reason: 'tool_calls', usage: { inputTokens: null, outputTokens: null } },
    ],
    [
      { type: 'text_delta', text: 'synthetic completed' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: null, outputTokens: null } },
    ],
  ]);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    permissions: { authorize: async () => ({ allowed: true, revision: 'owned-test' }) },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.read',
            version: '1',
            description: 'isolated deterministic receipt',
            inputSchema: { type: 'object' },
            async execute() {
              return { outcome: 'succeeded', content: 'complete 原文 🪁\n' };
            },
          },
        ],
      },
    ],
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    const identity = { expectedStoreId, sessionId: 'root', subjectId: 'owner' };
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Synthetic',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      workspaceId: 'w',
      ...identity,
      commandId: 'create',
      title: 'Synthetic canonical integrity',
    });
    await runtime.submitCommand({
      ...identity,
      commandId: 'start',
      request: { kind: 'run.start', content: 'synthetic task 原文' },
    });
    const deadline = Date.now() + 5000;
    for (;;) {
      const view = await store.getView('root');
      if (view.runs.length && view.runs.every((run) => !run.isActive)) break;
      if (Date.now() > deadline) throw Error('finite_fixture_budget');
      await Bun.sleep(10);
    }
    expect(model.requests).toHaveLength(2);
    const save = async (name: string, requests: readonly ModelRequest[]) => {
      const output = join(root, name);
      mkdirSync(output);
      return saveLiveCanonicalModelEvidence({
        runtime,
        store,
        requests,
        root: output,
        subjectId: 'owner',
        verifyRequests: true,
      });
    };
    const original = await save('original', model.requests);
    expect(original.complete).toBe(true);
    expect(original.requestIdentity).toMatchObject({ matches: true, checked: 2, dispatched: 2 });
    const actual = model.requests;
    const mutations: ModelRequest[][] = [
      actual.map((request, index) =>
        index === 1
          ? {
              ...request,
              messages: request.messages.map((message) =>
                message.role === 'tool'
                  ? { ...message, content: `${message.content}changed` }
                  : message,
              ),
            }
          : request,
      ),
      actual.map((request, index) =>
        index === 1
          ? {
              ...request,
              messages: request.messages.map((message) =>
                message.role === 'tool' ? { ...message, toolCallId: 'wrong-call' } : message,
              ),
            }
          : request,
      ),
      actual.map((request, index) =>
        index === 1
          ? {
              ...request,
              messages: request.messages.map((message) =>
                message.role === 'tool' ? { ...message, role: 'user' } : message,
              ),
            }
          : request,
      ),
      actual.map((request, index) =>
        index === 1 ? { ...request, requestId: actual[0]!.requestId } : request,
      ),
      actual.map((request, index) => (index === 1 ? { ...request, tools: [] } : request)),
    ];
    for (const [index, requests] of mutations.entries()) {
      const result = await save(`changed-${index}`, requests);
      expect(result.complete).toBe(false);
      expect(result.requestIdentity?.matches).toBe(false);
    }
  } finally {
    try {
      await runtime.close();
    } finally {
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 10000);

test('actual Files and Task assembly exposes exactly the production study catalog and rejects accidental extra tools', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'quality-tool-catalog-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const files = createWorkspaceFiles({ root });
  const model = createFixedModel([
    [
      { type: 'text_delta', text: 'synthetic catalog probe' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: null, outputTokens: null } },
    ],
  ]);
  const task = createTaskExtension({
    roles: defaultTaskRoles.map((role) => ({
      id: role.id,
      configurationId: role.id,
      description: role.description!,
    })),
    defaultRole: 'worker',
    presets: defaultTaskRoles.filter((role) => role.id !== 'worker').map((role) => role.id),
  });
  const child = createChildConfiguration({
    roles: defaultTaskRoles,
    async resolve(_input, selection) {
      return { model, modelId: 'fixed', toolIds: selection.role.toolIds, snapshot: {} };
    },
  });
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    ...child,
    extensions: [
      task,
      {
        id: 'builtin.files',
        version: '1',
        apiMajor: 1,
        tools: createFileTools(files).filter((tool) =>
          ['files.read', 'files.list', 'files.glob', 'files.search', 'files.write'].includes(
            tool.id,
          ),
        ),
      },
    ],
    permissions: { authorize: async () => ({ allowed: true, revision: 'owned-catalog-test' }) },
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    const identity = { expectedStoreId, sessionId: 'root', subjectId: 'owner' };
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Synthetic',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      ...identity,
      workspaceId: 'w',
      commandId: 'create',
      title: 'Catalog probe',
    });
    await runtime.submitCommand({
      ...identity,
      commandId: 'work',
      request: { kind: 'run.start', content: 'Synthetic exact catalog probe' },
    });
    const deadline = Date.now() + 5000;
    for (;;) {
      const view = await store.getView('root');
      if (view.runs.length && view.runs.every((run) => !run.isActive)) break;
      if (Date.now() > deadline) throw Error('finite_catalog_fixture_budget');
      await Bun.sleep(10);
    }
    expect(model.requests).toHaveLength(1);
    const tools = model.requests[0]!.tools;
    expect(() => assertCheckoutToolCatalog(tools)).not.toThrow();
    expect(() =>
      assertCheckoutToolCatalog([
        ...tools,
        { id: 'accidental_tool', definitionVersion: '1', inputSchema: { type: 'object' } },
      ]),
    ).toThrow('unexpected_production_tool_catalog');
    expect(() =>
      assertCheckoutToolCatalog(tools.filter((tool) => tool.id !== 'read_file')),
    ).toThrow('unexpected_production_tool_catalog');
    expect(() => assertCheckoutToolCatalog([...tools, tools[0]!])).toThrow(
      'unexpected_production_tool_catalog',
    );
  } finally {
    try {
      await runtime.close();
    } finally {
      try {
        await files.close();
      } finally {
        await store.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
}, 10000);
