import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage';

async function denied(promise: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string })?.code).toBe(code);
}

test('new resumed checker may record an inconclusive check of the exact old terminal runless mutation without adopting or replaying it', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-mutation-resume-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  let store = await openSqliteStore(profile);
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
    title: 'mutation resume',
  });
  await store.acceptCommand({
    ...base,
    commandId: 'work',
    request: { kind: 'run.start', content: 'original mutation work' },
  });
  const oldOwner = (await store.acquireSessionOwner('s', 'original'))!;
  const originalWrite = { expectedStoreId, owner: oldOwner };
  const configuration = {
    model: 'fixed',
    extensions: [{ id: 'fixture', version: '1' }],
    tools: ['parent', 'mutation', 'checker'].map((id) => ({
      id,
      version: '1',
      extensionId: 'fixture',
    })),
  };
  const run = await store.startRun({ ...originalWrite, commandId: 'work', configuration });
  const inputDigest = await semanticDigest({});
  const modelInput = { messages: [], modelId: 'fixed' };
  const modelSource = { kind: 'fixed' };
  const model = async (executionId: string, finishReason: 'tool_calls' | 'stop') => {
    await store.planExecution({
      ...originalWrite,
      executionId,
      sessionId: 's',
      runId: run.id,
      originCommandId: 'work',
      kind: 'model',
      stepId: executionId,
      callId: executionId,
      definitionId: 'fixed',
      definitionVersion: '1',
      input: modelInput,
      decisionSource: modelSource,
    });
    await store.markDispatching({
      ...originalWrite,
      executionId,
      authorization: {
        allowed: true,
        revision: '1',
        definitionVersion: '1',
        inputDigest: await semanticDigest(modelInput),
      },
      requirements: [],
      freshness: { checked: true, source: modelSource },
    });
    await store.finishExecution({
      ...originalWrite,
      executionId,
      status: 'succeeded',
      result: {
        content: 'complete fixed result',
        reasoning: '',
        finishReason,
        toolCalls:
          finishReason === 'tool_calls'
            ? [{ id: 'parent-call', name: 'parent', arguments: '{}' }]
            : [],
      },
    });
  };
  let passed = false;
  try {
    await store.beginRunRequirementsInitialization({ ...originalWrite, runId: run.id });
    const recordKey = `run/${run.id}/mutation.required`;
    const policy = await store.initializeRunRecord({
      ...originalWrite,
      runId: run.id,
      extensionId: 'fixture',
      write: {
        key: recordKey,
        contentType: 'agent.mutation-policy',
        contentVersion: 1,
        value: {
          kind: 'mutation_policy',
          runId: run.id,
          requirementId: 'mutation.required',
          definitions: [{ id: 'mutation', version: '1', effects: ['workspace_write'] }],
          checkDefinitionId: 'checker',
          checkDefinitionVersion: '1',
          checkTools: [],
        },
      },
    });
    const initialized = await store.registerRunRequirements({
      ...originalWrite,
      runId: run.id,
      initialize: true,
      requirements: [
        {
          extensionId: 'fixture',
          definitionVersion: '1',
          requirementId: 'mutation.required',
          recordKey,
          revision: policy.revision,
          phase: 'completion',
          sessionId: 's',
          runId: run.id,
        },
      ],
    });
    const requirement = initialized.requirements[0]!;
    await model('first-model', 'tool_calls');
    const parentSource = { kind: 'model_decision', modelExecutionId: 'first-model', sources: [] };
    await store.planExecution({
      ...originalWrite,
      executionId: 'parent',
      sessionId: 's',
      runId: run.id,
      originCommandId: 'work',
      kind: 'tool',
      stepId: 'first-model',
      callId: 'parent-call',
      definitionId: 'parent',
      definitionVersion: '1',
      input: {},
      decisionSource: parentSource,
    });
    await store.markDispatching({
      ...originalWrite,
      executionId: 'parent',
      authorization: { allowed: true, revision: '1', definitionVersion: '1', inputDigest },
      requirements: [],
      freshness: { checked: true, source: parentSource },
    });
    const operation = await store.ensureOperation({
      ...originalWrite,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      parentExecutionId: 'parent',
      operationKey: 'original-mutation',
      request: { kind: 'tool', definitionId: 'mutation', definitionVersion: '1', input: {} },
    });
    await store.planExecution({
      ...originalWrite,
      executionId: 'mutation',
      sessionId: 's',
      runId: null,
      originCommandId: operation.commandId,
      parentExecutionId: 'parent',
      kind: 'tool',
      stepId: 'mutation',
      callId: 'mutation',
      definitionId: 'mutation',
      definitionVersion: '1',
      input: {},
      decisionSource: parentSource,
    });
    await store.registerMutationIntent({
      ...originalWrite,
      executionId: 'mutation',
      requirement,
      descriptor: { kind: 'file_hash', path: 'effect.txt' },
    });
    await store.markDispatching({
      ...originalWrite,
      executionId: 'mutation',
      authorization: { allowed: true, revision: '1', definitionVersion: '1', inputDigest },
      requirements: [],
      freshness: { checked: true, source: parentSource },
    });
    // This public Store fixture owns one known effect; it does not manufacture a Files hash proof.
    writeFileSync(join(root, 'effect.txt'), 'exact original effect\n', { flag: 'wx' });
    const target = await store.finishExecution({
      ...originalWrite,
      executionId: 'mutation',
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'exact original mutation receipt' },
    });
    await store.finishExecution({
      ...originalWrite,
      executionId: 'parent',
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'parent complete' },
    });
    await model('stop-model', 'stop');
    expect(target.ownerGeneration).toBe(oldOwner.generation);
    expect(target.runId).toBeNull();
    expect(target.requirements).toEqual([requirement]);
    const settledKey = `run/${run.id}/mutation/settled/mutation`;
    const originalSettlement = await store.getExtensionRecord({
      sessionId: 's',
      extensionId: 'fixture',
      key: settledKey,
    });
    expect(originalSettlement?.value).toMatchObject({
      executionId: target.id,
      status: 'succeeded',
      resultRevision: target.resultRevision,
    });
    await store.close();
    store = await openSqliteStore(profile);
    const resumeInput = {
      ...base,
      commandId: 'resume',
      runId: run.id,
      expectedOwnerGeneration: oldOwner.generation,
    };
    const state = await store.verifyRunResume(resumeInput);
    expect(state.checkpoint?.boundary).toBe('completion');
    expect(state.requirementsInitialized).toBe(true);
    const begun = await store.beginRunResume({
      ...resumeInput,
      checkpoint: state.checkpoint!,
      instanceId: 'resumed',
    });
    const committed = await store.commitRunResume({
      expectedStoreId,
      lease: begun.lease!,
      expectedConfiguration: configuration,
      checkpoint: state.checkpoint!,
    });
    expect(committed.owner.generation).not.toBe(oldOwner.generation);
    expect(committed.run.requirements).toEqual([requirement]);
    expect(await store.getExecution(target.id)).toEqual(target);
    const head = await store.getExtensionRecord({
      sessionId: 's',
      extensionId: 'fixture',
      key: `run/${run.id}/mutation.current`,
    });
    const checkerInput = {
      runId: run.id,
      mutationExecutionId: target.id,
      headRevision: head!.revision,
      seq: '1',
    };
    const checkerSource = {
      kind: 'completion_decision',
      requirement: requirement as unknown as Json,
      key: 'original-mutation-check',
      sources: [],
    };
    const resumedWrite = { expectedStoreId, owner: committed.owner };
    await store.planExecution({
      ...resumedWrite,
      executionId: 'checker',
      sessionId: 's',
      runId: run.id,
      originCommandId: 'work',
      kind: 'tool',
      stepId: 'checker',
      callId: 'checker',
      definitionId: 'checker',
      definitionVersion: '1',
      input: checkerInput,
      decisionSource: checkerSource,
    });
    await store.markDispatching({
      ...resumedWrite,
      executionId: 'checker',
      authorization: {
        allowed: true,
        revision: '1',
        definitionVersion: '1',
        inputDigest: await semanticDigest(checkerInput),
      },
      requirements: [],
      freshness: { checked: true, source: checkerSource },
    });
    const check = {
      executionId: 'checker',
      requirement,
      mutationExecutionId: target.id,
      headRevision: head!.revision,
      outcome: 'inconclusive' as const,
      evidence: { reason: 'fixture_has_no_file_checker' },
    };
    const before = (await store.getMetadata()).lastChangeCursor;
    await denied(
      store.commitMutationCheck({ expectedStoreId, owner: oldOwner, ...check }),
      'owner_changed',
    );
    expect((await store.getMetadata()).lastChangeCursor).toBe(before);
    writeFileSync(
      join(root, 'before-check.json'),
      JSON.stringify(
        {
          target,
          originalSettlement,
          head,
          committedOwner: committed.owner,
          checker: await store.getExecution('checker'),
        },
        null,
        2,
      ),
    );
    await store.commitMutationCheck({ ...resumedWrite, ...check });
    const facts = await store.listMutationFacts({ expectedStoreId, requirement });
    expect(facts.facts[0]).toMatchObject({
      executionId: target.id,
      status: 'succeeded',
      resultRevision: target.resultRevision,
      check: { outcome: 'inconclusive', executionId: 'checker' },
    });
    expect(await store.getExecution(target.id)).toEqual(target);
    expect(
      await store.getExtensionRecord({ sessionId: 's', extensionId: 'fixture', key: settledKey }),
    ).toEqual(originalSettlement);
    expect(readFileSync(join(root, 'effect.txt'), 'utf8')).toBe('exact original effect\n');
    const finalHead = await store.getExtensionRecord({
      sessionId: 's',
      extensionId: 'fixture',
      key: `run/${run.id}/mutation.current`,
    });
    expect(finalHead?.value).toMatchObject({
      lastSeq: '1',
      checkedThrough: '0',
      lastOutcome: 'inconclusive',
      lastCheckerExecutionId: 'checker',
    });
    await store.finishExecution({
      ...resumedWrite,
      executionId: 'checker',
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'inconclusive remains required' },
    });
    await store.finishRun({
      ...resumedWrite,
      runId: run.id,
      status: 'cancelled',
      requirements: [],
      reason: 'fixture_does_not_fake_validation_pass',
    });
    passed = true;
  } finally {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    try {
      await Promise.race([
        store.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`mutation_resume_close_timeout:${root}`)),
            4000,
          );
        }),
      ]);
      closed = true;
    } finally {
      if (timer) clearTimeout(timer);
      if (passed && closed) rmSync(root, { recursive: true, force: true });
      else console.error(`mutation resume evidence retained: ${root}`);
    }
  }
}, 10000);
