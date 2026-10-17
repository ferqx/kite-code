import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { openSqliteStore } from '../../../src/sqlite';

test('unrelated Session events cannot renew a statically stale completion obligation', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-unrelated-completion-')));
  const store = await openSqliteStore({ dataRoot: root, profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const finish: Extract<ModelEvent, { type: 'finish' }> = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'write', name: 'fixture.write', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
  ]);
  let runtime!: ReturnType<typeof createRuntime>;
  let recordKey = '';
  let finishAttempts = 0,
    evaluations = 0,
    effects = 0;
  const runtimeStore = new Proxy(store, {
    get(target, key) {
      if (key === 'finishRun')
        return async (input: Parameters<typeof store.finishRun>[0]) => {
          if (input.status === 'completed' && ++finishAttempts <= 3)
            // Actual unrelated events, bounded so a regression fails promptly rather than hanging.
            await runtime.createSession({
              expectedStoreId,
              subjectId: 'owner',
              commandId: `noise-${finishAttempts}`,
              sessionId: `unrelated-${finishAttempts}`,
              workspaceId: 'w',
              title: 'Unrelated history',
            });
          return target.finishRun(input);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  runtime = createRuntime({
    store: runtimeStore,
    model,
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'owned' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        records: [{ contentType: 'fixture.state', contentVersion: 1, schema: { type: 'object' } }],
        tools: [
          {
            id: 'fixture.write',
            version: '1',
            description: 'Perform the actual record version change',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              const record = (await context.records.get(recordKey))!;
              await context.records.write({
                key: recordKey,
                expectedRevision: record.revision,
                contentType: 'fixture.state',
                contentVersion: 1,
                value: { done: true },
              });
              effects++;
              return { outcome: 'succeeded', content: 'Record actually advanced to revision 2' };
            },
          },
        ],
      },
    ],
    async initializeRunRequirements(input) {
      const scoped = await input.forExtension('fixture');
      recordKey = `run/${input.run.id}/obligation`;
      await scoped.records.create({
        key: recordKey,
        contentType: 'fixture.state',
        contentVersion: 1,
        value: { done: false },
      });
      return [
        {
          extensionId: 'fixture',
          sessionId: 's',
          runId: input.run.id,
          requirementId: 'static-obligation',
          definitionVersion: '1',
          recordKey,
          revision: '1',
          phase: 'completion',
        },
      ];
    },
    conditions: {
      async evaluate(requirements, _phase, context) {
        evaluations++;
        return Promise.all(
          requirements.map(async (requirement) => {
            const scoped = await context!.forRequirement(requirement);
            const actual = (await scoped.records.get(requirement.recordKey))!;
            return {
              requirement,
              recordRevision: actual.revision,
              outcome: (actual.value as { done: boolean }).done
                ? ('satisfied' as const)
                : ('unsatisfied' as const),
              evidence: { observedRevision: actual.revision },
            };
          }),
        );
      },
    },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'w',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      expectedStoreId,
      subjectId: 'owner',
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Original work',
    });
    await runtime.submitCommand({
      expectedStoreId,
      subjectId: 'owner',
      commandId: 'work',
      sessionId: 's',
      request: { kind: 'run.start', content: 'Perform the actual record change' },
    });
    await runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect((await store.getView('s')).runs[0]).toMatchObject({
      status: 'failed',
      reason: 'requirement_not_satisfied',
    });
    expect(finishAttempts).toBe(1);
    expect(evaluations).toBe(1);
    expect(effects).toBe(1);
    expect(model.requests).toHaveLength(2);
    expect(await store.getSession('unrelated-1')).not.toBeNull();
    expect(await store.getSession('unrelated-2')).toBeNull();
    expect(
      await store.getExtensionRecord({ extensionId: 'fixture', sessionId: 's', key: recordKey }),
    ).toMatchObject({ revision: '2', value: { done: true } });
  } finally {
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
