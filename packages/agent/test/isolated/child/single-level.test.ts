import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import type { Extension, OperationRef } from '../../../src/extensions';
import { createTaskExtension } from '../../../src/extensions/task';
import { isChildPreparationFailure } from '../../../src/extensions/task/preparation-failure';
import { isRootAgentObservationTaskTool } from '../../../src/extensions/task/roles';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import { AgentError } from '../../../src/storage';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};

test('root-only Task observation matches the exact builtin identity', () => {
  expect(
    isRootAgentObservationTaskTool({
      extensionId: 'builtin.task',
      id: 'task.events',
      version: '1',
    }),
  ).toBe(true);
  for (const binding of [
    { extensionId: 'custom.task', id: 'task.events', version: '1' },
    { extensionId: 'builtin.task', id: 'task.events', version: '2' },
    { extensionId: 'builtin.task', id: 'task.message', version: '1' },
  ])
    expect(isRootAgentObservationTaskTool(binding)).toBe(false);
});

for (const { dynamic, builtin } of [
  { dynamic: false, builtin: true },
  { dynamic: true, builtin: true },
  { dynamic: true, builtin: false },
])
  test(`only roots create collaborators with ${dynamic ? 'dynamic' : 'static'} bindings; ${builtin ? 'builtin' : 'unrelated'} spawn identity`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-single-child-level-')));
    const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const refs: OperationRef[] = [];
    const rejected: { code: string; trusted: boolean }[] = [];
    const childDirectories: string[][] = [];
    const parentDirectories: string[][] = [];
    const eventQueries: string[] = [];
    const forcedWaits: { before: number; after: number; result: unknown }[] = [];
    const genericWaits: string[] = [];
    const listAgentEvents = store.listAgentEvents.bind(store);
    store.listAgentEvents = async (input) => {
      eventQueries.push(input.sessionId);
      return listAgentEvents(input);
    };
    const worked: string[] = [];
    let rootResolutions = 0;
    let nestedResolutions = 0;
    let nextLevelModels = 0;
    const task: Extension = builtin
      ? createTaskExtension({
          roles: [{ id: 'worker', configurationId: 'worker', description: 'Owned worker' }],
        })
      : {
          id: 'custom.task',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'task.spawn',
              version: '1',
              description: 'An unrelated local observation with a coincidentally matching name.',
              model: { name: 'spawn_agent' },
              inputSchema: { type: 'object', additionalProperties: false },
              execute: async () => ({ outcome: 'succeeded', content: 'Local observation.' }),
            },
          ],
        };
    const child: ModelAdapter = {
      async *stream(request) {
        const execution = (await store.getExecution(request.requestId))!;
        const session = (await store.getSession(execution.sessionId))!;
        // Keep the pre-fix counterexample finite instead of recursively spawning forever.
        if (session.parentSessionId !== 's') {
          nextLevelModels++;
          yield finish;
          return;
        }
        childDirectories.push(request.tools.map((tool) => tool.id));
        const results = request.messages.filter((message) => message.role === 'tool');
        if (results.length < (builtin ? 3 : 2)) {
          yield {
            type: 'tool_call',
            id: `child-step-${results.length}`,
            name:
              results.length === 2
                ? 'wait_agent_events'
                : results.length
                  ? 'fixture.work'
                  : 'fixture.try_nested',
            arguments: results.length === 2 ? '{"wait_ms":0}' : '{}',
          };
          yield { ...finish, reason: 'tool_calls' };
        } else yield finish;
      },
    };
    const extra: Extension = {
      id: 'fixture',
      version: '1',
      apiMajor: 1,
      tools: [
        {
          id: 'fixture.delegate',
          version: '1',
          description: 'Create two direct collaborators and observe their original work.',
          inputSchema: { type: 'object', additionalProperties: false },
          async execute(_input, context) {
            const ensure = (index: number) =>
              context.operations.ensure({
                key: `root-owned-${index}`,
                request: {
                  kind: 'agent',
                  configurationId: 'worker',
                  input: { content: 'Try the bounded operation, then continue normal work.' },
                },
              });
            const [first, duplicate] = await Promise.all([ensure(0), ensure(0)]);
            expect(duplicate).toEqual(first);
            const second = await ensure(1);
            expect(await ensure(0)).toEqual(first);
            refs.push(first, second);
            await Promise.all(
              refs.map((ref) =>
                context.operations.wait(ref, { signal: context.signal, timeoutMs: 5000 }),
              ),
            );
            return { outcome: 'succeeded', content: 'Both original collaborators finished.' };
          },
        },
        {
          id: 'fixture.try_nested',
          version: '1',
          description: 'Attempt an Agent operation through the generic extension API.',
          inputSchema: { type: 'object', additionalProperties: false },
          async execute(_input, context) {
            try {
              await context.operations.ensure({
                key: `nested-${context.executionId}`,
                request: {
                  kind: 'agent',
                  configurationId: 'worker',
                  input: { content: 'This next level must not be accepted.' },
                },
              });
              return { outcome: 'succeeded', content: 'A next-level collaborator was accepted.' };
            } catch (error) {
              rejected.push({
                code: error instanceof AgentError ? error.code : 'unknown',
                trusted: isChildPreparationFailure(error),
              });
              return {
                outcome: 'failed',
                content: 'Only the main Agent can create collaborators. Ask the parent for help.',
              };
            }
          },
        },
        {
          id: 'fixture.work',
          version: '1',
          description: 'Continue ordinary child work after a failed tool.',
          inputSchema: { type: 'object', additionalProperties: false },
          async execute(_input, context) {
            // Third-party extensions retain their ordinary observation API.
            await context.operations.waitAgentEvents!({ waitMs: 0 });
            genericWaits.push(context.sessionId);
            if (builtin) {
              const before = eventQueries.filter(
                (sessionId) => sessionId === context.sessionId,
              ).length;
              // Bypass the Model catalogue using a real runless Tool operation.
              const ref = await context.operations.ensure({
                key: 'force-builtin-events',
                request: {
                  kind: 'tool',
                  definitionId: 'task.events',
                  definitionVersion: '1',
                  input: { waitMs: 0 },
                },
              });
              const result = await context.operations.wait(ref, {
                signal: context.signal,
                timeoutMs: 3000,
              });
              forcedWaits.push({
                before,
                after: eventQueries.filter((sessionId) => sessionId === context.sessionId).length,
                result: result.result,
              });
            }
            worked.push(context.sessionId);
            return { outcome: 'succeeded', content: 'Original assigned work continued.' };
          },
        },
      ],
    };
    const parent = createFixedModel([
      ...(builtin
        ? [
            [
              {
                type: 'tool_call',
                id: 'root-observe',
                name: 'wait_agent_events',
                arguments: '{"wait_ms":0}',
              },
              { ...finish, reason: 'tool_calls' },
            ] as ModelEvent[],
          ]
        : []),
      [
        { type: 'tool_call', id: 'root-delegate', name: 'fixture.delegate', arguments: '{}' },
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
    ]);
    const runtime = createRuntime({
      store,
      model: {
        async *stream(request, context) {
          parentDirectories.push(request.tools.map((tool) => tool.id));
          yield* parent.stream(request, context);
        },
      },
      modelId: 'parent',
      modelConcurrency: 2,
      maxConcurrentSubagents: 3,
      extensions: [task, extra],
      permissions: { authorize: async () => ({ allowed: true, revision: 'owned-full' }) },
      childConfigurations: [
        {
          id: 'worker',
          version: '1',
          model: child,
          modelId: 'child',
          toolIds: [
            'task.spawn',
            ...(builtin ? ['task.events'] : []),
            'fixture.try_nested',
            'fixture.work',
          ],
          snapshot: {},
        },
      ],
      ...(dynamic
        ? {
            async resolveChildRunConfiguration(input) {
              if (input.parentSession.parentSessionId === null) rootResolutions++;
              else nestedResolutions++;
              return {
                model: child,
                modelId: 'child',
                toolIds: [
                  'task.spawn',
                  ...(builtin ? ['task.events'] : []),
                  'fixture.try_nested',
                  'fixture.work',
                ],
                snapshot: {},
              };
            },
          }
        : {}),
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'owned',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        expectedStoreId,
        subjectId: 'owner',
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        title: 'Single-level collaborators',
      });
      await runtime.submitCommand({
        expectedStoreId,
        subjectId: 'owner',
        commandId: 'work',
        sessionId: 's',
        request: { kind: 'run.start', content: 'Use two direct collaborators.' },
      });
      await runtime.waitForCommand('work', { timeoutMs: 10000 });
      expect(refs).toHaveLength(2);
      expect(new Set(refs.map((ref) => ref.childSessionId)).size).toBe(2);
      expect(rejected).toEqual([
        { code: 'child_agent_creation_denied', trusted: true },
        { code: 'child_agent_creation_denied', trusted: true },
      ]);
      expect(nestedResolutions).toBe(0);
      expect(nextLevelModels).toBe(0);
      if (dynamic) expect(rootResolutions).toBeGreaterThanOrEqual(2);
      expect(new Set(worked)).toEqual(new Set(refs.map((ref) => ref.childSessionId!)));
      expect(childDirectories.length).toBe(builtin ? 8 : 6);
      for (const tools of childDirectories) expect(tools.includes('spawn_agent')).toBe(!builtin);
      for (const tools of childDirectories) expect(tools).not.toContain('wait_agent_events');
      expect(new Set(genericWaits)).toEqual(new Set(refs.map((ref) => ref.childSessionId!)));
      if (builtin) {
        for (const tools of parentDirectories) expect(tools).toContain('wait_agent_events');
        expect(eventQueries).toContain('s');
        expect(forcedWaits).toHaveLength(2);
        for (const wait of forcedWaits) {
          expect(wait.after).toBe(wait.before);
          expect(wait.result).toMatchObject({ outcome: 'failed' });
          expect(JSON.parse((wait.result as { content: string }).content)).toMatchObject({
            error: { code: 'permission_denied' },
          });
        }
      }
      for (const ref of refs) {
        const original = (await store.getExecution(ref.executionId!))!;
        const frozen = original.childConfiguration!.snapshot as { tools: { id: string }[] };
        expect(frozen.tools.some((tool) => tool.id === 'task.spawn')).toBe(true);
        expect(frozen.tools.some((tool) => tool.id === 'task.events')).toBe(builtin);
        const executions = await store.listExecutions(ref.childSessionId!);
        expect(executions.filter((execution) => execution.childSessionId)).toEqual([]);
        expect(
          executions.filter((execution) => execution.definitionId === 'fixture.work'),
        ).toHaveLength(1);
        expect(
          await store.getOperation({
            extensionId: ref.extensionId,
            sessionId: ref.sessionId,
            key: ref.key,
            subjectId: 'owner',
            originStoreId: expectedStoreId,
          }),
        ).toEqual(ref);
      }
      expect(await store.listSessions()).toHaveLength(1);
    } finally {
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
