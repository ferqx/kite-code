import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import { createPermissionPolicy } from '../../../src/permissions';
import { openSqliteStore } from '../../../src/sqlite';

function barrier() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
}
async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('auto_wait_budget_missing')), 3000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};

async function fixture(phase: 'prepare' | 'queue') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-auto-wait-')));
  const profile = { dataRoot: root, profile: 'test' };
  const store = await openSqliteStore(profile);
  const held = barrier();
  const effect = barrier();
  let preparationReleased = false;
  let preparationCalls = 0;
  let holderStarts = 0;
  let effects = 0;
  let reviews = 0;
  const prepare = store.prepareAuthorizationCheck.bind(store);
  if (phase === 'prepare')
    store.prepareAuthorizationCheck = async (input) => {
      preparationCalls++;
      await held.waiting;
      preparationReleased = true;
      return prepare(input);
    };
  const calls: ModelEvent[] = [
    ...(phase === 'queue'
      ? [
          {
            type: 'tool_call' as const,
            id: 'hold-model-permit',
            name: 'fixture.hold',
            arguments: '{}',
          },
        ]
      : []),
    { type: 'tool_call', id: 'effect', name: 'fixture.effect', arguments: '{}' },
    { ...finish, reason: 'tool_calls' } as ModelEvent,
  ];
  const model = createFixedModel([calls, [finish]]);
  const reviewer: ModelAdapter = {
    async *stream() {
      reviews++;
      yield {
        type: 'text_delta',
        text: JSON.stringify({ decision: 'approve_once', reason: 'Governed local fixture only.' }),
      };
      yield finish;
    },
  };
  const permissions = createPermissionPolicy({
    readPolicy: () => ({
      mode: 'auto',
      workspaceTrust: true,
      revision: 'fixture',
      allowed: [
        { kind: 'model', definitionId: 'fixed', definitionVersion: '1' },
        { kind: 'tool', definitionId: 'fixture.hold', definitionVersion: '1' },
        { kind: 'tool', definitionId: 'fixture.effect', definitionVersion: '1' },
      ],
    }),
    describeCapability: (request) => ({
      kind: request.kind,
      definitionId: request.definitionId,
      definitionVersion: request.definitionVersion,
      revision: 'fixture',
      hardAllowed: true,
      safeRead: request.definitionId === 'fixture.hold',
      effects:
        request.kind === 'model'
          ? []
          : request.definitionId === 'fixture.hold'
            ? ['read']
            : ['workspace_write'],
      ...(request.definitionId === 'fixture.effect'
        ? { autoTimeoutScope: 'governed' as const }
        : {}),
    }),
  });
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model,
    modelId: 'fixed',
    modelConcurrency: 1,
    permissions,
    authorizationCheck: {
      id: 'checker',
      version: '1',
      modelId: 'reviewer',
      model: reviewer,
      timeoutMs: 40,
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.hold',
            version: '1',
            description: 'Hold the actual shared Model permit without effects',
            inputSchema: { type: 'object' },
            resources: { slot: 'model' },
            async execute() {
              holderStarts++;
              await held.waiting;
              return { outcome: 'succeeded', content: 'Original permit holder ended.' };
            },
          },
          {
            id: 'fixture.effect',
            version: '1',
            description: 'One trusted governed local counter',
            inputSchema: { type: 'object' },
            async execute() {
              effects++;
              effect.release();
              return { outcome: 'succeeded', content: 'Governed counter updated.' };
            },
          },
        ],
      },
    ],
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'test',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'Auto waits',
  });
  return {
    runtime,
    store,
    model,
    effect,
    counts: () => ({ effects, reviews, holderStarts, preparationCalls, preparationReleased }),
    release: held.release,
    async start() {
      await runtime.submitCommand({
        expectedStoreId,
        commandId: 'work',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'Perform the bounded local fixture operation.' },
      });
    },
    async close() {
      held.release();
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const phase of ['prepare', 'queue'] as const)
  test(`Auto total budget covers actual ${phase} waiting without waiting for the original gate`, async () => {
    const f = await fixture(phase);
    try {
      await f.start();
      await bounded(f.effect.waiting);
      expect(f.counts()).toEqual({
        effects: 1,
        reviews: 0,
        holderStarts: phase === 'queue' ? 1 : 0,
        preparationCalls: phase === 'prepare' ? 1 : 0,
        preparationReleased: false,
      });
      const executions = await f.store.listExecutions('s');
      const check = executions.find((entry) => entry.definitionId === 'reviewer')!;
      expect(check.status).toBe('failed');
      expect(check.result).toMatchObject({ code: 'authorization_check_timeout', incomplete: true });
      const timing = (
        check.result as {
          timing: {
            budgetMs: number;
            prepareMs: number;
            queueMs: number;
            providerMs: number;
            totalMs: number;
          };
        }
      ).timing;
      expect(timing.budgetMs).toBe(40);
      expect(timing.totalMs).toBeGreaterThanOrEqual(timing.budgetMs);
      expect(timing.prepareMs).toBeGreaterThanOrEqual(0);
      expect(timing.queueMs).toBeGreaterThanOrEqual(0);
      expect(timing.providerMs).toBe(0);
      expect(timing.prepareMs + timing.queueMs + timing.providerMs).toBe(timing.totalMs);
      if (phase === 'prepare') expect(timing.queueMs).toBe(0);
      else {
        expect(timing.queueMs).toBeGreaterThan(0);
        expect(executions.find((entry) => entry.definitionId === 'fixture.hold')!.status).toBe(
          'dispatching',
        );
        // An unsettled sibling still holds the original batch join and shared
        // permit; timeout continuation does not add capacity or skip that join.
        expect(f.model.requests).toHaveLength(1);
      }
      f.release();
      await f.runtime.waitForCommand('work');
      expect((await f.store.getView('s')).runs[0]!.status).toBe('completed');
      expect(f.counts().reviews).toBe(0);
      expect(f.model.requests).toHaveLength(2);
    } finally {
      await f.close();
    }
  }, 10_000);
