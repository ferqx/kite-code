import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import type {
  Json,
  PermissionControlRead,
  SessionExecutionRoot,
  Store,
} from '../../../src/storage';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';
import { boundWorktreeConfiguration } from '../../../src/storage/sqlite/worktree-authorization';

const original = { rootUri: 'file:///source', identity: { dev: '1', ino: '10' } };
const target = {
  rootUri: 'file:///linked',
  identity: { dev: '1', ino: '20' },
  requestedPath: '/linked',
};
async function rejected(promise: Promise<unknown>, code: string) {
  expect(await promise.catch((error) => error)).toMatchObject({ code });
}
async function fixture() {
  const directory = temporaryDirectory('kite-session-root-');
  const profile = { dataRoot: directory, profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: original.rootUri,
    name: 'source',
  });
  for (const sessionId of ['s', 'other'])
    await store.createSession({
      ...base,
      sessionId,
      commandId: `create-${sessionId}`,
      workspaceId: 'w',
      title: sessionId,
    });
  const owner = (await store.acquireSessionOwner('s', 'fixture'))!;
  const owned = { expectedStoreId, owner };
  await store.acceptCommand({
    ...base,
    commandId: 'start',
    request: { kind: 'run.start', content: 'use linked worktree' },
  });
  const run = await store.startRun({
    ...owned,
    commandId: 'start',
    configuration: {
      tools: [
        { id: 'git.worktree', version: '1', extensionId: 'builtin.shell' },
        { id: 'fixture/parent', version: '1', extensionId: 'fixture' },
      ],
      extensions: [{ id: 'builtin.shell', version: '1' }],
    },
  });
  const physical = new Database(join(directory, 'test/core.db'));
  async function planned(
    id: string,
    kind: 'model' | 'tool' | 'job',
    input: Json,
    source: Json = {},
    definitionId = 'fixture',
  ) {
    return store.planExecution({
      ...owned,
      executionId: id,
      sessionId: 's',
      runId: run.id,
      originCommandId: 'start',
      stepId: id.replace(/^(model-|tool-)/, ''),
      callId: id,
      kind,
      definitionId,
      definitionVersion: '1',
      input,
      decisionSource: source,
    });
  }
  async function dispatch(id: string, reads?: PermissionControlRead[]) {
    const execution = (await store.getExecution(id))!;
    return store.markDispatching({
      ...owned,
      executionId: id,
      authorization: {
        allowed: true,
        revision: 'test',
        definitionVersion: '1',
        inputDigest: await semanticDigest(execution.input),
        ...(reads ? { controlReads: reads } : {}),
      },
      requirements: [],
      freshness: { checked: true, source: execution.decisionSource },
    });
  }
  async function tool(name: string, action: 'use' | 'exit' = 'use', epoch = '0', batchSize = 1) {
    const input: Json = action === 'use' ? { action, path: target.requestedPath } : { action };
    const calls = [{ id: `tool-${name}`, name: 'git.worktree', arguments: JSON.stringify(input) }];
    const reads: PermissionControlRead[] = [
      { kind: 'session.execution_root', scope: 'session:s', revision: epoch },
    ];
    await planned(`model-${name}`, 'model', {});
    await dispatch(`model-${name}`, reads);
    await store.finishExecution({
      ...owned,
      executionId: `model-${name}`,
      status: 'succeeded',
      result: { content: '', toolCalls: calls },
    });
    await planned(
      `tool-${name}`,
      'tool',
      input,
      { kind: 'model_decision', modelExecutionId: `model-${name}`, toolBatchSize: batchSize },
      'git.worktree',
    );
    await dispatch(`tool-${name}`, reads);
    return {
      ...owned,
      sessionId: 's',
      executionId: `tool-${name}`,
      expectedEpoch: epoch,
      action,
      source: epoch === '0' ? original : { rootUri: target.rootUri, identity: target.identity },
      target: action === 'use' ? target : original,
    };
  }
  function terminal(
    executionId: string,
    binding: SessionExecutionRoot,
    action: 'use' | 'exit' = 'use',
  ) {
    return {
      ...owned,
      executionId,
      status: 'succeeded' as const,
      result: {
        outcome: 'succeeded',
        content: `execution root ${binding.epoch}`,
        details: { action, cwdChanged: true, executionRoot: binding },
      } as unknown as Json,
    };
  }
  return {
    store,
    profile,
    physical,
    expectedStoreId,
    base,
    owned,
    run,
    planned,
    dispatch,
    tool,
    terminal,
    async close() {
      physical.close(true);
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('old Sessions default to their Workspace with read-only epoch-zero queries', async () => {
  const f = await fixture();
  let cold: Store | undefined;
  try {
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const expected = {
      sessionId: 's',
      workspaceId: 'w',
      effectiveRootUri: original.rootUri,
      epoch: '0',
      identity: null,
    };
    expect(await f.store.getSessionExecutionRoot({ sessionId: 's' })).toEqual(expected);
    expect(await f.store.getSessionExecutionRoot({ sessionId: 's', epoch: '0' })).toEqual(expected);
    await rejected(
      f.store.getSessionExecutionRoot({ sessionId: 's', epoch: '1' }),
      'execution_root_epoch_unavailable',
    );
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    expect(await cold.getSessionExecutionRoot({ sessionId: 's' })).toEqual(expected);
    expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await cold?.close();
    await f.close();
  }
});

test('prepare alone grants nothing; successful Tool publication atomically switches only its Session and exit retains history', async () => {
  const f = await fixture();
  try {
    const intent = await f.tool('use');
    const next = await f.store.prepareSessionExecutionRoot(intent);
    expect(next).toMatchObject({
      epoch: '1',
      effectiveRootUri: target.rootUri,
      activationExecutionId: intent.executionId,
    });
    expect(await f.store.prepareSessionExecutionRoot(intent)).toEqual(next);
    expect((await f.store.getSessionExecutionRoot({ sessionId: 's' })).epoch).toBe('0');
    expect(
      (await f.store.listSessionExecutionRoots({ expectedStoreId: f.expectedStoreId })).roots,
    ).toContainEqual(next);
    expect(
      await f.store.getSessionExecutionRootPreparation({
        sessionId: 's',
        executionId: intent.executionId,
      }),
    ).toEqual({
      state: 'prepared',
      binding: next,
    });
    const finish = f.terminal(intent.executionId, next);
    await f.store.finishExecution(finish);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await f.store.finishExecution(finish);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(await f.store.getSessionExecutionRoot({ sessionId: 's' })).toEqual(next);
    expect(await f.store.getSessionExecutionRoot({ sessionId: 's', epoch: '0' })).toMatchObject({
      effectiveRootUri: original.rootUri,
      identity: original.identity,
    });
    expect((await f.store.getSessionExecutionRoot({ sessionId: 'other' })).effectiveRootUri).toBe(
      original.rootUri,
    );
    expect((await f.store.getWorkspace('w'))?.rootUri).toBe(original.rootUri);
    const exit = await f.tool('exit', 'exit', '1');
    const restored = await f.store.prepareSessionExecutionRoot(exit);
    await f.store.finishExecution(f.terminal(exit.executionId, restored, 'exit'));
    expect(await f.store.getSessionExecutionRoot({ sessionId: 's' })).toMatchObject({
      epoch: '2',
      effectiveRootUri: original.rootUri,
    });
    expect(await f.store.getSessionExecutionRoot({ sessionId: 's', epoch: '1' })).toEqual(next);
    expect(
      await f.store.getSessionExecutionRootPreparation({
        sessionId: 's',
        executionId: intent.executionId,
      }),
    ).toEqual({ state: 'committed', binding: next });
  } finally {
    await f.close();
  }
});

test('a terminal write fault rolls back binding, epoch, receipt and event together; retry publishes once', async () => {
  const f = await fixture();
  try {
    const intent = await f.tool('fault');
    const next = await f.store.prepareSessionExecutionRoot(intent);
    f.physical.run(
      "CREATE TRIGGER root_fault BEFORE UPDATE ON execution WHEN new.id='tool-fault' AND new.state='succeeded' BEGIN SELECT RAISE(ABORT,'injected_root_fault'); END",
    );
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const fault = await f.store
      .finishExecution(f.terminal(intent.executionId, next))
      .catch((error) => error);
    expect(fault.message).toContain('injected_root_fault');
    expect((await f.store.getSessionExecutionRoot({ sessionId: 's' })).epoch).toBe('0');
    expect(
      (
        await f.store.getSessionExecutionRootPreparation({
          sessionId: 's',
          executionId: intent.executionId,
        })
      )?.state,
    ).toBe('prepared');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    f.physical.run('DROP TRIGGER root_fault');
    await Promise.all([
      f.store.finishExecution(f.terminal(intent.executionId, next)),
      f.store.finishExecution(f.terminal(intent.executionId, next)),
    ]);
    expect((await f.store.getSessionExecutionRoot({ sessionId: 's' })).epoch).toBe('1');
  } finally {
    await f.close();
  }
});

test('failed, cancelled and unknown Tools cannot publish a prepared root', async () => {
  for (const status of ['failed', 'cancelled', 'outcome_unknown'] as const) {
    const f = await fixture();
    try {
      const intent = await f.tool(status);
      await f.store.prepareSessionExecutionRoot(intent);
      await f.store.finishExecution({
        ...f.owned,
        executionId: intent.executionId,
        status,
        result: { outcome: status, content: status },
      });
      expect((await f.store.getSessionExecutionRoot({ sessionId: 's' })).epoch).toBe('0');
    } finally {
      await f.close();
    }
  }
});

test('late cancellation fences the terminal publication and a stale owner cannot prepare', async () => {
  const f = await fixture();
  try {
    const intent = await f.tool('cancel');
    await rejected(
      f.store.prepareSessionExecutionRoot({
        ...intent,
        owner: { ...intent.owner, generation: '999' },
      }),
      'owner_changed',
    );
    const next = await f.store.prepareSessionExecutionRoot(intent);
    await f.store.cancelCommand({ ...f.base, commandId: 'stop', targetCommandId: 'start' });
    await rejected(
      f.store.finishExecution(f.terminal(intent.executionId, next)),
      'cancelled_before_dispatch',
    );
    expect((await f.store.getSessionExecutionRoot({ sessionId: 's' })).epoch).toBe('0');
  } finally {
    await f.close();
  }
});

test('single-call provenance, exact request path, epoch and original exit target are checked', async () => {
  const f = await fixture();
  try {
    const intent = await f.tool('batch', 'use', '0', 2);
    await rejected(f.store.prepareSessionExecutionRoot(intent), 'execution_root_source_invalid');
    await f.store.finishExecution({
      ...f.owned,
      executionId: intent.executionId,
      status: 'failed',
      result: {},
    });
    const multiple = await f.tool('multiple-calls');
    f.physical.run(
      "UPDATE execution SET result_json=json_set(result_json,'$.toolCalls[#]',json(?)) WHERE id='model-multiple-calls'",
      [JSON.stringify({ id: 'another', name: 'git.worktree', arguments: '{}' })],
    );
    await rejected(f.store.prepareSessionExecutionRoot(multiple), 'execution_root_batch_invalid');
    await f.store.finishExecution({
      ...f.owned,
      executionId: multiple.executionId,
      status: 'failed',
      result: {},
    });
    const valid = await f.tool('valid');
    await rejected(
      f.store.prepareSessionExecutionRoot({ ...valid, expectedEpoch: '1' }),
      'execution_root_conflict',
    );
    await rejected(
      f.store.prepareSessionExecutionRoot({
        ...valid,
        target: { ...target, requestedPath: '/unrequested' },
      }),
      'execution_root_target_invalid',
    );
    const next = await f.store.prepareSessionExecutionRoot(valid);
    await rejected(
      f.store.prepareSessionExecutionRoot({
        ...valid,
        target: { ...target, rootUri: 'file:///different' },
      }),
      'execution_root_conflict',
    );
    await rejected(
      f.store.finishExecution(f.terminal(valid.executionId, { ...next, epoch: '99' })),
      'execution_root_result_invalid',
    );
    expect((await f.store.getSessionExecutionRoot({ sessionId: 's' })).epoch).toBe('0');
    await f.store.finishExecution(f.terminal(valid.executionId, next));
    const exit = await f.tool('wrong-exit', 'exit', '1');
    await rejected(
      f.store.prepareSessionExecutionRoot({
        ...exit,
        target: { rootUri: target.rootUri, identity: target.identity },
      }),
      'execution_root_target_invalid',
    );
  } finally {
    await f.close();
  }
});

test('unsettled same-Session Tools block switching; already dispatched Jobs keep their original execution', async () => {
  const f = await fixture();
  try {
    const intent = await f.tool('frontier');
    await f.planned('sibling', 'tool', {});
    await rejected(f.store.prepareSessionExecutionRoot(intent), 'execution_root_busy');
    await f.store.finishExecution({
      ...f.owned,
      executionId: 'sibling',
      status: 'cancelled',
      result: {},
    });
    await f.planned('background', 'tool', { originalRoot: original.rootUri });
    await f.dispatch('background');
    // Seed an already dispatched historical Job. Native process lifetime is tested by Shell.
    f.physical.run(
      "UPDATE execution SET kind='job',state='running',reference_json='{}' WHERE id='background'",
    );
    const job = await f.store.getExecution('background');
    const next = await f.store.prepareSessionExecutionRoot(intent);
    await f.store.finishExecution(f.terminal(intent.executionId, next));
    expect(await f.store.getExecution('background')).toEqual(job);
  } finally {
    await f.close();
  }
});

test('new dispatch cannot reuse an old root approval, omit the fence or borrow another Session epoch', async () => {
  const f = await fixture();
  try {
    const intent = await f.tool('switch');
    const next = await f.store.prepareSessionExecutionRoot(intent);
    await f.store.finishExecution(f.terminal(intent.executionId, next));
    await f.planned('after', 'tool', {});
    await rejected(f.dispatch('after'), 'execution_root_read_required');
    await rejected(
      f.dispatch('after', [{ kind: 'session.execution_root', scope: 'session:s', revision: '0' }]),
      'permission_control_changed',
    );
    await rejected(
      f.dispatch('after', [
        { kind: 'session.execution_root', scope: 'session:other', revision: '1' },
      ]),
      'execution_root_read_required',
    );
    await f.dispatch('after', [
      { kind: 'session.execution_root', scope: 'session:s', revision: '1' },
    ]);
  } finally {
    await f.close();
  }
});

test('cold readers distinguish preparation from a committed receipt and retain exact historical epochs', async () => {
  const f = await fixture();
  try {
    const intent = await f.tool('durable');
    const next = await f.store.prepareSessionExecutionRoot(intent);
    const key = { sessionId: 's', executionId: intent.executionId };
    let reader = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect(await reader.getSessionExecutionRootPreparation(key)).toEqual({
        state: 'prepared',
        binding: next,
      });
      expect((await reader.getSessionExecutionRoot({ sessionId: 's' })).epoch).toBe('0');
    } finally {
      await reader.close();
    }
    await f.store.finishExecution(f.terminal(intent.executionId, next));
    reader = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect(await reader.getSessionExecutionRootPreparation(key)).toEqual({
        state: 'committed',
        binding: next,
      });
      expect(await reader.getSessionExecutionRoot({ sessionId: 's' })).toEqual(next);
      expect(
        (await reader.getSessionExecutionRoot({ sessionId: 's', epoch: '0' })).identity,
      ).toEqual(original.identity);
    } finally {
      await reader.close();
    }
  } finally {
    await f.close();
  }
});

test('occupancy is one complete bounded snapshot including original roots of unsettled Jobs after exit', async () => {
  const f = await fixture();
  try {
    const intent = await f.tool('occupied');
    const next = await f.store.prepareSessionExecutionRoot(intent);
    await f.store.finishExecution(f.terminal(intent.executionId, next));
    await f.planned('old-job', 'tool', {}, { executionRoot: next } as unknown as Json);
    await f.dispatch('old-job', [
      { kind: 'session.execution_root', scope: 'session:s', revision: '1' },
    ]);
    f.physical.run(
      "UPDATE execution SET kind='job',state='running',reference_json='{}' WHERE id='old-job'",
    );
    const exit = await f.tool('inventory-exit', 'exit', '1');
    const restored = await f.store.prepareSessionExecutionRoot(exit);
    await f.store.finishExecution(f.terminal(exit.executionId, restored, 'exit'));
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const listed = await f.store.listSessionExecutionRoots({ expectedStoreId: f.expectedStoreId });
    expect(listed.snapshotCursor).toBe(cursor);
    expect(listed.roots).toContainEqual(next);
    expect(listed.roots).toContainEqual(restored);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    await rejected(
      f.store.listSessionExecutionRoots({ expectedStoreId: 'wrong-store' }),
      'store_identity_mismatch',
    );
    f.physical.run(
      "UPDATE execution SET decision_source_json=json_set(decision_source_json,'$.executionRoot.epoch','77') WHERE id='old-job'",
    );
    await rejected(
      f.store.listSessionExecutionRoots({ expectedStoreId: f.expectedStoreId }),
      'execution_root_epoch_unavailable',
    );
    f.physical.run("UPDATE execution SET state='failed' WHERE id='old-job'");
    f.physical.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10001)
      INSERT INTO session(id,workspace_id,root_id,title,context_selection_id)
      SELECT 'bounded-'||i,'w','bounded-'||i,'bounded','selection-'||i FROM n`);
    await rejected(
      f.store.listSessionExecutionRoots({ expectedStoreId: f.expectedStoreId }),
      'execution_root_inventory_limit',
    );
  } finally {
    await f.close();
  }
});

test('new child starts at its parent dispatch root and stays independent when the parent exits', async () => {
  const f = await fixture();
  try {
    const intent = await f.tool('before-child');
    const next = await f.store.prepareSessionExecutionRoot(intent);
    await f.store.finishExecution(f.terminal(intent.executionId, next));
    await f.planned(
      'parent',
      'tool',
      {},
      { executionRoot: next } as unknown as Json,
      'fixture/parent',
    );
    await f.dispatch('parent', [
      { kind: 'session.execution_root', scope: 'session:s', revision: '1' },
    ]);
    const child = await f.store.ensureOperation({
      ...f.owned,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'start',
      parentExecutionId: 'parent',
      operationKey: 'child',
      request: { kind: 'agent', configurationId: 'reviewer', input: { task: 'review' } },
      childConfiguration: { id: 'reviewer', version: '1', snapshot: { modelId: 'fixed' } },
    });
    const inherited = await f.store.getSessionExecutionRoot({ sessionId: child.childSessionId! });
    expect(inherited).toEqual({
      sessionId: child.childSessionId!,
      workspaceId: 'w',
      effectiveRootUri: target.rootUri,
      epoch: '0',
      identity: target.identity,
    });
    expect((await f.store.getSession(child.childSessionId!))?.parentSessionId).toBe('s');
    await f.store.finishExecution({
      ...f.owned,
      executionId: child.executionId!,
      status: 'cancelled',
      result: {},
    });
    await f.store.finishExecution({
      ...f.owned,
      executionId: 'parent',
      status: 'failed',
      result: {},
    });
    const exit = await f.tool('parent-exit', 'exit', '1');
    const restored = await f.store.prepareSessionExecutionRoot(exit);
    await f.store.finishExecution(f.terminal(exit.executionId, restored, 'exit'));
    expect(await f.store.getSessionExecutionRoot({ sessionId: child.childSessionId! })).toEqual(
      inherited,
    );
  } finally {
    await f.close();
  }
});

test('Fork inherits the source effective root as its own epoch zero without source activation authority', async () => {
  const f = await fixture();
  try {
    const intent = await f.tool('before-fork');
    const next = await f.store.prepareSessionExecutionRoot(intent);
    await f.store.finishExecution(f.terminal(intent.executionId, next));
    await f.store.finishRun({ ...f.owned, runId: f.run.id, status: 'completed', requirements: [] });
    const source = (await f.store.getSession('s'))!;
    const input = {
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: 'fork',
      sourceSessionId: 's',
      expectedContextSelectionId: source.contextSelectionId,
      newSessionId: 'forked',
      title: 'forked',
      boundary: null,
    };
    const fork = await f.store.forkSession(input);
    expect(fork.session.workspaceId).toBe('w');
    expect(fork.session.parentSessionId).toBeNull();
    const inherited = {
      sessionId: 'forked',
      workspaceId: 'w',
      effectiveRootUri: target.rootUri,
      epoch: '0',
      identity: target.identity,
    };
    expect(await f.store.getSessionExecutionRoot({ sessionId: 'forked' })).toEqual(inherited);
    expect(
      await f.store.getSessionExecutionRootPreparation({
        sessionId: 'forked',
        executionId: intent.executionId,
      }),
    ).toBeNull();
    await f.store.forkSession(input);
    expect(await f.store.getSessionExecutionRoot({ sessionId: 'forked' })).toEqual(inherited);
  } finally {
    await f.close();
  }
});

test('worktree child authorization uses its original host-sealed Step cwd, not stale Run cwd or Tool input', async () => {
  const f = await fixture();
  try {
    const intent = await f.tool('root-for-create');
    const next = await f.store.prepareSessionExecutionRoot(intent);
    await f.store.finishExecution(f.terminal(intent.executionId, next));
    const later = await f.tool('later-worktree', 'exit', '1');
    const originalConfiguration = {
      sourceCwd: '/source',
      identity: 'original',
      defaultRoot: '/default',
      git: { path: '/git', sha256: 'fixed' },
    };
    const originalCapture = {
      configuration: originalConfiguration,
      assets: [{ path: '/worker', digest: 'fixed' }],
    };
    const run = {
      snapshot: { shell: { cwd: '/source', assets: { gitWorktree: originalCapture } } },
    };
    const configuration = { ...originalConfiguration, sourceCwd: '/linked', identity: 'rebound' };
    const modelSource = {
      executionRoot: next,
      capabilitySnapshot: {
        executionRoot: next,
        shell: { cwd: '/linked', assets: { gitWorktree: { ...originalCapture, configuration } } },
      },
    };
    const source = {
      kind: 'model_decision',
      modelExecutionId: 'model-later-worktree',
      toolBatchSize: 1,
      executionRoot: next,
    };
    f.physical.run('UPDATE execution SET decision_source_json=? WHERE id=?', [
      JSON.stringify(source),
      later.executionId,
    ]);
    f.physical.run('UPDATE execution SET decision_source_json=? WHERE id=?', [
      JSON.stringify(modelSource),
      'model-later-worktree',
    ]);
    const db = new SqliteOperations(f.physical, true);
    const parent = () => db.row('SELECT * FROM execution WHERE id=?', later.executionId)!;
    expect(boundWorktreeConfiguration(db, parent(), run)).toEqual(configuration);
    expect(originalConfiguration.sourceCwd).toBe('/source');
    const corruptions = [
      { ...modelSource, executionRoot: { ...next, epoch: '0' } },
      {
        ...modelSource,
        capabilitySnapshot: {
          ...modelSource.capabilitySnapshot,
          executionRoot: { ...next, sessionId: 'other' },
        },
      },
      {
        ...modelSource,
        capabilitySnapshot: {
          ...modelSource.capabilitySnapshot,
          shell: { ...modelSource.capabilitySnapshot.shell, cwd: '/unsealed' },
        },
      },
      {
        ...modelSource,
        capabilitySnapshot: {
          ...modelSource.capabilitySnapshot,
          shell: {
            cwd: '/linked',
            assets: {
              gitWorktree: {
                ...originalCapture,
                configuration: { ...configuration, git: { path: '/other', sha256: 'changed' } },
              },
            },
          },
        },
      },
    ];
    for (const corruption of corruptions) {
      f.physical.run('UPDATE execution SET decision_source_json=? WHERE id=?', [
        JSON.stringify(corruption),
        'model-later-worktree',
      ]);
      expect(() => boundWorktreeConfiguration(db, parent(), run)).toThrow(
        'worktree_authorization_changed',
      );
    }
    f.physical.run('UPDATE execution SET decision_source_json=? WHERE id=?', [
      JSON.stringify(modelSource),
      'model-later-worktree',
    ]);
    f.physical.run(
      "UPDATE execution SET dispatch_authorization_json=json_set(dispatch_authorization_json,'$.controlReads[0].revision','0') WHERE id=?",
      [later.executionId],
    );
    expect(() => boundWorktreeConfiguration(db, parent(), run)).toThrow(
      'worktree_authorization_changed',
    );
  } finally {
    await f.close();
  }
});

test('an already planned destructive Tool fences a new root reservation across Sessions', async () => {
  const f = await fixture();
  try {
    const intent = await f.tool('removal-race');
    await f.planned(
      'remove-other',
      'tool',
      { action: 'remove', path: '/linked' },
      {},
      'git.worktree',
    );
    // The census is global and conservative even before a remove has a resolved physical plan.
    f.physical.run("UPDATE execution SET session_id='other' WHERE id='remove-other'");
    await rejected(f.store.prepareSessionExecutionRoot(intent), 'execution_root_remove_pending');
    expect(
      await f.store.getSessionExecutionRootPreparation({
        sessionId: 's',
        executionId: intent.executionId,
      }),
    ).toBeNull();
    f.physical.run("UPDATE execution SET state='failed' WHERE id='remove-other'");
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const next = await f.store.prepareSessionExecutionRoot(intent);
    const preparedCursor = (await f.store.getMetadata()).lastChangeCursor;
    expect(BigInt(preparedCursor) > BigInt(cursor)).toBe(true);
    expect(
      (await f.store.listSessionExecutionRoots({ expectedStoreId: f.expectedStoreId })).roots,
    ).toContainEqual(next);
    await f.store.prepareSessionExecutionRoot(intent);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(preparedCursor);
    await f.store.finishExecution({
      ...f.owned,
      executionId: intent.executionId,
      status: 'cancelled',
      result: {},
    });
    expect(
      (await f.store.listSessionExecutionRoots({ expectedStoreId: f.expectedStoreId })).roots.some(
        (root) => root.epoch === '1',
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});
