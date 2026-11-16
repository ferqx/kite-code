import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { createArtifactStore } from '../../../src/artifacts';
import { canonicalJson, semanticDigest } from '../../../src/json';
import { ModelOutputWriter } from '../../../src/model-output';
import { openSqliteStore } from '../../../src/sqlite';
import { verifyAuthorizationBehaviorBinding } from '../../../src/storage/sqlite/authorization-check';
import { executionBehaviorManifest } from '../../../src/storage/sqlite/execution-behavior-manifest';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';
import type { Json } from '../../../src/storage/types';

const old = {
  capability: { kind: 'tool' as const, definitionId: 'fixture/effect', definitionVersion: '1' },
  contractRef: 'fixture.review',
  configurationDigest: 'a'.repeat(64),
};
const selected = { ...old, configurationDigest: 'b'.repeat(64) };
const selectedJob = {
  ...selected,
  capability: { kind: 'job' as const, definitionId: 'fixture/job', definitionVersion: '1' },
};
async function fixture() {
  const directory = temporaryDirectory('kite-step-behavior-');
  const store = await openSqliteStore({ dataRoot: directory, profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: 'file:///fixture',
    name: 'fixture',
  });
  await store.createSession({ ...base, workspaceId: 'w', commandId: 'create', title: 'fixture' });
  await store.acceptCommand({
    ...base,
    commandId: 'work',
    request: { kind: 'run.start', content: 'two different Steps' },
  });
  const owner = (await store.acquireSessionOwner('s', 'fixture'))!;
  const owned = { expectedStoreId, owner };
  const run = await store.startRun({
    ...owned,
    commandId: 'work',
    configuration: {
      toolBehaviors: [old],
      tools: [{ id: 'fixture/effect', version: '1', extensionId: 'fixture' }],
    },
  });
  const executionRoot = {
    sessionId: 's',
    workspaceId: 'w',
    effectiveRootUri: 'file:///fixture',
    epoch: '0',
    identity: null,
  };
  const modelSource = {
    kind: 'model_request',
    toolBehaviorBindings: [selected, selectedJob],
    executionRoot,
    capabilitySnapshot: { executionRoot },
  };
  const source = { kind: 'model_decision', modelExecutionId: 'model', executionRoot };
  const input = { text: 'original' };
  const modelResult = {
    content: '',
    toolCalls: [{ id: 'call', name: 'fixture/effect', arguments: JSON.stringify(input) }],
  };
  async function plan(id: string, kind: 'tool' | 'model', value: Json, decisionSource: Json) {
    return store.planExecution({
      ...owned,
      executionId: id,
      sessionId: 's',
      runId: run.id,
      originCommandId: 'work',
      stepId: 'step',
      callId: kind === 'tool' ? 'call' : id,
      kind,
      definitionId: kind === 'tool' ? 'fixture/effect' : 'fixed',
      definitionVersion: '1',
      input: value,
      decisionSource,
    });
  }
  async function dispatch(executionId: string) {
    const execution = (await store.getExecution(executionId))!;
    return store.markDispatching({
      ...owned,
      executionId,
      authorization: {
        allowed: true,
        revision: 'fixture',
        definitionVersion: '1',
        inputDigest: await semanticDigest(execution.input),
      },
      requirements: [],
      freshness: { checked: true, source: execution.decisionSource },
    });
  }
  await plan('model', 'model', {}, modelSource as unknown as Json);
  await dispatch('model');
  await store.finishExecution({
    ...owned,
    executionId: 'model',
    status: 'succeeded',
    result: modelResult,
  });
  await plan('target', 'tool', input, source as unknown as Json);
  const physical = new Database(join(directory, 'test/core.db'));
  const db = new SqliteOperations(physical, true);
  const target = () => db.row('SELECT * FROM execution WHERE id=?', 'target')!;
  const saveModelSource = (value: unknown) =>
    physical.run("UPDATE execution SET decision_source_json=? WHERE id='model'", [
      JSON.stringify(value),
    ]);
  return {
    profile: { dataRoot: directory, profile: 'test' },
    store,
    owned,
    run,
    db,
    physical,
    target,
    saveModelSource,
    modelSource,
    modelResult,
    source,
    input,
    dispatch,
    async close() {
      physical.close(true);
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('new Step binding replaces only its original Model manifest; empty and malformed selections never fall back', async () => {
  const f = await fixture();
  try {
    expect(executionBehaviorManifest(f.db, f.target()).bindings).toEqual([selected, selectedJob]);
    verifyAuthorizationBehaviorBinding(f.db, f.target(), selected, {});
    expect(() => verifyAuthorizationBehaviorBinding(f.db, f.target(), old, {})).toThrow(
      'authorization_check_binding_invalid',
    );
    f.saveModelSource({ ...f.modelSource, toolBehaviorBindings: [] });
    expect(executionBehaviorManifest(f.db, f.target()).bindings).toEqual([]);
    expect(() => verifyAuthorizationBehaviorBinding(f.db, f.target(), old, {})).toThrow(
      'authorization_check_binding_invalid',
    );
    for (const invalid of [
      null,
      {},
      [selected, selected],
      [{ ...selected, configurationDigest: 'not-a-digest' }],
    ]) {
      f.saveModelSource({ ...f.modelSource, toolBehaviorBindings: invalid });
      expect(() => executionBehaviorManifest(f.db, f.target())).toThrow(
        'execution_behavior_source_invalid',
      );
    }
    const { toolBehaviorBindings: _bindings, ...rootWithoutBindings } = f.modelSource;
    f.saveModelSource(rootWithoutBindings);
    expect(() => executionBehaviorManifest(f.db, f.target())).toThrow(
      'execution_behavior_source_invalid',
    );
    f.saveModelSource({ kind: 'model_request' });
    f.physical.run("UPDATE execution SET decision_source_json=? WHERE id='target'", [
      JSON.stringify({ kind: 'model_decision', modelExecutionId: 'model' }),
    ]);
    expect(executionBehaviorManifest(f.db, f.target()).bindings).toEqual([old]);
    verifyAuthorizationBehaviorBinding(f.db, f.target(), old, {});
  } finally {
    await f.close();
  }
});

test('a caller cannot borrow a different Model scope, stale root, fake body or a different actual ToolCall', async () => {
  const f = await fixture();
  try {
    for (const source of [
      { kind: 'model_decision', executionRoot: f.source.executionRoot },
      { ...f.source, modelExecutionId: 'missing-model' },
    ]) {
      f.physical.run("UPDATE execution SET decision_source_json=? WHERE id='target'", [
        JSON.stringify(source),
      ]);
      expect(() => executionBehaviorManifest(f.db, f.target())).toThrow(
        'execution_behavior_source_invalid',
      );
      expect(() => verifyAuthorizationBehaviorBinding(f.db, f.target(), selected, {})).toThrow(
        'authorization_check_binding_invalid',
      );
    }
    f.physical.run("UPDATE execution SET decision_source_json=? WHERE id='target'", [
      JSON.stringify(f.source),
    ]);
    for (const [column, value] of [
      ['session_id', 'other'],
      ['run_id', 'another'],
      ['origin_store_id', 'foreign'],
      ['root_work_command_id', 'other'],
      ['root_work_seq', 999],
      ['state', 'running'],
    ] as const) {
      const before = f.db.row('SELECT * FROM execution WHERE id=?', 'model')!;
      f.physical.run(`UPDATE execution SET ${column}=? WHERE id='model'`, [value]);
      expect(() => executionBehaviorManifest(f.db, f.target())).toThrow(
        'execution_behavior_source_invalid',
      );
      f.physical.run(`UPDATE execution SET ${column}=? WHERE id='model'`, [before[column]!]);
    }
    const forgedSource = {
      ...f.modelSource,
      executionRoot: { ...f.modelSource.executionRoot, epoch: '1' },
    };
    f.saveModelSource(forgedSource);
    expect(() => executionBehaviorManifest(f.db, f.target())).toThrow(
      'execution_behavior_source_invalid',
    );
    f.saveModelSource({
      ...f.modelSource,
      capabilitySnapshot: { executionRoot: { ...f.modelSource.executionRoot, epoch: '1' } },
    });
    expect(() => executionBehaviorManifest(f.db, f.target())).toThrow(
      'execution_behavior_source_invalid',
    );
    f.saveModelSource({
      ...f.modelSource,
      sourceBody: { kind: 'model_body', version: 1, reference: {} },
    });
    expect(() => executionBehaviorManifest(f.db, f.target())).toThrow('model_body_invalid');
    f.saveModelSource(f.modelSource);
    for (const patch of [
      { id: 'different' },
      { name: 'different' },
      { arguments: '{"text":"changed"}' },
    ]) {
      f.physical.run("UPDATE execution SET result_json=? WHERE id='model'", [
        JSON.stringify({
          ...f.modelResult,
          toolCalls: [{ ...f.modelResult.toolCalls[0], ...patch }],
        }),
      ]);
      expect(() => executionBehaviorManifest(f.db, f.target())).toThrow(
        'execution_behavior_source_invalid',
      );
    }
  } finally {
    await f.close();
  }
});

test('a nested Job uses its genuine original Tool Model and rejects crossed or rewritten operation edges', async () => {
  const f = await fixture();
  try {
    await f.dispatch('target');
    const job = await f.store.ensureOperation({
      ...f.owned,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      parentExecutionId: 'target',
      operationKey: 'job',
      request: {
        kind: 'job',
        definitionId: 'fixture/job',
        definitionVersion: '1',
        input: { value: 1 },
      },
    });
    const row = () => f.db.row('SELECT * FROM execution WHERE id=?', job.executionId!)!;
    verifyAuthorizationBehaviorBinding(f.db, row(), selectedJob, {});
    expect(executionBehaviorManifest(f.db, row()).bindings).toEqual([selected, selectedJob]);
    const command = f.db.row('SELECT * FROM command WHERE id=?', job.commandId)!;
    f.physical.run(
      "UPDATE command SET request_json=json_set(request_json,'$.input.value',2) WHERE id=?",
      [job.commandId],
    );
    expect(() => executionBehaviorManifest(f.db, row())).toThrow(
      'execution_behavior_source_invalid',
    );
    f.physical.run('UPDATE command SET request_json=? WHERE id=?', [
      command.request_json!,
      job.commandId,
    ]);
    f.physical.run('UPDATE execution SET parent_execution_id=id WHERE id=?', [job.executionId!]);
    expect(() => executionBehaviorManifest(f.db, row())).toThrow(
      'execution_behavior_source_invalid',
    );
  } finally {
    await f.close();
  }
});

test('artifact output uses the original Model terminal call manifest and validates the source body envelope', async () => {
  const f = await fixture();
  const artifacts = createArtifactStore({ profile: f.profile, store: f.store });
  try {
    let sequence = 0;
    const writer = new ModelOutputWriter(
      {
        storeId: f.owned.expectedStoreId,
        sessionId: 's',
        subjectId: 'owner',
        executionId: 'model',
      },
      (value) =>
        artifacts.publish({
          expectedStoreId: f.owned.expectedStoreId,
          refId: `output-${++sequence}`,
          sessionId: 's',
          subjectId: 'owner',
          scope: { kind: 'execution', id: 'model' },
          mediaType: 'application/vnd.kite.model-output+json',
          content: Buffer.from(canonicalJson(value)),
        }),
      async () => {},
    );
    await writer.call(f.modelResult.toolCalls[0]!);
    const descriptor = writer.descriptor(true)!;
    const proof = {
      id: 'call',
      name: 'fixture/effect',
      inputDigest: await semanticDigest(f.input),
    };
    const saved = { content: '', toolCalls: [], modelOutput: descriptor, modelToolCalls: [proof] };
    const setResult = (value: unknown) =>
      f.physical.run("UPDATE execution SET result_json=? WHERE id='model'", [
        JSON.stringify(value),
      ]);
    setResult(saved);
    expect(executionBehaviorManifest(f.db, f.target()).bindings).toEqual([selected, selectedJob]);
    const body = await artifacts.publish({
      expectedStoreId: f.owned.expectedStoreId,
      refId: 'source-body',
      sessionId: 's',
      subjectId: 'owner',
      scope: { kind: 'session', id: 's' },
      mediaType: 'application/json',
      content: Buffer.from(canonicalJson(f.modelSource as unknown as Json)),
    });
    f.saveModelSource({
      ...f.modelSource,
      sourceBody: { kind: 'model_body', version: 1, reference: body },
    });
    verifyAuthorizationBehaviorBinding(f.db, f.target(), selected, {});
    for (const changed of [
      { ...saved, modelToolCalls: undefined },
      { ...saved, modelToolCalls: [] },
      {
        ...saved,
        modelToolCalls: [proof, proof],
        modelOutput: { ...descriptor, toolCallCount: 2 },
      },
      { ...saved, modelToolCalls: [{ ...proof, inputDigest: 'c'.repeat(64) }] },
      { ...saved, modelToolCalls: [{ ...proof, name: 'foreign' }] },
      { ...saved, modelToolCalls: [{ ...proof, inputDigest: null }] },
      { ...saved, modelToolCalls: [{ ...proof, extra: true }] },
    ]) {
      setResult(changed);
      expect(() => executionBehaviorManifest(f.db, f.target())).toThrow(
        'execution_behavior_source_invalid',
      );
    }
    setResult(saved);
    f.saveModelSource({
      ...f.modelSource,
      sourceBody: { kind: 'model_body', version: 1, reference: { ...body, hash: 'd'.repeat(64) } },
    });
    expect(() => executionBehaviorManifest(f.db, f.target())).toThrow('model_body_invalid');
  } finally {
    await artifacts.close();
    await f.close();
  }
});
