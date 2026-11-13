import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createFixedModel } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { createRuntime } from '../../../src';
import type { Permissions, ToolDefinition } from '../../../src/extensions';
import { intersectPermissionPolicies } from '../../../src/permissions/inheritance';
import { openSqliteStore } from '../../../src/sqlite';

test('a concurrent actual Tool cannot replace another Tool independent confirmation challenge', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-confirmation-interleaving-')));
  const store = await openSqliteStore({ dataRoot: root, profile: 'new' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, subjectId: 'user' };
  let confirmedEffects = 0;
  let unrelatedEffects = 0;
  let confirmedExecutionId: string | undefined;
  let interleaved = false;
  let releaseConfirmed!: () => void;
  let releaseUnrelated!: () => void;
  const confirmedRead = new Promise<void>((resolve) => {
    releaseConfirmed = resolve;
  });
  const unrelatedRead = new Promise<void>((resolve) => {
    releaseUnrelated = resolve;
  });
  const confirmed: ToolDefinition = {
    id: 'fixture.confirmed',
    version: '1',
    description: 'Requires its independent policy',
    inputSchema: { type: 'object' },
    async execute() {
      confirmedEffects++;
      return { outcome: 'succeeded', content: 'effect' };
    },
  };
  const unrelated: ToolDefinition = {
    id: 'fixture.unrelated',
    version: '1',
    description: 'An independently allowed operation',
    inputSchema: { type: 'object' },
    async execute() {
      unrelatedEffects++;
      return { outcome: 'succeeded', content: 'unrelated' };
    },
  };
  const sharedSnapshot = { namespace: 'fixture.current', version: '1', data: {} };
  const composed = intersectPermissionPolicies(
    {
      async authorize() {
        return { allowed: true, revision: 'current', snapshot: sharedSnapshot };
      },
    },
    {
      async authorize(request) {
        return request.definitionId === confirmed.id
          ? { allowed: false, revision: 'independent', check: { request: { separate: true } } }
          : { allowed: true, revision: 'unrelated' };
      },
    },
  );
  const permissions: Permissions = {
    ...composed,
    async authorize(request) {
      if (request.definitionId === unrelated.id) await confirmedRead;
      const decision = await composed.authorize(request);
      if (request.definitionId === confirmed.id) {
        confirmedExecutionId = request.executionId;
        releaseConfirmed();
      }
      if (request.definitionId === unrelated.id) releaseUnrelated();
      return decision;
    },
  };
  const readExecution = store.getExecution.bind(store);
  store.getExecution = async (id) => {
    if (id === confirmedExecutionId && !interleaved) {
      interleaved = true;
      await unrelatedRead;
    }
    return readExecution(id);
  };
  const runtime = createRuntime({
    store,
    permissions,
    modelId: 'fixed',
    extensions: [
      { id: 'fixture.concurrent', version: '1', apiMajor: 1, tools: [confirmed, unrelated] },
    ],
    toolBehaviors: [
      {
        definition: confirmed,
        capability: { kind: 'tool', definitionId: confirmed.id, definitionVersion: '1' },
        contractRef: 'fixture.confirmation',
        configurationDigest: '0'.repeat(64),
        async executionConfirmation() {
          return { request: { exact: true } };
        },
      },
    ],
    model: createFixedModel([
      [
        { type: 'tool_call', id: 'confirmed', name: confirmed.id, arguments: '{}' },
        { type: 'tool_call', id: 'unrelated', name: unrelated.id, arguments: '{}' },
        { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
      [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
    ]),
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Owned',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      ...base,
      commandId: 'session',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Concurrent policy',
    });
    await runtime.submitCommand({
      ...base,
      commandId: 'work',
      sessionId: 's',
      request: { kind: 'run.start', content: 'Two independent operations' },
    });
    const completed = runtime.waitForCommand('work', { timeoutMs: 5000 });
    let finished = false;
    void completed
      .finally(() => {
        finished = true;
      })
      .catch(() => {});
    // Answer any erroneous owner card so the unsafe pre-fix path settles too.
    while (!finished) {
      const cards = (await runtime.listInteractions({ ...base, sessionId: 's' })).interactions;
      for (const card of cards.filter((value) => value.state === 'pending'))
        await runtime.answerInteraction({
          ...base,
          presentationSessionId: card.presentationSessionId,
          interactionId: card.id,
          commandId: `answer-${card.id}`,
          expectedRevision: card.revision,
          answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
        });
      await Promise.race([completed, sleepTimer(5)]);
    }
    await completed;
    expect(interleaved).toBe(true);
    expect(unrelatedEffects).toBe(1);
    expect(confirmedEffects).toBe(0);
    expect((await runtime.listInteractions({ ...base, sessionId: 's' })).interactions).toHaveLength(
      0,
    );
    const actual = await store.getExecution(confirmedExecutionId!);
    expect(actual?.authorization?.dispatched).toBe(false);
    expect(actual?.result).toMatchObject({ content: 'execution_confirmation_policy_unsupported' });
  } finally {
    releaseConfirmed();
    releaseUnrelated();
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
