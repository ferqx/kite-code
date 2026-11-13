import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from '@kite-ai/agent/runtime-sqlite';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { Store } from '@kite-ai/agent/storage';
import { expect, test } from '#kite-test';
import { semanticDigest } from '../../../../packages/agent/src/json';
import {
  approvalReviewerTimeoutMs,
  approvalTimeoutRequestIds,
  expectedShellRiskOperationInput,
  hasValidatorDiagnostic,
  lifecycleStopApprovalJobId,
  type NaturalChildEvidence,
  naturalChildIdentity,
  priorFilesScopeFailures,
  readLiveExecutionDirectory,
  readLiveSessionLogPages,
  verifyUnifiedShellModelCatalogue,
} from './approval-execution-fixture';

async function executionDirectoryFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-live-execution-directory-')));
  const store = await openSqliteStore({ dataRoot: root, profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'workspace',
    rootUri: pathToFileURL(root).href,
    name: 'directory fixture',
  });
  await store.createSession({
    expectedStoreId,
    sessionId: 's',
    workspaceId: 'workspace',
    commandId: 'create',
    subjectId: 'owner',
    title: 'directory',
  });
  await store.acceptCommand({
    expectedStoreId,
    sessionId: 's',
    commandId: 'work',
    subjectId: 'owner',
    request: { kind: 'run.start', content: 'observe complete execution records' },
  });
  const owner = (await store.acquireSessionOwner('s', 'host'))!;
  const source = { kind: 'fixture' };
  const configuration = {
    modelId: 'fixed',
    tools: [{ id: 'owned.read', version: '1', extensionId: 'owned' }],
  };
  const run = await store.startRun({ expectedStoreId, owner, commandId: 'work', configuration });
  const observation = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  async function plan(
    id: string,
    kind: 'model' | 'tool' = 'tool',
    scope = { sessionId: 's', runId: run.id, commandId: 'work' },
  ) {
    return store.planExecution({
      expectedStoreId,
      owner,
      executionId: id,
      sessionId: scope.sessionId,
      runId: scope.runId,
      originCommandId: scope.commandId,
      stepId: id,
      callId: id,
      kind,
      definitionId: kind === 'model' ? 'fixed' : 'owned.read',
      definitionVersion: '1',
      input:
        kind === 'model'
          ? { modelId: 'fixed', requestId: id, messages: [], tools: [] }
          : { ordinal: id },
      decisionSource: source,
    });
  }
  return {
    root,
    store,
    expectedStoreId,
    owner,
    source,
    configuration,
    run,
    observation,
    plan,
    async close() {
      await store.close();
      rmSync(root, { recursive: true });
    },
  };
}

test('live directory reads every real Store execution beyond 200 in rowid order, including child carriers and later child rows', async () => {
  const f = await executionDirectoryFixture();
  let db: Database | undefined;
  try {
    for (let index = 0; index < 211; index++)
      await f.plan(`entry-${300 - index}`, index % 3 === 0 ? 'model' : 'tool');
    const parent = await f.plan('parent');
    await f.store.markDispatching({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: parent.id,
      authorization: {
        allowed: true,
        revision: 'fixture',
        definitionVersion: '1',
        inputDigest: await semanticDigest(parent.input),
      },
      requirements: [],
      freshness: { checked: true, source: f.source },
    });
    const operation = {
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      sessionId: 's',
      extensionId: 'owned',
      originCommandId: 'work',
      parentExecutionId: parent.id,
    };
    const job = await f.store.ensureOperation({
      ...operation,
      operationKey: 'job',
      request: { kind: 'job', definitionId: 'owned.job', definitionVersion: '1', input: {} },
    });
    await f.store.markDispatching({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: job.executionId!,
      authorization: {
        allowed: true,
        revision: 'fixture-job',
        definitionVersion: '1',
        inputDigest: await semanticDigest({}),
      },
      requirements: [],
      freshness: { checked: true, source: f.source },
    });
    const originalOutput = [];
    for (let index = 0; index < 205; index++)
      originalOutput.push(
        await f.store.appendExecutionOutput({
          expectedStoreId: f.expectedStoreId,
          owner: f.owner,
          executionId: job.executionId!,
          stream: index % 2 === 0 ? 'stdout' : 'stderr',
          content: `original output ${index} 🪁\n`,
        }),
      );
    await f.store.finishExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: job.executionId!,
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'original late Job completed' },
    });
    const child = await f.store.ensureOperation({
      ...operation,
      operationKey: 'child',
      request: { kind: 'agent', configurationId: 'child', input: { content: 'inspect' } },
      childConfiguration: { id: 'child', version: '1', snapshot: f.configuration },
    });
    await f.store.markDispatching({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: child.executionId!,
      authorization: {
        allowed: true,
        revision: 'fixture-child',
        definitionVersion: '1',
        inputDigest: await semanticDigest({ content: 'inspect' }),
      },
      requirements: [],
      freshness: { checked: true, source: f.source },
    });
    const activation = await f.store.activateChildRun({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: child.executionId!,
      configuration: f.configuration,
      requirementEvaluations: [],
      freshness: { checked: true, source: f.source },
    });
    for (let index = 0; index < 207; index++)
      await f.plan(`child-${300 - index}`, index % 2 === 0 ? 'model' : 'tool', {
        sessionId: child.childSessionId!,
        runId: activation.run.id,
        commandId: activation.command.id,
      });
    await f.store.finishExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'entry-299',
      status: 'failed',
      result: { code: 'fixture-cross-page-status' },
    });
    expect(await f.store.listExecutions('s', 1000)).toHaveLength(200);
    db = new Database(join(f.root, 'test', 'core.db'), { readonly: true });
    const rowids = (sessionId: string) =>
      (
        db!.query('SELECT id FROM execution WHERE session_id=? ORDER BY rowid').all(sessionId) as {
          id: string;
        }[]
      ).map((row) => row.id);
    const expected = rowids('s');
    let pages = 0;
    const calls: Parameters<Store['getSessionLogs']>[0][] = [];
    const directory = await readLiveExecutionDirectory(
      {
        getSessionLogs: async (input) => {
          calls.push(input);
          const page = await f.store.getSessionLogs(input);
          if (++pages === 1) {
            await f.store.finishExecution({
              expectedStoreId: f.expectedStoreId,
              owner: f.owner,
              executionId: 'entry-300',
              status: 'failed',
              result: { code: 'fixture-state-drift' },
            });
            await f.plan('after-fixed-watermark');
          }
          return page;
        },
        getExecution: (id) => f.store.getExecution(id),
      },
      f.observation,
    );
    expect(pages).toBeGreaterThan(1);
    expect(directory.executions.map((row) => row.id)).toEqual(expected);
    expect(new Set(directory.executions.map((row) => row.id)).size).toBe(expected.length);
    expect(directory.executions[0]!.status).toBe('failed');
    expect(directory.executions[0]!.result).toEqual({ code: 'fixture-state-drift' });
    expect(directory.executions.find((row) => row.id === 'entry-299')!.status).toBe('failed');
    expect(directory.executions.some((row) => row.id === job.executionId)).toBe(true);
    expect(directory.executions.findIndex((row) => row.id === job.executionId)).toBeGreaterThan(
      199,
    );
    const completedJobs = directory.executions.filter(
      (row) => row.kind === 'job' && row.status === 'succeeded',
    );
    expect(completedJobs.map((row) => row.id)).toEqual([job.executionId!]);
    const output = [];
    let afterSeq = '0';
    for (;;) {
      const page = await f.store.listExecutionOutput({
        executionId: completedJobs[0]!.id,
        afterSeq,
        limit: 200,
      });
      output.push(...page.items);
      if (!page.items.length || page.items.at(-1)!.seq === page.highWaterSeq) break;
      afterSeq = page.items.at(-1)!.seq;
    }
    expect(output).toEqual(originalOutput);
    expect(output).toHaveLength(205);
    expect(output.at(-1)).toMatchObject({
      executionId: job.executionId!,
      seq: '205',
      stream: 'stdout',
      content: 'original output 204 🪁\n',
    });
    expect(directory.executions.find((row) => row.id === child.executionId)?.childSessionId).toBe(
      child.childSessionId,
    );
    expect(directory.executions.some((row) => row.id === 'after-fixed-watermark')).toBe(false);
    expect(calls[0]!.upperCursor).toBeUndefined();
    expect(calls.slice(1).every((call) => call.upperCursor === directory.upperCursor)).toBe(true);
    const logPages = [];
    for await (const page of readLiveSessionLogPages(f.store, {
      ...f.observation,
      upperCursor: directory.upperCursor,
    }))
      logPages.push(page);
    expect(logPages.length).toBeGreaterThan(1);
    expect(logPages.flatMap((page) => page.entries).length).toBeGreaterThan(200);
    expect(logPages.every((page) => page.upperCursor === directory.upperCursor)).toBe(true);
    expect(logPages.at(-1)!.complete).toBe(true);
    expect(logPages.at(-1)!.nextAfterCursor).toBeNull();
    expect(
      logPages
        .flatMap((page) => page.entries)
        .some((entry) => entry.objectId === 'after-fixed-watermark'),
    ).toBe(false);
    const childDirectory = await readLiveExecutionDirectory(f.store, {
      ...f.observation,
      sessionId: child.childSessionId!,
    });
    expect(childDirectory.executions.map((row) => row.id)).toEqual(rowids(child.childSessionId!));
    expect(childDirectory.executions).toHaveLength(207);
    expect(childDirectory.executions.at(-1)!.id).toBe('child-94');
    const fresh = await readLiveExecutionDirectory(f.store, f.observation);
    expect(fresh.executions.at(-1)!.id).toBe('after-fixed-watermark');
  } finally {
    db?.close();
    await f.close();
  }
}, 30000);

test('live directory includes real action.planned Jobs and ignores policy-like noncreation logs', async () => {
  const f = await executionDirectoryFixture();
  try {
    await f.plan('tool');
    const page = await f.store.getSessionLogs({ ...f.observation, afterCursor: '0' });
    const creation = page.entries.find((entry) => entry.type === 'execution.planned')!;
    let executionReads = 0;
    const directory = await readLiveExecutionDirectory(
      {
        getSessionLogs: async () => ({
          ...page,
          upperCursor: String(BigInt(page.upperCursor) + 1n),
          snapshotCursor: String(BigInt(page.upperCursor) + 1n),
          entries: [
            ...page.entries,
            {
              ...creation,
              cursor: String(BigInt(page.upperCursor) + 1n),
              type: 'authorization.policy',
              objectId: 'policy-evidence-is-not-an-execution',
              details: { ...creation.details, executionId: 'tool' },
            },
          ],
        }),
        getExecution: async (id) => {
          executionReads++;
          return f.store.getExecution(id);
        },
      },
      f.observation,
    );
    expect(directory.executions.map((row) => row.id)).toEqual(['tool']);
    expect(executionReads).toBe(1);
    await f.store.createSession({
      expectedStoreId: f.expectedStoreId,
      sessionId: 'action-session',
      commandId: 'create-action-session',
      workspaceId: 'workspace',
      subjectId: 'owner',
      title: 'action',
    });
    await f.store.acceptCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 'action-session',
      subjectId: 'owner',
      commandId: 'action',
      request: {
        kind: 'extension.invoke',
        extensionId: 'owned',
        actionId: 'start',
        definitionVersion: '1',
        input: {},
      },
    });
    const owner = (await f.store.acquireSessionOwner('action-session', 'host'))!;
    await f.store.planAction({
      expectedStoreId: f.expectedStoreId,
      owner,
      commandId: 'action',
      executionId: 'action-job',
      extensionId: 'owned',
      definitionId: 'owned/start',
      definitionVersion: '1',
      input: {},
      decisionSource: {
        kind: 'action_decision',
        commandId: 'action',
        extensionId: 'owned',
        actionId: 'start',
        definitionVersion: '1',
        preparedDigest: await semanticDigest({}),
      },
    });
    const actions = await readLiveExecutionDirectory(f.store, {
      ...f.observation,
      sessionId: 'action-session',
    });
    expect(actions.executions.map((row) => [row.id, row.kind])).toEqual([['action-job', 'job']]);
  } finally {
    await f.close();
  }
});

test('live directory fails on missing originals, stalled pages or drifting watermarks and honors observation cancellation', async () => {
  const f = await executionDirectoryFixture();
  const failedMessage = async (operation: Promise<unknown>) => {
    let error: unknown;
    try {
      await operation;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  };
  try {
    await f.plan('original');
    const page = await f.store.getSessionLogs({ ...f.observation, afterCursor: '0' });
    expect(
      await failedMessage(
        readLiveExecutionDirectory(
          { getSessionLogs: async () => page, getExecution: async () => null },
          f.observation,
        ),
      ),
    ).toBe('live_execution_directory_original_missing:original');
    expect(
      await failedMessage(
        readLiveExecutionDirectory(
          {
            getSessionLogs: async () => ({ ...page, complete: false, nextAfterCursor: '0' }),
            getExecution: (id) => f.store.getExecution(id),
          },
          f.observation,
        ),
      ),
    ).toBe('live_execution_directory_cursor_stalled');
    const older = await readLiveExecutionDirectory(f.store, {
      ...f.observation,
      upperCursor: String(BigInt(page.upperCursor) - 1n),
    });
    expect(older.executions).toEqual([]);
    expect(
      await failedMessage(
        readLiveExecutionDirectory(
          { getSessionLogs: async () => page, getExecution: (id) => f.store.getExecution(id) },
          { ...f.observation, upperCursor: String(BigInt(page.upperCursor) - 1n) },
        ),
      ),
    ).toBe('live_execution_directory_snapshot_incomplete');
    const controller = new AbortController();
    let reads = 0;
    expect(
      await failedMessage(
        readLiveExecutionDirectory(
          {
            getSessionLogs: async (input) => {
              reads++;
              const result = await f.store.getSessionLogs(input);
              controller.abort(Error('owned-observation-cancelled'));
              return result;
            },
            getExecution: (id) => f.store.getExecution(id),
          },
          { ...f.observation, signal: controller.signal },
        ),
      ),
    ).toBe('owned-observation-cancelled');
    expect(reads).toBe(1);
    expect((await f.store.getExecution('original'))!.status).toBe('planned');
  } finally {
    await f.close();
  }
});

test('live reviewer budget is explicit, bounded and retains the historical semantic default', () => {
  expect(approvalReviewerTimeoutMs()).toBe(30000);
  expect(approvalReviewerTimeoutMs('3000')).toBe(3000);
  expect(approvalReviewerTimeoutMs('1')).toBe(1);
  for (const value of ['0', '30001', '-1', '3e3', '1.5', 'Infinity', ''])
    expect(() => approvalReviewerTimeoutMs(value)).toThrow();
});

test('risk oracle removes only known Shell display text and preserves original input', () => {
  const target = {
    kind: 'tool',
    definitionId: 'shell.execute',
    definitionVersion: '1',
    input: { command: 'printf description', description: 'display only', network: 'none' },
  };
  expect(expectedShellRiskOperationInput(target)).toEqual({
    command: 'printf description',
    network: 'none',
  });
  expect(target.input.description).toBe('display only');
  for (const changed of [{ kind: 'job' }, { definitionId: 'custom' }, { definitionVersion: '2' }])
    expect(expectedShellRiskOperationInput({ ...target, ...changed })).toEqual(target.input);
});

test('public model catalogue must expose the unified current Shell contract', () => {
  const tools = ['shell_execute', 'shell_read', 'shell_wait', 'shell_stop'].map((id) => ({
    id,
    inputSchema: {
      properties: Object.fromEntries(
        [
          'command',
          'description',
          'background',
          'execution_timeout_ms',
          'filesystem',
          'network',
        ].map((key) => [key, {}]),
      ),
      required: ['command'],
      additionalProperties: false,
    },
  }));
  expect(verifyUnifiedShellModelCatalogue(tools)).toBe(true);
  expect(verifyUnifiedShellModelCatalogue(tools, true)).toBe(true);
  expect(verifyUnifiedShellModelCatalogue([])).toBe(false);
  const readOnly = tools.filter((tool) => tool.id !== 'shell_stop');
  expect(verifyUnifiedShellModelCatalogue(readOnly)).toBe(true);
  expect(() => verifyUnifiedShellModelCatalogue(readOnly, true)).toThrow(
    'live_shell_root_catalogue_incomplete',
  );
  expect(verifyUnifiedShellModelCatalogue(tools.filter((tool) => tool.id === 'shell_read'))).toBe(
    true,
  );
  expect(() => verifyUnifiedShellModelCatalogue([tools[0]!, tools[0]!])).toThrow();
  expect(() => verifyUnifiedShellModelCatalogue([{ ...tools[0]!, id: 'shell.launch' }])).toThrow();
  expect(() => verifyUnifiedShellModelCatalogue([{ ...tools[0]!, id: 'shell_unknown' }])).toThrow();
  expect(() =>
    verifyUnifiedShellModelCatalogue([...tools, { ...tools[0]!, id: 'shell_launch' }]),
  ).toThrow();
  const leaked = structuredClone(tools);
  leaked[0]!.inputSchema.properties.key = {};
  expect(() => verifyUnifiedShellModelCatalogue(leaked)).toThrow();
});

function stopApprovalFixture() {
  const scope = {
    sessionId: 's',
    originStoreId: 'store',
    rootWorkCommandId: 'work',
    rootWorkSeq: '2',
  };
  const ref = {
    extensionId: 'builtin.shell',
    sessionId: 's',
    originStoreId: 'store',
    key: 'returned-handle',
    executionId: 'background-job',
    commandId: 'background-command',
  };
  const details = { accepted: true, shell_id: 'returned-handle', ref };
  const pending: Record<string, unknown> = {
    ...scope,
    id: 'stop',
    kind: 'tool',
    definitionId: 'shell.stop',
    definitionVersion: '1',
    input: { shellId: 'returned-handle', commandId: 'cancel-once' },
  };
  const records: Record<string, unknown>[] = [
    {
      ...scope,
      id: 'background-tool',
      kind: 'tool',
      definitionId: 'shell.execute',
      definitionVersion: '1',
      status: 'succeeded',
      input: { background: true },
      result: { content: JSON.stringify(details), details },
    },
    {
      ...scope,
      id: 'background-job',
      kind: 'job',
      definitionId: 'shell.command',
      definitionVersion: '1',
      originCommandId: 'background-command',
      parentExecutionId: 'background-tool',
      status: 'running',
    },
  ];
  return { pending, records };
}

test('lifecycle operator approves only the precise originally returned background handle', () => {
  const fixture = stopApprovalFixture();
  expect(lifecycleStopApprovalJobId(fixture.pending, fixture.records)).toBe('background-job');
  const mutations: ((fixture: ReturnType<typeof stopApprovalFixture>) => void)[] = [
    ({ pending }) => {
      pending.definitionId = 'shell.execute';
    },
    ({ pending }) => {
      pending.definitionVersion = '2';
    },
    ({ pending }) => {
      pending.input = { shellId: 'wrong-handle', commandId: 'cancel-once' };
    },
    ({ pending }) => {
      pending.sessionId = 'sibling';
    },
    ({ pending }) => {
      pending.originStoreId = 'foreign';
    },
    ({ pending }) => {
      pending.rootWorkCommandId = 'other-work';
    },
    ({ pending }) => {
      pending.rootWorkSeq = '3';
    },
    ({ records }) => {
      records[1]!.parentExecutionId = 'another-tool';
    },
    ({ records }) => {
      records[1]!.originCommandId = 'another-command';
    },
    ({ records }) => {
      records[1]!.definitionVersion = '2';
    },
    ({ records }) => {
      records[0]!.input = { background: false };
    },
    ({ records }) => {
      records[0]!.status = 'failed';
    },
    ({ records }) => {
      records[0]!.result = { content: '{}', details: {} };
    },
  ];
  for (const mutate of mutations) {
    const changed = stopApprovalFixture();
    mutate(changed);
    expect(lifecycleStopApprovalJobId(changed.pending, changed.records)).toBeUndefined();
  }
});

test('reading the validator script is not evidence that its failing branch ran', () => {
  const script =
    '#!/bin/sh\nif [ ! -f ready.flag ]; then\n  echo "INPUT_NOT_READY: prepare ready.flag" >&2\n  exit 17\nfi\n';
  expect(hasValidatorDiagnostic({ stdout: script, stderr: '' }, 'INPUT_NOT_READY')).toBe(false);
  expect(
    hasValidatorDiagnostic({ stdout: 'SNAPSHOT_MISSING\n', stderr: '' }, 'SNAPSHOT_MISSING'),
  ).toBe(false);
});

test('real stderr and redirected stdout diagnostics retain the original reason', () => {
  expect(
    hasValidatorDiagnostic(
      { stdout: '', stderr: 'INPUT_NOT_READY: prepare ready.flag\n' },
      'INPUT_NOT_READY',
    ),
  ).toBe(true);
  expect(
    hasValidatorDiagnostic(
      { stdout: 'SNAPSHOT_MISSING: use --source\r\n', stderr: '' },
      'SNAPSHOT_MISSING',
    ),
  ).toBe(true);
});

test('a successful outer command can still carry a real validator failure', () => {
  expect(
    hasValidatorDiagnostic(
      { stdout: 'validator_exit=17\n', stderr: 'INPUT_NOT_READY: prepare ready.flag\n' },
      'INPUT_NOT_READY',
    ),
  ).toBe(true);
  expect(
    hasValidatorDiagnostic({ stdout: 'VALIDATED:source-value\n', stderr: '' }, 'INPUT_NOT_READY'),
  ).toBe(false);
});

test('only the exact recorded reviewer timeout is an expected deadline abort', () => {
  const executions = [
    {
      id: 'tool',
      kind: 'tool',
      status: 'succeeded',
      authorization: { check: { executionId: 'review' } },
    },
    {
      id: 'review',
      kind: 'model',
      status: 'failed',
      parentExecutionId: 'tool',
      result: { code: 'authorization_check_timeout' },
    },
    { id: 'business', kind: 'model', status: 'failed', result: { code: 'model_failed' } },
    {
      id: 'unbound',
      kind: 'model',
      status: 'failed',
      parentExecutionId: 'tool',
      result: { code: 'authorization_check_timeout' },
    },
    {
      id: 'technical',
      kind: 'model',
      status: 'failed',
      parentExecutionId: 'tool',
      result: { code: 'MODEL_ATTEMPT_RETRYABLE_FAILURE:connection_failed' },
    },
  ];
  expect([...approvalTimeoutRequestIds(executions)]).toEqual(['review']);
  expect(approvalTimeoutRequestIds(executions.slice(1)).size).toBe(0);
});

function childTurns(): NaturalChildEvidence[] {
  const original: NaturalChildEvidence = {
    id: 'carrier-1',
    sessionId: 's',
    childSessionId: 'child',
    originCommandId: 'operation-1',
    status: 'succeeded',
    resultRevision: '1',
    reference: {
      commandId: 'child-start-carrier-1',
      runId: 'child-run-1',
      childSessionId: 'child',
    },
    parent: {
      id: 'spawn-tool',
      sessionId: 's',
      kind: 'tool',
      definitionId: 'task.spawn',
      input: {},
    },
    operation: { parentExecutionId: 'spawn-tool' },
    childRun: { id: 'child-run-1', sessionId: 'child', status: 'completed', isActive: false },
    acceptance: {
      resultRevision: '1',
      sourceId: 'result-1',
      sourceObserved: true,
      run: { id: 'root-run-1', sessionId: 's', status: 'completed', isActive: false },
    },
  };
  return [
    original,
    {
      ...structuredClone(original),
      id: 'carrier-2',
      originCommandId: 'operation-2',
      reference: {
        commandId: 'child-start-carrier-2',
        runId: 'child-run-2',
        childSessionId: 'child',
      },
      parent: {
        id: 'follow-up-tool',
        sessionId: 's',
        kind: 'tool',
        definitionId: 'task.follow_up',
        input: { agentId: 'child' },
      },
      operation: {
        parentExecutionId: 'follow-up-tool',
        followUp: {
          previousCommandId: 'operation-1',
          previousExecutionId: 'carrier-1',
          childSessionId: 'child',
          afterRunId: 'child-run-1',
        },
      },
      childRun: { id: 'child-run-2', sessionId: 'child', status: 'completed', isActive: false },
      acceptance: {
        resultRevision: '1',
        sourceId: 'result-2',
        sourceObserved: true,
        run: { id: 'root-run-2', sessionId: 's', status: 'completed', isActive: false },
      },
    },
  ];
}

test('one original collaborator can complete a follow-up with its own accepted result and root continuation', () => {
  const turns = childTurns();
  expect(naturalChildIdentity(turns.slice(0, 1))).toEqual({
    childSessionId: 'child',
    spawnExecutionId: 'carrier-1',
  });
  expect(naturalChildIdentity(turns)).toEqual({
    childSessionId: 'child',
    spawnExecutionId: 'carrier-1',
  });
  expect(naturalChildIdentity(turns.toReversed())).toEqual({
    childSessionId: 'child',
    spawnExecutionId: 'carrier-1',
  });
});

const invalidChildEvidence: [string, (turns: NaturalChildEvidence[]) => void][] = [
  [
    'second child identity',
    (turns) => {
      turns[1]!.childSessionId = 'another';
    },
  ],
  [
    'new spawn disguised as a continuation',
    (turns) => {
      turns[1]!.parent!.definitionId = 'task.spawn';
    },
  ],
  [
    'second original spawn in the same child',
    (turns) => {
      delete turns[1]!.operation.followUp;
    },
  ],
  [
    'unlinked previous carrier',
    (turns) => {
      turns[1]!.operation.followUp!.previousExecutionId = 'missing';
    },
  ],
  [
    'wrong previous command',
    (turns) => {
      turns[1]!.operation.followUp!.previousCommandId = 'other';
    },
  ],
  [
    'wrong previous child Run',
    (turns) => {
      turns[1]!.operation.followUp!.afterRunId = 'other';
    },
  ],
  [
    'follow-up aimed at another child',
    (turns) => {
      turns[1]!.parent!.input = { agentId: 'another' };
    },
  ],
  [
    'unknown carrier',
    (turns) => {
      turns[1]!.status = 'outcome_unknown';
    },
  ],
  [
    'running carrier',
    (turns) => {
      turns[1]!.status = 'running';
    },
  ],
  [
    'missing child Run',
    (turns) => {
      turns[1]!.childRun = null;
    },
  ],
  [
    'active child Run',
    (turns) => {
      turns[1]!.childRun!.isActive = true;
    },
  ],
  [
    'failed child Run',
    (turns) => {
      turns[1]!.childRun!.status = 'failed';
    },
  ],
  [
    'missing acceptance',
    (turns) => {
      turns[1]!.acceptance = null;
    },
  ],
  [
    'stale accepted revision',
    (turns) => {
      turns[1]!.acceptance!.resultRevision = '0';
    },
  ],
  [
    'result absent from its real parent Model',
    (turns) => {
      turns[1]!.acceptance!.sourceObserved = false;
    },
  ],
  [
    'active parent continuation',
    (turns) => {
      turns[1]!.acceptance!.run!.isActive = true;
    },
  ],
  [
    'failed parent continuation',
    (turns) => {
      turns[1]!.acceptance!.run!.status = 'failed';
    },
  ],
  [
    'parent continuation in another Session',
    (turns) => {
      turns[1]!.acceptance!.run!.sessionId = 'another';
    },
  ],
];
for (const [name, invalidate] of invalidChildEvidence)
  test(`natural collaborator oracle rejects ${name}`, () => {
    const turns = childTurns();
    invalidate(turns);
    expect(() => naturalChildIdentity(turns)).toThrow(
      'natural-child-original-and-successor-evidence',
    );
  });

test('natural collaborator oracle rejects no child, duplicate carriers, branching successors and cycles', () => {
  expect(() => naturalChildIdentity([])).toThrow();
  const turns = childTurns();
  expect(() => naturalChildIdentity([...turns, structuredClone(turns[1]!)])).toThrow();
  const branch = structuredClone(turns[1]!);
  branch.id = 'carrier-3';
  branch.reference.commandId = 'child-start-carrier-3';
  expect(() => naturalChildIdentity([...turns, branch])).toThrow();
  turns[1]!.operation.followUp!.previousExecutionId = turns[1]!.id;
  expect(() => naturalChildIdentity(turns)).toThrow();
});

test('refusal oracle separates prior unsupported Files entries from later refusal bypass attempts', () => {
  const failed = {
    id: 'before',
    definitionId: 'files.write',
    definitionVersion: '3',
    status: 'failed',
    authorization: { dispatched: false },
    result: {
      details: {
        code: 'permission_denied',
        reason: 'file_full_access_required',
        dispatchCommitted: false,
        adapterAttempted: false,
      },
    },
  };
  const denied = {
    ...failed,
    id: 'human-refusal',
    definitionId: 'shell.execute',
    definitionVersion: '1',
    result: { details: { code: 'approval_denied' } },
  };
  const after = { ...failed, id: 'after' };
  expect([...priorFilesScopeFailures([failed, denied, after], denied.id)]).toEqual(['before']);
  for (const changed of [
    { status: 'outcome_unknown' },
    { status: 'succeeded' },
    { authorization: { dispatched: true } },
    { authorization: undefined },
    { definitionId: 'files.read', definitionVersion: '5' },
    { definitionVersion: '4' },
    { result: { details: { ...failed.result.details, reason: 'file_path_protected' } } },
    { result: { details: { ...failed.result.details, adapterAttempted: true } } },
    { result: { details: { ...failed.result.details, dispatchCommitted: true } } },
    { result: { details: { ...failed.result.details, code: 'approval_denied' } } },
  ])
    expect(priorFilesScopeFailures([{ ...failed, ...changed }, denied], denied.id).size).toBe(0);
  expect(() => priorFilesScopeFailures([failed], 'missing')).toThrow(
    'natural-original-denied-tool-missing',
  );
});
