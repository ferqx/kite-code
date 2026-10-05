import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { mcpCanonical } from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src/index';
import { createMcpSourceConfiguration } from '../../src/mcp-source-configuration';
import { assembleProcessService } from '../../src/process-service';

const obj = (v: unknown) => v as Record<string, Json>;
async function until<T>(read: () => Promise<T | null>): Promise<T> {
  const end = Date.now() + 5000;
  for (;;) {
    const v = await read();
    if (v !== null) return v;
    if (Date.now() > end) throw Error('source_result_deadline');
    await Bun.sleep(5);
  }
}
async function fixture(
  mode: 'allow' | 'deny' | 'ask' = 'allow',
  observer: string | null = 'owner',
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-source-result-'))),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  mkdirSync(join(workspace, '.kite-code'));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(workspace, '.kite-code', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        local: { type: 'http', url: 'https://controlled.invalid/mcp', auth: { type: 'none' } },
      },
    }),
  );
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const storeId = (await store.getMetadata()).storeId;
  let runtime!: ReturnType<typeof createRuntime>;
  let lookups = 0;
  const sources = createMcpSourceConfiguration({
    profile,
    runtime: () => runtime,
    ...(observer === null ? {} : { observerSubjectId: observer }),
    credentialVault: {
      async resolve() {
        lookups++;
        throw Error('no_vault');
      },
    },
  });
  runtime = createRuntime({
    store,
    artifacts: createArtifactStore({
      profile: { dataRoot: profile.dataRoot, profile: profile.profile },
      store,
    }),
    extensions: [sources.extension],
    permissions: {
      async authorize() {
        return mode === 'allow'
          ? { allowed: true, revision: 'owned' }
          : mode === 'deny'
            ? { allowed: false, revision: 'owned' }
            : {
                allowed: false,
                revision: 'owned',
                approval: { request: { effects: ['configuration'] }, grants: ['approve_once'] },
              };
      },
    },
  });
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'owned',
    rootUri: `file://${workspace}/`,
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'owned',
  });
  const service = await startService({
    runtime,
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    buildId: 'source-result',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['extension_queries', 'extensions_actions'],
    },
  });
  await client.connect();
  async function query(commandId: string) {
    return obj(
      (
        await client.queryExtension('s', 'builtin.mcp.sources', 'mcp.source.result', { commandId })
      )[0]!.payload,
    );
  }
  async function start() {
    const d = obj(
      (await client.queryExtension('s', 'builtin.mcp.sources', 'mcp.sources', {}))[0]!.payload,
    );
    const server = obj((d.items as Json[])[0]);
    await client.invokeExtension('s', {
      kind: 'extension.invoke',
      expectedStoreId: storeId,
      commandId: 'original',
      extensionId: 'builtin.mcp.sources',
      actionId: 'mcp.source.approve',
      definitionVersion: '1',
      input: { serverId: server.id!, expectedReadSet: d.readSet! },
    });
  }
  async function card() {
    return until(
      async () =>
        (
          await store.listInteractions({
            expectedStoreId: storeId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions[0] ?? null,
    );
  }
  async function answer(decision: string) {
    const c = await card();
    await client.answerInteraction('s', c.id, {
      commandId: 'answer',
      expectedStoreId: storeId,
      expectedRevision: c.revision,
      answer:
        c.kind === 'approval'
          ? { kind: 'approval', decision: 'deny' }
          : { kind: 'question', answers: { decision } },
    });
    return c;
  }
  async function terminal() {
    return until(async () => {
      const c = await runtime.getCommand('original');
      const id = obj(c?.receipt).executionId;
      if (typeof id !== 'string') return null;
      const e = await runtime.getExecution(id);
      return e && ['failed', 'cancelled', 'succeeded', 'outcome_unknown'].includes(e.status)
        ? e
        : null;
    });
  }
  return {
    root,
    workspace,
    store,
    storeId,
    runtime,
    client,
    profile,
    query,
    start,
    card,
    answer,
    terminal,
    get lookups() {
      return lookups;
    },
    async close() {
      await service.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
for (const decision of ['approved', 'rejected', 'cancel'])
  test(`original source ${decision} proof and removed Workspace history are GET-only`, async () => {
    const f = await fixture();
    try {
      await f.start();
      const card = await f.card();
      expect(card.kind).toBe('question');
      expect(obj(card.request).schema).toEqual({
        type: 'object',
        additionalProperties: false,
        required: ['decision'],
        properties: { decision: { type: 'string', enum: ['approved', 'rejected', 'cancel'] } },
      });
      expect((await f.query('original')).phase).toBe('pending');
      await f.answer(decision);
      const e = await f.terminal();
      expect(e.status).toBe(decision === 'cancel' ? 'cancelled' : 'succeeded');
      const before = (await f.store.getMetadata()).lastChangeCursor;
      const result = await f.query('original');
      expect(result.phase).toBe(decision === 'cancel' ? 'cancelled' : 'saved');
      expect(result.decision).toBe(decision);
      expect(obj(result.proof).interactionId).toBe(card.id);
      expect(obj(result.proof).acceptedRevision).toBe('2');
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(16384);
      renameSync(f.workspace, join(f.root, 'renamed'));
      expect(await f.query('original')).toEqual(result);
      expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
      expect(f.lookups).toBe(0);
      expect(result.mutation === null).toBe(decision === 'cancel');
    } finally {
      await f.close();
    }
  }, 10000);
for (const mode of ['deny', 'ask'] as const)
  test(`ordinary ${mode} zero-adapter does not manufacture a source Question`, async () => {
    const f = await fixture(mode);
    try {
      await f.start();
      if (mode === 'ask') {
        const c = await f.answer('deny');
        expect(c.kind).toBe('approval');
      }
      const e = await f.terminal();
      const r = await f.query('original');
      expect(r.phase).toBe(e.status);
      expect(r.proof).toBeNull();
      expect(r.mutation).toBeNull();
      expect(obj(obj(e.result).details).adapterAttempted).toBe(false);
      expect(
        (
          await f.store.listInteractions({ expectedStoreId: f.storeId, sessionId: 's' })
        ).interactions.some((c) => c.kind === 'question'),
      ).toBe(false);
    } finally {
      await f.close();
    }
  }, 10000);
for (const observer of ['foreign', null])
  test(`history requires independently bound observer ${String(observer)}`, async () => {
    const f = await fixture('allow', observer);
    try {
      await f.start();
      await f.answer('approved');
      await f.terminal();
      const result = await f.query('original');
      expect(result.phase).toBe('outcome_unknown');
      expect(result.command).toBeNull();
      expect(result.execution).toBeNull();
      expect(result.proof).toBeNull();
    } finally {
      await f.close();
    }
  }, 10000);

test('partial result, mutated proof and reprepare cannot manufacture terminal saved facts', async () => {
  const f = await fixture();
  try {
    await f.start();
    await f.answer('approved');
    const e = await f.terminal();
    expect((await f.query('original')).phase).toBe('saved');
    const db = new Database(f.profile.databasePath);
    try {
      const commandOriginal = db
        .query('SELECT receipt_json FROM command WHERE id=?')
        .get('original') as { receipt_json: string };
      const original = db.query('SELECT result_json FROM execution WHERE id=?').get(e.id) as {
        result_json: string;
      };
      for (const fault of [
        'missing-proof',
        'wrong-record-key',
        'changed-time',
        'changed-answer',
        'partial-mutation',
        'extra-result',
        'extra-details',
        'connection-attempted',
        'credential-attempted',
      ]) {
        const result = JSON.parse(original.result_json);
        if (fault === 'extra-result') result.extra = true;
        if (fault === 'extra-details') result.details.extra = true;
        if (fault === 'connection-attempted') result.details.connectionAttempted = true;
        if (fault === 'credential-attempted') result.details.credentialLookupAttempted = true;
        if (fault === 'missing-proof') delete result.details.proof;
        if (fault === 'wrong-record-key') result.details.recordKey = '0'.repeat(64);
        if (fault === 'changed-time') result.details.proof.recordedAt++;
        if (fault === 'changed-answer') result.details.decision = 'rejected';
        if (fault === 'partial-mutation') result.details = { mutation: result.details.mutation };
        db.run('UPDATE execution SET result_json=? WHERE id=?', [JSON.stringify(result), e.id]);
        // Owned ledger fault: retain a self-consistent final receipt to exercise the independent Question/mutation proof, not just the result checksum.
        const finalizationDigest = createHash('sha256')
          .update(
            mcpCanonical({
              status: e.status,
              preparingNextAttempt: false,
              result,
              writes: [],
              message: null,
            }),
          )
          .digest('hex');
        db.run('UPDATE command SET receipt_json=? WHERE id=?', [
          JSON.stringify({ ...JSON.parse(commandOriginal.receipt_json), finalizationDigest }),
          'original',
        ]);
        expect((await f.query('original')).phase).toBe('outcome_unknown');
      }
      db.run('UPDATE execution SET result_json=? WHERE id=?', [original.result_json, e.id]);
      db.run('UPDATE command SET receipt_json=? WHERE id=?', [
        commandOriginal.receipt_json,
        'original',
      ]);
      expect((await f.query('original')).phase).toBe('saved');
      // An existing publication attempt cannot become pending merely because its carrier is nonterminal.
      for (const status of ['planned', 'dispatching', 'running']) {
        db.run('UPDATE execution SET state=? WHERE id=?', [status, e.id]);
        expect((await f.query('original')).phase).toBe('outcome_unknown');
      }
      db.run('UPDATE execution SET state=? WHERE id=?', [e.status, e.id]);
      expect((await f.query('original')).phase).toBe('saved');
      const mutationRow = db
        .query('SELECT receipt_json FROM host_mutation WHERE id=?')
        .get(`mcp-source-${e.id}`) as { receipt_json: string };
      for (const receipt of [
        { ...JSON.parse(mutationRow.receipt_json), extra: true },
        { status: 'applied', etag: 'not-a-hash' },
      ]) {
        db.run('UPDATE host_mutation SET receipt_json=? WHERE id=?', [
          JSON.stringify(receipt),
          `mcp-source-${e.id}`,
        ]);
        expect((await f.query('original')).phase).toBe('outcome_unknown');
      }
      db.run('UPDATE host_mutation SET receipt_json=? WHERE id=?', [
        mutationRow.receipt_json,
        `mcp-source-${e.id}`,
      ]);
      expect((await f.query('original')).phase).toBe('saved');
      db.run('UPDATE command SET kind=? WHERE id=?', ['context.select', 'original']);
      expect((await f.query('original')).phase).toBe('outcome_unknown');
      db.run('UPDATE command SET kind=? WHERE id=?', ['extension.invoke', 'original']);
      expect((await f.query('original')).phase).toBe('saved');
      const row = db.query('SELECT receipt_json FROM command WHERE id=?').get('original') as {
        receipt_json: string;
      };
      db.run('UPDATE command SET receipt_json=? WHERE id=?', [
        JSON.stringify({ ...JSON.parse(row.receipt_json), preparingNextAttempt: true }),
        'original',
      ]);
      expect((await f.query('original')).phase).toBe('outcome_unknown');
      db.run('UPDATE command SET receipt_json=? WHERE id=?', [row.receipt_json, 'original']);
    } finally {
      db.close();
    }
    expect(f.lookups).toBe(0);
  } finally {
    await f.close();
  }
}, 10000);
test('process configure receives the frozen actual HTTP observer identity', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-source-observer-process-'))),
    profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  let captured: unknown;
  let service: Awaited<ReturnType<typeof assembleProcessService>> | undefined;
  try {
    service = await assembleProcessService(
      {
        profile: {
          dataRoot: profile.dataRoot,
          profile: profile.profile,
          profileAccessKey: profile.profileAccessKey,
        },
        instanceId: 'owned-process',
        buildId: 'source-observer',
        token: 'x'.repeat(64),
      },
      {
        subjectId: 'explicit-observer',
        configure(_startup, context) {
          captured = context;
          expect(Object.isFrozen(context)).toBe(true);
          return {};
        },
      },
    );
    const client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: {
        profile: service.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['sessions'],
      },
    });
    const info = await client.connect();
    expect(captured).toEqual({ subjectId: 'explicit-observer' });
    expect(info.subjectId).toBe('explicit-observer');
  } finally {
    await service?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('unconfigured process default uses the actual local observer and separate ordinary Ask before Source Question', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-source-default-result-'))),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  mkdirSync(join(workspace, '.kite-code'));
  writeFileSync(
    join(workspace, '.kite-code', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        local: { type: 'http', url: 'https://controlled.invalid/mcp', auth: { type: 'none' } },
      },
    }),
  );
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  let service: Awaited<ReturnType<typeof assembleProcessService>> | undefined;
  try {
    service = await assembleProcessService({
      profile: {
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        profileAccessKey: profile.profileAccessKey,
      },
      instanceId: 'default-source',
      buildId: 'source-default',
      token: 'x'.repeat(64),
    });
    const client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: {
        profile: service.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: [
          'sessions',
          'extension_queries',
          'extensions_actions',
          'interactions',
        ],
      },
    });
    const info = await client.connect();
    const storeId = info.storeId;
    if (typeof storeId !== 'string') throw Error('default_store_unavailable');
    expect(info.subjectId).toBe('local-user');
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'owned',
      rootUri: `file://${workspace}`,
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'source default',
    });
    const trust = await client.getWorkspaceTrust('w', { storeId });
    await client.setWorkspaceTrust('w', {
      expectedStoreId: storeId,
      commandId: 'trust',
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
      trusted: true,
      ifRevision: trust.revision,
    });
    const directory = obj(
      (await client.queryExtension('s', 'builtin.mcp.sources', 'mcp.sources', {}))[0]!.payload,
    );
    const server = obj((directory.items as Json[])[0]);
    expect(server.admitted).toBe(false);
    await client.invokeExtension('s', {
      kind: 'extension.invoke',
      commandId: 'default-review',
      expectedStoreId: storeId,
      extensionId: 'builtin.mcp.sources',
      actionId: 'mcp.source.approve',
      definitionVersion: '1',
      input: { serverId: server.id!, expectedReadSet: directory.readSet! },
    });
    const nextCard = () =>
      until(
        async () =>
          (await client.listInteractions('s', { storeId, limit: 100, state: 'pending' }))
            .interactions[0] ?? null,
      );
    const ask = await nextCard();
    expect(ask.kind).toBe('approval');
    await client.answerInteraction('s', ask.id, {
      commandId: 'ordinary-approval',
      expectedStoreId: storeId,
      expectedRevision: ask.revision,
      answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
    const question = await nextCard();
    expect(question.kind).toBe('question');
    await client.answerInteraction('s', question.id, {
      commandId: 'source-answer',
      expectedStoreId: storeId,
      expectedRevision: question.revision,
      answer: { kind: 'question', answers: { decision: 'approved' } },
    });
    await until(async () => {
      const command = await client.getCommand('default-review');
      return obj(command.receipt).status === 'succeeded' ? command : null;
    });
    const result = await until(async () => {
      const fact = obj(
        (
          await client.queryExtension('s', 'builtin.mcp.sources', 'mcp.source.result', {
            commandId: 'default-review',
          })
        )[0]!.payload,
      );
      return fact.phase === 'pending' ? null : fact;
    });
    expect(result.phase).toBe('saved');
    expect(obj(result.proof).subjectId).toBe(info.subjectId);
    expect(obj(result.proof).interactionId).toBe(question.id);
    expect((await client.getView('s')).runs).toHaveLength(0);
  } finally {
    await service?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('durable cancellation during ordinary Ask is zero-adapter and no Source Question', async () => {
  const f = await fixture('ask');
  try {
    await f.start();
    const card = await f.card();
    expect(card.kind).toBe('approval');
    await f.client.cancelCommand('s', {
      kind: 'command.cancel',
      expectedStoreId: f.storeId,
      commandId: 'cancel-original',
      targetCommandId: 'original',
    });
    const e = await f.terminal();
    const r = await f.query('original');
    expect(e.cancelRequestedAt !== null).toBe(true);
    expect(r.phase).toBe('cancelled');
    expect(r.proof).toBeNull();
    expect(r.mutation).toBeNull();
    expect(obj(obj(e.result).details).adapterAttempted).toBe(false);
  } finally {
    await f.close();
  }
}, 10000);

for (const field of ['user', 'workspace', 'approval', 'binding'])
  test(`accepted Source Question retains original ${field} CAS and failed mutation stays unknown`, async () => {
    const f = await fixture();
    try {
      await f.start();
      const card = await f.card();
      const path =
        field === 'workspace'
          ? join(f.workspace, '.kite-code', 'mcp.json')
          : join(
              f.profile.profilePath,
              field === 'user'
                ? 'mcp.json'
                : field === 'approval'
                  ? 'mcp-approvals.json'
                  : 'mcp-auth-bindings.json',
            );
      writeFileSync(
        path,
        field === 'workspace'
          ? JSON.stringify({
              mcpServers: {
                local: { type: 'http', url: 'https://changed.invalid/mcp', auth: { type: 'none' } },
              },
            })
          : field === 'user'
            ? ' {"mcpServers":{}}'
            : ' {"records":{}}',
        { mode: 0o600 },
      );
      await f.answer('approved');
      const e = await f.terminal();
      expect(e.status).toBe('failed');
      const result = await f.query('original');
      expect(result.phase).toBe('outcome_unknown');
      expect(obj(result.mutation).state).toBe('failed');
      expect(result.proof).toBeNull();
      expect(obj(obj(e.result).details).effectAttempted).toBe(false);
      expect(card.acceptedDecisionRevision).toBeNull();
      expect(f.lookups).toBe(0);
    } finally {
      await f.close();
    }
  }, 10000);

test('cancel proof requires closed original result and persistent read scope', async () => {
  const f = await fixture();
  try {
    await f.start();
    await f.answer('cancel');
    const e = await f.terminal();
    expect((await f.query('original')).phase).toBe('cancelled');
    const db = new Database(f.profile.databasePath);
    try {
      const row = db.query('SELECT result_json FROM execution WHERE id=?').get(e.id) as {
        result_json: string;
      };
      const cmd = db.query('SELECT receipt_json FROM command WHERE id=?').get('original') as {
        receipt_json: string;
      };
      for (const fault of ['extra-result', 'extra-details', 'zero-time', 'large-revision']) {
        const result = JSON.parse(row.result_json);
        if (fault === 'extra-result') result.extra = true;
        if (fault === 'extra-details') result.details.extra = true;
        if (fault === 'zero-time') result.details.proof.recordedAt = 0;
        if (fault === 'large-revision') result.details.proof.acceptedRevision = '1'.repeat(257);
        const finalizationDigest = createHash('sha256')
          .update(
            mcpCanonical({
              status: e.status,
              preparingNextAttempt: false,
              result,
              writes: [],
              message: null,
            }),
          )
          .digest('hex');
        db.run('UPDATE execution SET result_json=? WHERE id=?', [JSON.stringify(result), e.id]);
        db.run('UPDATE command SET receipt_json=? WHERE id=?', [
          JSON.stringify({ ...JSON.parse(cmd.receipt_json), finalizationDigest }),
          'original',
        ]);
        expect((await f.query('original')).phase).toBe('outcome_unknown');
      }
      db.run('UPDATE execution SET result_json=? WHERE id=?', [row.result_json, e.id]);
      db.run('UPDATE command SET receipt_json=? WHERE id=?', [cmd.receipt_json, 'original']);
      await f.runtime.createWorkspace({
        expectedStoreId: f.storeId,
        id: 'other-workspace',
        name: 'other',
        rootUri: `file://${f.workspace}/`,
      });
      db.run('UPDATE session SET workspace_id=? WHERE id=?', ['other-workspace', 's']);
      expect((await f.query('original')).phase).toBe('outcome_unknown');
      db.run('UPDATE session SET workspace_id=? WHERE id=?', ['w', 's']);
      // Read-only original proof remains valid after each isolated fault is removed.
      expect((await f.query('original')).phase).toBe('cancelled');
    } finally {
      db.close();
    }
    expect(f.lookups).toBe(0);
  } finally {
    await f.close();
  }
}, 10000);
