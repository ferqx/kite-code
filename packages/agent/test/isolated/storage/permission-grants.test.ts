import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';

test('grant directory has frozen keyset upper, preserves over 200 accepted facts and is cold-readable without replay', async () => {
  const dataRoot = mkdtempSync('/private/tmp/kite-grant-directory-');
  const profile = { dataRoot, profile: 'new' };
  let store = await openSqliteStore(profile);
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: 'file:///explicit-fixture',
      name: 'Temporary',
    });
    await store.createSession({
      expectedStoreId,
      subjectId: 'owner',
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Temporary',
    });
    await store.acceptCommand({
      expectedStoreId,
      subjectId: 'owner',
      commandId: 'work',
      sessionId: 's',
      request: { kind: 'run.start', content: 'Explicit harmless ledger fixture' },
    });
    const owner = (await store.acquireSessionOwner('s', 'host'))!;
    const owned = { expectedStoreId, owner };
    const run = await store.startRun({
      ...owned,
      commandId: 'work',
      configuration: { tools: [{ id: 'fixture.command', version: '1', extensionId: 'fixture' }] },
    });
    const source = { kind: 'host_intent', commandId: 'work' };
    async function save(index: number, offer = true) {
      const input = { command: `harmless-${index}` };
      const inputDigest = await semanticDigest(input);
      const binding = {
        ...owned,
        executionId: `execution-${index}`,
        attempt: 1,
        definitionId: 'fixture.command',
        definitionVersion: '1',
        inputDigest,
        policyRevision: 'policy',
      };
      await store.planExecution({
        ...owned,
        executionId: binding.executionId,
        sessionId: 's',
        runId: run.id,
        originCommandId: 'work',
        kind: 'tool',
        stepId: `step-${index}`,
        callId: `call-${index}`,
        definitionId: binding.definitionId,
        definitionVersion: '1',
        input,
        decisionSource: source,
      });
      await store.requestInteraction({
        ...binding,
        interactionId: `interaction-${index}`,
        kind: 'approval',
        requiredRefs: [],
        source,
        request: { grants: offer ? ['approve_once', 'same_command'] : ['approve_once'] },
      });
      await store.answerInteraction({
        expectedStoreId,
        subjectId: 'owner',
        commandId: `answer-${index}`,
        presentationSessionId: 's',
        interactionId: `interaction-${index}`,
        expectedRevision: '1',
        answer: { kind: 'approval', decision: 'approve', grant: 'same_command' },
      });
      await store.acceptInteractionDecision({
        ...binding,
        interactionId: `interaction-${index}`,
        decisionRevision: '2',
        requirements: [],
        freshness: { checked: true, source },
      });
    }
    for (let index = 0; index < 201; index++) await save(index);
    const query = { expectedStoreId, subjectId: 'owner', sessionId: 's', limit: 200 };
    const first = await store.listPermissionGrants(query);
    expect(first.items).toHaveLength(200);
    expect(first.nextAfterSeq).toBe(first.items.at(-1)!.seq);
    await save(201);
    const unoffered = await save(202, false).catch((error) => error);
    expect(unoffered.code).toBe('interaction_answer_invalid');
    const last = await store.listPermissionGrants({
      ...query,
      afterSeq: first.nextAfterSeq!,
      upperSeq: first.upperSeq,
    });
    expect(last.items).toHaveLength(1);
    expect(last.items[0]!.grant.id).toBe('interaction-200');
    expect(last.nextAfterSeq).toBeNull();
    const watermark = (await store.getMetadata()).lastChangeCursor;
    await store.listPermissionGrants(query);
    expect((await store.getMetadata()).lastChangeCursor).toBe(watermark);
    for (const invalid of [{ afterSeq: '01' }, { upperSeq: '999999' }, { limit: 201 }]) {
      const error = await store
        .listPermissionGrants({ ...query, ...invalid })
        .catch((error) => error);
      expect(error.code).toMatch(/invalid_permission/);
    }
    await store.close();
    store = await openSqliteStore({ ...profile, mode: 'readonly' });
    const cold = await store.listPermissionGrants({ ...query, limit: 200 });
    expect(cold.items).toEqual(first.items);
    expect(cold.nextAfterSeq).toBe(first.nextAfterSeq);
    const second = await store.listPermissionGrants({
      ...query,
      afterSeq: cold.nextAfterSeq!,
      upperSeq: cold.upperSeq,
    });
    expect(second.items).toHaveLength(2);
    expect((await store.getMetadata()).lastChangeCursor).toBe(watermark);
    const rejected = await store
      .clearPermissionGrants({ ...query, commandId: 'cold-clear', ifRevision: cold.revision })
      .catch((error) => error);
    expect(rejected.code).toBe('read_only');
  } finally {
    await store.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}, 15000);
