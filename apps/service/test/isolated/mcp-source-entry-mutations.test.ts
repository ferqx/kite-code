import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend, mcpCanonical } from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { startService } from '../../src/index';

const obj = (value: unknown) => value as Record<string, Json>;
const sha = (value: unknown) => createHash('sha256').update(mcpCanonical(value)).digest('hex');
const http: Json = { type: 'http', url: 'https://controlled.invalid/mcp' };
const placeholder = `\${KEPT}`;
async function until<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw Error('source_entry_deadline');
    await Bun.sleep(5);
  }
}

async function fixture(options: { mode?: 'full' | 'ask' | 'deny'; observer?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-service-source-entry-')));
  chmodSync(root, 0o700);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(join(workspace, '.kite-code'), { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const user = join(profile.profilePath, 'mcp.json');
  const project = join(workspace, '.kite-code', 'mcp.json');
  const originalUser = `// retained user comment\r\n{"env":{"UNRELATED":"${placeholder}"},"unknown":{"keep":true},"mcpServers":{"shared":{"type":"http","url":"https://controlled.invalid/user"}}}\r\n`;
  writeFileSync(user, originalUser, { mode: 0o600 });
  writeFileSync(project, '{"mcpServers":{}}\n', { mode: 0o600 });
  let variables: Record<string, string> = { KEPT: 'original' };
  const vaultCalls: string[] = [];
  const backend = createTemporaryCredentialBackend();
  const host = createDefaultProcessConfiguration({
    profile,
    observerSubjectId: options.observer ?? 'owner',
    credentialBackend: {
      kind: backend.kind,
      async status(id) {
        vaultCalls.push('status');
        expect(id).toMatch(/^owned-credential:[a-f0-9]{64}$/);
        await backend.resolve(id);
        return 'available';
      },
      async put(id, secret) {
        vaultCalls.push('put');
        await backend.put(id, secret);
      },
      async resolve(id) {
        vaultCalls.push('resolve');
        return backend.resolve(id);
      },
      async remove(id) {
        vaultCalls.push('remove');
        await backend.remove(id);
      },
    },
    mcpSources: { variables: () => variables },
    ...(options.mode === 'deny'
      ? {
          permissions: {
            async authorize() {
              return { allowed: false, revision: 'owned-deny' };
            },
          },
        }
      : {
          permissionPolicy: {
            readPolicy: (request) => ({
              mode: options.mode === 'ask' ? 'ask' : 'full',
              workspaceTrust: true,
              revision: 'owned-entry-policy',
              allowed: [
                {
                  kind: request.kind,
                  definitionId: request.definitionId,
                  definitionVersion: request.definitionVersion,
                },
              ],
            }),
          },
        }),
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const storeId = (await store.getMetadata()).storeId;
  const coordinator = createWorkspaceSerialLocks(profile);
  host.bindWorkspaceSerialLocks!(coordinator);
  const runtime = createRuntime({
    store,
    workspaceSerialLocks: coordinator,
    artifacts: createArtifactStore({
      profile: { dataRoot: profile.dataRoot, profile: profile.profile },
      store,
    }),
    permissions: host.permissions!,
    extensions: host.extensions,
    conditions: host.conditions,
    initializeRunRequirements: host.initializeRunRequirements,
    resolveRunConfiguration: host.resolveRunConfiguration,
    resolveRecoveryRunConfiguration: host.resolveRecoveryRunConfiguration,
    supportsExtensionInputs: host.supportsExtensionInputs,
  });
  host.permissionManagement?.(runtime);
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
    buildId: 'source-entry-owned',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['extension_queries', 'extensions_actions', 'interactions'],
    },
  });
  await client.connect();
  async function query(queryId: string, input: Json) {
    const envelopes = await client.queryExtension('s', 'builtin.mcp.sources', queryId, input);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.artifactRefs).toEqual([]);
    expect(envelopes[0]!.actions).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(envelopes))).toBeLessThanOrEqual(16384);
    return obj(envelopes[0]!.payload);
  }
  const directory = () => query('mcp.sources', {});
  const history = async (commandId: string, credentialPreflight = false) => {
    const result = await query('mcp.source.mutation.result', { commandId });
    expect(Object.keys(result).sort()).toEqual(
      [
        'storeId',
        'sessionId',
        'workspaceId',
        'operation',
        'command',
        'execution',
        'phase',
        'mutation',
        'receipt',
        'reason',
        ...(credentialPreflight ? ['credentialCleanup'] : []),
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toContain('controlled.invalid');
    expect(JSON.stringify(result)).not.toContain(placeholder);
    if (credentialPreflight)
      expect(result.credentialCleanup).toEqual({ status: 'not_needed', attempted: false });
    return result;
  };
  async function invoke(commandId: string, actionId: string, input: Json) {
    return client.invokeExtension('s', {
      kind: 'extension.invoke',
      expectedStoreId: storeId,
      commandId,
      extensionId: 'builtin.mcp.sources',
      actionId,
      definitionVersion: '1',
      input,
    });
  }
  async function add(
    commandId = 'original',
    scope: 'user' | 'workspace' = 'workspace',
    name = 'shared',
  ) {
    const d = await directory();
    expect(d.readSet).not.toBeNull();
    return invoke(commandId, 'mcp.source.add', {
      scope,
      name,
      entry: http,
      expectedReadSet: d.readSet!,
    });
  }
  async function terminal(commandId = 'original') {
    return until(async () => {
      const command = await runtime.getCommand(commandId);
      const executionId = obj(command?.receipt).executionId;
      if (typeof executionId !== 'string') return null;
      const execution = await runtime.getExecution(executionId);
      return execution &&
        ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status)
        ? execution
        : null;
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
  async function answer(decision: 'approve_once' | 'deny') {
    const interaction = await card();
    expect(interaction.kind).toBe('approval');
    await client.answerInteraction('s', interaction.id, {
      commandId: `answer-${interaction.id}`,
      expectedStoreId: storeId,
      expectedRevision: interaction.revision,
      answer:
        decision === 'deny'
          ? { kind: 'approval', decision: 'deny' }
          : { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
    return interaction;
  }
  async function noExecutionSideEffects(allowSourceQuestion = false, credentialPreflight = false) {
    expect(vaultCalls).toEqual(credentialPreflight ? ['status', 'resolve'] : []);
    const db = new Database(profile.databasePath, { readonly: true });
    try {
      expect(db.query('SELECT COUNT(*) AS n FROM run').get()).toEqual({ n: 0 });
      expect(
        db
          .query(
            "SELECT COUNT(*) AS n FROM execution WHERE kind='model' OR adapter_id LIKE 'mcp.connection.%' OR adapter_id='mcp.source.connection'",
          )
          .get(),
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }
    if (!allowSourceQuestion)
      expect(
        (
          await store.listInteractions({ expectedStoreId: storeId, sessionId: 's' })
        ).interactions.some((interaction) => interaction.kind === 'question'),
      ).toBe(false);
  }
  return {
    root,
    workspace,
    user,
    project,
    profile,
    store,
    storeId,
    runtime,
    client,
    directory,
    history,
    query,
    invoke,
    add,
    terminal,
    card,
    answer,
    noExecutionSideEffects,
    originalUser,
    setVariables(value: Record<string, string>) {
      variables = value;
    },
    async close() {
      client.disposeNetwork();
      await service.close();
      await runtime.close();
      await coordinator.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('default ordinary Add and Remove have independent Ask and exact shadow preview, no Question or execution grant', async () => {
  const f = await fixture({ mode: 'ask' });
  try {
    await f.add();
    const before = readFileSync(f.project);
    const approval = await f.card();
    expect(approval.kind).toBe('approval');
    expect(readFileSync(f.project)).toEqual(before);
    await f.answer('approve_once');
    const added = await f.terminal();
    expect(added.status).toBe('succeeded');
    expect(
      JSON.parse(readFileSync(f.project, 'utf8')).mcpServers.shared._kiteSourceCreation,
    ).toEqual({ version: 1, operationId: added.id });
    const saved = await f.history('original');
    expect(saved.phase).toBe('saved');
    expect(obj(saved.receipt).operationId).toBe(added.id);
    expect(obj(saved.mutation).id).toBe(`mcp-entry-${added.id}`);
    const d = await f.directory();
    const item = obj((d.items as Json[]).find((value) => obj(value).name === 'shared'));
    expect(item.reason).toBe('mcp_project_approval_pending');
    const preview = await f.query('mcp.source.entry.preview', {
      scope: 'workspace',
      serverId: item.id!,
      expectedReadSet: d.readSet!,
    });
    const impact = obj(preview.preview);
    expect(obj(impact.target).rawEntryDigest).toBe(obj(obj(saved.receipt).target).rawEntryDigest);
    expect(obj(obj(impact.fallback).source).kind).toBe('user');
    await f.invoke('remove', 'mcp.source.remove', {
      scope: 'workspace',
      serverId: item.id!,
      expectedRawEntryDigest: obj(impact.target).rawEntryDigest!,
      expectedReadSet: d.readSet!,
    });
    expect((await f.card()).id).not.toBe(approval.id);
    await f.answer('approve_once');
    expect((await f.terminal('remove')).status).toBe('succeeded');
    expect((await f.history('remove', true)).phase).toBe('saved');
    expect(JSON.parse(readFileSync(f.project, 'utf8')).mcpServers).toEqual({});
    expect(readFileSync(f.user, 'utf8')).toBe(f.originalUser);
    const remaining = obj(
      ((await f.directory()).items as Json[]).find((value) => obj(value).name === 'shared'),
    );
    expect(obj(remaining.source).kind).toBe('user');
    await f.noExecutionSideEffects(false, true);
  } finally {
    await f.close();
  }
}, 10000);

test('basic user STDIO Add stores a declaration without launch and same-layer duplicate does not overwrite', async () => {
  const f = await fixture();
  try {
    const directory = await f.directory();
    await f.invoke('original', 'mcp.source.add', {
      scope: 'user',
      name: 'owned-stdio',
      entry: { type: 'stdio', command: '/owned/never-executed' },
      expectedReadSet: directory.readSet!,
    });
    const execution = await f.terminal();
    expect(execution.status).toBe('succeeded');
    expect((await f.history('original')).phase).toBe('saved');
    const before = readFileSync(f.user);
    const fresh = await f.directory();
    await f.invoke('duplicate', 'mcp.source.add', {
      scope: 'user',
      name: 'owned-stdio',
      entry: http,
      expectedReadSet: fresh.readSet!,
    });
    expect((await f.terminal('duplicate')).status).toBe('failed');
    expect((await f.history('duplicate')).phase).toBe('failed');
    expect(readFileSync(f.user)).toEqual(before);
    expect(before.toString()).toContain(`"env":{"UNRELATED":"${placeholder}"}`);
    expect(before.toString()).toContain('"unknown":{"keep":true}');
    expect(before.toString()).toContain('// retained user comment\r\n');
    await f.noExecutionSideEffects();
  } finally {
    await f.close();
  }
}, 10000);

for (const mode of ['deny', 'ask', 'cancel'] as const)
  test(`ordinary ${mode} before publication leaves no Source mutation or Question`, async () => {
    const f = await fixture({ mode: mode === 'deny' ? 'deny' : 'ask' });
    try {
      const before = readFileSync(f.project);
      await f.add();
      if (mode === 'ask') await f.answer('deny');
      if (mode === 'cancel') {
        await f.card();
        await f.client.cancelCommand('s', {
          kind: 'command.cancel',
          expectedStoreId: f.storeId,
          commandId: 'cancel-original',
          targetCommandId: 'original',
        });
      }
      const execution = await f.terminal();
      const result = await f.history('original');
      expect(['failed', 'cancelled']).toContain(execution.status);
      expect(result.phase).toBe(execution.status);
      expect(result.mutation).toBeNull();
      expect(result.receipt).toBeNull();
      expect(readFileSync(f.project)).toEqual(before);
      expect(
        await f.runtime.getHostMutation({
          expectedStoreId: f.storeId,
          commandId: `mcp-entry-${execution.id}`,
          subjectId: 'owner',
        }),
      ).toBeNull();
      await f.noExecutionSideEffects();
    } finally {
      await f.close();
    }
  }, 10000);

for (const drift of ['user', 'workspace', 'approval', 'binding', 'variables', 'root'] as const)
  test(`Ask preserves complete ${drift} freshness before source publication`, async () => {
    const f = await fixture({ mode: 'ask' });
    try {
      await f.add();
      await f.card();
      if (drift === 'user') writeFileSync(f.user, `${f.originalUser}// independent edit\r\n`);
      if (drift === 'workspace') writeFileSync(f.project, '{"mcpServers":{},"independent":true}\n');
      if (drift === 'approval')
        writeFileSync(join(f.profile.profilePath, 'mcp-approvals.json'), '{}', { mode: 0o600 });
      if (drift === 'binding')
        writeFileSync(join(f.profile.profilePath, 'mcp-auth-bindings.json'), '{}', { mode: 0o600 });
      if (drift === 'variables') f.setVariables({ KEPT: 'changed' });
      const originalRoot = join(f.root, 'original-workspace');
      if (drift === 'root') {
        renameSync(f.workspace, originalRoot);
        mkdirSync(f.workspace, { mode: 0o700 });
        mkdirSync(join(f.workspace, '.kite-code'), { mode: 0o700 });
        writeFileSync(f.project, '{"mcpServers":{}}\n', { mode: 0o600 });
      }
      const before = readFileSync(f.project);
      await f.answer('approve_once');
      expect((await f.terminal()).status).not.toBe('succeeded');
      expect((await f.history('original')).phase).not.toBe('saved');
      expect(readFileSync(f.project)).toEqual(before);
      if (drift === 'root')
        expect(
          JSON.parse(readFileSync(join(originalRoot, '.kite-code', 'mcp.json'), 'utf8')).mcpServers,
        ).toEqual({});
      await f.noExecutionSideEffects();
    } finally {
      await f.close();
    }
  }, 10000);

for (const window of ['before-commit', 'after-commit'] as const)
  test(`published Source ${window} HostMutation finish loss stays unknown and duplicate original Command never republishes`, async () => {
    const f = await fixture();
    const originalFinish = f.runtime.finishHostMutation.bind(f.runtime);
    let lost = 0;
    f.runtime.finishHostMutation = async (input) => {
      const injected =
        input.commandId.startsWith('mcp-entry-') && input.state === 'applied' && lost++ === 0;
      if (injected && window === 'before-commit') throw Error('owned_pre_commit_finish_failure');
      const record = await originalFinish(input);
      if (injected) throw Error('owned_post_commit_reply_lost');
      return record;
    };
    try {
      const d = await f.directory();
      const input: Json = {
        scope: 'workspace',
        name: 'shared',
        entry: http,
        expectedReadSet: d.readSet!,
      };
      await f.invoke('original', 'mcp.source.add', input);
      const execution = await f.terminal();
      expect(execution.status).toBe('outcome_unknown');
      expect(lost).toBe(1);
      expect((await f.history('original')).phase).toBe('outcome_unknown');
      const bytes = readFileSync(f.project);
      expect(JSON.parse(bytes.toString()).mcpServers.shared._kiteSourceCreation.operationId).toBe(
        execution.id,
      );
      await f.invoke('original', 'mcp.source.add', input);
      expect(readFileSync(f.project)).toEqual(bytes);
      expect(lost).toBe(1);
      expect(obj((await f.runtime.getCommand('original'))!.receipt).executionId).toBe(execution.id);
      await f.noExecutionSideEffects();
    } finally {
      f.runtime.finishHostMutation = originalFinish;
      await f.close();
    }
  }, 10000);

test('project re-add cannot reuse a real old source approval and has no extra Question', async () => {
  const f = await fixture();
  try {
    await f.add();
    const first = await f.terminal();
    expect(first.status).toBe('succeeded');
    const initial = await f.directory();
    const source = obj((initial.items as Json[]).find((value) => obj(value).name === 'shared'));
    await f.invoke('review', 'mcp.source.approve', {
      serverId: source.id!,
      expectedReadSet: initial.readSet!,
    });
    const question = await f.card();
    expect(question.kind).toBe('question');
    expect(obj(question.request).kind).toBe('mcp_source_approval');
    await f.client.answerInteraction('s', question.id, {
      commandId: 'source-answer',
      expectedStoreId: f.storeId,
      expectedRevision: question.revision,
      answer: { kind: 'question', answers: { decision: 'approved' } },
    });
    expect((await f.terminal('review')).status).toBe('succeeded');
    const oldApproval = readFileSync(join(f.profile.profilePath, 'mcp-approvals.json'));
    const approved = await f.directory();
    const approvedSource = obj(
      (approved.items as Json[]).find((value) => obj(value).name === 'shared'),
    );
    expect(approvedSource.admitted).toBe(true);
    const impact = obj(
      (
        await f.query('mcp.source.entry.preview', {
          scope: 'workspace',
          serverId: source.id!,
          expectedReadSet: approved.readSet!,
        })
      ).preview,
    );
    const oldDigest = obj(impact.target).rawEntryDigest;
    await f.invoke('remove-old', 'mcp.source.remove', {
      scope: 'workspace',
      serverId: source.id!,
      expectedRawEntryDigest: oldDigest!,
      expectedReadSet: approved.readSet!,
    });
    expect((await f.terminal('remove-old')).status).toBe('succeeded');
    await f.add('readd');
    const next = await f.terminal('readd');
    expect(next.status).toBe('succeeded');
    expect(next.id).not.toBe(first.id);
    const current = obj(
      ((await f.directory()).items as Json[]).find((value) => obj(value).name === 'shared'),
    );
    expect(current.admitted).toBe(false);
    expect(current.reason).toBe('mcp_project_approval_pending');
    expect(obj(obj((await f.history('readd')).receipt).target).rawEntryDigest).not.toBe(oldDigest);
    expect(readFileSync(join(f.profile.profilePath, 'mcp-approvals.json'))).toEqual(oldApproval);
    const questions = (
      await f.store.listInteractions({ expectedStoreId: f.storeId, sessionId: 's' })
    ).interactions.filter((interaction) => interaction.kind === 'question');
    expect(questions.map((interaction) => interaction.id)).toEqual([question.id]);
    await f.noExecutionSideEffects(true, true);
  } finally {
    await f.close();
  }
}, 10000);

test('history survives removed sources and physical Workspace with original identity and zero cursor growth', async () => {
  const f = await fixture();
  try {
    await f.add();
    const execution = await f.terminal();
    expect(execution.status).toBe('succeeded');
    const result = await f.history('original');
    expect(result.phase).toBe('saved');
    expect(result.storeId).toBe(f.storeId);
    expect(result.sessionId).toBe('s');
    expect(result.workspaceId).toBe('w');
    rmSync(f.user);
    renameSync(f.workspace, join(f.root, 'removed-workspace'));
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect(await f.history('original')).toEqual(result);
    expect(await f.history('original')).toEqual(result);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    await f.noExecutionSideEffects();
  } finally {
    await f.close();
  }
}, 10000);

test('independently wrong observer cannot publish or read a saved source fact', async () => {
  const f = await fixture({ observer: 'foreign' });
  try {
    const before = readFileSync(f.project);
    await f.add();
    expect((await f.terminal()).status).toBe('failed');
    const result = await f.history('original');
    expect(result.phase).toBe('outcome_unknown');
    expect(result.command).toBeNull();
    expect(result.execution).toBeNull();
    expect(readFileSync(f.project)).toEqual(before);
    await f.noExecutionSideEffects();
  } finally {
    await f.close();
  }
}, 10000);

test('original result, finalization and HostMutation faults cannot manufacture saved, pending or a foreign grant', async () => {
  const f = await fixture();
  try {
    await f.add();
    const execution = await f.terminal();
    expect(execution.status).toBe('succeeded');
    expect((await f.history('original')).phase).toBe('saved');
    const db = new Database(f.profile.databasePath);
    try {
      const c = db
        .query(
          'SELECT receipt_json, request_json, request_digest, subject_id FROM command WHERE id=?',
        )
        .get('original') as {
        receipt_json: string;
        request_json: string;
        request_digest: string;
        subject_id: string;
      };
      const e = db
        .query('SELECT result_json, intent_json, origin_store_id FROM execution WHERE id=?')
        .get(execution.id) as {
        result_json: string;
        intent_json: string;
        origin_store_id: string;
      };
      const mid = `mcp-entry-${execution.id}`;
      const m = db
        .query(
          'SELECT receipt_json, state, request_digest, subject_id FROM host_mutation WHERE id=?',
        )
        .get(mid) as {
        receipt_json: string;
        state: string;
        request_digest: string;
        subject_id: string;
      };
      const faults: { name: string; apply(): void; restore(): void }[] = [
        {
          name: 'command-subject',
          apply: () =>
            db.run('UPDATE command SET subject_id=? WHERE id=?', ['foreign', 'original']),
          restore: () =>
            db.run('UPDATE command SET subject_id=? WHERE id=?', [c.subject_id, 'original']),
        },
        {
          name: 'command-digest',
          apply: () =>
            db.run('UPDATE command SET request_digest=? WHERE id=?', ['0'.repeat(64), 'original']),
          restore: () =>
            db.run('UPDATE command SET request_digest=? WHERE id=?', [
              c.request_digest,
              'original',
            ]),
        },
        {
          name: 'execution-origin',
          apply: () =>
            db.run('UPDATE execution SET origin_store_id=? WHERE id=?', [
              'foreign-store',
              execution.id,
            ]),
          restore: () =>
            db.run('UPDATE execution SET origin_store_id=? WHERE id=?', [
              e.origin_store_id,
              execution.id,
            ]),
        },
        {
          name: 'execution-input',
          apply: () =>
            db.run('UPDATE execution SET intent_json=? WHERE id=?', [
              JSON.stringify({ ...JSON.parse(e.intent_json), forged: true }),
              execution.id,
            ]),
          restore: () =>
            db.run('UPDATE execution SET intent_json=? WHERE id=?', [e.intent_json, execution.id]),
        },
        {
          name: 'finalization',
          apply: () =>
            db.run('UPDATE command SET receipt_json=? WHERE id=?', [
              JSON.stringify({ ...JSON.parse(c.receipt_json), finalizationDigest: '0'.repeat(64) }),
              'original',
            ]),
          restore: () =>
            db.run('UPDATE command SET receipt_json=? WHERE id=?', [c.receipt_json, 'original']),
        },
        {
          name: 'mutation-state',
          apply: () =>
            db.run('UPDATE host_mutation SET state=? WHERE id=?', ['outcome_unknown', mid]),
          restore: () => db.run('UPDATE host_mutation SET state=? WHERE id=?', [m.state, mid]),
        },
        {
          name: 'mutation-subject',
          apply: () => db.run('UPDATE host_mutation SET subject_id=? WHERE id=?', ['foreign', mid]),
          restore: () =>
            db.run('UPDATE host_mutation SET subject_id=? WHERE id=?', [m.subject_id, mid]),
        },
        {
          name: 'mutation-digest',
          apply: () =>
            db.run('UPDATE host_mutation SET request_digest=? WHERE id=?', ['0'.repeat(64), mid]),
          restore: () =>
            db.run('UPDATE host_mutation SET request_digest=? WHERE id=?', [m.request_digest, mid]),
        },
        {
          name: 'mutation-receipt',
          apply: () =>
            db.run('UPDATE host_mutation SET receipt_json=? WHERE id=?', [
              JSON.stringify({ ...JSON.parse(m.receipt_json), extra: true }),
              mid,
            ]),
          restore: () =>
            db.run('UPDATE host_mutation SET receipt_json=? WHERE id=?', [m.receipt_json, mid]),
        },
      ];
      const cursor = (await f.store.getMetadata()).lastChangeCursor;
      for (const fault of faults) {
        try {
          fault.apply();
          expect((await f.history('original')).phase, fault.name).toBe('outcome_unknown');
        } finally {
          fault.restore();
        }
        expect((await f.history('original')).phase).toBe('saved');
      }
      for (const status of ['planned', 'dispatching', 'running']) {
        try {
          db.run('UPDATE execution SET state=? WHERE id=?', [status, execution.id]);
          expect((await f.history('original')).phase).toBe('outcome_unknown');
        } finally {
          db.run('UPDATE execution SET state=? WHERE id=?', [execution.status, execution.id]);
        }
      }
      const result = JSON.parse(e.result_json);
      result.details.modelAttempted = true;
      const receipt = {
        ...JSON.parse(c.receipt_json),
        finalizationDigest: sha({
          status: execution.status,
          preparingNextAttempt: false,
          result,
          writes: [],
          message: null,
        }),
      };
      try {
        db.run('UPDATE execution SET result_json=? WHERE id=?', [
          JSON.stringify(result),
          execution.id,
        ]);
        db.run('UPDATE command SET receipt_json=? WHERE id=?', [
          JSON.stringify(receipt),
          'original',
        ]);
        expect((await f.history('original')).phase).toBe('outcome_unknown');
      } finally {
        db.run('UPDATE execution SET result_json=? WHERE id=?', [e.result_json, execution.id]);
        db.run('UPDATE command SET receipt_json=? WHERE id=?', [c.receipt_json, 'original']);
      }
      expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    } finally {
      db.close();
    }
    await f.noExecutionSideEffects();
  } finally {
    await f.close();
  }
}, 10000);
