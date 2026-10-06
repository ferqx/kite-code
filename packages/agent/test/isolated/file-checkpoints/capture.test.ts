import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import { artifactPath } from '../../../src/artifacts-files';
import { bytesDigest } from '../../../src/business/file-checkpoints/records';
import type { Extension, ReadContext } from '../../../src/extensions';
import {
  createFileCheckpointing,
  createScopedFileCheckpointing,
  type FileCheckpointOptions,
} from '../../../src/files';
import { semanticDigest } from '../../../src/json';
import { createWorkspaceSerialLocks } from '../../../src/resources';
import { openSqliteStore } from '../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function fixture(
  mode:
    | 'normal'
    | 'no-boundary'
    | 'after-fail'
    | 'after-cas'
    | 'capture-cancel'
    | 'restore-ask'
    | 'restore-seal'
    | 'restore-before-image-fail'
    | 'restore-after-ledger-fail'
    | 'lazy'
    | 'lazy-close' = 'normal',
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-checkpoint-capture-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const original = Buffer.from(`\uFEFF${'完整预像\r\n'.repeat(40000)}`);
  writeFileSync(join(workspace, 'original'), original);
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile);
  const artifacts = createArtifactStore({ profile, store });
  const locks = createWorkspaceSerialLocks(profile);
  const storeId = (await store.getMetadata()).storeId;
  let calls = 0;
  let captureEntered = false,
    releaseCapture!: () => void;
  const captureGate = new Promise<void>((resolve) => {
    releaseCapture = resolve;
  });
  const checkpointOptions: FileCheckpointOptions = {
    workspace: { id: 'w', root: workspace },
    protectedPaths: [],
    maxBytes: 2 * 1024 * 1024,
    ...(mode === 'no-boundary'
      ? {}
      : {
          async readBoundary(context, actual) {
            const session = await store.getSession(context.sessionId),
              run = await store.getRun(actual.runId!);
            const command = await store.getCommand(actual.originCommandId!);
            const page = await store.getSelectedContext({
              expectedStoreId: storeId,
              sessionId: 's',
              contextSelectionId: session!.contextSelectionId,
            });
            const message = page.messages.find(
              (message) => message.runId === run!.id && message.role === 'user',
            );
            if (
              session?.workspaceId !== 'w' ||
              !run ||
              run.sessionId !== session.id ||
              command?.subjectId !== 'owner' ||
              !message ||
              message.status !== 'complete'
            )
              throw new Error('actual boundary missing');
            const tool = await store.getExecution(actual.id);
            const modelExecutionId = (tool!.decisionSource as { modelExecutionId: string })
              .modelExecutionId;
            const snapshot = await runtime.readModelInput({
              expectedStoreId: storeId,
              sessionId: 's',
              subjectId: 'owner',
              executionId: modelExecutionId,
            });
            const before = page.messages
              .filter((row) => BigInt(row.seq) < BigInt(message.seq))
              .at(-1);
            return {
              boundary: {
                storeId,
                workspaceId: 'w',
                sessionId: 's',
                runId: run.id,
                contextSelectionId: page.selection.id,
                messageId: before?.id ?? null,
                messageSeq: before?.seq ?? '0',
                triggerMessageId: message.id,
                triggerSeq: message.seq,
              },
              modelExecutionId,
              modelInputHash: snapshot.bodyHash,
            };
          },
        }),
    async readSelectedLineage(context) {
      const session = await store.getSession(context.sessionId);
      const page = await store.getSelectedContext({
        expectedStoreId: storeId,
        sessionId: 's',
        contextSelectionId: session!.contextSelectionId,
        messageLimit: 200,
        sourceLimit: 100,
      });
      if (page.nextAfterSeq || page.nextAfterSourceId)
        throw new Error('fixture incomplete selection');
      return {
        storeId,
        workspaceId: 'w',
        sessionId: 's',
        contextSelectionId: page.selection.id,
        upperSeq: page.highWaterSeq,
        messages: page.messages.map((message) => ({ id: message.id, seq: message.seq })),
      };
    },
    async verifyCaptureSource(context, point, source) {
      const tool = await store.getExecution(source.executionId);
      const binding = tool!.decisionSource as { modelExecutionId: string };
      if (
        binding.modelExecutionId !== source.modelExecutionId ||
        tool!.runId !== point.boundary.runId ||
        tool!.sessionId !== context.sessionId
      )
        throw new Error('original model binding mismatch');
      const model = await store.getExecution(source.modelExecutionId);
      const snapshot = await runtime.readModelInput({
        expectedStoreId: storeId,
        sessionId: 's',
        subjectId: 'owner',
        executionId: source.modelExecutionId,
      });
      if (model?.status !== 'succeeded' || snapshot.bodyHash !== source.modelInputHash)
        throw new Error('original model hash mismatch');
    },
  };
  const checkpoint = createFileCheckpointing(checkpointOptions);
  let stage = 0,
    generation = 0;
  const model: ModelAdapter = {
    async *stream() {
      calls++;
      if (stage === 3) {
        yield finish;
        return;
      }
      const step = stage++;
      const input =
        step === 2
          ? { path: generation ? 'created-next' : 'created', base: null, content: 'created\r\n' }
          : {
              path: 'original',
              base: (await checkpoint.files.read('original')).baseline,
              content: step === 0 ? 'middle\r\n' : generation ? 'next-last\r\n' : 'last\r\n',
            };
      yield {
        type: 'tool_call',
        id: `call-${step}`,
        name: 'files.write',
        arguments: JSON.stringify(input),
      };
      yield { ...finish, reason: 'tool_calls' };
    },
  };
  let resolved = 0,
    closed = 0;
  const extension: { -readonly [K in keyof Extension]: Extension[K] } = [
    'lazy',
    'lazy-close',
  ].includes(mode)
    ? {
        ...createScopedFileCheckpointing(
          async () => {
            resolved++;
            const capability = createFileCheckpointing(checkpointOptions);
            const close = capability.close;
            capability.close = async () => {
              closed++;
              await close();
              if (mode === 'lazy-close' && resolved === 5)
                throw new Error('scoped close after confirmed physical restore');
            };
            return capability;
          },
          { includeTools: true },
        ),
      }
    : { ...checkpoint.extension };
  if (mode === 'after-fail')
    extension.tools = extension.tools!.map((tool) =>
      tool.id === 'files.write'
        ? {
            ...tool,
            async execute(input, context) {
              const reader = context.getExecution;
              let reads = 0;
              context.getExecution = async (id) => {
                if (++reads === 2) throw new Error('actual after publication proof read fails');
                return reader(id);
              };
              return tool.execute(input, context);
            },
          }
        : tool,
    );
  if (mode === 'after-cas')
    extension.tools = extension.tools!.map((tool) =>
      tool.id === 'files.write'
        ? {
            ...tool,
            async execute(input, context) {
              const original = context.records.write;
              context.records.write = async (value) => {
                if (
                  value.contentType === 'builtin.files.checkpoint.file' &&
                  value.expectedRevision !== null
                ) {
                  const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
                  try {
                    db.run(
                      'UPDATE extension_record SET revision=revision+1 WHERE extension_id=? AND scope_id=? AND key=?',
                      ['builtin.files', 's', value.key],
                    );
                  } finally {
                    db.close();
                  }
                }
                return original(value);
              };
              return tool.execute(input, context);
            },
          }
        : tool,
    );
  extension.actions = [
    ...(extension.actions ?? []),
    {
      id: 'fixture.intent',
      version: '1',
      description: 'Fixture records blocked restore intent only',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['pointId', 'restoreId'],
        properties: { pointId: { type: 'string' }, restoreId: { type: 'string' } },
      },
      async prepare(input) {
        return input;
      },
      async execute(input, context) {
        const value = input as { pointId: string; restoreId: string };
        const record = await checkpoint.recordRestoreIntent(
          context,
          value.pointId,
          value.restoreId,
        );
        return { outcome: 'failed' as const, content: JSON.stringify(record.value) };
      },
    },
  ];
  if (mode === 'restore-seal')
    extension.actions = extension.actions!.map((action) =>
      action.id === 'files.checkpoint.restore'
        ? {
            ...action,
            async execute(prepared, context) {
              const original = context.records.write;
              context.records.write = async (value) => {
                const journal = value.value as { phase?: string; files?: { state: string }[] };
                if (
                  journal.phase === 'restoring' &&
                  journal.files?.some((file) => file.state === 'restored')
                ) {
                  const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
                  try {
                    db.run(
                      'UPDATE extension_record SET revision=revision+1 WHERE extension_id=? AND scope_id=? AND key=?',
                      ['builtin.files', 's', value.key],
                    );
                  } finally {
                    db.close();
                  }
                }
                return original(value);
              };
              return action.execute(prepared, context);
            },
          }
        : action,
    );
  if (mode === 'restore-before-image-fail') {
    let failBeforeImage = true;
    extension.actions = extension.actions!.map((action) =>
      action.id === 'files.checkpoint.restore'
        ? {
            ...action,
            async execute(prepared, context) {
              const publisher = context.artifacts!.publish;
              context.artifacts!.publish = async (input) => {
                if (failBeforeImage && input.mediaType === 'application/octet-stream') {
                  failBeforeImage = false;
                  throw new Error(
                    'fixture before-image publication unavailable before any file effect',
                  );
                }
                return publisher(input);
              };
              return action.execute(prepared, context);
            },
          }
        : action,
    );
  }
  if (mode === 'restore-after-ledger-fail') {
    extension.actions = extension.actions!.map((action) =>
      action.id === 'files.checkpoint.restore'
        ? {
            ...action,
            async execute(prepared, context) {
              const writer = context.records.write;
              let failAfterLedger = true;
              context.records.write = async (input) => {
                const record = await writer(input);
                if (
                  failAfterLedger &&
                  input.contentType === 'builtin.files.checkpoint.restore-effect'
                ) {
                  failAfterLedger = false;
                  throw new Error('fixture loses reply after pending effect ledger commit');
                }
                return record;
              };
              return action.execute(prepared, context);
            },
          }
        : action,
    );
  }
  const runtime = createRuntime({
    store,
    artifacts:
      mode === 'capture-cancel'
        ? {
            ...artifacts,
            async publish(input) {
              const reference = await artifacts.publish(input);
              if (input.mediaType === 'application/octet-stream') {
                captureEntered = true;
                await captureGate;
              }
              return reference;
            },
          }
        : artifacts,
    workspaceSerialLocks: locks,
    model,
    modelId: 'fixed',
    extensions: [extension],
    permissions: {
      async authorize(request) {
        if (
          request.definitionId === 'builtin.files/files.checkpoint.restore' &&
          [
            'restore-ask',
            'restore-seal',
            'restore-before-image-fail',
            'restore-after-ledger-fail',
            'lazy',
            'lazy-close',
          ].includes(mode)
        )
          return {
            allowed: false,
            revision: 'restore-ask-1',
            approval: { request: { title: 'Restore exact original checkpoint bytes' } },
          };
        return { allowed: true, revision: 'fixed' };
      },
    },
  });
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: `file://${workspace}`,
    name: 'w',
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 's',
  });
  const read: ReadContext = {
    sessionId: 's',
    readExecutionGroupSafety: () =>
      store.readExecutionGroupSafety({
        expectedStoreId: storeId,
        sessionId: 's',
        subjectId: 'owner',
      }),
    getRun: (id) => store.getRun(id),
    getExecution: async (id) => {
      const execution = await store.getExecution(id);
      return execution
        ? { ...execution, inputDigest: await semanticDigest(execution.input) }
        : null;
    },
    records: {
      get: (key) => store.getExtensionRecord({ sessionId: 's', extensionId: 'builtin.files', key }),
      list: (options) =>
        store.listExtensionRecords({ sessionId: 's', extensionId: 'builtin.files', ...options }),
    },
    artifacts: {
      read: (ref) =>
        artifacts.read({
          expectedStoreId: storeId,
          subjectId: 'owner',
          sessionId: 's',
          refId: ref.id,
          scope: ref.scope!,
        }),
    },
  };
  return {
    root,
    workspace,
    original,
    profile,
    store,
    artifacts,
    storeId,
    checkpoint,
    runtime,
    extension,
    get resolved() {
      return resolved;
    },
    get closed() {
      return closed;
    },
    read,
    get captureEntered() {
      return captureEntered;
    },
    releaseCapture,
    get calls() {
      return calls;
    },
    async runAgain(commandId = 'work-next') {
      generation++;
      stage = 0;
      await runtime.submitCommand({
        expectedStoreId: storeId,
        commandId,
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'change next files' },
      });
      await runtime.waitForCommand(commandId);
    },
    async run() {
      await runtime.submitCommand({
        expectedStoreId: storeId,
        commandId: 'work',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'change actual files' },
      });
      await runtime.waitForCommand('work');
    },
    async close() {
      releaseCapture();
      await runtime.close();
      await checkpoint.close();
      await artifacts.close();
      await locks.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('actual Files Tool receipts seal first full preimage and last postimage; readonly preview and blocked intent have zero effect', async () => {
  const f = await fixture();
  try {
    await f.run();
    const writes = (await f.store.getView('s')).executions.filter(
      (execution) => execution.kind === 'tool',
    );
    expect(
      writes.map((execution) => ({
        callId: execution.callId,
        status: execution.status,
        failure: execution.status === 'succeeded' ? null : execution.result,
      })),
    ).toEqual([
      { callId: 'call-0', status: 'succeeded', failure: null },
      { callId: 'call-1', status: 'succeeded', failure: null },
      { callId: 'call-2', status: 'succeeded', failure: null },
    ]);
    const points = await f.read.records.list({ contentType: 'builtin.files.checkpoint' });
    expect(points).toHaveLength(1);
    const id = (points[0]!.value as { id: string }).id;
    const listing = await f.checkpoint.listPoints(f.read, { limit: 1 });
    expect(listing.items.map((item) => item.checkpoint.id)).toEqual([id]);
    expect(
      (await f.checkpoint.listPoints(f.read, { afterKey: listing.nextAfterKey!, limit: 1 })).items,
    ).toHaveLength(0);
    const point = await f.checkpoint.readPoint(f.read, id);
    expect(point.files).toHaveLength(2);
    const original = point.files.find((file) => file.path === 'original')!,
      created = point.files.find((file) => file.path === 'created')!;
    expect(original.first!.baseline!.hash).toBe(bytesDigest(f.original));
    expect(original.first!.artifact!.scope).toEqual({
      kind: 'execution',
      id: original.first!.source.executionId,
    });
    const full = await f.read.artifacts!.read(original.first!.artifact!);
    expect(Buffer.from(full)).toEqual(f.original);
    expect(full.length).toBeGreaterThan(300 * 1024);
    expect(original.last!.baseline.hash).toBe(bytesDigest(Buffer.from('last\r\n')));
    expect(original.first!.source.executionId).not.toBe(original.last!.source.executionId);
    expect(original.first!.source.executionId).toBe(writes[0]!.id);
    expect(original.last!.source.executionId).toBe(writes[1]!.id);
    expect(created.first!.source.executionId).toBe(writes[2]!.id);
    expect(created.first!.artifact).toBeNull();
    expect(created.first!.baseline).toBeNull();
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const modelCalls = f.calls;
    const preview = await f.checkpoint.preview(f.read, id);
    expect(preview.files.map((file) => [file.path, file.status])).toEqual([
      ['created', 'remove'],
      ['original', 'restore'],
    ]);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(f.calls).toBe(modelCalls);
    for (const drift of ['hash', 'ref', 'source', 'post', 'revision'] as const) {
      const changed: ReadContext = {
        ...f.read,
        records: {
          ...f.read.records,
          async list(options) {
            const rows = await f.read.records.list(options);
            return rows.map((row) => {
              if (
                row.contentType !== 'builtin.files.checkpoint.file' ||
                (row.value as { path?: string }).path !== 'original'
              )
                return row;
              const altered = structuredClone(row);
              const value = altered.value as unknown as {
                first: {
                  baseline: { hash: string };
                  artifact: { scope: { id: string } };
                  source: { attempt: number };
                };
                last: { baseline: { hash: string } };
              };
              if (drift === 'hash') value.first.baseline.hash = '0'.repeat(64);
              if (drift === 'ref') value.first.artifact.scope.id = 'foreign-execution';
              if (drift === 'source') value.first.source.attempt++;
              if (drift === 'post') value.last.baseline.hash = '0'.repeat(64);
              if (drift === 'revision') altered.contentVersion = 2;
              return altered;
            });
          },
        },
      };
      if (drift === 'revision') {
        let rejected = false;
        try {
          await f.checkpoint.preview(changed, id);
        } catch {
          rejected = true;
        }
        expect(rejected).toBe(true);
      } else
        expect(
          (await f.checkpoint.preview(changed, id)).files.find((file) => file.path === 'original')!
            .status,
        ).toBe('unavailable');
      expect(readFileSync(join(f.workspace, 'original'), 'utf8')).toBe('last\r\n');
      expect(f.calls).toBe(modelCalls);
    }
    let changedHead = false;
    const raced: ReadContext = {
      ...f.read,
      records: {
        ...f.read.records,
        async list(options) {
          const result = await f.read.records.list(options);
          if (!changedHead && options?.contentType === 'builtin.files.checkpoint.file') {
            changedHead = true;
            const db = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
            try {
              db.run(
                'UPDATE extension_record SET revision=revision+1 WHERE extension_id=? AND scope_id=? AND key=?',
                ['builtin.files', 's', point.head.key],
              );
            } finally {
              db.close();
            }
          }
          return result;
        },
      },
    };
    let racedCode = '';
    try {
      await f.checkpoint.readPoint(raced, id);
    } catch (error) {
      racedCode = (error as { code: string }).code;
    }
    expect(racedCode).toBe('checkpoint_refresh_required');
    expect(f.calls).toBe(modelCalls);
    const foreign: ReadContext = { ...f.read, sessionId: 'foreign' };
    let denied = false;
    try {
      await f.checkpoint.readPoint(foreign, id);
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);
    writeFileSync(join(f.workspace, 'original'), 'external');
    expect(
      (await f.checkpoint.preview(f.read, id)).files.find((file) => file.path === 'original')!
        .status,
    ).toBe('conflict');
    await f.runtime.submitCommand({
      expectedStoreId: f.storeId,
      commandId: 'intent',
      sessionId: 's',
      subjectId: 'owner',
      request: {
        kind: 'extension.invoke',
        extensionId: 'builtin.files',
        actionId: 'fixture.intent',
        definitionVersion: '1',
        input: { pointId: id, restoreId: 'restore-one' },
      },
    });
    await f.runtime.waitForCommand('intent');
    const intent = await f.read.records.get('checkpoint/restore/restore-one');
    if (!intent)
      console.error(
        'intent diagnostic',
        JSON.stringify({
          command: await f.store.getCommand('intent'),
          executions: (await f.store.listExecutions('s'))
            .filter((e) => e.originCommandId === 'intent')
            .map((e) => ({ state: e.status, result: e.result })),
        }),
      );
    expect((intent!.value as { phase: string }).phase).toBe('blocked');
    const after = (await f.store.getMetadata()).lastChangeCursor;
    await f.runtime.submitCommand({
      expectedStoreId: f.storeId,
      commandId: 'intent',
      sessionId: 's',
      subjectId: 'owner',
      request: {
        kind: 'extension.invoke',
        extensionId: 'builtin.files',
        actionId: 'fixture.intent',
        definitionVersion: '1',
        input: { pointId: id, restoreId: 'restore-one' },
      },
    });
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(after);
    expect(readFileSync(join(f.workspace, 'original'), 'utf8')).toBe('external');
    expect(existsSync(join(f.workspace, 'created'))).toBe(true);
    expect(f.calls).toBe(modelCalls);
    const ref = original.first!.artifact!;
    const reference = await f.store.getArtifactReference({
      expectedStoreId: f.storeId,
      subjectId: 'owner',
      sessionId: 's',
      refId: ref.id,
      scope: ref.scope!,
    });
    rmSync(artifactPath(join(f.profile.dataRoot, f.profile.profile), reference!.hash));
    expect(
      (await f.checkpoint.preview(f.read, id)).files.find((file) => file.path === 'original')!
        .status,
    ).toBe('unavailable');
    rmSync(join(f.workspace, 'created'));
    expect(
      (await f.checkpoint.preview(f.read, id)).files.find((file) => file.path === 'created')!
        .status,
    ).toBe('conflict');
  } finally {
    await f.close();
  }
}, 15000);

test('recovery boundary maps the selected current Messages while retaining original point identity and separate file conflicts', async () => {
  const f = await fixture('restore-ask');
  try {
    await f.run();
    await f.runAgain();
    const points = (await f.checkpoint.listPoints(f.read)).items
      .map((item) => item.checkpoint)
      .sort((a, b) => (BigInt(a.boundary.triggerSeq) < BigInt(b.boundary.triggerSeq) ? -1 : 1));
    const first = points[0]!,
      second = points[1]!;
    const read = async (id: string) => {
      const views = await f.runtime.queryExtension({
        expectedStoreId: f.storeId,
        subjectId: 'owner',
        sessionId: 's',
        extensionId: 'builtin.files',
        queryId: 'files.checkpoint.recovery-boundary',
        input: { pointId: id },
      });
      expect(views).toHaveLength(1);
      expect(views[0]).toMatchObject({
        contentType: 'builtin.files.checkpoint.recovery-boundary',
        contentVersion: 1,
        artifactRefs: [],
        actions: [],
      });
      return views[0]!.payload as unknown;
    };
    const calls = f.calls;
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const before = (await f.store.getSession('s'))!;
    expect(await read(first.id)).toEqual({
      storeId: f.storeId,
      sessionId: 's',
      workspaceId: 'w',
      contextSelectionId: before.contextSelectionId,
      checkpoint: first,
      boundary: null,
      trigger: { messageId: first.boundary.triggerMessageId, seq: first.boundary.triggerSeq },
    });
    const secondBoundary = await read(second.id);
    expect(secondBoundary).toEqual({
      storeId: f.storeId,
      sessionId: 's',
      workspaceId: 'w',
      contextSelectionId: before.contextSelectionId,
      checkpoint: second,
      boundary: { messageId: second.boundary.messageId, seq: second.boundary.messageSeq },
      trigger: { messageId: second.boundary.triggerMessageId, seq: second.boundary.triggerSeq },
    });
    writeFileSync(join(f.workspace, 'original'), 'external conflict');
    expect(
      (await f.checkpoint.preview(f.read, second.id)).files.some(
        (file) => file.status === 'conflict',
      ),
    ).toBe(true);
    expect(await read(second.id)).toEqual(secondBoundary);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    const all = await f.store.getSelectedContext({
      expectedStoreId: f.storeId,
      sessionId: 's',
      contextSelectionId: before.contextSelectionId,
    });
    const last = all.messages.at(-1)!;
    await f.runtime.selectContext({
      expectedStoreId: f.storeId,
      commandId: 'same-members',
      sessionId: 's',
      subjectId: 'owner',
      expectedContextSelectionId: before.contextSelectionId,
      boundary: { messageId: last.id, seq: last.seq },
    });
    const selected = (await f.store.getSession('s'))!;
    expect(selected.contextSelectionId).not.toBe(before.contextSelectionId);
    expect(await read(second.id)).toEqual({
      ...(secondBoundary as Record<string, unknown>),
      contextSelectionId: selected.contextSelectionId,
    });
    await f.runtime.selectContext({
      expectedStoreId: f.storeId,
      commandId: 'exclude-trigger',
      sessionId: 's',
      subjectId: 'owner',
      expectedContextSelectionId: selected.contextSelectionId,
      boundary: null,
    });
    const finalCursor = (await f.store.getMetadata()).lastChangeCursor;
    let rejected: unknown;
    try {
      await read(second.id);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toMatchObject({ code: 'checkpoint_branch_not_selected' });
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(finalCursor);
    expect(readFileSync(join(f.workspace, 'original'), 'utf8')).toBe('external conflict');
    expect(f.calls).toBe(calls);
    expect(
      (await f.store.listExecutions('s')).filter((execution) => execution.kind === 'job'),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('missing trusted boundary produces zero Files effect and no invented checkpoint', async () => {
  const f = await fixture('no-boundary');
  try {
    await f.run();
    expect(readFileSync(join(f.workspace, 'original'))).toEqual(f.original);
    expect(existsSync(join(f.workspace, 'created'))).toBe(false);
    expect(await f.read.records.list({ contentType: 'builtin.files.checkpoint' })).toHaveLength(0);
    expect(
      (await f.store.listExecutions('s'))
        .filter((execution) => execution.definitionId === 'files.write')
        .every((execution) => execution.status === 'failed'),
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 15000);

test('actual publication followed by capture failure remains unknown with ineligible pending journal', async () => {
  const f = await fixture('after-fail');
  try {
    await f.run();
    expect(bytesDigest(readFileSync(join(f.workspace, 'original')))).toBe(
      bytesDigest(Buffer.from('middle\r\n')),
    );
    const executions = await f.store.listExecutions('s');
    expect(executions.find((execution) => execution.definitionId === 'files.write')!.status).toBe(
      'outcome_unknown',
    );
    const points = await f.read.records.list({ contentType: 'builtin.files.checkpoint' });
    const id = (points[0]!.value as { id: string }).id;
    const saved = await f.checkpoint.readPoint(f.read, id);
    expect(saved.files[0]!.first).toBeNull();
    expect(saved.files[0]!.state).toBe('unknown');
    expect(saved.files[0]!.pending).not.toBeNull();
    expect((await f.checkpoint.preview(f.read, id)).files[0]!.status).toBe('unavailable');
  } finally {
    await f.close();
  }
}, 15000);

test('actual competing namespace revision after publication rejects CAS and preserves unknown/incomplete', async () => {
  const f = await fixture('after-cas');
  try {
    await f.run();
    expect(bytesDigest(readFileSync(join(f.workspace, 'original')))).toBe(
      bytesDigest(Buffer.from('middle\r\n')),
    );
    const tool = (await f.store.listExecutions('s')).find(
      (execution) => execution.definitionId === 'files.write',
    )!;
    expect(tool.status).toBe('outcome_unknown');
    const points = await f.read.records.list({ contentType: 'builtin.files.checkpoint' });
    const id = (points[0]!.value as { id: string }).id;
    const value = await f.checkpoint.readPoint(f.read, id);
    expect(value.head.state).toBe('pending');
    expect(value.files[0]!.first).toBeNull();
    expect(value.files[0]!.pending).not.toBeNull();
    expect((await f.checkpoint.preview(f.read, id)).files[0]!.status).toBe('unavailable');
  } finally {
    await f.close();
  }
}, 15000);

test('cancel during actual immutable preimage publication leaves original file and no recoverable journal', async () => {
  const f = await fixture('capture-cancel');
  try {
    const work = f.run();
    const deadline = Date.now() + 3000;
    while (!f.captureEntered && Date.now() < deadline) await Bun.sleep(10);
    expect(f.captureEntered).toBe(true);
    await f.runtime.cancelCommand({
      expectedStoreId: f.storeId,
      commandId: 'cancel',
      sessionId: 's',
      subjectId: 'owner',
      targetCommandId: 'work',
    });
    f.releaseCapture();
    await work;
    expect(bytesDigest(readFileSync(join(f.workspace, 'original')))).toBe(bytesDigest(f.original));
    expect(existsSync(join(f.workspace, 'created'))).toBe(false);
    const records = await f.read.records.list({ contentType: 'builtin.files.checkpoint.file' });
    expect(records).toHaveLength(0);
    expect(
      (await f.store.listExecutions('s')).find(
        (execution) => execution.definitionId === 'files.write',
      )!.status,
    ).toBe('cancelled');
  } finally {
    await f.close();
  }
}, 15000);

async function invokeRestore(
  f: Awaited<ReturnType<typeof fixture>>,
  checkpointId: string,
  commandId = 'restore',
  restoreId = 'restore-real',
) {
  return f.runtime.submitCommand({
    expectedStoreId: f.storeId,
    commandId,
    sessionId: 's',
    subjectId: 'owner',
    request: {
      kind: 'extension.invoke',
      extensionId: 'builtin.files',
      actionId: 'files.checkpoint.restore',
      definitionVersion: '1',
      input: { checkpointId, restoreId },
    },
  });
}
async function restoreApproval(f: Awaited<ReturnType<typeof fixture>>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const page = await f.runtime.listInteractions({
      expectedStoreId: f.storeId,
      sessionId: 's',
      state: 'pending',
    });
    if (page.interactions[0]) return page.interactions[0];
    await Bun.sleep(10);
  }
  console.error(
    'restore Ask diagnostic',
    JSON.stringify({
      command: await f.store.getCommand('restore'),
      executions: (await f.store.listExecutions('s'))
        .filter((e) => e.originCommandId === 'restore')
        .map((e) => ({ id: e.id, status: e.status, result: e.result })),
      safety: await f.store.readExecutionGroupSafety({
        expectedStoreId: f.storeId,
        sessionId: 's',
        subjectId: 'owner',
      }),
    }),
  );
  throw new Error('actual restore Ask missing');
}
async function approveRestore(
  f: Awaited<ReturnType<typeof fixture>>,
  record: Awaited<ReturnType<typeof restoreApproval>>,
) {
  await f.runtime.answerInteraction({
    expectedStoreId: f.storeId,
    commandId: `answer-${record.id}`,
    presentationSessionId: record.presentationSessionId,
    interactionId: record.id,
    expectedRevision: record.revision,
    subjectId: 'owner',
    answer: { kind: 'approval', decision: 'approve' },
  });
}
async function earliestPoint(f: Awaited<ReturnType<typeof fixture>>) {
  const points = await f.read.records.list({ contentType: 'builtin.files.checkpoint' });
  return points
    .map((point) => point.value as { id: string; boundary: { triggerSeq: string } })
    .sort((a, b) => (BigInt(a.boundary.triggerSeq) < BigInt(b.boundary.triggerSeq) ? -1 : 1))[0]!
    .id;
}

test('actual code-only restore independently asks, aggregates selected later Run, restores full original bytes and removes creations without Model', async () => {
  const f = await fixture('restore-ask');
  try {
    await f.run();
    await f.runAgain();
    const id = await earliestPoint(f);
    const preview = await f.checkpoint.preview(f.read, id);
    expect(preview.files.map((file) => [file.path, file.status])).toEqual([
      ['created', 'remove'],
      ['created-next', 'remove'],
      ['original', 'restore'],
    ]);
    const calls = f.calls;
    const selection = (await f.store.getSession('s'))!.contextSelectionId;
    let physicalRestore = 0,
      physicalRemove = 0;
    const restore = f.checkpoint.files.restore,
      remove = f.checkpoint.files.remove;
    f.checkpoint.files.restore = async (input) => {
      physicalRestore++;
      return restore(input);
    };
    f.checkpoint.files.remove = async (input) => {
      physicalRemove++;
      return remove(input);
    };
    await invokeRestore(f, id);
    const ask = await restoreApproval(f);
    expect(readFileSync(join(f.workspace, 'original'), 'utf8')).toBe('next-last\r\n');
    expect(existsSync(join(f.workspace, 'created'))).toBe(true);
    expect(f.calls).toBe(calls);
    await approveRestore(f, ask);
    await f.runtime.waitForCommand('restore');
    const journal = await f.checkpoint.readRestoreIntent(f.read, id, 'restore-real');
    if (!journal)
      console.error(
        'restore dispatch diagnostic',
        JSON.stringify({
          command: await f.store.getCommand('restore'),
          executions: (await f.store.listExecutions('s'))
            .filter((e) => e.originCommandId === 'restore')
            .map((e) => ({
              id: e.id,
              status: e.status,
              result: e.result,
              source: e.decisionSource,
            })),
        }),
      );
    expect(journal!.value).toMatchObject({
      phase: 'restored',
      files: [
        { state: 'removed', confirmedPost: { baseline: null } },
        { state: 'removed', confirmedPost: { baseline: null } },
        { state: 'restored' },
      ],
    });
    expect(journal!.contentVersion).toBe(2);
    const confirmed = journal!
      .value as unknown as import('../../../src/files').FileCheckpointRestoreJournal;
    const restoredFile = confirmed.files.find((file) => file.path === 'original')!;
    const actualRestored = await f.checkpoint.files.readBytes('original', {
      maxBytes: 2 * 1024 * 1024,
    });
    expect(restoredFile.confirmedPost).toEqual({ baseline: actualRestored.baseline });
    expect(restoredFile.confirmedPost!.baseline!.inode).not.toBe(restoredFile.expected!.inode);
    expect(restoredFile.confirmedPost!.baseline!.hash).toBe(restoredFile.original!.hash);
    expect(restoredFile.confirmedPost!.baseline!.size).toBe(f.original.byteLength);
    expect(readFileSync(join(f.workspace, 'original'))).toEqual(f.original);
    expect(existsSync(join(f.workspace, 'created'))).toBe(false);
    expect(existsSync(join(f.workspace, 'created-next'))).toBe(false);
    expect((await f.store.getSession('s'))!.contextSelectionId).toBe(selection);
    expect([physicalRestore, physicalRemove]).toEqual([1, 2]);
    expect(f.calls).toBe(calls);
    const commands = await f.store.listAcceptedCommands('s');
    expect(commands).toHaveLength(0);
    const revision = journal!.revision;
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await invokeRestore(f, id); // Original Command replay, no Action or I/O.
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect((await f.checkpoint.readRestoreIntent(f.read, id, 'restore-real'))!.revision).toBe(
      revision,
    );
    await f.runtime.close();
    const cold = await openSqliteStore(f.profile);
    const runtime = createRuntime({
      store: cold,
      extensions: [f.checkpoint.extension],
      model: {
        stream() {
          throw new Error('cold replay must not call Model');
        },
      },
      modelId: 'fixed',
      workspaceSerialLocks: createWorkspaceSerialLocks(f.profile),
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'cold' };
        },
      },
    });
    try {
      const before = readFileSync(join(f.workspace, 'original'));
      await runtime.submitCommand({
        expectedStoreId: f.storeId,
        commandId: 'cold-replay',
        sessionId: 's',
        subjectId: 'owner',
        request: {
          kind: 'extension.invoke',
          extensionId: 'builtin.files',
          actionId: 'files.checkpoint.restore',
          definitionVersion: '1',
          input: { checkpointId: id, restoreId: 'restore-real' },
        },
      });
      await runtime.waitForCommand('cold-replay');
      expect(readFileSync(join(f.workspace, 'original'))).toEqual(before);
      expect(
        (await cold.getExtensionRecord({
          sessionId: 's',
          extensionId: 'builtin.files',
          key: 'checkpoint/restore/restore-real',
        }))!.revision,
      ).toBe(revision);
      expect(
        (await cold.getExtensionRecord({
          sessionId: 's',
          extensionId: 'builtin.files',
          key: 'checkpoint/restore/restore-real',
        }))!.value,
      ).toEqual(journal!.value);
      expect(
        (await cold.listExecutions('s')).filter(
          (execution) => execution.originCommandId === 'cold-replay',
        )[0]!.status,
      ).toBe('succeeded');
      expect([physicalRestore, physicalRemove]).toEqual([1, 2]);
    } finally {
      await runtime.close();
    }
  } finally {
    await f.close();
  }
});

test('confirmed later restore and a new Run retain full earlier preimages and use each actual new inode', async () => {
  const f = await fixture('restore-ask');
  try {
    await f.run();
    await f.runAgain();
    const points = (await f.read.records.list({ contentType: 'builtin.files.checkpoint' }))
      .map((record) => record.value as { id: string; boundary: { triggerSeq: string } })
      .sort((a, b) => (BigInt(a.boundary.triggerSeq) < BigInt(b.boundary.triggerSeq) ? -1 : 1));
    expect(points).toHaveLength(2);
    const early = points[0]!.id,
      later = points[1]!.id;
    const modelCalls = f.calls;
    const selection = (await f.store.getSession('s'))!.contextSelectionId;
    await invokeRestore(f, later, 'restore-later', 'restore-later-id');
    const laterAsk = await restoreApproval(f);
    expect((await f.store.getExecution(laterAsk.executionId))!.originCommandId).toBe(
      'restore-later',
    );
    await approveRestore(f, laterAsk);
    await f.runtime.waitForCommand('restore-later');
    const laterRecord = await f.checkpoint.readRestoreIntent(f.read, later, 'restore-later-id');
    const laterJournal = laterRecord!
      .value as unknown as import('../../../src/files').FileCheckpointRestoreJournal;
    expect(laterJournal.phase).toBe('restored');
    const lateFile = laterJournal.files.find((file) => file.path === 'original')!;
    const afterLate = await f.checkpoint.files.readBytes('original', { maxBytes: 2 * 1024 * 1024 });
    expect(lateFile.confirmedPost).toEqual({ baseline: afterLate.baseline });
    expect(afterLate.baseline.inode).not.toBe(lateFile.expected!.inode);
    expect(Buffer.from(afterLate.bytes).equals(Buffer.from('last\r\n'))).toBe(true);
    expect(existsSync(join(f.workspace, 'created'))).toBe(true);
    expect(existsSync(join(f.workspace, 'created-next'))).toBe(false);
    const earlyPreview = await f.checkpoint.preview(f.read, early);
    expect(earlyPreview.files.map((file) => [file.path, file.status])).toEqual([
      ['created', 'remove'],
      ['created-next', 'unchanged'],
      ['original', 'restore'],
    ]);
    expect(earlyPreview.files.find((file) => file.path === 'original')!.expected).toEqual(
      afterLate.baseline,
    );
    await invokeRestore(f, early, 'restore-earlier', 'restore-earlier-id');
    const earlyAsk = await restoreApproval(f);
    expect((await f.store.getExecution(earlyAsk.executionId))!.originCommandId).toBe(
      'restore-earlier',
    );
    expect(earlyAsk.id).not.toBe(laterAsk.id);
    await approveRestore(f, earlyAsk);
    await f.runtime.waitForCommand('restore-earlier');
    const earlyRecord = await f.checkpoint.readRestoreIntent(f.read, early, 'restore-earlier-id');
    const earlyJournal = earlyRecord!
      .value as unknown as import('../../../src/files').FileCheckpointRestoreJournal;
    expect(earlyJournal.phase).toBe('restored');
    const afterEarly = await f.checkpoint.files.readBytes('original', {
      maxBytes: 2 * 1024 * 1024,
    });
    expect(Buffer.from(afterEarly.bytes).equals(f.original)).toBe(true);
    expect(afterEarly.baseline.inode).not.toBe(afterLate.baseline.inode);
    expect(earlyJournal.files.find((file) => file.path === 'original')!.confirmedPost).toEqual({
      baseline: afterEarly.baseline,
    });
    expect(f.calls).toBe(modelCalls);
    expect((await f.store.getSession('s'))!.contextSelectionId).toBe(selection);
    await f.runAgain('work-after-confirmed-restores');
    expect(f.calls).toBe(modelCalls + 4);
    const subsequent = await f.checkpoint.preview(f.read, early);
    expect(subsequent.files.map((file) => [file.path, file.status])).toEqual([
      ['created', 'unchanged'],
      ['created-next', 'remove'],
      ['original', 'restore'],
    ]);
    await invokeRestore(f, early, 'restore-after-next-run', 'restore-after-next-run-id');
    const nextAsk = await restoreApproval(f);
    expect(nextAsk.id).not.toBe(earlyAsk.id);
    await approveRestore(f, nextAsk);
    await f.runtime.waitForCommand('restore-after-next-run');
    expect(
      (await f.checkpoint.readRestoreIntent(f.read, early, 'restore-after-next-run-id'))!.value,
    ).toMatchObject({ phase: 'restored' });
    expect(readFileSync(join(f.workspace, 'original')).equals(f.original)).toBe(true);
    expect(existsSync(join(f.workspace, 'created-next'))).toBe(false);
    expect(f.calls).toBe(modelCalls + 4);
  } finally {
    await f.close();
  }
}, 15000);

test('known failed carrier and an empty effect ledger retain zero-effect evidence without blocking a fresh restore or Fork', async () => {
  const f = await fixture('restore-before-image-fail');
  try {
    await f.run();
    const pointId = await earliestPoint(f);
    const before = await f.checkpoint.files.readBytes('original', { maxBytes: 2 * 1024 * 1024 });
    const createdBefore = await f.checkpoint.files.readBytes('created', {
      maxBytes: 2 * 1024 * 1024,
    });
    const modelCalls = f.calls;
    let physicalRestores = 0,
      physicalRemoves = 0;
    const restore = f.checkpoint.files.restore,
      remove = f.checkpoint.files.remove;
    f.checkpoint.files.restore = async (input) => {
      physicalRestores++;
      return restore(input);
    };
    f.checkpoint.files.remove = async (input) => {
      physicalRemoves++;
      return remove(input);
    };
    await invokeRestore(f, pointId, 'restore-no-effect', 'restore-no-effect-id');
    const firstAsk = await restoreApproval(f);
    await approveRestore(f, firstAsk);
    await f.runtime.waitForCommand('restore-no-effect');
    const failed = await f.checkpoint.readRestoreIntent(f.read, pointId, 'restore-no-effect-id');
    expect(failed!.value).toMatchObject({
      phase: 'failed',
      files: [
        { path: 'created', state: 'failed', confirmedPost: null },
        { path: 'original', state: 'not_started', confirmedPost: null },
      ],
    });
    const carrier = (await f.store.listExecutions('s')).find(
      (execution) => execution.originCommandId === 'restore-no-effect',
    )!;
    expect(carrier.status).toBe('failed');
    expect(JSON.parse((carrier.result as { content: string }).content)).toEqual(failed!.value);
    expect(
      await f.read.records.list({ contentType: 'builtin.files.checkpoint.restore-effect' }),
    ).toHaveLength(0);
    expect(
      (await f.checkpoint.files.readBytes('original', { maxBytes: 2 * 1024 * 1024 })).baseline,
    ).toEqual(before.baseline);
    expect(
      (await f.checkpoint.files.readBytes('created', { maxBytes: 2 * 1024 * 1024 })).baseline,
    ).toEqual(createdBefore.baseline);
    expect([physicalRestores, physicalRemoves]).toEqual([0, 0]);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await invokeRestore(f, pointId, 'restore-no-effect', 'restore-no-effect-id');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect([physicalRestores, physicalRemoves]).toEqual([0, 0]);
    expect((await f.checkpoint.preview(f.read, pointId)).files.map((file) => file.status)).toEqual([
      'remove',
      'restore',
    ]);
    await f.runtime.forkSession({
      expectedStoreId: f.storeId,
      commandId: 'fork-after-no-effect',
      sourceSessionId: 's',
      expectedContextSelectionId: (await f.store.getSession('s'))!.contextSelectionId,
      newSessionId: 'fork-after-no-effect-session',
      subjectId: 'owner',
      title: 'Fork with exact failed no-effect evidence',
    });
    const anchor = await f.store.getExtensionRecord({
      sessionId: 'fork-after-no-effect-session',
      extensionId: 'builtin.files',
      key: 'checkpoint/fork/snapshot',
    });
    const events = (
      anchor!
        .value as unknown as import('../../../src/business/file-checkpoints/types').FileCheckpointForkSnapshot
    ).events;
    expect(events.map((event) => event.kind)).toEqual(['capture', 'restore']);
    const retained = events[1]!;
    expect(retained.kind).toBe('restore');
    if (retained.kind !== 'restore') throw new Error('failed restore source evidence missing');
    expect(retained.journal.sessionId).toBe('s');
    expect(retained.journal.value).toEqual(failed!.value);
    expect(retained.effects).toHaveLength(0);
    expect([physicalRestores, physicalRemoves]).toEqual([0, 0]);
    await invokeRestore(f, pointId, 'restore-after-no-effect', 'restore-after-no-effect-id');
    const secondAsk = await restoreApproval(f);
    expect(secondAsk.id).not.toBe(firstAsk.id);
    await approveRestore(f, secondAsk);
    await f.runtime.waitForCommand('restore-after-no-effect');
    expect(
      (await f.checkpoint.readRestoreIntent(f.read, pointId, 'restore-after-no-effect-id'))!.value,
    ).toMatchObject({ phase: 'restored' });
    expect(readFileSync(join(f.workspace, 'original')).equals(f.original)).toBe(true);
    expect(existsSync(join(f.workspace, 'created'))).toBe(false);
    expect([physicalRestores, physicalRemoves]).toEqual([1, 1]);
    expect(f.calls).toBe(modelCalls);
  } finally {
    await f.close();
  }
}, 15000);

test('a committed pending effect ledger never becomes a zero-effect proof or permits Fork and replayed file effects', async () => {
  const f = await fixture('restore-after-ledger-fail');
  try {
    await f.run();
    const pointId = await earliestPoint(f);
    const before = await f.checkpoint.files.readBytes('original', { maxBytes: 2 * 1024 * 1024 });
    const createdBefore = await f.checkpoint.files.readBytes('created', {
      maxBytes: 2 * 1024 * 1024,
    });
    const calls = f.calls;
    let physicalEffects = 0;
    const restore = f.checkpoint.files.restore,
      remove = f.checkpoint.files.remove;
    f.checkpoint.files.restore = async (input) => {
      physicalEffects++;
      return restore(input);
    };
    f.checkpoint.files.remove = async (input) => {
      physicalEffects++;
      return remove(input);
    };
    await invokeRestore(f, pointId);
    await approveRestore(f, await restoreApproval(f));
    await f.runtime.waitForCommand('restore');
    const journal = await f.checkpoint.readRestoreIntent(f.read, pointId, 'restore-real');
    expect(journal!.value).toMatchObject({ phase: 'failed' });
    const effects = await f.read.records.list({
      contentType: 'builtin.files.checkpoint.restore-effect',
    });
    expect(effects).toHaveLength(1);
    expect(effects[0]!.value).toMatchObject({ state: 'pending', confirmedPost: null });
    const preview = await f.checkpoint.preview(f.read, pointId);
    expect(
      preview.files.every(
        (file) => file.status === 'unavailable' && file.reason === 'checkpoint_restore_unconfirmed',
      ),
    ).toBe(true);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const selectedId = (await f.store.getSession('s'))!.contextSelectionId;
    let forkFailure: unknown;
    try {
      await f.runtime.forkSession({
        expectedStoreId: f.storeId,
        commandId: 'fork-after-pending-ledger',
        sourceSessionId: 's',
        expectedContextSelectionId: selectedId,
        newSessionId: 'forbidden-pending-ledger-fork',
        subjectId: 'owner',
        title: 'Cannot reinterpret a pending effect as zero effects',
      });
    } catch (error) {
      forkFailure = error;
    }
    expect(forkFailure).toMatchObject({ code: 'checkpoint_restore_unconfirmed' });
    expect(await f.store.getSession('forbidden-pending-ledger-fork')).toBeNull();
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    await invokeRestore(f, pointId);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(
      (await f.checkpoint.files.readBytes('original', { maxBytes: 2 * 1024 * 1024 })).baseline,
    ).toEqual(before.baseline);
    expect(
      (await f.checkpoint.files.readBytes('created', { maxBytes: 2 * 1024 * 1024 })).baseline,
    ).toEqual(createdBefore.baseline);
    expect(physicalEffects).toBe(0);
    expect(f.calls).toBe(calls);
  } finally {
    await f.close();
  }
}, 15000);

test('post-publication invalid byte confirmation cannot seal a usable restore baseline or permit another effect', async () => {
  const f = await fixture('restore-ask');
  try {
    await f.run();
    const pointId = await earliestPoint(f);
    const originalRestore = f.checkpoint.files.restore;
    let publications = 0;
    f.checkpoint.files.restore = async (input) => {
      const result = await originalRestore(input);
      publications++;
      return { ...result, baseline: { ...result.baseline, hash: '0'.repeat(64) } };
    };
    const calls = f.calls;
    await invokeRestore(f, pointId);
    await approveRestore(f, await restoreApproval(f));
    await f.runtime.waitForCommand('restore');
    const execution = (await f.store.listExecutions('s')).find(
      (value) => value.originCommandId === 'restore',
    );
    expect(execution!.status).toBe('outcome_unknown');
    expect(readFileSync(join(f.workspace, 'original'))).toEqual(f.original);
    const journal = await f.checkpoint.readRestoreIntent(f.read, pointId, 'restore-real');
    expect(journal!.contentVersion).toBe(2);
    expect(journal!.value).toMatchObject({ phase: 'outcome_unknown' });
    const state = journal!
      .value as unknown as import('../../../src/files').FileCheckpointRestoreJournal;
    expect(state.files.find((value) => value.path === 'original')).toMatchObject({
      state: 'outcome_unknown',
      confirmedPost: null,
      error: 'checkpoint_restore_confirmation_invalid',
    });
    expect(publications).toBe(1);
    expect(f.calls).toBe(calls);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await invokeRestore(f, pointId);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(publications).toBe(1);
    expect(f.calls).toBe(calls);
    expect(
      (
        await f.store.readExecutionGroupSafety({
          expectedStoreId: f.storeId,
          sessionId: 's',
          subjectId: 'owner',
        })
      ).quiescent,
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test('original selected branch membership and actual last image conflict reject restoration with zero writes and zero Model', async () => {
  const f = await fixture('restore-ask');
  try {
    await f.run();
    const id = await earliestPoint(f);
    const calls = f.calls;
    const session = (await f.store.getSession('s'))!;
    await f.runtime.selectContext({
      expectedStoreId: f.storeId,
      commandId: 'rewind',
      sessionId: 's',
      subjectId: 'owner',
      expectedContextSelectionId: session.contextSelectionId,
      boundary: null,
    });
    expect(
      (await f.checkpoint.preview(f.read, id)).files.every((file) => file.status === 'unavailable'),
    ).toBe(true);
    await invokeRestore(f, id);
    await f.runtime.waitForCommand('restore');
    expect(await f.checkpoint.readRestoreIntent(f.read, id, 'restore-real')).toBeNull();
    expect(readFileSync(join(f.workspace, 'original'), 'utf8')).toBe('last\r\n');
    expect(existsSync(join(f.workspace, 'created'))).toBe(true);
    expect(f.calls).toBe(calls);
  } finally {
    await f.close();
  }
  const changed = await fixture('restore-ask');
  try {
    await changed.run();
    const id = await earliestPoint(changed);
    const calls = changed.calls;
    writeFileSync(join(changed.workspace, 'original'), 'external');
    await invokeRestore(changed, id);
    await changed.runtime.waitForCommand('restore');
    expect(await changed.checkpoint.readRestoreIntent(changed.read, id, 'restore-real')).toBeNull();
    expect(readFileSync(join(changed.workspace, 'original'), 'utf8')).toBe('external');
    expect(existsSync(join(changed.workspace, 'created'))).toBe(true);
    expect(changed.calls).toBe(calls);
  } finally {
    await changed.close();
  }
});

test('actual namespace final read-set drift after Ask prevents every restoration effect', async () => {
  const f = await fixture('restore-ask');
  try {
    await f.run();
    const id = await earliestPoint(f);
    const calls = f.calls;
    const mark = f.store.markDispatching;
    let drifted = false;
    f.store.markDispatching = async (input) => {
      if (!drifted && input.readSet?.executionGroup) {
        drifted = true;
        const db = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
        try {
          db.run(
            'UPDATE extension_record SET revision=revision+1 WHERE extension_id=? AND scope_id=? AND key=?',
            ['builtin.files', 's', `checkpoint/${id}/head`],
          );
        } finally {
          db.close();
        }
      }
      return mark(input);
    };
    await invokeRestore(f, id);
    const ask = await restoreApproval(f);
    await approveRestore(f, ask);
    await f.runtime.waitForCommand('restore');
    expect(await f.checkpoint.readRestoreIntent(f.read, id, 'restore-real')).toBeNull();
    expect(readFileSync(join(f.workspace, 'original'), 'utf8')).toBe('last\r\n');
    expect(existsSync(join(f.workspace, 'created'))).toBe(true);
    expect(f.calls).toBe(calls);
    expect(
      (await f.store.listExecutions('s'))
        .filter((execution) => execution.originCommandId === 'restore')
        .every((execution) => execution.status !== 'succeeded'),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('publication followed by actual restore journal CAS failure remains unknown with original pending intent and persistent fence', async () => {
  const f = await fixture('restore-seal');
  try {
    await f.run();
    const id = await earliestPoint(f);
    const calls = f.calls;
    await invokeRestore(f, id);
    const ask = await restoreApproval(f);
    await approveRestore(f, ask);
    await f.runtime.waitForCommand('restore');
    const execution = (await f.store.listExecutions('s')).find(
      (execution) => execution.originCommandId === 'restore',
    )!;
    expect(execution.status).toBe('outcome_unknown');
    const journal = await f.checkpoint.readRestoreIntent(f.read, id, 'restore-real');
    expect(journal!.value).toMatchObject({
      phase: 'restoring',
      files: [{ state: 'removed' }, { state: 'pending' }],
    });
    expect(readFileSync(join(f.workspace, 'original'))).toEqual(f.original);
    expect(existsSync(join(f.workspace, 'created'))).toBe(false);
    const safety = await f.store.readExecutionGroupSafety({
      expectedStoreId: f.storeId,
      sessionId: 's',
      subjectId: 'owner',
    });
    expect(safety.quiescent).toBe(false);
    expect(safety.unconfirmedExecutionIds).toContain(execution.id);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await invokeRestore(f, id);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect((await f.checkpoint.readRestoreIntent(f.read, id, 'restore-real'))!.revision).toBe(
      journal!.revision,
    );
    expect(f.calls).toBe(calls);
    const status = await f.runtime.queryExtension({
      expectedStoreId: f.storeId,
      subjectId: 'owner',
      sessionId: 's',
      extensionId: 'builtin.files',
      queryId: 'files.checkpoint.restore-status',
      input: { checkpointId: id, restoreId: 'restore-real' },
    });
    expect(status[0]!.payload).toMatchObject({
      journal: journal!.value,
      execution: { id: execution.id, status: 'outcome_unknown' },
    });
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    await f.runtime.close();
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      const read: ReadContext = {
        ...f.read,
        records: {
          get: (key) =>
            cold.getExtensionRecord({ sessionId: 's', extensionId: 'builtin.files', key }),
          list: (options) =>
            cold.listExtensionRecords({ sessionId: 's', extensionId: 'builtin.files', ...options }),
        },
      };
      expect((await f.checkpoint.readRestoreIntent(read, id, 'restore-real'))!.value).toEqual(
        journal!.value,
      );
      expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
      expect(readFileSync(join(f.workspace, 'original'))).toEqual(f.original);
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});

test('missing immutable preimage and actual Model proof drift reject the Action before any file publication', async () => {
  for (const fault of ['media', 'model-proof'] as const) {
    const f = await fixture('restore-ask');
    try {
      await f.run();
      const id = await earliestPoint(f);
      const calls = f.calls;
      const point = await f.checkpoint.readPoint(f.read, id);
      const original = point.files.find((file) => file.path === 'original')!;
      if (fault === 'media') {
        const ref = await f.store.getArtifactReference({
          expectedStoreId: f.storeId,
          sessionId: 's',
          subjectId: 'owner',
          scope: original.first!.artifact!.scope!,
          refId: original.first!.artifact!.id,
        });
        rmSync(artifactPath(join(f.profile.dataRoot, f.profile.profile), ref!.hash));
      } else {
        const db = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
        try {
          db.run(
            "UPDATE extension_record SET json=json_set(json,'$.first.source.modelInputHash',?),revision=revision+1 WHERE extension_id=? AND scope_id=? AND key=?",
            [
              '0'.repeat(64),
              'builtin.files',
              's',
              `checkpoint/${id}/file/${bytesDigest(Buffer.from('original'))}`,
            ],
          );
        } finally {
          db.close();
        }
      }
      await invokeRestore(f, id);
      await f.runtime.waitForCommand('restore');
      expect(await f.checkpoint.readRestoreIntent(f.read, id, 'restore-real')).toBeNull();
      expect(readFileSync(join(f.workspace, 'original'), 'utf8')).toBe('last\r\n');
      expect(existsSync(join(f.workspace, 'created'))).toBe(true);
      expect(f.calls).toBe(calls);
      expect(
        (
          await f.runtime.listInteractions({
            expectedStoreId: f.storeId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions,
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  }
});

test('actual selected-context change between approved final capture and SQL dispatch rejects the original restoration', async () => {
  const f = await fixture('restore-ask');
  try {
    await f.run();
    const id = await earliestPoint(f);
    const calls = f.calls;
    const original = (await f.store.getSession('s'))!.contextSelectionId;
    const page = await f.store.getSelectedContext({
      expectedStoreId: f.storeId,
      sessionId: 's',
      contextSelectionId: original,
      messageLimit: 200,
      sourceLimit: 100,
    });
    const last = page.messages.at(-1)!;
    await f.runtime.selectContext({
      expectedStoreId: f.storeId,
      commandId: 'retained-selection',
      sessionId: 's',
      subjectId: 'owner',
      expectedContextSelectionId: original,
      boundary: { messageId: last.id, seq: last.seq },
    });
    const mark = f.store.markDispatching;
    let selected = false;
    f.store.markDispatching = async (input) => {
      if (!selected && input.readSet?.executionGroup) {
        selected = true;
        const db = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
        try {
          db.run('UPDATE session SET context_selection_id=? WHERE id=?', [original, 's']);
        } finally {
          db.close();
        }
      }
      return mark(input);
    };
    await invokeRestore(f, id);
    const ask = await restoreApproval(f);
    await approveRestore(f, ask);
    await f.runtime.waitForCommand('restore');
    expect(selected).toBe(true);
    expect(await f.checkpoint.readRestoreIntent(f.read, id, 'restore-real')).toBeNull();
    expect(readFileSync(join(f.workspace, 'original'), 'utf8')).toBe('last\r\n');
    expect(existsSync(join(f.workspace, 'created'))).toBe(true);
    expect(f.calls).toBe(calls);
    const actual = (await f.store.listExecutions('s')).find(
      (execution) => execution.originCommandId === 'restore',
    )!;
    expect(actual.status).toBe('failed');
    expect(actual.result).toMatchObject({
      details: { adapterAttempted: false, code: 'execution_group_not_quiescent' },
    });
  } finally {
    await f.close();
  }
});

test('accepted independent work at final SQL cannot be excluded by the restoring carrier', async () => {
  const f = await fixture('restore-ask');
  try {
    await f.run();
    const id = await earliestPoint(f);
    const calls = f.calls;
    const mark = f.store.markDispatching;
    let accepted = false;
    f.store.markDispatching = async (input) => {
      if (!accepted && input.readSet?.executionGroup) {
        accepted = true;
        await f.store.acceptCommand({
          expectedStoreId: f.storeId,
          commandId: 'independent',
          sessionId: 's',
          subjectId: 'owner',
          request: {
            kind: 'extension.invoke',
            extensionId: 'builtin.files',
            actionId: 'fixture.intent',
            definitionVersion: '1',
            input: { pointId: id, restoreId: 'independent-blocked' },
          },
        });
      }
      return mark(input);
    };
    await invokeRestore(f, id);
    const ask = await restoreApproval(f);
    await approveRestore(f, ask);
    await f.runtime.waitForCommand('restore');
    await f.runtime.waitForCommand('independent');
    expect(accepted).toBe(true);
    expect(await f.checkpoint.readRestoreIntent(f.read, id, 'restore-real')).toBeNull();
    expect(readFileSync(join(f.workspace, 'original'), 'utf8')).toBe('last\r\n');
    expect(existsSync(join(f.workspace, 'created'))).toBe(true);
    expect(f.calls).toBe(calls);
    expect(
      (await f.store.listExecutions('s')).find(
        (execution) => execution.originCommandId === 'restore',
      )!.result,
    ).toMatchObject({
      details: { adapterAttempted: false, code: 'execution_group_not_quiescent' },
    });
  } finally {
    await f.close();
  }
});

test('pure scoped registration shares original descriptors and lazily owns/closes each actual Tool, query and restoration attempt', async () => {
  let called = 0;
  const readonly = createScopedFileCheckpointing(async () => {
    called++;
    throw new Error('must not resolve during registration');
  });
  expect(called).toBe(0);
  expect(readonly.tools).toBeUndefined();
  const f = await fixture('lazy');
  try {
    expect(f.resolved).toBe(0);
    const metadata = (extension: typeof f.extension) => ({
      id: extension.id,
      version: extension.version,
      records: extension.records,
      tools: extension.tools?.map(({ execute: _execute, ...metadata }) => metadata),
      actions: extension.actions
        ?.filter((action) => action.id === 'files.checkpoint.restore')
        .map(({ prepare: _prepare, execute: _execute, ...metadata }) => metadata),
      queries: extension.queries?.map(({ execute: _execute, ...metadata }) => metadata),
    });
    expect(metadata(f.extension)).toEqual(metadata(f.checkpoint.extension));
    await f.run();
    const id = await earliestPoint(f);
    const calls = f.calls;
    expect([f.resolved, f.closed]).toEqual([3, 3]);
    const before = (await f.store.getMetadata()).lastChangeCursor;
    const views = await f.runtime.queryExtension({
      expectedStoreId: f.storeId,
      subjectId: 'owner',
      sessionId: 's',
      extensionId: 'builtin.files',
      queryId: 'files.checkpoint.detail',
      input: { pointId: id },
    });
    expect(
      (views[0]!.payload as { files: { status: string }[] }).files.map((file) => file.status),
    ).toEqual(['remove', 'restore']);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
    expect([f.resolved, f.closed]).toEqual([4, 4]);
    await invokeRestore(f, id);
    const ask = await restoreApproval(f);
    expect(f.resolved).toBe(f.closed);
    await approveRestore(f, ask);
    await f.runtime.waitForCommand('restore');
    expect(readFileSync(join(f.workspace, 'original'))).toEqual(f.original);
    expect(existsSync(join(f.workspace, 'created'))).toBe(false);
    expect(f.resolved).toBe(f.closed);
    expect(f.resolved).toBeGreaterThanOrEqual(6);
    expect(f.calls).toBe(calls);
    let missingError: unknown;
    try {
      await f.runtime.queryExtension({
        expectedStoreId: f.storeId,
        subjectId: 'owner',
        sessionId: 's',
        extensionId: 'builtin.files',
        queryId: 'files.checkpoint.detail',
        input: { pointId: '0'.repeat(64) },
      });
    } catch (error) {
      missingError = error;
    }
    expect(missingError).toMatchObject({ code: 'checkpoint_not_found' });
    expect(f.resolved).toBe(f.closed);
  } finally {
    await f.close();
  }
});

test('scoped close failure after full restoration preserves actual unknown even when durable journal says restored', async () => {
  const f = await fixture('lazy-close');
  try {
    await f.run();
    const id = await earliestPoint(f);
    const calls = f.calls;
    await invokeRestore(f, id);
    await approveRestore(f, await restoreApproval(f));
    await f.runtime.waitForCommand('restore');
    const original = (await f.store.listExecutions('s')).find(
      (execution) => execution.originCommandId === 'restore',
    )!;
    expect(readFileSync(join(f.workspace, 'original'))).toEqual(f.original);
    expect(existsSync(join(f.workspace, 'created'))).toBe(false);
    expect(original.status).toBe('outcome_unknown');
    const journal = await f.checkpoint.readRestoreIntent(f.read, id, 'restore-real');
    expect(journal!.value).toMatchObject({ phase: 'restored', executionId: original.id });
    const views = await f.runtime.queryExtension({
      expectedStoreId: f.storeId,
      subjectId: 'owner',
      sessionId: 's',
      extensionId: 'builtin.files',
      queryId: 'files.checkpoint.restore-status',
      input: { checkpointId: id, restoreId: 'restore-real' },
    });
    expect(views[0]!.payload).toMatchObject({
      journal: { phase: 'restored' },
      execution: { id: original.id, status: 'outcome_unknown' },
    });
    const revision = journal!.revision;
    const resolved = f.resolved;
    await invokeRestore(f, id);
    await f.runtime.waitForCommand('restore');
    expect((await f.checkpoint.readRestoreIntent(f.read, id, 'restore-real'))!.revision).toBe(
      revision,
    );
    expect(f.resolved).toBe(resolved);
    expect(f.calls).toBe(calls);
  } finally {
    await f.close();
  }
});
