import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import type { Extension } from '../../../src/extensions';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
for (const large of [false, true])
  test(`Fork actual selected history ${large ? '17MiB original artifact' : 'small original body'}: no execution copies, exact original pairing and sources in a new explicit Model`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-context-fork-'))),
      profile = { dataRoot: join(directory, 'data'), profile: 'test' };
    const store = await openSqliteStore(profile),
      storeId = (await store.getMetadata()).storeId;
    const artifacts = createArtifactStore({ profile, store }),
      requests: ModelRequest[] = [];
    const originalBody = large
      ? `full-original-body-${'x'.repeat(17 * 1024 * 1024)}`
      : 'small actual original body';
    let effects = 0;
    const extension: Extension = {
      id: 'fixture',
      version: '1',
      apiMajor: 1,
      records: [{ contentType: 'fixture.note', contentVersion: 1, schema: { type: 'object' } }],
      tools: [
        {
          id: 'effect',
          version: '1',
          description: 'private harmless effect',
          inputSchema: { type: 'object' },
          async execute(_input, context) {
            effects++;
            await context.records.write({
              key: 'note',
              expectedRevision: null,
              contentType: 'fixture.note',
              contentVersion: 1,
              value: { original: true },
            });
            return { outcome: 'succeeded', content: 'actual original effect result' };
          },
        },
      ],
    };
    const model: ModelAdapter = {
      async *stream(request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          yield { type: 'text_delta', text: originalBody };
          yield { type: 'tool_call', id: 'original-call', name: 'effect', arguments: '{}' };
          yield { ...finish, reason: 'tool_calls' };
        } else {
          yield {
            type: 'text_delta',
            text: requests.length === 2 ? 'original completed' : 'new explicit branch completed',
          };
          yield finish;
        }
      },
    };
    const runtime = createRuntime({
      store,
      artifacts,
      model,
      modelId: 'fixed',
      extensions: [extension],
      permissions: {
        async authorize() {
          return { allowed: true, revision: '1' };
        },
      },
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        name: 'private',
        rootUri: `file://${directory}`,
      });
      await runtime.createSession({
        expectedStoreId: storeId,
        sessionId: 'source',
        workspaceId: 'w',
        subjectId: 'owner',
        commandId: 'create',
        title: 'source',
      });
      await runtime.submitCommand({
        expectedStoreId: storeId,
        sessionId: 'source',
        subjectId: 'owner',
        commandId: 'original',
        request: { kind: 'run.start', content: 'original work' },
      });
      await runtime.waitForCommand('original', { timeoutMs: 20000 });
      const before = await store.getView('source'),
        selection = before.session.contextSelectionId;
      const input = {
        expectedStoreId: storeId,
        sourceSessionId: 'source',
        expectedContextSelectionId: selection,
        newSessionId: 'fork',
        commandId: 'fork-command',
        subjectId: 'owner',
        title: 'explicit readable fork',
      };
      const wrongStore = await runtime
        .forkSession({ ...input, expectedStoreId: 'foreign' })
        .catch((error) => error);
      expect(wrongStore.code).toBe('store_identity_mismatch');
      const intruder = await runtime
        .forkSession({ ...input, subjectId: 'intruder' })
        .catch((error) => error);
      expect(intruder.code).toBe('permission_denied');
      const assistant = before.messages.find(
        (m) => m.toolCalls?.length || m.modelOutput?.toolCallCount,
      )!;
      const unpaired = await runtime
        .forkSession({ ...input, boundary: { messageId: assistant.id, seq: assistant.seq } })
        .catch((error) => error);
      expect(unpaired.code).toBe('context_boundary_unpaired');
      if (!large) {
        const physical = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
        const water = (await store.getMetadata()).lastChangeCursor;
        try {
          physical.run(
            "CREATE TRIGGER fail_fork BEFORE INSERT ON message WHEN NEW.session_id='fork' BEGIN SELECT RAISE(ABORT,'fork rollback'); END",
          );
          const failed = await runtime.forkSession(input).catch((error) => error);
          expect(failed.code).toBe('SQLITE_CONSTRAINT_TRIGGER');
          expect(await store.getSession('fork')).toBeNull();
          expect(await store.getCommand('fork-command')).toBeNull();
          expect((await store.getMetadata()).lastChangeCursor).toBe(water);
          expect((await store.getView('source')).messages).toEqual(before.messages);
          physical.run('DROP TRIGGER fail_fork');
        } finally {
          physical.close();
        }
      }
      const fork = await runtime.forkSession(input);
      expect(fork.omittedExtensionState).toBe(true);
      expect(fork.command.kind).toBe('session.create');
      expect(fork.session.rootSessionId).toBe('fork');
      expect(fork.session.ownerGeneration).toBe('0');
      expect(fork.session.ownerInstanceId).toBeNull();
      const view = await store.getView('fork');
      expect(view.runs).toHaveLength(0);
      expect(view.executions).toHaveLength(0);
      expect(view.messages).toHaveLength(before.messages.length);
      expect(view.messages.every((m) => m.runId === null)).toBe(true);
      expect(
        await store.getExtensionRecord({ extensionId: 'fixture', sessionId: 'fork', key: 'note' }),
      ).toBeNull();
      expect(
        (await store.getExtensionRecord({
          extensionId: 'fixture',
          sessionId: 'source',
          key: 'note',
        }))!.value,
      ).toEqual({ original: true });
      const cursor = (await store.getMetadata()).lastChangeCursor;
      expect((await runtime.forkSession(input)).selection).toEqual(fork.selection);
      expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
      expect(
        (await runtime.forkSession({ ...input, title: 'changed intent' }).catch((error) => error))
          .code,
      ).toBe('command_conflict');
      expect(requests).toHaveLength(2);
      expect(effects).toBe(1);
      const copiedAssistant = view.messages.find(
        (m) => m.toolCalls?.length || m.modelOutput?.toolCallCount,
      )!;
      const original = await store.getMessageOrigin({
        expectedStoreId: storeId,
        sessionId: 'fork',
        subjectId: 'owner',
        messageId: copiedAssistant.id,
      });
      expect(original.message.id).toBe(assistant.id);
      expect(original.message.sessionId).toBe('source');
      expect(
        (
          await store
            .getMessageOrigin({
              expectedStoreId: storeId,
              sessionId: 'fork',
              subjectId: 'owner',
              messageId: assistant.id,
            })
            .catch((error) => error)
        ).code,
      ).toBe('message_not_found');
      await runtime.submitCommand({
        expectedStoreId: storeId,
        sessionId: 'fork',
        subjectId: 'owner',
        commandId: 'new-work',
        request: { kind: 'run.start', content: 'new explicit branch work' },
      });
      await runtime.waitForCommand('new-work', { timeoutMs: 20000 });
      expect(requests).toHaveLength(3);
      expect(effects).toBe(1);
      const request = requests[2]!;
      const copied = request.messages.find((m) =>
        m.toolCalls?.some((c) => c.id === 'original-call'),
      )!;
      expect(copied.content).toBe(originalBody);
      expect(copied.sourceIds).toEqual(assistant.sourceIds);
      expect(
        request.messages.filter((m) => m.role === 'tool' && m.toolCallId === 'original-call'),
      ).toHaveLength(1);
      expect((await store.getView('source')).runs).toHaveLength(1);
      expect((await store.getView('fork')).runs).toHaveLength(1);
      await runtime.close();
      await store.close();
      const readonly = await openSqliteStore({ ...profile, mode: 'readonly' });
      try {
        const water = (await readonly.getMetadata()).lastChangeCursor;
        const page = await readonly.getSelectedContext({
          expectedStoreId: storeId,
          sessionId: 'fork',
          messageLimit: 200,
          byteLimit: 8 * 1024 * 1024,
        });
        expect(page.messages.length).toBeGreaterThan(0);
        expect((await readonly.getMetadata()).lastChangeCursor).toBe(water);
        expect(requests).toHaveLength(3);
        expect(effects).toBe(1);
        expect((await readonly.getSession('fork'))!.ownerInstanceId).toBeNull();
      } finally {
        await readonly.close();
      }
    } finally {
      await runtime.close();
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 40000);

test('Fork preserves future content as readonly and refuses to reinterpret it before a new Provider call', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-future-fork-')));
  const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  let calls = 0;
  const runtime = createRuntime({
    store,
    modelId: 'fixed',
    model: {
      async *stream() {
        calls++;
        yield { type: 'text_delta', text: 'actual committed body' };
        yield finish;
      },
    },
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'w',
      rootUri: `file://${directory}`,
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      sessionId: 'source',
      workspaceId: 'w',
      subjectId: 'owner',
      commandId: 'create',
      title: 'source',
    });
    await runtime.submitCommand({
      expectedStoreId: storeId,
      sessionId: 'source',
      subjectId: 'owner',
      commandId: 'work',
      request: { kind: 'run.start', content: 'original' },
    });
    await runtime.waitForCommand('work', { timeoutMs: 5000 });
    const before = await store.getView('source');
    const original = before.messages.find((message) => message.role === 'assistant')!;
    const physical = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
    try {
      physical.run('UPDATE message_part SET content_version=2 WHERE message_id=?', [original.id]);
    } finally {
      physical.close();
    }
    const fork = await runtime.forkSession({
      expectedStoreId: storeId,
      sourceSessionId: 'source',
      expectedContextSelectionId: before.session.contextSelectionId,
      newSessionId: 'fork',
      commandId: 'fork',
      subjectId: 'owner',
      title: 'future readonly',
    });
    expect(fork.omittedExtensionState).toBe(true);
    expect(calls).toBe(1);
    const raw = await store.getView('fork');
    const copied = raw.messages.find((message) => message.role === 'assistant')!;
    expect(copied.content).toBe('actual committed body');
    expect(
      (
        await store
          .getMessageOrigin({
            expectedStoreId: storeId,
            sessionId: 'fork',
            subjectId: 'owner',
            messageId: copied.id,
          })
          .catch((error) => error)
      ).code,
    ).toBe('fork_content_unsupported');
    await runtime.submitCommand({
      expectedStoreId: storeId,
      sessionId: 'fork',
      subjectId: 'owner',
      commandId: 'new-work',
      request: { kind: 'run.start', content: 'new explicit intent' },
    });
    await runtime.waitForCommand('new-work', { timeoutMs: 5000 });
    expect(calls).toBe(1);
    const after = await store.getView('fork');
    expect(after.runs[0]!.status).toBe('failed');
    expect(after.runs[0]!.reason).toBe('fork_content_unsupported');
    expect(after.executions).toHaveLength(0);
    expect(
      (await store.getView('source')).messages.find((message) => message.id === original.id)!
        .content,
    ).toBe('actual committed body');
    const version = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
      readonly: true,
    });
    try {
      expect(
        version.query('SELECT content_version FROM message_part WHERE message_id=?').get(copied.id),
      ).toEqual({ content_version: 2 });
    } finally {
      version.close();
    }
  } finally {
    await runtime.close();
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Fork retains only currently selected consumed result provenance; empty and excluded boundaries cannot regain history', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-result-fork-')));
  const store = await openSqliteStore({ dataRoot: join(directory, 'data'), profile: 'test' });
  const storeId = (await store.getMetadata()).storeId;
  const requests: ModelRequest[] = [];
  let starts = 0;
  const runtime = createRuntime({
    store,
    modelId: 'fixed',
    model: {
      async *stream(request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          yield { type: 'tool_call', id: 'call', name: 'launch', arguments: '{}' };
          yield { ...finish, reason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'actual completion' };
          yield finish;
        }
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'launch',
            version: '1',
            description: 'actual Job',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              const ref = await context.operations.ensure({
                key: 'job',
                cancellation: 'detached',
                request: { kind: 'job', definitionId: 'job', definitionVersion: '1', input: {} },
              });
              await context.operations.wait(ref, { signal: context.signal, timeoutMs: 5000 });
              return { outcome: 'succeeded', content: 'actual settled Job' };
            },
          },
        ],
        jobs: [
          {
            id: 'job',
            version: '1',
            description: 'counted result',
            inputSchema: { type: 'object' },
            resources: { slot: 'process' },
            async start() {
              starts++;
              return { reference: { id: 'actual' } };
            },
            async *observe() {
              yield {
                type: 'terminal',
                supervision: 'ended',
                result: { outcome: 'failed', content: 'accurate known failed result' },
              };
            },
            async cancel() {
              return { status: 'stopped' };
            },
            async dispose() {},
          },
        ],
      },
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'w',
      rootUri: `file://${directory}`,
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      sessionId: 'source',
      workspaceId: 'w',
      subjectId: 'owner',
      commandId: 'create',
      title: 'source',
    });
    await runtime.submitCommand({
      expectedStoreId: storeId,
      sessionId: 'source',
      subjectId: 'owner',
      commandId: 'work',
      request: { kind: 'run.start', content: 'original' },
    });
    await runtime.waitForCommand('work', { timeoutMs: 5000 });
    const before = await store.getView('source');
    const original = await store.getSelectedContext({
      expectedStoreId: storeId,
      sessionId: 'source',
    });
    expect(original.resultSources).toHaveLength(1);
    const source = original.resultSources[0]!;
    expect(source.result).toMatchObject({
      outcome: 'failed',
      content: 'accurate known failed result',
    });
    const base = {
      expectedStoreId: storeId,
      sourceSessionId: 'source',
      expectedContextSelectionId: before.session.contextSelectionId,
      subjectId: 'owner',
      title: 'fork',
    };
    await runtime.forkSession({ ...base, commandId: 'fork', newSessionId: 'fork' });
    const selected = await store.getSelectedContext({
      expectedStoreId: storeId,
      sessionId: 'fork',
    });
    expect(selected.resultSources).toHaveLength(1);
    expect(selected.resultSources[0]!.executionId).toBe(source.executionId);
    expect(selected.resultSources[0]!.originStoreId).toBe(source.originStoreId);
    expect(selected.resultSources[0]!.resultRevision).toBe(source.resultRevision);
    expect(selected.resultSources[0]!.id).not.toBe(source.id);
    expect((await store.getExecution(source.executionId))!.delivery).toBe('consumed');
    await runtime.submitCommand({
      expectedStoreId: storeId,
      sessionId: 'fork',
      subjectId: 'owner',
      commandId: 'next',
      request: { kind: 'run.start', content: 'explicit new work' },
    });
    await runtime.waitForCommand('next', { timeoutMs: 5000 });
    const contribution = requests[2]!.messages.filter((message) =>
      message.sourceIds?.includes(selected.resultSources[0]!.id),
    );
    expect(contribution).toHaveLength(1);
    expect(contribution[0]!.role).toBe('user');
    expect(contribution[0]!.content).toContain('accurate known failed result');
    expect(starts).toBe(1);
    await runtime.forkSession({
      ...base,
      commandId: 'empty',
      newSessionId: 'empty',
      boundary: null,
    });
    const empty = await store.getSelectedContext({ expectedStoreId: storeId, sessionId: 'empty' });
    expect(empty.messages).toHaveLength(0);
    expect(empty.resultSources).toHaveLength(0);
    const first = before.messages[0]!;
    const rewind = await runtime.selectContext({
      expectedStoreId: storeId,
      sessionId: 'source',
      subjectId: 'owner',
      commandId: 'rewind',
      expectedContextSelectionId: base.expectedContextSelectionId,
      boundary: { messageId: first.id, seq: first.seq },
    });
    await runtime.forkSession({
      ...base,
      expectedContextSelectionId: rewind.selection.id,
      commandId: 'prefix',
      newSessionId: 'prefix',
    });
    const prefix = await store.getSelectedContext({
      expectedStoreId: storeId,
      sessionId: 'prefix',
    });
    expect(prefix.messages).toHaveLength(1);
    expect(prefix.resultSources).toHaveLength(0);
    const excluded = await runtime
      .forkSession({
        ...base,
        expectedContextSelectionId: rewind.selection.id,
        commandId: 'excluded',
        newSessionId: 'excluded',
        boundary: { messageId: before.messages.at(-1)!.id, seq: before.messages.at(-1)!.seq },
      })
      .catch((error) => error);
    expect(excluded.code).toBe('context_boundary_invalid');
    expect(await store.getSession('excluded')).toBeNull();
    expect(requests).toHaveLength(3);
    expect(starts).toBe(1);
  } finally {
    await runtime.close();
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Fork refuses live and actual unknown group effects without creating a Session or command', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-unsettled-fork-')));
  const store = await openSqliteStore({ dataRoot: join(directory, 'data'), profile: 'test' });
  const storeId = (await store.getMetadata()).storeId;
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  let models = 0,
    starts = 0;
  const runtime = createRuntime({
    store,
    modelId: 'fixed',
    model: {
      async *stream() {
        models++;
        if (models === 1) {
          entered();
          await gate;
          yield { type: 'tool_call', id: 'launch', name: 'launch', arguments: '{}' };
          yield { ...finish, reason: 'tool_calls' };
        } else {
          yield finish;
        }
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'launch',
            version: '1',
            description: 'unknown external fact',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              const ref = await context.operations.ensure({
                key: 'unknown',
                cancellation: 'detached',
                request: {
                  kind: 'job',
                  definitionId: 'unknown',
                  definitionVersion: '1',
                  input: {},
                },
              });
              await context.operations.wait(ref, { signal: context.signal, timeoutMs: 5000 });
              return { outcome: 'succeeded', content: 'actual unknown remains unknown' };
            },
          },
        ],
        jobs: [
          {
            id: 'unknown',
            version: '1',
            description: 'unconfirmed supervision',
            inputSchema: { type: 'object' },
            resources: { slot: 'process' },
            async start() {
              starts++;
              return { reference: { known: true } };
            },
            async *observe() {
              yield {
                type: 'terminal',
                supervision: 'unknown',
                result: { outcome: 'outcome_unknown', content: 'external effect unconfirmed' },
              };
            },
            async cancel() {
              return { status: 'unknown' };
            },
            async dispose() {},
          },
        ],
      },
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'w',
      rootUri: `file://${directory}`,
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      sessionId: 'source',
      workspaceId: 'w',
      subjectId: 'owner',
      commandId: 'create',
      title: 'source',
    });
    const base = {
      expectedStoreId: storeId,
      sourceSessionId: 'source',
      expectedContextSelectionId: (await store.getSession('source'))!.contextSelectionId,
      newSessionId: 'fork',
      commandId: 'fork',
      subjectId: 'owner',
      title: 'no takeover',
    };
    await runtime.submitCommand({
      expectedStoreId: storeId,
      sessionId: 'source',
      subjectId: 'owner',
      commandId: 'work',
      request: { kind: 'run.start', content: 'original' },
    });
    await reached;
    expect((await runtime.forkSession(base).catch((error) => error)).code).toBe(
      'context_execution_unsettled',
    );
    expect(await store.getSession('fork')).toBeNull();
    expect(await store.getCommand('fork')).toBeNull();
    release();
    await runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect((await store.getView('source')).executions.find((e) => e.kind === 'job')!.status).toBe(
      'outcome_unknown',
    );
    expect((await runtime.forkSession(base).catch((error) => error)).code).toBe(
      'context_execution_unsettled',
    );
    expect(await store.getSession('fork')).toBeNull();
    expect(await store.getCommand('fork')).toBeNull();
    expect(starts).toBe(1);
  } finally {
    release();
    expect(await runtime.close().catch((error: unknown) => error)).toMatchObject({
      code: 'shutdown_cleanup_unconfirmed',
    });
    expect(runtime.getLifecycleState().state).toBe('drain_failed');
    expect((await store.getMetadata()).storeId).toBe(storeId);
    // This fixture's Job is an in-memory adapter without an external process.
    // Explicit test cleanup does not turn its unconfirmed production drain into success.
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
