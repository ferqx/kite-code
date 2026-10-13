import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json, RequirementEvaluation, RequirementRef } from '../../../src/storage';

async function rejected(promise: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string })?.code).toBe(code);
}

test('ordinary runless Tool freezes actual parent obligations through replay, descendants, final dispatch and mutation settlement', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-nested-requirements-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'temporary',
    rootUri: pathToFileURL(root).href,
  });
  await store.createSession({
    ...base,
    commandId: 'create',
    workspaceId: 'w',
    title: 'nested requirements',
  });
  await store.acceptCommand({
    ...base,
    commandId: 'work',
    request: { kind: 'run.start', content: 'original work' },
  });
  const owner = (await store.acquireSessionOwner('s', 'host'))!;
  const write = { expectedStoreId, owner };
  const run = await store.startRun({
    ...write,
    commandId: 'work',
    configuration: {
      tools: ['writer', 'mutation', 'leaf', 'checker'].map((id) => ({
        id,
        version: '1',
        extensionId: 'fixture',
      })),
    },
  });
  const source = { kind: 'model_decision', modelExecutionId: 'fixed' };
  const inputDigest = await semanticDigest({});
  const dispatch = (executionId: string, requirements: RequirementEvaluation[]) =>
    store.markDispatching({
      ...write,
      executionId,
      authorization: { allowed: true, revision: '1', definitionVersion: '1', inputDigest },
      requirements,
      freshness: { checked: true, source },
    });
  const evaluate = (requirement: RequirementRef): RequirementEvaluation => ({
    requirement,
    recordRevision: requirement.revision,
    outcome: 'satisfied',
    evidence: { observed: 'exact persisted requirement' },
    recordReads: [
      {
        key: requirement.recordKey,
        revision: requirement.revision,
        originStoreId: expectedStoreId,
      },
    ],
  });
  const record = (key: string, contentType: string, value: Json) =>
    store.writeExtensionRecord({
      ...write,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      originExecutionId: 'writer',
      write: {
        key,
        expectedRevision: null,
        contentType,
        contentVersion: 1,
        value,
        executable: true,
      },
    });
  const register = async (key: string, requirementId: string, phase: 'both' | 'completion') => {
    const registered = await store.registerRunRequirements({
      ...write,
      runId: run.id,
      requirements: [
        {
          extensionId: 'fixture',
          definitionVersion: '1',
          requirementId,
          recordKey: key,
          revision: '1',
          phase,
          sessionId: 's',
          runId: run.id,
        },
      ],
    });
    return registered.requirements.find((ref) => ref.requirementId === requirementId)!;
  };
  let passed = false;
  try {
    await store.planExecution({
      ...write,
      executionId: 'writer',
      sessionId: 's',
      runId: run.id,
      originCommandId: 'work',
      kind: 'tool',
      stepId: 'writer',
      callId: 'writer',
      definitionId: 'writer',
      definitionVersion: '1',
      input: {},
      decisionSource: source,
    });
    await dispatch('writer', []);
    await record('original-required', 'fixture.facts', { required: true });
    const original = await register('original-required', 'original', 'both');
    const policyKey = `run/${run.id}/mutation.required`;
    await record(policyKey, 'agent.mutation-policy', {
      kind: 'mutation_policy',
      runId: run.id,
      requirementId: 'mutation.required',
      definitions: [{ id: 'mutation', version: '1', effects: ['workspace_write'] }],
      checkDefinitionId: 'checker',
      checkDefinitionVersion: '1',
      checkTools: [],
    });
    const mutation = await register(policyKey, 'mutation.required', 'completion');
    const childOperation = await store.ensureOperation({
      ...write,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      parentExecutionId: 'writer',
      operationKey: 'original-child',
      request: { kind: 'tool', definitionId: 'mutation', definitionVersion: '1', input: {} },
    });
    const childPlan = {
      ...write,
      executionId: 'child',
      sessionId: 's',
      runId: null,
      originCommandId: childOperation.commandId,
      parentExecutionId: 'writer',
      kind: 'tool' as const,
      stepId: 'child',
      callId: 'child',
      definitionId: 'mutation',
      definitionVersion: '1',
      input: {},
      decisionSource: source,
    };
    const child = await store.planExecution(childPlan);
    expect(child.runId).toBeNull();
    expect(child.requirements).toEqual([original, mutation]);
    await record('later-required', 'fixture.facts', { newlyRequired: true });
    const later = await register('later-required', 'later', 'both');
    expect((await store.getRun(run.id))!.requirements).toEqual([original, mutation, later]);
    const cursor = (await store.getMetadata()).lastChangeCursor;
    expect(await store.planExecution(childPlan)).toEqual(child);
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
    await rejected(dispatch('child', []), 'requirement_not_satisfied');
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect((await store.getExecution('child'))!.status).toBe('planned');
    await rejected(dispatch('child', [evaluate(original)]), 'mutation_intent_missing');
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
    await store.registerMutationIntent({
      ...write,
      executionId: 'child',
      requirement: mutation,
      descriptor: { kind: 'file_hash', path: 'result.txt' },
    });
    expect((await dispatch('child', [evaluate(original)])).status).toBe('dispatching');
    const descendantOperation = await store.ensureOperation({
      ...write,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: childOperation.commandId,
      parentExecutionId: 'child',
      operationKey: 'descendant',
      request: { kind: 'tool', definitionId: 'leaf', definitionVersion: '1', input: {} },
    });
    const descendant = await store.planExecution({
      ...write,
      executionId: 'descendant',
      sessionId: 's',
      runId: null,
      originCommandId: descendantOperation.commandId,
      parentExecutionId: 'child',
      kind: 'tool',
      stepId: 'descendant',
      callId: 'descendant',
      definitionId: 'leaf',
      definitionVersion: '1',
      input: {},
      decisionSource: source,
    });
    expect(descendant.requirements).toEqual(child.requirements);
    expect(descendant.requirements).not.toContainEqual(later);
    const descendantCursor = (await store.getMetadata()).lastChangeCursor;
    await rejected(dispatch('descendant', []), 'requirement_not_satisfied');
    expect((await store.getMetadata()).lastChangeCursor).toBe(descendantCursor);
    expect((await dispatch('descendant', [evaluate(original)])).status).toBe('dispatching');
    await store.finishExecution({
      ...write,
      executionId: 'descendant',
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'known descendant result' },
    });
    const finished = await store.finishExecution({
      ...write,
      executionId: 'child',
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'known mutation result' },
    });
    const settled = await store.getExtensionRecord({
      sessionId: 's',
      extensionId: 'fixture',
      key: `run/${run.id}/mutation/settled/child`,
    });
    expect(settled?.value).toEqual({
      executionId: 'child',
      status: 'succeeded',
      resultRevision: finished.resultRevision,
    });
    const facts = await store.listMutationFacts({ expectedStoreId, requirement: mutation });
    expect(facts.facts).toHaveLength(1);
    expect(facts.facts[0]).toMatchObject({
      executionId: 'child',
      status: 'succeeded',
      resultRevision: finished.resultRevision,
      check: null,
    });
    const head = await store.getExtensionRecord({
      sessionId: 's',
      extensionId: 'fixture',
      key: `run/${run.id}/mutation.current`,
    });
    expect(head?.revision).toBe('2');
    expect(head?.value).toMatchObject({ lastSeq: '1', checkedThrough: '0' });
    await store.finishExecution({
      ...write,
      executionId: 'writer',
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'original writer ended' },
    });
    // No fake checker or passed fact: this Store test ends the work without claiming mutation verification.
    await store.finishRun({
      ...write,
      runId: run.id,
      status: 'cancelled',
      requirements: [],
      reason: 'fixture_finished_without_fake_verification',
    });
    passed = true;
  } finally {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        store.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`nested_requirements_close_timeout:${root}`)),
            4000,
          );
        }),
      ]);
      closed = true;
    } finally {
      if (timer) clearTimeout(timer);
      if (passed && closed) rmSync(root, { recursive: true, force: true });
      else {
        writeFileSync(
          join(root, 'failure.json'),
          JSON.stringify({ root, expectedStoreId, runId: run.id }),
        );
        console.error(`nested requirements evidence retained: ${root}`);
      }
    }
  }
}, 10000);
