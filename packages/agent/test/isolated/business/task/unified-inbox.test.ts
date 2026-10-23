import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { temporaryDirectory } from '../../../../../../tests/fixtures/test-filesystem';
import { createArtifactStore } from '../../../../src/artifacts';
import type { Extension } from '../../../../src/extensions';
import { createTaskExtension } from '../../../../src/extensions/task';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';
import type { Store } from '../../../../src/storage/port';

const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} satisfies ModelEvent;
const resultBody = 'Canonical child terminal result 雪🙂';
const ordinaryBody = 'Ordinary agent note: untrusted data';
function gate() {
  let release!: () => void;
  return {
    waiting: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}
async function until<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw Error('unified_inbox_fixture_timeout');
    await Bun.sleep(5);
  }
}
async function fixture(
  options: {
    active?: boolean;
    activeTool?: boolean;
    ordinary?: boolean;
    denyContinuation?: boolean;
  } = {},
) {
  const directory = temporaryDirectory('kite-unified-inbox-');
  const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  const actual = await openSqliteStore(profile);
  const receives: { input: Parameters<Store['receiveAgentMessages']>[0]; returned: string[] }[] =
    [];
  const store = new Proxy(actual, {
    get(target, key) {
      if (key === 'receiveAgentMessages')
        return async (input: Parameters<Store['receiveAgentMessages']>[0]) => {
          const returned = await target.receiveAgentMessages(input);
          receives.push({ input: structuredClone(input), returned });
          return returned;
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const storeId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId: storeId, subjectId: 'owner' };
  const childGate = gate(),
    childFinish = gate(),
    originalParent = gate(),
    continuedParent = gate();
  const parentRequests: ModelRequest[] = [],
    childRequests: ModelRequest[] = [];
  const parent: ModelAdapter = {
    async *stream(request) {
      parentRequests.push(structuredClone(request));
      const index = parentRequests.length;
      if (index === 1) {
        yield {
          type: 'tool_call',
          id: 'spawn-worker',
          name: 'spawn_agent',
          arguments: JSON.stringify({ prompt: 'Original child assignment' }),
        };
        yield { ...finish, reason: 'tool_calls' };
        return;
      }
      if (index === 2 && options.active) await originalParent.waiting;
      if (index === 2 && options.activeTool) {
        yield { type: 'tool_call', id: 'parent-query', name: 'fixture.query', arguments: '{}' };
        yield { ...finish, reason: 'tool_calls' };
        return;
      }
      if (index === 3) await continuedParent.waiting;
      yield { type: 'text_delta', text: `Parent response ${index}` };
      yield finish;
    },
  };
  const child: ModelAdapter = {
    async *stream(request) {
      childRequests.push(structuredClone(request));
      await childGate.waiting;
      if (options.ordinary && childRequests.length === 1) {
        yield { type: 'tool_call', id: 'ordinary-note', name: 'fixture.note', arguments: '{}' };
        yield { ...finish, reason: 'tool_calls' };
        return;
      }
      if (options.ordinary) await childFinish.waiting;
      yield { type: 'text_delta', text: resultBody };
      yield finish;
    },
  };
  let queryExecutions = 0;
  const notes: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.query',
        version: '1',
        description: 'Read the existing parent Session title',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        async execute() {
          queryExecutions++;
          return { outcome: 'succeeded', content: (await store.getSession('root'))!.title };
        },
      },
      {
        id: 'fixture.note',
        version: '1',
        description: 'Send an actual ordinary note',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        async execute(_input, context) {
          const target = await context.operations.readAgentMessageTarget!('parent');
          const sent = await context.operations.sendAgentMessage!('parent', {
            key: 'note',
            content: ordinaryBody,
            contextSelectionId: target.contextSelectionId,
            ...(target.targetRunId ? { targetRunId: target.targetRunId } : {}),
          });
          return { outcome: 'succeeded', content: JSON.stringify(sent) };
        },
      },
    ],
  };
  let authorizations = 0;
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model: parent,
    modelId: 'parent',
    modelConcurrency: 4,
    extensions: [
      createTaskExtension({
        roles: [{ id: 'worker', configurationId: 'worker', description: 'Original worker' }],
      }),
      notes,
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'current' };
      },
    },
    afterTurn: {
      async authorize(input) {
        if (input.phase === 'apply') authorizations++;
        return {
          allowed: !(input.phase === 'apply' && options.denyContinuation),
          revision: 'original-continuation-policy',
        };
      },
    },
    childConfigurations: [
      {
        id: 'worker',
        version: '1',
        model: child,
        modelId: 'child',
        toolIds: options.ordinary ? ['fixture.note'] : [],
        snapshot: {},
      },
    ],
  });
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'inbox',
    rootUri: pathToFileURL(directory).href,
  });
  await runtime.createSession({
    ...base,
    sessionId: 'root',
    commandId: 'create',
    workspaceId: 'w',
    title: 'root',
  });
  const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'), { readonly: true });
  const inbox = () => store.listAgentMessages({ ...base, sessionId: 'root' });
  return {
    runtime,
    store,
    profile,
    base,
    db,
    receives,
    parentRequests,
    childRequests,
    childGate,
    childFinish,
    originalParent,
    continuedParent,
    inbox,
    authorizations: () => authorizations,
    queryExecutions: () => queryExecutions,
    submit: () =>
      runtime.submitCommand({
        ...base,
        sessionId: 'root',
        commandId: 'work',
        request: { kind: 'run.start', content: 'Coordinate original work' },
      }),
    async close() {
      childGate.release();
      childFinish.release();
      originalParent.release();
      continuedParent.release();
      await runtime.close();
      db.close();
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const active of [true, false])
  test(`typed result enters the existing inbox and is received once as a Source while parent is ${active ? 'active' : 'idle'}`, async () => {
    const f = await fixture({ active });
    try {
      await f.submit();
      await until(async () => (f.parentRequests.length === 2 ? true : null));
      if (!active) await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      const originalRun = (await f.store.getView('root')).runs[0]!;
      expect(originalRun.isActive).toBe(active);
      f.childGate.release();
      const mail = await until(
        async () => (await f.inbox()).items.find((item) => item.kind === 'result') ?? null,
      );
      expect(mail.id.startsWith('report-')).toBe(true);
      expect(mail.body).toBeNull();
      expect(mail.result).not.toBeNull();
      const carrier = (await f.store.getExecution(mail.result!.executionId))!;
      expect(mail.result!.resultRevision).toBe(carrier.resultRevision);
      expect(carrier.childSessionId).not.toBeNull();
      if (active) {
        expect(mail.receivedSourceId).toBeNull();
        expect(f.parentRequests).toHaveLength(2);
        f.originalParent.release();
      }
      await until(async () => (f.parentRequests.length === 3 ? true : null));
      const received = await until(async () => {
        const item = (await f.inbox()).items.find((item) => item.id === mail.id);
        return item?.state === 'received' ? item : null;
      });
      expect(received.receivedMessageId).toBeNull();
      expect(received.receivedSourceId).toBeString();
      expect(received.receivedRunId === originalRun.id).toBe(active);
      const delivery = f.receives.find(
        (entry) =>
          entry.input.messageIds.includes(mail.id) &&
          entry.returned.includes(received.receivedSourceId!),
      );
      expect(delivery).toBeDefined();
      expect(await f.store.receiveAgentMessages(delivery!.input)).toEqual(delivery!.returned);
      if (!active) {
        const originalReceipt = (await f.store.getCommand(mail.id))!.receipt;
        const wrongRunError = await f.store
          .receiveAgentMessages({ ...delivery!.input, runId: originalRun.id })
          .then(
            () => null,
            (error) => error,
          );
        expect(wrongRunError).toMatchObject({ code: 'agent_message_unverifiable' });
        expect((await f.store.getCommand(mail.id))!.receipt).toEqual(originalReceipt);
        expect((await f.inbox()).items.find((entry) => entry.id === mail.id)!.receivedRunId).toBe(
          received.receivedRunId,
        );
      }
      const sourceId = received.receivedSourceId!;
      const sources = f.db
        .query(
          "SELECT id,request_json FROM context_snapshot WHERE kind='result_ref' AND execution_id=? AND result_revision=?",
        )
        .all(carrier.id, carrier.resultRevision!) as { id: string; request_json: string }[];
      expect(sources).toHaveLength(1);
      expect(sources[0]!.id).toBe(sourceId);
      expect(
        f.db
          .query('SELECT id FROM message WHERE id=? OR id=?')
          .all(sourceId, `agent-mail-${mail.id}`),
      ).toHaveLength(0);
      expect((await f.store.getExecution(carrier.id))!.resultAcceptance?.sourceId).toBe(sourceId);
      const prepared = f.parentRequests[2]!.messages.filter((message) =>
        message.sourceIds?.includes(sourceId),
      );
      expect(prepared).toHaveLength(1);
      expect(prepared[0]!.role).toBe('user');
      expect(prepared[0]!.content).toContain(resultBody);
      expect(f.authorizations()).toBe(active ? 0 : 1);
      if (active) {
        const session = (await f.store.getSession('root'))!;
        await f.runtime.submitCommand({
          ...f.base,
          sessionId: 'root',
          commandId: 'human-correction',
          request: {
            kind: 'input.steer',
            targetRunId: received.receivedRunId!,
            contextSelectionId: session.contextSelectionId,
            content: 'Explicit human correction',
          },
        });
        expect(
          f.parentRequests[2]!.messages.some(
            (message) => message.content === 'Explicit human correction',
          ),
        ).toBe(false);
      }
      f.continuedParent.release();
      if (active) {
        await until(async () => (f.parentRequests.length === 4 ? true : null));
        const human = (await f.store.listMessages('root')).find(
          (message) => message.originCommandId === 'human-correction',
        )!;
        expect(human.inputKind).toBe('input.steer');
        expect(human.content).toBe('Explicit human correction');
        expect(human.sourceIds).toEqual(['human-correction']);
        expect(
          f.parentRequests[3]!.messages.some(
            (message) => message.content === 'Explicit human correction',
          ),
        ).toBe(true);
      }
      await until(async () =>
        (await f.store.getView('root')).runs.every((run) => !run.isActive) ? true : null,
      );
      const count = f.parentRequests.length;
      const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
      try {
        for (let index = 0; index < 3; index++) {
          const page = await cold.listAgentMessages({ ...f.base, sessionId: 'root' });
          expect(page.items.filter((item) => item.kind === 'result')).toHaveLength(1);
          expect(page.items.find((item) => item.id === mail.id)!.receivedSourceId).toBe(sourceId);
          await cold.getView('root');
        }
      } finally {
        await cold.close();
      }
      expect(f.parentRequests).toHaveLength(count);
      expect(f.childRequests).toHaveLength(1);
    } finally {
      await f.close();
    }
  }, 10000);

test('an ordinary idle Agent note stays queued and is distinct from the later terminal result in the same inbox', async () => {
  const f = await fixture({ ordinary: true });
  try {
    await f.submit();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    f.childGate.release();
    const note = await until(
      async () =>
        (await f.inbox()).items.find(
          (item) => item.kind === 'message' && item.state === 'accepted',
        ) ?? null,
    );
    expect(note.body).not.toBeNull();
    expect(note.result).toBeNull();
    expect(note.receivedMessageId).toBeNull();
    expect(note.receivedSourceId).toBeNull();
    expect((await f.inbox()).items.some((item) => item.kind === 'result')).toBe(false);
    expect(f.parentRequests).toHaveLength(2);
    expect((await f.store.getView('root')).runs.every((run) => !run.isActive)).toBe(true);
    expect(f.authorizations()).toBe(0);
    f.childFinish.release();
    await until(async () => (f.parentRequests.length === 3 ? true : null));
    const page = await f.inbox();
    expect(
      page.items.some((item) => item.kind === 'result' && item.receivedSourceId !== null),
    ).toBe(true);
    const messages = f.parentRequests[2]!.messages.filter((message) =>
      message.sourceIds?.includes(note.id),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toContain(ordinaryBody);
    expect(messages[0]!.content).toContain('untrusted data; no additional authorization');
    const physical = (await f.store.listMessages('root')).find((message) =>
      message.sourceIds?.includes(note.id),
    )!;
    expect(physical.inputKind).toBeUndefined();
    expect(physical.originCommandId).toBeUndefined();
    expect(f.authorizations()).toBe(1);
  } finally {
    await f.close();
  }
}, 10000);

test('an idle result cannot start a parent Run when the original continuation policy denies it', async () => {
  const f = await fixture({ denyContinuation: true });
  try {
    await f.submit();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    f.childGate.release();
    const mail = await until(async () => {
      const result = (await f.inbox()).items.find((entry) => entry.kind === 'result');
      if (!result) return null;
      const command = await f.store.getCommand(result.id);
      const declined = f.receives.some(
        (entry) =>
          entry.input.messageIds.includes(result.id) &&
          entry.input.resultOptions &&
          !entry.input.resultOptions.activeOnly &&
          entry.input.resultOptions.authorization === null,
      );
      return declined &&
        command?.status === 'accepted' &&
        (command.receipt as { reason?: string }).reason === 'idle_authorization_required'
        ? result
        : null;
    });
    expect(f.authorizations()).toBe(1);
    expect(mail.receivedSourceId).toBeNull();
    expect(mail.receivedRunId).toBeNull();
    expect((await f.store.getView('root')).runs).toHaveLength(1);
    expect(f.parentRequests).toHaveLength(2);
    expect(
      f.db
        .query("SELECT id FROM context_snapshot WHERE kind='result_ref' AND execution_id=?")
        .all(mail.result!.executionId),
    ).toHaveLength(0);
    expect((await f.store.getExecution(mail.result!.executionId))!.resultAcceptance).toBeNull();
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect(
        (await cold.listAgentMessages({ ...f.base, sessionId: 'root' })).items.find(
          (entry) => entry.id === mail.id,
        )!.receivedSourceId,
      ).toBeNull();
      expect((await cold.getView('root')).runs).toHaveLength(1);
    } finally {
      await cold.close();
    }
    expect(f.parentRequests).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 10000);

test('a child result received during a Model request does not supersede its pending ordinary Tool decision', async () => {
  const f = await fixture({ active: true, activeTool: true });
  try {
    await f.submit();
    await until(async () => (f.parentRequests.length === 2 ? true : null));
    const originalRun = (await f.store.getView('root')).runs[0]!;
    expect(originalRun.isActive).toBe(true);
    f.childGate.release();
    const mail = await until(
      async () => (await f.inbox()).items.find((entry) => entry.kind === 'result') ?? null,
    );
    expect(mail.receivedSourceId).toBeNull();
    expect(f.queryExecutions()).toBe(0);
    expect(f.parentRequests).toHaveLength(2);

    // The already-running Model returns its ordinary read-only Tool decision
    // after the child result has entered the inbox.
    f.originalParent.release();
    await until(async () => (f.parentRequests.length === 3 ? true : null));
    const received = (await f.inbox()).items.find((entry) => entry.id === mail.id)!;
    expect(received.receivedSourceId).toBeString();
    expect(received.receivedRunId).toBe(originalRun.id);
    expect(f.queryExecutions()).toBe(1);
    const view = await f.store.getView('root');
    expect(view.runs).toHaveLength(1);
    expect(view.runs[0]!.id).toBe(originalRun.id);
    const queries = view.executions.filter(
      (execution) => execution.definitionId === 'fixture.query',
    );
    expect(queries).toHaveLength(1);
    expect(queries[0]!.runId).toBe(originalRun.id);
    expect(queries[0]!.status).toBe('succeeded');
    expect(queries[0]!.authorization?.dispatched).toBe(true);
    const resultMessages = f.parentRequests[2]!.messages.filter((message) =>
      message.sourceIds?.includes(received.receivedSourceId!),
    );
    expect(resultMessages).toHaveLength(1);
    expect(resultMessages[0]!.content).toContain(resultBody);
    expect(f.parentRequests[2]!.messages.some((message) => message.role === 'tool')).toBe(true);
    expect(f.authorizations()).toBe(0);
    expect(
      f.db
        .query("SELECT id FROM context_snapshot WHERE kind='result_ref' AND execution_id=?")
        .all(mail.result!.executionId),
    ).toHaveLength(1);
    f.continuedParent.release();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(f.queryExecutions()).toBe(1);
    expect(f.parentRequests).toHaveLength(3);
    expect((await f.store.getView('root')).runs).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 10000);

test('sealed result mail with a missing, unsupported or damaged protocol marker cannot downgrade to a legacy report', async () => {
  const f = await fixture({ active: true });
  const writer = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
  let originalRequest: string | undefined;
  let reportId: string | undefined;
  try {
    await f.submit();
    await until(async () => (f.parentRequests.length === 2 ? true : null));
    const activeRun = (await f.store.getView('root')).runs[0]!;
    expect(activeRun.isActive).toBe(true);
    f.childGate.release();
    const mail = await until(
      async () => (await f.inbox()).items.find((entry) => entry.kind === 'result') ?? null,
    );
    reportId = mail.id;
    const saved = writer
      .query(
        'SELECT request_json,agent_source_execution_id,mail_target_session_id,mail_selection_id,mail_confirmed FROM command WHERE id=?',
      )
      .get(reportId) as {
      request_json: string;
      agent_source_execution_id: string;
      mail_target_session_id: string;
      mail_selection_id: string;
      mail_confirmed: number;
    };
    originalRequest = saved.request_json;
    expect(saved.agent_source_execution_id).toBe(mail.result!.executionId);
    expect(saved.mail_target_session_id).toBe('root');
    expect(saved.mail_confirmed).toBe(1);
    const request = JSON.parse(originalRequest);
    expect(request.mailboxVersion).toBe(1);
    const session = (await f.store.getSession('root'))!;
    const owner = {
      sessionId: 'root',
      instanceId: session.ownerInstanceId!,
      generation: session.ownerGeneration,
    };
    const { mailboxVersion: _version, ...missing } = request;
    for (const damaged of [
      JSON.stringify(missing),
      JSON.stringify({ ...request, mailboxVersion: 0 }),
      JSON.stringify({ ...request, mailboxVersion: 2 }),
      '{broken',
    ]) {
      writer.query('UPDATE command SET request_json=? WHERE id=?').run(damaged, reportId);
      try {
        const legacy = await f.store.listPendingJobReports({
          ...f.base,
          sessionId: 'root',
          limit: 100,
        });
        expect(legacy.commands.some((entry) => entry.id === reportId)).toBe(false);
        const receiveError = await f.store
          .receiveAgentMessages({
            expectedStoreId: f.base.expectedStoreId,
            owner,
            runId: activeRun.id,
            messageIds: [reportId],
          })
          .then(
            () => null,
            (error) => error,
          );
        expect(receiveError).toMatchObject({ code: 'agent_message_not_found' });
        const applyError = await f.store
          .applyJobReport({
            expectedStoreId: f.base.expectedStoreId,
            owner,
            commandId: reportId,
            authorization: null,
            activeOnly: true,
          })
          .then(
            () => null,
            (error) => error,
          );
        expect(applyError).toMatchObject({ code: 'result_mail_unverifiable' });
        expect((await f.store.getView('root')).runs).toHaveLength(1);
        // Reading the raw status avoids asking the public Command DTO to parse
        // the intentionally malformed request in the final case.
        expect(
          (
            writer.query('SELECT status FROM command WHERE id=?').get(reportId) as {
              status: string;
            }
          ).status,
        ).toBe('accepted');
        expect(
          f.db
            .query("SELECT id FROM context_snapshot WHERE kind='result_ref' AND execution_id=?")
            .all(mail.result!.executionId),
        ).toHaveLength(0);
        expect(f.parentRequests).toHaveLength(2);
      } finally {
        writer.query('UPDATE command SET request_json=? WHERE id=?').run(originalRequest, reportId);
      }
    }
    expect((await f.inbox()).items.find((entry) => entry.id === reportId)!.kind).toBe('result');
  } finally {
    if (originalRequest && reportId)
      writer.query('UPDATE command SET request_json=? WHERE id=?').run(originalRequest, reportId);
    writer.close();
    await f.close();
  }
}, 10000);
