import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, type RuntimeOptions } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { createPermissionManagement } from '../../src/permission-management';

async function expectCode(work: Promise<unknown>, code: string) {
  let actual: unknown;
  try {
    await work;
  } catch (error) {
    actual = error;
  }
  expect((actual as { code?: string })?.code).toBe(code);
}

async function fixture(child = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-permission-control-'))),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  let store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  let childSessionId: string | undefined;
  const finish = {
    type: 'finish' as const,
    reason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const childOptions: Pick<
    RuntimeOptions,
    'model' | 'modelId' | 'modelConcurrency' | 'childConfigurations' | 'extensions'
  > = child
    ? {
        model: createFixedModel([
          [
            { type: 'tool_call' as const, id: 'delegate', name: 'delegate', arguments: '{}' },
            { ...finish, reason: 'tool_calls' as const },
          ],
          [finish],
        ]),
        modelId: 'fixed-parent',
        modelConcurrency: 1,
        childConfigurations: [
          {
            id: 'role',
            version: '1',
            modelId: 'fixed-child',
            model: createFixedModel([[finish]]),
            toolIds: [],
            snapshot: {},
          },
        ],
        extensions: [
          {
            id: 'fixture',
            version: '1',
            apiMajor: 1,
            tools: [
              {
                id: 'delegate',
                version: '1',
                description: 'Create actual harmless child for scope reads',
                inputSchema: { type: 'object' },
                async execute(
                  _input: import('@kite-ai/agent/extensions').Json,
                  context: import('@kite-ai/agent/extensions').ToolContext,
                ) {
                  const ref = await context.operations.ensure({
                    key: 'scope-child',
                    request: {
                      kind: 'agent',
                      configurationId: 'role',
                      input: { content: 'scope proof' },
                    },
                  });
                  childSessionId = ref.childSessionId ?? undefined;
                  await context.operations.wait(ref);
                  return { outcome: 'succeeded' as const, content: 'actual child completed' };
                },
              },
            ],
          },
        ],
      }
    : {};
  const permissions = {
    async authorize() {
      return { allowed: child, revision: 'management-scope-fixture' };
    },
  };
  let runtime = createRuntime({ store, permissions, ...childOptions });
  const expectedStoreId = (await runtime.getMetadata()).storeId;
  const identity = { expectedStoreId, subjectId: 'owner' };
  let management = createPermissionManagement({ runtime, profile });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'Temporary',
    rootUri: `file://${workspace}`,
  });
  for (const [sessionId, subjectId] of [
    ['s', 'owner'],
    ['second', 'owner'],
    ['other', 'other'],
  ] as const)
    await runtime.createSession({
      expectedStoreId,
      sessionId,
      subjectId,
      commandId: `create-${sessionId}`,
      workspaceId: 'w',
      title: sessionId,
    });
  return {
    root,
    workspace,
    profile,
    identity,
    get childSessionId() {
      return childSessionId;
    },
    get runtime() {
      return runtime;
    },
    get management() {
      return management;
    },
    async reopen() {
      await runtime.close();
      store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      runtime = createRuntime({ store, permissions });
      management = createPermissionManagement({ runtime, profile });
    },
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('actual SQLite mode CAS/default/duplicate survive reopening and remain exact Store/subject controls', async () => {
  const f = await fixture();
  try {
    f.runtime.getView = async () => {
      throw new Error('permission_controls_must_not_read_history');
    };
    const initial = await f.management.readMode({ ...f.identity, sessionId: 's' });

    expect(initial).toMatchObject({
      mode: 'auto',
      defaultMode: 'auto',
      revision: '0',
      defaultRevision: '0',
      scopeSessionId: 's',
    });
    const request = {
      ...f.identity,
      sessionId: 's',
      commandId: 'mode',
      mode: 'ask' as const,
      ifRevision: initial.revision,
      makeDefault: true,
      ifDefaultRevision: initial.defaultRevision,
    };
    const saved = await f.management.setMode(request);

    expect(saved.state).toBe('applied');
    expect(saved.receipt).toMatchObject({ status: 'applied', mode: 'ask', makeDefault: true });
    expect(await f.management.setMode(request)).toEqual(saved);

    const state = await f.management.readMode({ ...f.identity, sessionId: 's' });

    expect(state.mode).toBe('ask');
    expect(state.revision).not.toBe('0');
    expect(state.defaultRevision).toBe(state.revision);
    expect((await f.management.readMode({ ...f.identity, sessionId: 'second' })).mode).toBe('ask');

    expect(
      (await f.management.readMode({ ...f.identity, subjectId: 'other', sessionId: 'other' }))
        .defaultMode,
    ).toBe('auto');

    await expectCode(
      f.management.readMode({ ...f.identity, subjectId: 'other', sessionId: 's' }),
      'host_control_scope_denied',
    );

    await expectCode(
      f.management.setMode({ ...request, commandId: 'stale', mode: 'full' }),
      'host_control_conflict',
    );

    await expectCode(f.management.setMode({ ...request, mode: 'full' }), 'host_mutation_conflict');

    await expectCode(
      f.management.getMutation({ ...f.identity, expectedStoreId: 'wrong', commandId: 'mode' }),
      'store_mismatch',
    );
    await expectCode(
      f.management.getMutation({ ...f.identity, subjectId: 'other', commandId: 'mode' }),
      'host_mutation_scope_denied',
    );
    await f.reopen();

    expect(await f.management.getMutation({ ...f.identity, commandId: 'mode' })).toEqual(saved);
    expect((await f.management.readMode({ ...f.identity, sessionId: 'second' })).defaultMode).toBe(
      'ask',
    );
    const current = await f.management.readMode({ ...f.identity, sessionId: 's' });
    const results = await Promise.allSettled(
      ['accept_edits', 'full'].map((mode, i) =>
        f.management.setMode({
          ...request,
          commandId: `concurrent-${i}`,
          mode: mode as 'accept_edits' | 'full',
          makeDefault: false,
          ifRevision: current.revision,
          ifDefaultRevision: current.defaultRevision,
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await f.management.readMode({ ...f.identity, sessionId: 's' })).mode).not.toBe('ask');
  } finally {
    await f.close();
  }
});

test('trust seals real directory and profile Skill identity, ignores Git metadata and rejects replaced root or wider scopes', async () => {
  const f = await fixture();
  try {
    const initial = await f.management.readTrust({ ...f.identity, workspaceId: 'w' });

    expect(initial).toMatchObject({ status: 'untrusted', trusted: false, revision: '0' });
    const request = {
      ...f.identity,
      workspaceId: 'w',
      commandId: 'trust',
      trusted: true,
      ifRevision: initial.revision,
      canonicalIdentity: initial.canonicalIdentity,
      externalReadScopeDigest: initial.externalReadScopeDigest,
    };
    const saved = await f.management.setTrust(request);

    expect(saved.receipt).toMatchObject({
      status: 'applied',
      trusted: true,
      canonicalIdentity: initial.canonicalIdentity,
    });
    expect(await f.management.setTrust(request)).toEqual(saved);
    expect((await f.management.readTrust({ ...f.identity, workspaceId: 'w' })).trusted).toBe(true);
    expect(
      (await f.management.readTrust({ ...f.identity, subjectId: 'other', workspaceId: 'w' }))
        .trusted,
    ).toBe(false);
    mkdirSync(join(f.workspace, '.git'));
    writeFileSync(join(f.workspace, '.git', 'HEAD'), 'ref: harmless');
    expect((await f.management.readTrust({ ...f.identity, workspaceId: 'w' })).trusted).toBe(true);
    await f.reopen();
    expect((await f.management.readTrust({ ...f.identity, workspaceId: 'w' })).trusted).toBe(true);
    mkdirSync(join(f.profile.profilePath, 'skills'));
    const changed = await f.management.readTrust({ ...f.identity, workspaceId: 'w' });
    expect(changed.status).toBe('scope_changed');
    expect(changed.trusted).toBe(false);
    expect(changed.readScopes.map((scope) => scope.kind)).toEqual(['workspace', 'profile_skills']);
    expect(changed.canonicalIdentity).toBe(initial.canonicalIdentity);
    expect(changed.externalReadScopeDigest).not.toBe(initial.externalReadScopeDigest);
    await expectCode(
      f.management.setTrust({ ...request, commandId: 'old-scope', ifRevision: changed.revision }),
      'workspace_scope_changed',
    );
    expect((await f.management.getMutation({ ...f.identity, commandId: 'old-scope' }))?.state).toBe(
      'failed',
    );
    await f.management.setTrust({
      ...request,
      commandId: 'new-scope',
      ifRevision: changed.revision,
      externalReadScopeDigest: changed.externalReadScopeDigest,
    });
    expect((await f.management.readTrust({ ...f.identity, workspaceId: 'w' })).trusted).toBe(true);
    renameSync(f.workspace, `${f.workspace}-original`);
    mkdirSync(f.workspace);
    const replaced = await f.management.readTrust({ ...f.identity, workspaceId: 'w' });
    expect(replaced.status).toBe('scope_changed');
    expect(replaced.trusted).toBe(false);
    expect(replaced.canonicalIdentity).not.toBe(initial.canonicalIdentity);
    const readonly = createPermissionManagement({
      runtime: f.runtime,
      profile: f.profile,
      writable: false,
    });
    await expectCode(
      readonly.setTrust({ ...request, commandId: 'external-authority' }),
      'permission_authority_external',
    );
  } finally {
    await f.close();
  }
});

test('an actual same-Loop child reads its root mode but cannot mutate the root control under its own Session', async () => {
  const f = await fixture(true);
  try {
    const current = await f.management.readMode({ ...f.identity, sessionId: 's' });
    await f.management.setMode({
      ...f.identity,
      sessionId: 's',
      commandId: 'root-mode',
      mode: 'ask',
      ifRevision: current.revision,
      makeDefault: false,
      ifDefaultRevision: current.defaultRevision,
    });
    await f.runtime.submitCommand({
      ...f.identity,
      commandId: 'child-work',
      sessionId: 's',
      request: { kind: 'run.start', content: 'create scope child' },
    });
    await f.runtime.waitForCommand('child-work', { timeoutMs: 5000 });
    expect(f.childSessionId).toBeString();
    const child = await f.management.readMode({ ...f.identity, sessionId: f.childSessionId! });
    const root = await f.management.readMode({ ...f.identity, sessionId: 's' });
    expect(child).toMatchObject({
      sessionId: f.childSessionId,
      scopeSessionId: 's',
      mode: 'ask',
      revision: root.revision,
    });
    await expectCode(
      f.management.setMode({
        ...f.identity,
        sessionId: f.childSessionId!,
        commandId: 'child-mode',
        mode: 'full',
        ifRevision: child.revision,
        makeDefault: false,
        ifDefaultRevision: child.defaultRevision,
      }),
      'group_root_required',
    );
    expect(await f.management.getMutation({ ...f.identity, commandId: 'child-mode' })).toBeNull();
    expect((await f.management.readMode({ ...f.identity, sessionId: 's' })).mode).toBe('ask');
  } finally {
    await f.close();
  }
});
