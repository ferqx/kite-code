import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json, RunResumeExecutionPageInput } from '../../../src/storage/types';

type Row = Record<string, string | number | bigint | null>;
const jsonRow = (row: Row): Json =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'bigint' ? String(value) : value,
    ]),
  );

async function denied(operation: Promise<unknown>, code: string) {
  const error = await operation.catch((caught) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as { code?: string }).code).toBe(code);
}

// Store transaction contract only: these are actual owned API records, not Runtime/Tool effects.
test('resume scans all original history, pages exact Model and Tool identities and binds omitted terminal rows in the unchanged canonical digest', async () => {
  const dataRoot = mkdtempSync('/private/tmp/kite-resume-history-');
  const profile = { dataRoot, profile: 'test' };
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let db: Database | undefined;
  let businessError: unknown;
  let failed = false;
  const cleanupErrors: unknown[] = [];
  try {
    store = await openSqliteStore(profile);
    const expectedStoreId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: `file://${dataRoot}`,
      name: 'w',
    });
    await store.createSession({
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'create',
      workspaceId: 'w',
      title: 'history',
    });
    await store.acceptCommand({
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'work',
      request: { kind: 'run.start', content: 'original owned history' },
    });
    const owner = (await store.acquireSessionOwner('s', 'original'))!;
    const configuration = { model: 'fixed', extensionVersion: '1' };
    const run = await store.startRun({ expectedStoreId, owner, commandId: 'work', configuration });
    await store.beginRunRequirementsInitialization({ expectedStoreId, owner, runId: run.id });
    await store.registerRunRequirements({
      expectedStoreId,
      owner,
      runId: run.id,
      requirements: [],
      initialize: true,
    });
    const modelInput = { messages: [], modelId: 'fixed' };
    const modelDigest = await semanticDigest(modelInput);
    const toolDigest = await semanticDigest({});
    const models = Array.from({ length: 206 }, (_, i) => `model-${i}`);
    const tools = Array.from({ length: 205 }, (_, i) => `tool-${i}`);
    const calls = tools.map((_, i) => ({ id: `call-${i}`, name: 'fixture.tool', arguments: '{}' }));
    for (const [i, executionId] of models.entries()) {
      await store.planExecution({
        expectedStoreId,
        owner,
        sessionId: 's',
        runId: run.id,
        executionId,
        originCommandId: 'work',
        stepId: `step-${i}`,
        callId: 'model',
        kind: 'model',
        definitionId: 'fixed',
        definitionVersion: '1',
        input: modelInput,
        decisionSource: { kind: 'fixed' },
      });
      await store.markDispatching({
        expectedStoreId,
        owner,
        executionId,
        authorization: {
          allowed: true,
          revision: 'fixed',
          definitionVersion: '1',
          inputDigest: modelDigest,
        },
        requirements: [],
        freshness: { checked: true, source: { kind: 'fixed' } },
      });
      await store.finishExecution({
        expectedStoreId,
        owner,
        executionId,
        status: 'succeeded',
        result: {
          content: `original Model ${i}`,
          reasoning: '',
          finishReason: i === 205 ? 'tool_calls' : 'stop',
          toolCalls: i === 205 ? calls : [],
        },
      });
    }
    const toolSource = { kind: 'model_decision', modelExecutionId: 'model-205', sources: [] };
    for (const [i, executionId] of tools.entries()) {
      await store.planExecution({
        expectedStoreId,
        owner,
        sessionId: 's',
        runId: run.id,
        executionId,
        originCommandId: 'work',
        stepId: 'step-205',
        callId: `call-${i}`,
        kind: 'tool',
        definitionId: 'fixture.tool',
        definitionVersion: '1',
        input: {},
        decisionSource: toolSource,
      });
      await store.markDispatching({
        expectedStoreId,
        owner,
        executionId,
        authorization: {
          allowed: true,
          revision: 'fixed',
          definitionVersion: '1',
          inputDigest: toolDigest,
        },
        requirements: [],
        freshness: { checked: true, source: toolSource },
      });
      await store.finishExecution({
        expectedStoreId,
        owner,
        executionId,
        status: 'succeeded',
        result: { outcome: 'succeeded', content: `original known Tool ${i}` },
      });
    }
    await store.planExecution({
      expectedStoreId,
      owner,
      sessionId: 's',
      runId: run.id,
      executionId: 'planned-next',
      originCommandId: 'work',
      stepId: 'step-next',
      callId: 'model',
      kind: 'model',
      definitionId: 'fixed',
      definitionVersion: '1',
      input: modelInput,
      decisionSource: { kind: 'fixed' },
    });
    await store.requestInteraction({
      expectedStoreId,
      owner,
      interactionId: 'original-approval',
      executionId: 'planned-next',
      attempt: 1,
      kind: 'approval',
      definitionId: 'fixed',
      definitionVersion: '1',
      inputDigest: modelDigest,
      policyRevision: 'fixed',
      requiredRefs: [],
      source: { kind: 'fixed' },
      request: { description: 'original pending authority' },
    });
    const planned = (await store.getExecution('planned-next'))!;
    await store.close();
    store = undefined;
    store = await openSqliteStore(profile);
    const current = store;
    const input = {
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'resume',
      runId: run.id,
      expectedOwnerGeneration: owner.generation,
    };
    const metadata = await current.getMetadata();
    const state = await current.verifyRunResume(input);
    expect(state.executions.map((execution) => execution.id)).toEqual(['planned-next']);
    expect(state.executions[0]!).toEqual(planned);
    expect(state.checkpoint?.boundary).toBe('before_model_dispatch');
    const pages = async (
      kind: RunResumeExecutionPageInput['kind'],
      modelExecutionId: string,
      expected: string[],
    ) => {
      const ids: string[] = [];
      const pageSizes: number[] = [];
      let cursor: string | undefined;
      let previous = 0n;
      for (;;) {
        const page = await current.readRunResumeExecutionPage({
          expectedStoreId,
          subjectId: 'owner',
          sessionId: 's',
          runId: run.id,
          modelExecutionId,
          kind,
          ...(cursor ? { afterRowid: cursor } : {}),
        });
        pageSizes.push(page.items.length);
        expect(page.items.length).toBeLessThanOrEqual(200);
        for (const item of page.items) {
          expect(BigInt(item.cursor)).toBeGreaterThan(previous);
          previous = BigInt(item.cursor);
          ids.push(item.executionId);
          const execution = (await current.getExecution(item.executionId))!;
          expect(execution.originStoreId).toBe(expectedStoreId);
          expect(execution.runId).toBe(run.id);
          expect(execution.sessionId).toBe('s');
          expect(execution.attempt).toBe(1);
          expect(execution.status).toBe('succeeded');
          expect(execution.kind).toBe(kind === 'prior_models' ? 'model' : 'tool');
          if (kind === 'model_tools') expect(execution.stepId).toBe('step-205');
        }
        if (page.nextCursor === null) break;
        expect(page.nextCursor).toBe(page.items.at(-1)!.cursor);
        cursor = page.nextCursor;
      }
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(expected.length);
      expect(pageSizes).toEqual([200, expected.length - 200]);
    };
    await pages('prior_models', 'planned-next', models);
    await pages('model_tools', 'model-205', tools);
    const directory: RunResumeExecutionPageInput = {
      expectedStoreId,
      subjectId: 'owner',
      sessionId: 's',
      runId: run.id,
      modelExecutionId: 'planned-next',
      kind: 'prior_models',
    };
    for (const [invalid, code] of [
      [{ ...directory, subjectId: 'foreign' }, 'model_input_scope_denied'],
      [{ ...directory, expectedStoreId: 'foreign' }, 'store_identity_mismatch'],
      [{ ...directory, modelExecutionId: 'tool-0' }, 'model_input_unavailable'],
      [{ ...directory, afterRowid: '-1' }, 'invalid_run_resume_cursor'],
    ] as const)
      await denied(current.readRunResumeExecutionPage(invalid), code);
    expect(await current.getMetadata()).toEqual(metadata);
    expect(await current.getCommand('resume')).toBeNull();
    expect(await current.getExecution('planned-next')).toEqual(planned);
    db = new Database(join(dataRoot, 'test', 'core.db'));
    const all = (sql: string, ...args: string[]): Row[] => {
      const statement = db!.query<Row, string[]>(sql);
      try {
        (
          statement as typeof statement & { safeIntegers(value: boolean): typeof statement }
        ).safeIntegers(true);
        return statement.all(...args);
      } finally {
        statement.finalize();
      }
    };
    const executions = all(
      'SELECT * FROM execution WHERE run_id=? AND session_id=? ORDER BY rowid',
      run.id,
      's',
    );
    const interactions = all('SELECT * FROM interaction WHERE run_id=? ORDER BY id', run.id);
    const rawRun = all('SELECT * FROM run WHERE id=?', run.id)[0]!;
    const rawSession = all('SELECT * FROM session WHERE id=?', 's')[0]!;
    expect(executions).toHaveLength(412);
    expect(interactions).toHaveLength(1);
    const originalCanonical = canonicalJson({
      executions: executions.map(jsonRow),
      interactions: interactions.map(jsonRow),
      run: jsonRow(rawRun),
      selection: String(rawSession.context_selection_id),
    });
    expect(state.checkpoint!.bindingDigest).toBe(
      createHash('sha256').update(originalCanonical).digest('hex'),
    );
    // Explicit corruption injection into a terminal record absent from the finite frontier.
    const oldResult = String(
      executions.find((execution) => execution.id === 'model-0')!.result_json,
    );
    db.run('UPDATE execution SET result_json=? WHERE id=?', ['{}', 'model-0']);
    await denied(current.verifyRunResume(input), 'run_resume_checkpoint_unavailable');
    db.run('UPDATE execution SET result_json=? WHERE id=?', [oldResult, 'model-0']);
    const begun = await current.beginRunResume({
      ...input,
      checkpoint: state.checkpoint!,
      instanceId: 'new',
    });
    expect(begun.lease).not.toBeNull();
    const accepted = await current.getCommand('resume');
    const owned = await current.getSession('s');
    const stillPlanned = await current.getExecution('planned-next');
    expect(accepted!.status).toBe('accepted');
    expect(accepted!.receipt).toBeNull();
    expect(owned!.ownerGeneration).toBe(begun.lease!.generation);
    expect(stillPlanned).toEqual(planned);
    const validChangedResult = {
      ...JSON.parse(oldResult),
      content: 'different but still complete original Model',
    };
    db.run('UPDATE execution SET result_json=? WHERE id=?', [
      JSON.stringify(validChangedResult),
      'model-0',
    ]);
    await denied(
      current.commitRunResume({
        expectedStoreId,
        lease: begun.lease!,
        expectedConfiguration: configuration,
        checkpoint: state.checkpoint!,
      }),
      'run_resume_checkpoint_changed',
    );
    expect(await current.getCommand('resume')).toEqual(accepted);
    expect(await current.getSession('s')).toEqual(owned);
    expect(await current.getExecution('planned-next')).toEqual(stillPlanned);
    await current.releaseRunResumeLease(begun.lease!);
  } catch (error) {
    failed = true;
    businessError = error;
  } finally {
    try {
      db?.close();
      db = undefined;
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await store?.close();
      store = undefined;
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (!cleanupErrors.length && !db && !store) {
      try {
        rmSync(dataRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(failed ? [businessError] : []), ...cleanupErrors],
      `resume_history_cleanup_failed_root_retained:${dataRoot}`,
    );
  if (failed) throw businessError;
}, 20000);
