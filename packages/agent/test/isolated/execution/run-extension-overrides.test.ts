import { expect, test } from 'bun:test';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import { createRuntime, type RuntimeOptions } from '../../../src';
import type { Extension, ToolDefinition } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';
import { AgentError } from '../../../src/storage';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string, input: Record<string, string> = {}): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];
const allow = {
  async authorize() {
    return { allowed: true, revision: 'fixture-1' };
  },
};
function choice(value: string, effects: string[]): ToolDefinition {
  return {
    id: 'fixture.choice',
    version: '1',
    description: `Choose the ${value} catalogue.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { value: { enum: [value] } },
      required: ['value'],
    },
    async execute() {
      effects.push(value);
      return { outcome: 'succeeded', content: value };
    },
  };
}
const extension = (tool: ToolDefinition): Extension => ({
  id: 'fixture',
  version: '1',
  apiMajor: 1,
  tools: [tool],
});
const emptyExtension = (id: string): Extension => ({ id, version: '1', apiMajor: 1 });
async function fixture(options: Omit<RuntimeOptions, 'store' | 'permissions'>) {
  const root = temporaryDirectory('kite-run-extension-overrides-');
  const store = await openSqliteStore({ dataRoot: root, profile: 'test' });
  const runtime = createRuntime({ permissions: allow, ...options, store });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'workspace',
    name: 'temporary',
    rootUri: pathToFileURL(root).href,
  });
  const createSession = (sessionId: string) =>
    runtime.createSession({
      expectedStoreId,
      commandId: `create-${sessionId}`,
      sessionId,
      workspaceId: 'workspace',
      subjectId: 'owner',
      title: sessionId,
    });
  await createSession('parent');
  return {
    runtime,
    store,
    createSession,
    async run(commandId: string, sessionId = 'parent') {
      await runtime.submitCommand({
        expectedStoreId,
        commandId,
        sessionId,
        subjectId: 'owner',
        request: { kind: 'run.start', content: `New task: ${commandId}` },
      });
      const command = await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
      const runId = (command.receipt as { runId?: string })?.runId;
      return { command, run: runId ? await store.getRun(runId) : null };
    },
    async close() {
      await runtime.close();
      await store.close();
      removeTemporaryDirectory(root);
    },
  };
}

test('a Run override reaches the actual Model and step catalogue while the global registration stays unchanged', async () => {
  const effects: string[] = [];
  const global = extension(choice('current', effects));
  const originalSchema = structuredClone(global.tools![0]!.inputSchema);
  const legacy = extension(choice('legacy', effects));
  const oldModel = createFixedModel([call('fixture.choice', { value: 'legacy' }), [finish]]);
  const newModel = createFixedModel([call('fixture.choice', { value: 'current' }), [finish]]);
  let stepReads = 0;
  const f = await fixture({
    extensions: [emptyExtension('before'), global, emptyExtension('after')],
    async resolveRunConfiguration({ command }) {
      return {
        model: command.id === 'legacy' ? oldModel : newModel,
        modelId: 'fixed',
        ...(command.id === 'legacy' ? { extensionOverrides: [legacy] } : {}),
        toolIds: ['fixture.choice'],
        snapshot: { catalogue: command.id },
        async readStepCapabilities() {
          stepReads++;
          return { toolIds: ['fixture.choice'], snapshot: { selected: 'fixture.choice' } };
        },
      };
    },
  });
  try {
    const old = await f.run('legacy');
    expect(old.run?.status).toBe('completed');
    expect(oldModel.requests).toHaveLength(2);
    for (const request of oldModel.requests)
      expect(request.tools).toEqual([
        {
          id: 'fixture.choice',
          definitionVersion: '1',
          description: 'Choose the legacy catalogue.',
          inputSchema: legacy.tools![0]!.inputSchema,
        },
      ]);
    expect(old.run?.configuration).toMatchObject({
      extensions: [
        { id: 'before', version: '1' },
        { id: 'fixture', version: '1' },
        { id: 'after', version: '1' },
      ],
    });
    expect(global.tools![0]!.inputSchema).toEqual(originalSchema);
    expect(global.tools![0]!.description).toBe('Choose the current catalogue.');
    await f.createSession('next');
    expect((await f.run('current', 'next')).run?.status).toBe('completed');
    expect(newModel.requests[0]!.tools[0]!.inputSchema).toEqual(originalSchema);
    expect(effects).toEqual(['legacy', 'current']);
    expect(stepReads).toBeGreaterThanOrEqual(4);
  } finally {
    await f.close();
  }
});

for (const invalid of ['unknown owner', 'duplicate owner', 'different version'] as const) {
  test(`a Run rejects an override with ${invalid} before any Model or effect`, async () => {
    const effects: string[] = [];
    const global = extension(choice('current', effects));
    const replacement = extension(choice('legacy', effects));
    const model = createFixedModel([[finish]]);
    const overrides =
      invalid === 'unknown owner'
        ? [{ ...replacement, id: 'unregistered' }]
        : invalid === 'duplicate owner'
          ? [replacement, replacement]
          : [{ ...replacement, version: '2' }];
    const f = await fixture({
      extensions: [global],
      async resolveRunConfiguration() {
        return { model, modelId: 'fixed', extensionOverrides: overrides, snapshot: null };
      },
    });
    try {
      const result = await f.run('invalid');
      expect(result.command.status).toBe('rejected');
      expect(result.command.receipt).toEqual({ reason: 'extension_definition_conflict' });
      expect(result.run).toBeNull();
      expect(model.requests).toHaveLength(0);
      expect(effects).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

for (const mismatch of [false, true]) {
  test(`a child uses its Run override and step selection ${mismatch ? 'rejects a schema beyond the parent' : 'within the exact parent definition'}`, async () => {
    const effects: string[] = [];
    const errors: string[] = [];
    const global = extension(choice('current', effects));
    const parentOverride = extension(choice('legacy', effects));
    const childOverride = mismatch
      ? extension({
          ...parentOverride.tools![0]!,
          inputSchema: choice('other', effects).inputSchema,
        })
      : parentOverride;
    const parentModel = createFixedModel([call('delegate'), [finish]]);
    const childModel = createFixedModel([call('fixture.choice', { value: 'legacy' }), [finish]]);
    const delegate: ToolDefinition = {
      id: 'delegate',
      version: '1',
      description: 'Delegate one bounded child.',
      inputSchema: { type: 'object', additionalProperties: false },
      async execute(_input, context) {
        try {
          const ref = await context.operations.ensure({
            key: 'bounded-child',
            request: {
              kind: 'agent',
              configurationId: 'child',
              input: { content: 'Use the exact inherited choice.' },
            },
          });
          await context.operations.wait(ref, { signal: context.signal, timeoutMs: 5000 });
          return { outcome: 'succeeded', content: 'Child settled.' };
        } catch (error) {
          if (!(error instanceof AgentError)) throw error;
          errors.push(error.code);
          return { outcome: 'failed', content: error.code };
        }
      },
    };
    const f = await fixture({
      modelConcurrency: 1,
      extensions: [global, { id: 'delegation', version: '1', apiMajor: 1, tools: [delegate] }],
      childConfigurations: [
        {
          id: 'child',
          version: '1',
          model: childModel,
          modelId: 'child',
          toolIds: [],
          snapshot: null,
        },
      ],
      async resolveRunConfiguration() {
        return {
          model: parentModel,
          modelId: 'parent',
          extensionOverrides: [parentOverride],
          toolIds: ['fixture.choice', 'delegate'],
          snapshot: { catalogue: 'legacy' },
        };
      },
      async resolveChildRunConfiguration({ parentTools }) {
        expect(parentTools).toContainEqual({
          id: 'fixture.choice',
          version: '1',
          extensionId: 'fixture',
        });
        return {
          model: childModel,
          modelId: 'child',
          extensionOverrides: [childOverride],
          toolIds: ['fixture.choice'],
          snapshot: { catalogue: 'legacy' },
          async readStepCapabilities() {
            return { toolIds: ['fixture.choice'], snapshot: { selected: 'fixture.choice' } };
          },
        };
      },
    });
    try {
      expect((await f.run('child')).run?.status).toBe('completed');
      if (mismatch) {
        expect(errors).toEqual(['child_tool_scope_exceeds_parent']);
        expect(childModel.requests).toHaveLength(0);
        expect(effects).toEqual([]);
        expect(
          (await f.store.listExecutions('parent')).filter((row) => row.childSessionId),
        ).toEqual([]);
      } else {
        expect(errors).toEqual([]);
        expect(childModel.requests).toHaveLength(2);
        for (const request of childModel.requests)
          expect(request.tools).toEqual([
            {
              id: 'fixture.choice',
              definitionVersion: '1',
              description: 'Choose the legacy catalogue.',
              inputSchema: parentOverride.tools![0]!.inputSchema,
            },
          ]);
        expect(effects).toEqual(['legacy']);
      }
      expect(global.tools![0]!.inputSchema).toEqual(choice('current', []).inputSchema);
    } finally {
      await f.close();
    }
  });
}
