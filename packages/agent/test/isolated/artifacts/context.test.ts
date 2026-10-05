import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime, type RuntimeOptions } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import type { ArtifactRef, Extension, Json, OperationRef } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function call(name: string, input: Json = {}): ModelEvent[] {
  return [
    { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
    { ...finish, reason: 'tool_calls' },
  ];
}
async function captureCode(work: Promise<unknown>) {
  try {
    await work;
    return '';
  } catch (error) {
    return (error as { code?: string }).code ?? '';
  }
}
async function errorCode(work: Promise<unknown>, expected: string) {
  expect(await captureCode(work)).toBe(expected);
}
async function fixture(
  extension: Extension,
  model = createFixedModel([]),
  options: Partial<RuntimeOptions> = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-artifact-context-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  let store: Awaited<ReturnType<typeof openSqliteStore>>;
  try {
    store = await openSqliteStore(profile);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const artifacts = createArtifactStore({ profile, store });
  let publications = 0;
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    extensions: [extension],
    ...options,
    artifacts: {
      ...artifacts,
      async publish(input) {
        publications++;
        return artifacts.publish(input);
      },
    },
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'temporary',
    rootUri: `file://${root}`,
  });
  for (const sessionId of ['s', 'foreign'])
    await runtime.createSession({
      expectedStoreId,
      sessionId,
      workspaceId: 'w',
      commandId: `create-${sessionId}`,
      subjectId: sessionId === 's' ? 'owner' : 'foreign-owner',
      title: sessionId,
    });
  return {
    store,
    artifacts,
    runtime,
    expectedStoreId,
    model,
    get publications() {
      return publications;
    },
    async run(commandId = 'run', sessionId = 's') {
      await runtime.submitCommand({
        expectedStoreId,
        sessionId,
        subjectId: 'owner',
        commandId,
        request: { kind: 'run.start', content: commandId },
      });
      await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
    },
    async action(actionId: string, input: Json = {}, commandId = actionId) {
      await runtime.submitCommand({
        expectedStoreId,
        sessionId: 's',
        subjectId: 'owner',
        commandId,
        request: {
          kind: 'extension.invoke',
          extensionId: extension.id,
          actionId,
          definitionVersion: '1',
          input,
        },
      });
      return runtime.waitForCommand(commandId, { timeoutMs: 5000 });
    },
    read(ref: ArtifactRef, sessionId = 's', subjectId = 'owner') {
      return runtime.readArtifact({
        expectedStoreId,
        sessionId,
        subjectId,
        refId: ref.id,
        scope: ref.scope!,
      });
    },
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('Model Tool publishes the same key twice under its immutable execution scope and reads exact binary bytes', async () => {
  let ref: ArtifactRef | undefined;
  let second: ArtifactRef | undefined;
  let executionId = '';
  const bytes = new Uint8Array([0, 255, 10, 128, 65]);
  const f = await fixture(
    {
      id: 'fixture',
      version: '1',
      apiMajor: 1,
      tools: [
        {
          id: 'fixture.publish',
          version: '1',
          description: 'Explicit artifact fixture',
          inputSchema: { type: 'object' },
          async execute(_input, context) {
            executionId = context.executionId;
            ref = await context.artifacts!.publish({
              key: 'binary',
              content: bytes,
              mediaType: 'application/octet-stream',
            });
            second = await context.artifacts!.publish({
              key: 'binary',
              content: bytes,
              mediaType: 'application/octet-stream',
            });
            expect(await context.artifacts!.read(ref)).toEqual(bytes);
            await errorCode(
              context.artifacts!.publish({
                key: 'binary',
                content: new Uint8Array([1]),
                mediaType: 'application/octet-stream',
              }),
              'artifact_reference_conflict',
            );
            return { outcome: 'succeeded', content: 'published', artifactRefs: [ref] };
          },
        },
      ],
    },
    createFixedModel([call('fixture.publish'), [finish]]),
  );
  try {
    await f.run();
    expect(second).toEqual(ref);
    expect(ref?.scope).toEqual({ kind: 'execution', id: executionId });
    expect(ref?.size).toBe('5');
    expect((await f.store.getExecution(executionId))?.status).toBe('succeeded');
    expect((await f.store.getExecution(executionId))?.result).toMatchObject({
      artifactRefs: [ref!],
    });
    expect((await f.read(ref!)).content).toEqual(bytes);
    expect((await f.read(ref!)).reference).toMatchObject({
      sessionId: 's',
      subjectId: 'owner',
      storeId: f.expectedStoreId,
      scope: ref!.scope!,
    });
    await errorCode(
      f.read({ ...ref!, scope: { kind: 'session', id: 's' } }),
      'artifact_reference_not_found',
    );
    await errorCode(f.read(ref!, 'foreign', 'foreign-owner'), 'artifact_scope_denied');
    await errorCode(f.read(ref!, 's', 'intruder'), 'artifact_scope_denied');
    await errorCode(f.read({ ...ref!, id: 'unknown' }), 'artifact_reference_not_found');
    expect(f.model.requests).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 10000);

test('Action preparation and Query have read-only artifact access; Action publish needs zero Model calls and repeated Query has zero ledger writes', async () => {
  let actionRef: ArtifactRef | undefined;
  let effects = 0;
  let prepareReads = 0;
  let queryReads = 0;
  const bytes = Buffer.from('trusted preparation bytes');
  const extension: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    actions: [
      {
        id: 'publish',
        version: '1',
        description: 'Explicit action',
        inputSchema: { type: 'object' },
        async prepare(input, context) {
          expect('publish' in context.artifacts!).toBe(false);
          const ref = input as unknown as ArtifactRef;
          expect(Buffer.from(await context.artifacts!.read(ref))).toEqual(bytes);
          prepareReads++;
          return {};
        },
        async execute(_prepared, context) {
          effects++;
          actionRef = await context.artifacts!.publish({
            key: 'result',
            content: Buffer.from('action output'),
            mediaType: 'text/plain',
          });
          return { outcome: 'succeeded', content: 'action done', artifactRefs: [actionRef] };
        },
      },
    ],
    queries: [
      {
        id: 'read',
        version: '1',
        description: 'Pure read',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'array' },
        async execute(input, context) {
          if ((input as { availability?: boolean }).availability)
            return [
              {
                extensionId: 'fixture',
                contentType: 'fixture/availability',
                contentVersion: 1,
                summary: 'capability',
                payload: { reader: !!context.artifacts },
                artifactRefs: [],
                actions: [],
              },
            ];
          const ref = input as unknown as ArtifactRef;
          expect('publish' in context.artifacts!).toBe(false);
          const content = Buffer.from(await context.artifacts!.read(ref)).toString();
          queryReads++;
          return [
            {
              extensionId: 'fixture',
              contentType: 'fixture/result',
              contentVersion: 1,
              summary: content,
              payload: { content },
              artifactRefs: [ref],
              actions: [],
            },
          ];
        },
      },
    ],
  };
  const f = await fixture(extension);
  try {
    const original = await f.artifacts.publish({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      refId: 'initial',
      scope: { kind: 'session', id: 's' },
      mediaType: 'text/plain',
      content: bytes,
    });
    const input = {
      id: original.id,
      mediaType: original.mediaType,
      size: original.size,
      scope: original.scope,
    };
    const command = await f.action('publish', input);
    const executionId = (command.receipt as { executionId: string }).executionId;
    expect(prepareReads).toBe(1);
    expect(effects).toBe(1);
    expect((await f.store.getExecution(executionId))?.status).toBe('succeeded');
    expect(actionRef?.scope).toEqual({ kind: 'execution', id: executionId });
    const before = await f.store.getView('s');
    const publications = f.publications;
    for (let i = 0; i < 3; i++)
      expect(
        (
          await f.runtime.queryExtension({
            sessionId: 's',
            extensionId: 'fixture',
            queryId: 'read',
            input: actionRef! as unknown as Json,
            subjectId: 'owner',
            expectedStoreId: f.expectedStoreId,
          })
        )[0]?.summary,
      ).toBe('action output');
    const after = await f.store.getView('s');
    expect(queryReads).toBe(3);
    expect(effects).toBe(1);
    expect(f.publications).toBe(publications);
    expect(after.snapshotCursor).toBe(before.snapshotCursor);
    expect(after.executions).toEqual(before.executions);
    expect(after.runs).toHaveLength(0);
    expect(f.model.requests).toHaveLength(0);
    expect(
      (
        await f.runtime.queryExtension({
          sessionId: 's',
          extensionId: 'fixture',
          queryId: 'read',
          input: { availability: true },
        })
      )[0]?.payload,
    ).toEqual({ reader: false });
    expect(
      (
        await f.runtime.queryExtension({
          sessionId: 's',
          extensionId: 'fixture',
          queryId: 'read',
          input: { availability: true },
          subjectId: 'owner',
          expectedStoreId: f.expectedStoreId,
        })
      )[0]?.payload,
    ).toEqual({ reader: true });
    await errorCode(
      f.runtime.queryExtension({
        sessionId: 's',
        extensionId: 'fixture',
        queryId: 'read',
        input: actionRef! as unknown as Json,
        subjectId: 'intruder',
        expectedStoreId: f.expectedStoreId,
      }),
      'artifact_scope_denied',
    );
    await f.runtime.submitCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'publish',
      request: {
        kind: 'extension.invoke',
        extensionId: 'fixture',
        actionId: 'publish',
        definitionVersion: '1',
        input,
      },
    });
    expect(effects).toBe(1);
  } finally {
    await f.close();
  }
}, 10000);

test('effects followed by nonexistent, foreign, wrong-scope or forged metadata references stay unknown and duplicate commands never replay effects', async () => {
  let ref: ArtifactRef | undefined;
  let foreign: ArtifactRef | undefined;
  let effects = 0;
  const modes = ['initial', 'unknown', 'foreign', 'scope', 'metadata'] as const;
  const readErrors: Record<string, string> = {};
  const f = await fixture(
    {
      id: 'fixture',
      version: '1',
      apiMajor: 1,
      tools: [
        {
          id: 'fixture.result',
          version: '1',
          description: 'Artifact result validation',
          inputSchema: { type: 'object' },
          async execute(input, context) {
            effects++;
            const mode = (input as { mode: string }).mode;
            if (mode === 'initial')
              ref = await context.artifacts!.publish({
                key: 'valid',
                content: Buffer.from('valid'),
                mediaType: 'text/plain',
              });
            const returned =
              mode === 'foreign'
                ? foreign!
                : mode === 'unknown'
                  ? { ...ref!, id: 'unknown' }
                  : mode === 'scope'
                    ? { ...ref!, scope: { kind: 'session' as const, id: 's' } }
                    : mode === 'metadata'
                      ? { ...ref!, size: '999' }
                      : ref!;
            if (mode !== 'initial')
              readErrors[mode] = await captureCode(context.artifacts!.read(returned));
            return { outcome: 'succeeded', content: 'effect happened', artifactRefs: [returned] };
          },
        },
      ],
    },
    createFixedModel(
      modes.flatMap((mode) =>
        mode === 'initial'
          ? [call('fixture.result', { mode }), [finish]]
          : [call('fixture.result', { mode })],
      ),
    ),
  );
  try {
    const foreignOriginal = await f.artifacts.publish({
      expectedStoreId: f.expectedStoreId,
      sessionId: 'foreign',
      subjectId: 'foreign-owner',
      refId: 'foreign-ref',
      scope: { kind: 'session', id: 'foreign' },
      content: Buffer.from('foreign'),
      mediaType: 'text/plain',
    });
    foreign = {
      id: foreignOriginal.id,
      mediaType: foreignOriginal.mediaType,
      size: foreignOriginal.size,
      scope: foreignOriginal.scope,
    };
    for (const mode of modes) {
      await f.run(mode);
      const command = await f.store.getCommand(mode);
      const runId = (command!.receipt as { runId: string }).runId;
      const tool = (await f.store.listExecutions('s')).find(
        (e) => e.runId === runId && e.kind === 'tool',
      );
      expect(tool?.status).toBe(mode === 'initial' ? 'succeeded' : 'outcome_unknown');
      if (mode !== 'initial')
        expect(readErrors[mode]).toBe(
          mode === 'foreign' ? 'artifact_scope_denied' : 'artifact_reference_invalid',
        );
      const before = effects;
      await f.run(mode);
      expect(effects).toBe(before);
    }
    expect(effects).toBe(5);
    expect(f.model.requests).toHaveLength(6);
  } finally {
    await f.close();
  }
}, 10000);

test('Action and Job terminal references are also validated after the effect, without Model calls or replay', async () => {
  for (const kind of ['action', 'job'] as const) {
    let effects = 0;
    let job: OperationRef | undefined;
    const forged: ArtifactRef = {
      id: 'unpublished',
      mediaType: 'text/plain',
      size: '1',
      scope: { kind: 'session', id: 's' },
    };
    const f = await fixture({
      id: 'fixture',
      version: '1',
      apiMajor: 1,
      jobs: [
        {
          id: 'fixture.job',
          version: '1',
          description: 'Local fact fixture',
          inputSchema: { type: 'object' },
          async start() {
            effects++;
            return { reference: { kind: 'local-fixture' } };
          },
          async *observe() {
            yield {
              type: 'terminal',
              supervision: 'ended',
              result: { outcome: 'succeeded', content: 'effect happened', artifactRefs: [forged] },
            };
          },
          async cancel() {
            return { status: 'already_finished' };
          },
          async dispose() {},
        },
      ],
      actions: [
        {
          id: 'effect',
          version: '1',
          description: 'Explicit action fixture',
          inputSchema: { type: 'object' },
          async prepare() {
            return {};
          },
          async execute(_input, context) {
            if (kind === 'action') {
              effects++;
              return { outcome: 'succeeded', content: 'effect happened', artifactRefs: [forged] };
            }
            job = await context.operations.ensure({
              key: 'job',
              request: {
                kind: 'job',
                definitionId: 'fixture.job',
                definitionVersion: '1',
                input: {},
              },
            });
            const result = await context.operations.wait(job, {
              signal: context.signal,
              timeoutMs: 4000,
            });
            return {
              outcome: result.status === 'outcome_unknown' ? 'outcome_unknown' : 'succeeded',
              content: 'job result',
            };
          },
        },
      ],
    });
    try {
      const command = await f.action('effect');
      const executionId = (command.receipt as { executionId: string }).executionId;
      expect((await f.store.getExecution(executionId))?.status).toBe('outcome_unknown');
      if (job)
        expect((await f.store.getExecution(job.executionId!))?.status).toBe('outcome_unknown');
      expect(effects).toBe(1);
      await f.action('effect');
      expect(effects).toBe(1);
      expect(f.model.requests).toHaveLength(0);
      expect(f.publications).toBe(0);
    } finally {
      await f.close();
    }
  }
}, 10000);

test('child ordinary Tool publishes under original child subject and Session; parent context cannot read a spoofed parent scope', async () => {
  let childRef: ArtifactRef | undefined;
  let childOperation: OperationRef | undefined;
  let parentDenied = '';
  let spoofDenied = '';
  const child = createFixedModel([call('fixture.publish'), [finish]]);
  const extension: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.delegate',
        version: '1',
        description: 'Explicit child',
        inputSchema: { type: 'object' },
        async execute(_input, context) {
          childOperation = await context.operations.ensure({
            key: 'child',
            request: { kind: 'agent', configurationId: 'child', input: { content: 'publish' } },
          });
          const result = await context.operations.wait(childOperation, {
            signal: context.signal,
            timeoutMs: 4000,
          });
          expect(result.status).toBe('succeeded');
          parentDenied = await captureCode(context.artifacts!.read(childRef!));
          spoofDenied = await captureCode(
            context.artifacts!.read({ ...childRef!, scope: { kind: 'session', id: 's' } }),
          );
          return { outcome: 'succeeded', content: 'child done' };
        },
      },
      {
        id: 'fixture.publish',
        version: '1',
        description: 'Child artifact',
        inputSchema: { type: 'object' },
        async execute(_input, context) {
          childRef = await context.artifacts!.publish({
            key: 'child-result',
            content: Buffer.from('child bytes'),
            mediaType: 'text/plain',
          });
          expect(Buffer.from(await context.artifacts!.read(childRef)).toString()).toBe(
            'child bytes',
          );
          return { outcome: 'succeeded', content: 'published', artifactRefs: [childRef] };
        },
      },
    ],
  };
  const f = await fixture(extension, createFixedModel([call('fixture.delegate'), [finish]]), {
    modelConcurrency: 1,
    childConfigurations: [
      {
        id: 'child',
        version: '1',
        model: child,
        modelId: 'fixed-child',
        toolIds: ['fixture.publish'],
        snapshot: {},
      },
    ],
  });
  try {
    await f.run();
    expect(parentDenied).toBe('artifact_scope_denied');
    expect(spoofDenied).toBe('artifact_reference_invalid');
    expect(child.requests).toHaveLength(2);
    const read = await f.read(childRef!, childOperation!.childSessionId!);
    expect(Buffer.from(read.content).toString()).toBe('child bytes');
    expect(read.reference.sessionId).toBe(childOperation!.childSessionId!);
    expect(read.reference.subjectId).toBe('owner');
    expect(read.reference.scope).toEqual(childRef!.scope!);
    await errorCode(f.read(childRef!), 'artifact_scope_denied');
    await errorCode(
      f.read({ ...childRef!, scope: { kind: 'session', id: 's' } }),
      'artifact_reference_not_found',
    );
    expect((await f.store.getExecution(childOperation!.executionId!))?.status).toBe('succeeded');
  } finally {
    await f.close();
  }
}, 10000);
