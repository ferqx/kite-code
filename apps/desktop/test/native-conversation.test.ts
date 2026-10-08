import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type AgentClient,
  ClientError,
  type Command,
  canonicalCallerCommandRequest,
  type PermissionMutation,
} from '@kite-ai/client';
import { callerTextDigest } from '../electron/caller-journal';
import { NativeCaller } from '../electron/native-caller';
import { decodeNativeRequest } from '../electron/native-ipc';
import type { NativeConversationResult, NativeDraft, NativeRequest } from '../src/native-bridge';
import { memoryPrivateData } from './private-data.fixture';

const text = 'first input\n雪🙂\u0000end';
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-conversation-')));
  const data = memoryPrivateData(),
    drafts = new Map<string, NativeDraft>();
  const id = (scope: unknown) => createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  data.read = (scope) =>
    drafts.get(id(scope)) ?? { id: id(scope), ...scope, content: '', revision: 0 };
  data.save = (scope, revision, content) => {
    const old = data.read(scope);
    if (old.revision !== revision) throw Error('draft_revision_conflict');
    const draft = { ...old, content, revision: revision + 1 };
    drafts.set(draft.id, draft);
    return draft;
  };
  data.readId = (key) => {
    const draft = drafts.get(key);
    if (!draft) throw Error('draft_not_found');
    return draft;
  };
  let creates = 0,
    starts = 0,
    modes = 0,
    trusts = 0,
    gets = 0,
    mode = 'auto',
    trusted = true;
  let loseCreation = false,
    loseInput = false,
    loseMode = false,
    rejectMode = false;
  let active = false;
  let releaseCreate: (() => void) | undefined;
  const commands = new Map<string, Command>(),
    mutations = new Map<string, PermissionMutation>();
  const session = (sessionId: string) => ({
    id: sessionId,
    workspaceId: 'w',
    rootSessionId: sessionId,
    parentSessionId: null,
    title: sessionId,
    nextSeq: '0',
    deletedAt: null,
    controlRevision: '0',
    contextSelectionId: 'context',
  });
  const port = {
    serverInfo: {
      storeId: 'store',
      subjectId: 'user',
      capabilities: ['configuration_management', 'permission_controls'],
    },
    connect: async () => ({}),
    async observe({ signal }: { signal: AbortSignal }) {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
    disposeNetwork() {},
    getView: async (sessionId: string) => ({
      storeId: 'store',
      snapshotCursor: '0',
      session: session(sessionId),
      runs: sessionId === 'busy' && active ? [{ isActive: true }] : [],
      executions: [],
      messages: [],
    }),
    listAllSessions: async () => (active ? [session('busy')] : []),
    listAllWorkspaces: async () => [
      { id: 'w', name: 'Workspace', rootUri: pathToFileURL(root).href },
    ],
    getModelSettings: async (scope: string, options: { workspaceId?: string }) => ({
      storeId: 'store',
      scope,
      workspaceId: options.workspaceId,
      readSet: null,
      errors: [],
      defaultModelId: 'model',
      models: [
        {
          id: 'model',
          enabled: true,
          configured: true,
          diagnostics: [],
          reasoningEffortChoices: ['low', 'high'],
        },
      ],
    }),
    getPermissionMode: async (sessionId: string) => ({
      storeId: 'store',
      sessionId,
      scopeSessionId: sessionId,
      mode,
      revision: String(modes),
      defaultMode: 'auto',
      defaultRevision: '0',
    }),
    getWorkspaceTrust: async () => ({
      storeId: 'store',
      workspaceId: 'w',
      trusted,
      status: trusted ? 'trusted' : 'untrusted',
      revision: String(trusts),
      canonicalIdentity: 'a'.repeat(64),
      externalReadScopeDigest: 'b'.repeat(64),
      readScopes: [{ kind: 'workspace', description: 'workspace' }],
    }),
    async setWorkspaceTrust(_workspace: string, input: { commandId: string }) {
      trusts++;
      trusted = true;
      const result = {
        commandId: input.commandId,
        kind: 'workspace.trust',
        state: 'applied',
        receipt: { status: 'applied' },
      } as PermissionMutation;
      mutations.set(input.commandId, result);
      return result;
    },
    async setPermissionMode(_session: string, input: { commandId: string; mode: string }) {
      modes++;
      if (rejectMode) throw new ClientError('permission_revision_conflict', undefined, 409);
      mode = input.mode;
      const result = {
        commandId: input.commandId,
        kind: 'permission.mode',
        state: 'applied',
        receipt: { status: 'applied' },
      } as PermissionMutation;
      mutations.set(input.commandId, result);
      if (loseMode) throw new ClientError('network_outcome_unknown');
      return result;
    },
    getPermissionMutation: async (commandId: string) => {
      gets++;
      return mutations.get(commandId)!;
    },
    async createSession(input: { commandId: string; sessionId: string }) {
      creates++;
      expect(
        data.read({ storeId: 'store', workspaceId: 'w', rootSessionId: input.sessionId }).content,
      ).toBe(text);
      commands.set(input.commandId, {
        id: input.commandId,
        sessionId: input.sessionId,
        originStoreId: 'store',
        kind: 'session.create',
        cancelRequestedAt: null,
        status: 'applied',
        receipt: { sessionId: input.sessionId },
      } as Command);
      if (releaseCreate)
        await new Promise<void>((resolve) => {
          releaseCreate = resolve;
        });
      if (loseCreation) throw new ClientError('network_outcome_unknown');
      return session(input.sessionId);
    },
    async startRun(
      sessionId: string,
      input: Extract<NativeRequest, { method: 'conversation.send' }>['intent'],
    ) {
      starts++;
      expect(
        data.callers().find((row) => row.intent.request.commandId === input.commandId)?.intent
          .request,
      ).toEqual(input);
      const result = {
        id: input.commandId,
        sessionId,
        originStoreId: 'store',
        subjectId: 'user',
        kind: 'run.start',
        status: 'accepted',
        receipt: null,
        requestDigest: callerTextDigest(canonicalCallerCommandRequest(input)),
      } as Command;
      commands.set(input.commandId, result);
      if (loseInput) throw new ClientError('network_outcome_unknown');
      return result;
    },
    getCommand: async (commandId: string) => {
      gets++;
      const command = commands.get(commandId);
      if (!command) throw new ClientError('command_not_found', undefined, 404);
      return command;
    },
  } as unknown as AgentClient;
  const caller = new NativeCaller(port, () => {}, data);
  const request: Extract<NativeRequest, { method: 'conversation.send' }> = {
    method: 'conversation.send',
    generation: 1,
    creation: {
      expectedStoreId: 'store',
      workspaceId: 'w',
      sessionId: 'new-session',
      commandId: 'new-creation',
      title: 'New',
    },
    intent: {
      kind: 'run.start',
      expectedStoreId: 'store',
      commandId: 'first-input',
      content: text,
      modelId: 'model',
      reasoningEffort: 'high',
    },
    permissionMode: 'ask',
  };
  return {
    caller,
    root,
    data,
    request,
    port,
    counts: () => ({ creates, starts, modes, trusts, gets }),
    loseCreate: () => {
      loseCreation = true;
    },
    loseStart: () => {
      loseInput = true;
    },
    losePermission: () => {
      loseMode = true;
    },
    failPermission: (value: boolean) => {
      rejectMode = value;
    },
    untrust: () => {
      trusted = false;
    },
    active: (value: boolean) => {
      active = value;
    },
    holdCreate: () => {
      releaseCreate = () => {};
    },
    releaseCreate: () => releaseCreate?.(),
    async ready() {
      await caller.invoke({ method: 'attach' });
      await caller.invoke({ method: 'directory', generation: 1 });
    },
    async close() {
      await caller.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('first send saves original text, reuses creation/permission/input callers and never changes the reading selection', async () => {
  const f = fixture();
  try {
    await f.ready();
    f.untrust();
    f.holdCreate();
    await f.caller.invoke({ method: 'select', generation: 1, sessionId: 'original' });
    const sending = f.caller.invoke(f.request);
    while (f.counts().creates === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    await f.caller.invoke({ method: 'select', generation: 1, sessionId: 'later' });
    f.releaseCreate();
    const result = await sending;
    expect(result).toMatchObject({
      kind: 'conversation',
      phase: 'accepted',
      stage: 'input',
      creation: { phase: 'created' },
      input: { sessionId: 'new-session', intent: { commandId: 'first-input' } },
    });
    expect(f.caller.state().selection?.session.id).toBe('later');
    expect(f.counts()).toMatchObject({ creates: 1, starts: 1, modes: 1, trusts: 1 });
    expect(f.data.callers()[0]?.intent.draft).toMatchObject({
      revision: '1',
      textDigest: callerTextDigest(text),
    });
    expect(f.data.modelRoute('store', 'new-session')).toBe('model');
    expect(await f.caller.invoke(f.request)).toEqual(result);
    expect(f.counts()).toMatchObject({ creates: 1, starts: 1, modes: 1, trusts: 1 });
  } finally {
    await f.close();
  }
});

test('unknown original creation/input is GET-only; cold creation cannot gain permission or start authority', async () => {
  const f = fixture();
  try {
    await f.ready();
    f.loseCreate();
    expect(await f.caller.invoke(f.request)).toMatchObject({
      phase: 'unknown',
      stage: 'create',
      creation: { phase: 'unknown' },
    });
    expect(f.counts()).toMatchObject({ creates: 1, starts: 0, modes: 0 });
    expect(
      await f.caller.invoke({
        method: 'conversation.lookup',
        generation: 1,
        commandId: 'first-input',
      }),
    ).toMatchObject({
      phase: 'failed',
      code: 'conversation_continue_explicit',
      creation: { phase: 'created' },
    });
    expect(f.counts()).toMatchObject({ creates: 1, starts: 0, modes: 0 });
    const cold = new NativeCaller(f.port, () => {}, f.data);
    try {
      await cold.invoke({ method: 'attach' });
      await cold.invoke({ method: 'directory', generation: 1 });
      expect(await cold.invoke(f.request)).toMatchObject({
        phase: 'unknown',
        code: 'conversation_original_saved',
      });
      expect(f.counts()).toMatchObject({ creates: 1, starts: 0, modes: 0 });
    } finally {
      await cold.close();
    }
    f.loseStart();
    const retry = { ...f.request, intent: { ...f.request.intent, commandId: 'explicit-input' } };
    expect(await f.caller.invoke(retry)).toMatchObject({ phase: 'unknown', stage: 'input' });
    expect(
      await f.caller.invoke({
        method: 'conversation.lookup',
        generation: 1,
        commandId: 'explicit-input',
      }),
    ).toMatchObject({ phase: 'accepted', input: { intent: { commandId: 'explicit-input' } } });
    expect(f.counts()).toMatchObject({ creates: 1, starts: 1, modes: 1 });
  } finally {
    await f.close();
  }
});

test('permission failure retains created Session and draft; unknown mode must be checked before explicit continuation', async () => {
  const f = fixture();
  try {
    await f.ready();
    f.failPermission(true);
    expect(await f.caller.invoke(f.request)).toMatchObject({
      phase: 'failed',
      stage: 'permission',
      creation: { phase: 'created' },
      code: 'permission_revision_conflict',
    });
    expect(f.counts()).toMatchObject({ creates: 1, starts: 0, modes: 1 });
    f.failPermission(false);
    f.losePermission();
    const next = { ...f.request, intent: { ...f.request.intent, commandId: 'retry-mode' } };
    expect(await f.caller.invoke(next)).toMatchObject({
      phase: 'unknown',
      stage: 'permission',
      creation: { phase: 'created' },
    });
    expect(f.counts()).toMatchObject({ creates: 1, starts: 0, modes: 2 });
    expect(await f.caller.invoke(next)).toMatchObject({ phase: 'unknown' });
    const result = (await f.caller.invoke({
      method: 'conversation.lookup',
      generation: 1,
      commandId: 'retry-mode',
    })) as NativeConversationResult;
    expect(result).toMatchObject({ phase: 'failed', code: 'conversation_continue_explicit' });
    expect(f.counts()).toMatchObject({ creates: 1, starts: 0, modes: 2 });
    expect(
      await f.caller.invoke({
        ...f.request,
        intent: { ...f.request.intent, commandId: 'after-check' },
      }),
    ).toMatchObject({ phase: 'accepted' });
    expect(f.counts()).toMatchObject({ creates: 1, starts: 1, modes: 2 });
  } finally {
    await f.close();
  }
});

test('preparation only reads known canonical projects and user models; closed IPC rejects injected path and control identities', async () => {
  const f = fixture();
  try {
    await f.ready();
    expect(
      await f.caller.invoke({ method: 'conversation.branch', generation: 1, workspaceId: 'w' }),
    ).toMatchObject({ repository: false, workspaceId: 'w' });
    expect(
      await f.caller.invoke({ method: 'conversation.models.read', generation: 1 }),
    ).toMatchObject({ kind: 'settings.models', scope: 'user', canWrite: false });
    expect(f.counts()).toMatchObject({ creates: 0, starts: 0, modes: 0, trusts: 0 });
    await expect(
      f.caller.invoke({ method: 'conversation.branch', generation: 1, workspaceId: 'foreign' }),
    ).rejects.toMatchObject({ code: 'workspace_observation_unavailable' });
    expect(decodeNativeRequest(f.request)).toEqual(f.request);
    for (const request of [
      { ...f.request, path: '/etc' },
      { ...f.request, creation: { ...f.request.creation, rootUri: 'file:///etc' } },
      { ...f.request, intent: { ...f.request.intent, subjectId: 'foreign' } },
      { ...f.request, intent: { ...f.request.intent, kind: 'input.steer' } },
      { ...f.request, targetBranch: 'x'.repeat(1025) },
    ])
      expect(() => decodeNativeRequest(request)).toThrow('invalid_native_request');
  } finally {
    await f.close();
  }
});

test('migrated Git leaf reads real branches and switches only at first send with no active work or dirty files', async () => {
  const f = fixture();
  const git = (...args: string[]) =>
    String(
      execFileSync(
        '/usr/bin/git',
        ['-c', 'user.name=Native fixture', '-c', 'user.email=native@example.invalid', ...args],
        { cwd: f.root, encoding: 'utf8' },
      ),
    ).trim();
  try {
    git('init', '-b', 'main');
    writeFileSync(join(f.root, 'fixture.txt'), 'original\n');
    git('add', 'fixture.txt');
    git('commit', '-m', 'owned fixture');
    git('branch', 'dev');
    await f.ready();
    expect(
      await f.caller.invoke({ method: 'conversation.branch', generation: 1, workspaceId: 'w' }),
    ).toMatchObject({ repository: true, current: 'main', branches: ['dev', 'main'] });
    expect(git('branch', '--show-current')).toBe('main');
    expect(f.counts()).toMatchObject({ creates: 0, starts: 0 });
    f.active(true);
    expect(await f.caller.invoke({ ...f.request, targetBranch: 'dev' })).toMatchObject({
      phase: 'failed',
      code: 'git_active_work',
    });
    expect(git('branch', '--show-current')).toBe('main');
    f.active(false);
    writeFileSync(join(f.root, 'untracked.txt'), 'keep these bytes');
    expect(
      await f.caller.invoke({
        ...f.request,
        intent: { ...f.request.intent, commandId: 'dirty-input' },
        targetBranch: 'dev',
      }),
    ).toMatchObject({ phase: 'failed', code: 'git_workspace_dirty' });
    expect(git('branch', '--show-current')).toBe('main');
    expect(f.counts()).toMatchObject({ creates: 0, starts: 0 });
    rmSync(join(f.root, 'untracked.txt'));
    const protectedCaller = new NativeCaller(f.port, () => {}, f.data, [f.root]);
    try {
      await protectedCaller.invoke({ method: 'attach' });
      await protectedCaller.invoke({ method: 'directory', generation: 1 });
      expect(await protectedCaller.invoke({ ...f.request, targetBranch: 'dev' })).toMatchObject({
        phase: 'failed',
        code: 'git_protected_root',
      });
      expect(git('branch', '--show-current')).toBe('main');
      expect(f.counts()).toMatchObject({ creates: 0, starts: 0 });
    } finally {
      await protectedCaller.close();
    }
    const original = f.port.getModelSettings.bind(f.port);
    f.port.getModelSettings = (async (...args) => {
      expect(git('branch', '--show-current')).toBe('dev');
      return await original(...args);
    }) as AgentClient['getModelSettings'];
    expect(
      await f.caller.invoke({
        ...f.request,
        intent: { ...f.request.intent, commandId: 'explicit-clean-input' },
        targetBranch: 'dev',
      }),
    ).toMatchObject({ phase: 'accepted' });
    expect(git('branch', '--show-current')).toBe('dev');
    expect(f.counts()).toMatchObject({ creates: 1, starts: 1 });
  } finally {
    await f.close();
  }
});
