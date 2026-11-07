import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { openSqliteStore } from '../../../src/sqlite';
import { ensureFixtureAuthorizationCheck } from '../../fixtures/review-behavior';

async function fixture(sealChecker = true) {
  const root = temporaryDirectory('kite-check-ensure-');
  const store = await openSqliteStore({ dataRoot: root, profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'Fixture',
    rootUri: 'file:///fixture',
  });
  await store.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 'Fixture' });
  await store.acceptCommand({
    ...base,
    commandId: 'work',
    request: { kind: 'run.start', content: 'Original task' },
  });
  const owner = (await store.acquireSessionOwner('s', 'host'))!;
  const owned = { expectedStoreId, owner };
  const run = await store.startRun({
    ...owned,
    commandId: 'work',
    configuration: sealChecker
      ? { authorizationCheck: { id: 'checker', version: '1', modelId: 'review', timeoutMs: 3000 } }
      : {},
  });
  await store.planExecution({
    ...owned,
    executionId: 'target',
    sessionId: 's',
    runId: run.id,
    originCommandId: 'work',
    stepId: 'target',
    callId: 'target',
    kind: 'tool',
    definitionId: 'effect',
    definitionVersion: '1',
    input: { value: 'exact' },
    decisionSource: { kind: 'host_intent', commandId: 'work' },
  });
  const request = {
    ...owned,
    targetExecutionId: 'target',
    policyRevision: 'p1',
    checker: { id: 'checker', version: '1', modelId: 'review' },
    operationKey: 'a'.repeat(64),
    requireApproval: true,
    request: { task: 'Original task' },
    timeout: { startedAt: Date.now() - 100, deadlineAt: Date.now() + 2900 },
  };
  return {
    store,
    base,
    owned,
    run,
    request,
    async close() {
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('same target ensure reuses its original fact despite a new timeout clock and never renews its deadline', async () => {
  const f = await fixture();
  try {
    const first = await ensureFixtureAuthorizationCheck(f.store, f.request);
    const second = await ensureFixtureAuthorizationCheck(f.store, {
      ...f.request,
      timeout: { startedAt: Date.now(), deadlineAt: Date.now() + 60000 },
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.execution.id).toBe(first.execution.id);
    expect(second.input).toEqual(first.input);
    expect((second.input as { timeout: unknown }).timeout).toEqual(f.request.timeout);
    expect(
      (await f.store.listExecutions('s')).filter((item) => item.kind === 'model'),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

for (const changed of ['request', 'policy', 'operation', 'human', 'context'] as const)
  test(`same target ensure does not reuse a different ${changed} binding`, async () => {
    const f = await fixture();
    try {
      const first = await ensureFixtureAuthorizationCheck(f.store, f.request);
      const next = {
        ...f.request,
        timeout: { startedAt: Date.now(), deadlineAt: Date.now() + 3000 },
      };
      if (changed === 'request') next.request = { task: 'Changed task' };
      if (changed === 'policy') next.policyRevision = 'p2';
      if (changed === 'operation') next.operationKey = 'b'.repeat(64);
      if (changed === 'human') next.requireApproval = false;
      if (changed === 'context') {
        await f.store.planExecution({
          ...f.owned,
          executionId: 'refused',
          sessionId: 's',
          runId: f.run.id,
          originCommandId: 'work',
          stepId: 'refused',
          callId: 'refused',
          kind: 'tool',
          definitionId: 'effect',
          definitionVersion: '1',
          input: {},
          decisionSource: { kind: 'host_intent', commandId: 'work' },
        });
        await f.store.finishExecution({
          ...f.owned,
          executionId: 'refused',
          status: 'failed',
          result: {
            outcome: 'failed',
            content: 'Actual refusal',
            details: { code: 'permission_denied' },
          },
        });
      }

      const second = await ensureFixtureAuthorizationCheck(f.store, next);
      expect(second.created).toBe(true);
      expect(second.execution.id).not.toBe(first.execution.id);
      expect(
        (await f.store.listExecutions('s')).filter((item) => item.kind === 'model'),
      ).toHaveLength(2);
    } finally {
      await f.close();
    }
  });

for (const changed of ['missing', 'id', 'version', 'modelId'] as const) {
  test(`a generic check cannot replace the original frozen Run checker (${changed})`, async () => {
    const f = await fixture(changed !== 'missing');
    try {
      const before = (await f.store.getMetadata()).lastChangeCursor;
      const next = { ...f.request, checker: { ...f.request.checker } };
      if (changed === 'id') next.checker.id = 'replacement';
      if (changed === 'version') next.checker.version = 'different-options-digest';
      if (changed === 'modelId') next.checker.modelId = 'replacement-model';
      const error = await ensureFixtureAuthorizationCheck(f.store, next).catch((error) => error);
      expect(error).toMatchObject({ code: 'authorization_check_binding_invalid' });
      expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
      expect(
        (await f.store.listExecutions('s')).filter((execution) => execution.kind === 'model'),
      ).toHaveLength(0);
      expect((await f.store.getExecution('target'))!.status).toBe('planned');
    } finally {
      await f.close();
    }
  });
}
