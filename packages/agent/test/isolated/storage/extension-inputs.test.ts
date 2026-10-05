import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixedModel, type ModelAdapter } from '@kite-ai/ai';
import { AgentError, createRuntime } from '../../../src';
import { openSqliteStore } from '../../../src/sqlite';
import type { CommandRequest } from '../../../src/storage/types';

async function reject(work: Promise<unknown>, code: string) {
  const error = await work.catch((error: unknown) => error);
  expect((error as { code?: string })?.code).toBe(code);
}

async function fixture() {
  const root = mkdtempSync('/private/tmp/kite-extension-inputs-');
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({ expectedStoreId, id: 'w', rootUri: 'file:///fixture', name: 'w' });
  await store.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    subjectId: 'user',
    workspaceId: 'w',
    title: 's',
  });
  return { root, profile, store, base: { expectedStoreId, sessionId: 's', subjectId: 'user' } };
}

test('extension intent arrays remain exact through digest, idempotency and cold reads for both Command kinds', async () => {
  const f = await fixture();
  let closed = false;
  try {
    const contextSelectionId = (await f.store.getSession('s'))!.contextSelectionId;
    for (const kind of ['run.start', 'input.follow_up'] as const) {
      const request: CommandRequest =
        kind === 'run.start'
          ? {
              kind,
              content: 'text',
              extensionInputs: [
                { extensionId: 'b', definitionVersion: '1', input: { text: 'first' } },
                { extensionId: 'a', definitionVersion: '1', input: null },
                { extensionId: 'b', definitionVersion: '1', input: { text: 'first' } },
              ],
            }
          : {
              kind,
              content: 'text',
              extensionInputs: [
                { extensionId: 'b', definitionVersion: '1', input: { text: 'first' } },
                { extensionId: 'a', definitionVersion: '1', input: null },
                { extensionId: 'b', definitionVersion: '1', input: { text: 'first' } },
              ],
              afterRunId: null,
              contextSelectionId,
            };
      const input = { ...f.base, commandId: kind, request };
      const original = await f.store.acceptCommand(input);
      expect((await f.store.acceptCommand(input)).requestDigest).toBe(original.requestDigest);
      expect(JSON.parse(JSON.stringify(original.request))).toEqual(
        JSON.parse(JSON.stringify(request)),
      );
      for (const extensionInputs of [
        [],
        [{ extensionId: 'b', definitionVersion: '2', input: { text: 'first' } }],
        [{ extensionId: 'b', definitionVersion: '1', input: { text: 'changed' } }],
        undefined,
      ]) {
        const changed = { ...request };
        if (extensionInputs === undefined) delete changed.extensionInputs;
        else changed.extensionInputs = extensionInputs;
        await reject(f.store.acceptCommand({ ...input, request: changed }), 'command_conflict');
      }
    }
    for (const kind of ['run.start', 'input.follow_up'] as const) {
      const request: CommandRequest =
        kind === 'run.start'
          ? { kind, content: 'empty', extensionInputs: [] }
          : { kind, content: 'empty', extensionInputs: [], afterRunId: null, contextSelectionId };
      const input = { ...f.base, commandId: `empty-${kind}`, request };
      await f.store.acceptCommand(input);
      const omitted = { ...request };
      delete omitted.extensionInputs;
      await reject(f.store.acceptCommand({ ...input, request: omitted }), 'command_conflict');
    }
    await f.store.acceptCommand({
      ...f.base,
      commandId: 'large-intent',
      request: {
        kind: 'run.start',
        content: 'bounded by existing transport',
        extensionInputs: Array.from({ length: 65 }, (_, i) => ({
          extensionId: 'a',
          definitionVersion: '1',
          input: { index: i, body: i === 0 ? 'x'.repeat(40000) : '' },
        })),
      },
    });
    await f.store.close();
    closed = true;
    const cold = await openSqliteStore(f.profile);
    try {
      const large = (await cold.getCommand('large-intent'))!.request as {
        extensionInputs: { input: { body: string } }[];
      };
      expect(large.extensionInputs).toHaveLength(65);
      expect(large.extensionInputs[0]!.input.body).toHaveLength(40000);
      expect((await cold.getCommand('run.start'))!.request).toMatchObject({
        extensionInputs: [
          { extensionId: 'b', definitionVersion: '1', input: { text: 'first' } },
          { extensionId: 'a', definitionVersion: '1', input: null },
          { extensionId: 'b', definitionVersion: '1', input: { text: 'first' } },
        ],
      });
      expect((await cold.getCommand('input.follow_up'))!.request).toMatchObject({
        extensionInputs: [
          { extensionId: 'b', definitionVersion: '1', input: { text: 'first' } },
          { extensionId: 'a', definitionVersion: '1', input: null },
          { extensionId: 'b', definitionVersion: '1', input: { text: 'first' } },
        ],
      });
    } finally {
      await cold.close();
    }
  } finally {
    if (!closed) await f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('direct malformed extension envelope and hidden start fields reject before durable acceptance', async () => {
  const f = await fixture();
  try {
    const contextSelectionId = (await f.store.getSession('s'))!.contextSelectionId;
    for (const kind of ['run.start', 'input.follow_up'] as const)
      for (const extensionInputs of [
        null,
        'a',
        [null],
        [{}],
        [{ extensionId: '', definitionVersion: '1', input: {} }],
        [{ extensionId: 'foreign/scope', definitionVersion: '1', input: {} }],
        [{ extensionId: 'a', definitionVersion: '', input: {} }],
        [{ extensionId: 'a', definitionVersion: '1' }],
        [{ extensionId: 'a', definitionVersion: '1', input: {}, authority: true }],
      ]) {
        await reject(
          f.store.acceptCommand({
            ...f.base,
            commandId: crypto.randomUUID(),
            request: {
              kind,
              content: 'text',
              extensionInputs,
              ...(kind === 'input.follow_up' ? { afterRunId: null, contextSelectionId } : {}),
            } as CommandRequest,
          }),
          'invalid_input_request',
        );
      }
    await reject(
      f.store.acceptCommand({
        ...f.base,
        commandId: 'hidden',
        request: {
          kind: 'run.start',
          content: 'text',
          authority: true,
        } as unknown as CommandRequest,
      }),
      'invalid_input_request',
    );
    await reject(
      f.store.acceptCommand({
        ...f.base,
        commandId: 'steer-envelope',
        request: {
          kind: 'input.steer',
          content: 'steer',
          targetRunId: 'unknown',
          contextSelectionId,
          extensionInputs: [],
        } as unknown as CommandRequest,
      }),
      'invalid_input_request',
    );
    expect(await f.store.getCommand('hidden')).toBeNull();
  } finally {
    await f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('unsupported fixed and custom resolver persist a rejection without model or resolver effects', async () => {
  for (const [custom, configured] of [
    [false, false],
    [false, true],
    [true, false],
  ] as const) {
    const f = await fixture();
    let calls = 0;
    const model = createFixedModel([]);
    const runtime = createRuntime({
      store: f.store,
      model,
      supportsExtensionInputs: configured,
      permissions: {
        async authorize() {
          return { allowed: true, revision: '1' };
        },
      },
      ...(custom
        ? {
            resolveRunConfiguration: async () => {
              calls++;
              throw Error('must not resolve');
            },
          }
        : {}),
    });
    try {
      expect(runtime.supportsExtensionInputs).toBe(false);
      const contextSelectionId = (await f.store.getSession('s'))!.contextSelectionId;
      for (const kind of ['run.start', 'input.follow_up'] as const) {
        const input = {
          ...f.base,
          commandId: kind,
          request: {
            kind,
            content: 'text',
            extensionInputs: [],
            ...(kind === 'input.follow_up' ? { afterRunId: null, contextSelectionId } : {}),
          } as CommandRequest,
        };
        await runtime.submitCommand(input);
        const rejected = await runtime.waitForCommand(kind, { timeoutMs: 3000 });
        expect(rejected.status).toBe('rejected');
        expect(JSON.stringify(rejected.receipt)).toContain('extension_inputs_unavailable');
        expect((await runtime.submitCommand(input)).requestDigest).toBe(rejected.requestDigest);
        expect(calls).toBe(0);
        expect(model.requests).toHaveLength(0);
      }
    } finally {
      await runtime.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('trusted generic initialization preserves original intent and seals scoped obligations before the first Model', async () => {
  const f = await fixture();
  const fixed = createFixedModel([
    [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
  ]);
  const extensionInputs = [
    { extensionId: 'fixture', definitionVersion: '1', input: { requested: 'original' } },
  ];
  let initialized = 0;
  let modelCalls = 0;
  const model: ModelAdapter = {
    async *stream(request, options) {
      modelCalls++;
      expect(initialized).toBe(1);
      const run = (await f.store.getView('s')).runs.find((run) => run.isActive)!;
      expect(run.requirements).toHaveLength(1);
      const record = await f.store.getExtensionRecord({
        extensionId: 'fixture',
        sessionId: 's',
        key: run.requirements[0]!.recordKey,
      });
      expect(record?.value).toEqual({ original: extensionInputs });
      yield* fixed.stream(request, options);
    },
  };
  const extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1 as const,
    records: [
      { contentType: 'fixture.intent', contentVersion: 1, schema: { type: 'object' as const } },
    ],
    conditions: {
      async evaluate(
        refs: readonly import('../../../src/storage/types').RequirementRef[],
        _phase: unknown,
        context?: import('../../../src/extensions').NecessaryConditionContext,
      ) {
        return Promise.all(
          refs.map(async (requirement) => {
            const scoped = await context!.forRequirement(requirement);
            const record = await scoped.records.get(requirement.recordKey);
            return {
              requirement,
              recordRevision: record!.revision,
              outcome: 'satisfied' as const,
              evidence: { checked: true },
            };
          }),
        );
      },
    },
  };
  const runtime = createRuntime({
    store: f.store,
    model,
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    supportsExtensionInputs: true,
    async resolveRunConfiguration({ command }) {
      const requested = command.request as {
        extensionInputs?: readonly {
          extensionId: string;
          definitionVersion: string;
          input: unknown;
        }[];
      };
      for (const input of requested.extensionInputs ?? [])
        if (input.extensionId !== extension.id || input.definitionVersion !== extension.version)
          throw new AgentError('extension_input_unavailable');
      return {
        model,
        modelId: 'fixed',
        snapshot: { inputPresent: Object.hasOwn(command.request as object, 'extensionInputs') },
        extensions: [extension],
        async initializeRequirements({ command, run, session, forExtension }) {
          initialized++;
          const context = await forExtension(extension.id);
          const record = await context.records.create({
            key: `run/${run.id}/intent`,
            contentType: 'fixture.intent',
            contentVersion: 1,
            value: {
              original: (
                command.request as { extensionInputs: import('../../../src/storage/types').Json[] }
              ).extensionInputs,
            },
          });
          return [
            {
              extensionId: extension.id,
              definitionVersion: extension.version,
              evaluationProvider: 'extension' as const,
              requirementId: 'original-intent',
              revision: record.revision,
              phase: 'completion' as const,
              sessionId: session.id,
              runId: run.id,
              recordKey: record.key,
            },
          ];
        },
      };
    },
  });
  try {
    expect(runtime.supportsExtensionInputs).toBe(true);
    const intent = {
      ...f.base,
      commandId: 'original',
      request: { kind: 'run.start' as const, content: 'first model', extensionInputs },
    };
    await runtime.submitCommand(intent);
    const finished = await runtime.waitForCommand('original', { timeoutMs: 3000 });
    expect(finished.status).toBe('applied');
    expect(modelCalls).toBe(1);
    expect(fixed.requests).toHaveLength(1);
    expect((await f.store.getView('s')).runs[0]?.status).toBe('completed');
    await runtime.submitCommand(intent);
    expect(initialized).toBe(1);
    expect(modelCalls).toBe(1);
    await runtime.submitCommand({
      ...f.base,
      commandId: 'wrong-version',
      request: {
        kind: 'run.start',
        content: 'unsupported',
        extensionInputs: [{ extensionId: 'fixture', definitionVersion: '2', input: {} }],
      },
    });
    const denied = await runtime.waitForCommand('wrong-version', { timeoutMs: 3000 });
    expect(denied.status).toBe('rejected');
    expect(JSON.stringify(denied.receipt)).toContain('extension_input_unavailable');
    expect(initialized).toBe(1);
    expect(modelCalls).toBe(1);
  } finally {
    await runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
