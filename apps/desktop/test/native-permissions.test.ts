import { expect, test } from 'bun:test';
import {
  type AgentClient,
  type Change,
  ClientError,
  type PermissionMutation,
  type SetPermissionModeRequest,
} from '@kite-ai/client';
import { NativeCaller } from '../electron/native-caller';
import { createDesktopController } from '../src/controller';
import type { NativeState } from '../src/native-bridge';

function port() {
  let unavailable = false,
    writes = 0;
  const inputs: { sessionId: string; input: SetPermissionModeRequest }[] = [];
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['permission_controls'] },
    connect: async () => ({}),
    disposeNetwork() {},
    async observe({ signal }: { signal: AbortSignal }) {
      await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
    },
    async getView(id: string) {
      return {
        storeId: 'store',
        snapshotCursor: '0',
        session: {
          id,
          workspaceId: 'w',
          rootSessionId: id === 'child' ? 'a' : id,
          parentSessionId: id === 'child' ? 'a' : null,
          title: id,
          nextSeq: '0',
          contextSelectionId: 'ctx',
          controlRevision: '0',
          deletedAt: null,
        },
        messages: [],
        runs: [],
        executions: [],
      };
    },
    async getPermissionMode(id: string) {
      if (unavailable) throw Error('read lost');
      return {
        storeId: 'store',
        sessionId: id,
        scopeSessionId: id === 'child' ? 'a' : id,
        mode: 'auto',
        revision: '0',
        defaultMode: 'auto',
        defaultRevision: '0',
      };
    },
    async getWorkspaceTrust(id: string) {
      return {
        storeId: 'store',
        workspaceId: id,
        status: 'untrusted',
        trusted: false,
        revision: '0',
        canonicalIdentity: 'a'.repeat(64),
        externalReadScopeDigest: 'b'.repeat(64),
        readScopes: [{ kind: 'workspace', description: 'current workspace' }],
      };
    },
    async setPermissionMode(sessionId: string, input: SetPermissionModeRequest) {
      writes++;
      inputs.push({ sessionId, input });
      return {
        commandId: input.commandId,
        kind: 'permission.mode',
        state: 'applied',
        receipt: {
          status: 'applied',
          mode: input.mode,
          makeDefault: input.makeDefault,
          revision: '1',
          defaultRevision: '0',
        },
      } as PermissionMutation;
    },
  };
  return {
    client: client as unknown as AgentClient,
    inputs,
    get writes() {
      return writes;
    },
    set unavailable(value: boolean) {
      unavailable = value;
    },
  };
}
async function code(work: Promise<unknown>) {
  try {
    await work;
    return 'success';
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
}

function controlChange(
  sessionId: string | null,
  kind: string,
  scope: string,
  makeDefault = false,
): Change {
  return {
    cursor: '1',
    sessionId,
    objectId: 'permission-command',
    type: 'host_control.changed',
    revision: '1',
    payload: { kind, scope, receipt: { status: 'applied', makeDefault } },
  };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error('permission_observation_deadline');
    await Bun.sleep(1);
  }
}

for (const native of [false, true]) {
  test(`${native ? 'Native' : 'Desktop'} observation refreshes child root/default/trust facts and isolates foreign and late scopes`, async () => {
    const source = port();
    let notify!: Parameters<AgentClient['observe']>[0]['onChange'];
    source.client.observe = async (options) => {
      notify = options.onChange;
      await new Promise<void>((resolve) =>
        options.signal!.addEventListener('abort', () => resolve(), { once: true }),
      );
    };
    const originalMode = source.client.getPermissionMode.bind(source.client),
      originalTrust = source.client.getWorkspaceTrust.bind(source.client);
    let mode: 'auto' | 'full' = 'auto',
      reads = 0,
      trustReads = 0;
    let hold: { entered: () => void; promise: Promise<void> } | undefined;
    source.client.getPermissionMode = async (...args) => {
      reads++;
      const result = { ...(await originalMode(...args)), mode };
      const held = hold;
      hold = undefined;
      if (held) {
        held.entered();
        await held.promise;
      }
      return result;
    };
    source.client.getWorkspaceTrust = async (...args) => {
      trustReads++;
      return originalTrust(...args);
    };
    const caller = native ? new NativeCaller(source.client, () => {}) : undefined,
      desktop = native
        ? undefined
        : createDesktopController({ admittedClient: source.client, onSnapshot() {} });
    let generation = 0;
    const select = async (sessionId: string) => {
      if (caller) await caller.invoke({ method: 'select', generation, sessionId });
      else await desktop!.selectSession(sessionId);
    };
    const facts = () =>
      caller ? caller.state().selection?.permissions : desktop!.snapshot?.permissions;
    const selected = () =>
      caller ? caller.state().selection?.session.id : desktop!.snapshot?.sessionId;
    try {
      if (caller)
        generation = ((await caller.invoke({ method: 'attach' })) as NativeState).generation;
      else void desktop!.observe();
      await select('child');
      expect(facts()!.mode.scopeSessionId).toBe('a');
      const initialReads = reads;
      await notify(controlChange('foreign', 'permission.mode', 'session:foreign'));
      await notify(controlChange(null, 'workspace.trust', 'workspace:foreign'));
      await Bun.sleep(130);
      expect(reads).toBe(initialReads);
      mode = 'full';
      await notify(controlChange('a', 'permission.mode', 'session:a'));
      await until(() => facts()?.mode.mode === 'full');
      expect(facts()!.mode.sessionId).toBe('child');
      const defaultReads = reads;
      mode = 'auto';
      await notify(controlChange('foreign', 'permission.mode', 'session:foreign', true));
      await until(() => reads > defaultReads && facts()?.mode.mode === 'auto');
      const priorTrustReads = trustReads;
      await notify(controlChange(null, 'workspace.trust', 'workspace:w'));
      await until(() => trustReads > priorTrustReads && !!facts());

      let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      hold = {
        entered,
        promise: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      mode = 'full';
      const oldRefresh = notify(controlChange('a', 'permission.mode', 'session:a'));
      await waiting;
      mode = 'auto';
      await select('other');
      release();
      await oldRefresh;
      await Bun.sleep(130);
      expect(selected()).toBe('other');
      expect(facts()!.mode).toMatchObject({
        sessionId: 'other',
        scopeSessionId: 'other',
        mode: 'auto',
      });

      // The first View has arrived, but no complete child snapshot exists yet.
      let enterFirst!: () => void, releaseFirst!: () => void;
      const firstRead = new Promise<void>((resolve) => {
        enterFirst = resolve;
      });
      hold = {
        entered: enterFirst,
        promise: new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
      };
      const selecting = select('child').catch(() => undefined);
      await firstRead;
      mode = 'full';
      const firstChange = notify(controlChange('a', 'permission.mode', 'session:a'));
      releaseFirst();
      await Promise.all([selecting, firstChange]);
      await until(() => facts()?.mode.sessionId === 'child' && facts()?.mode.mode === 'full');
      expect(facts()!.mode).toMatchObject({
        sessionId: 'child',
        scopeSessionId: 'a',
        mode: 'full',
      });
      expect(source.writes).toBe(0);
    } finally {
      if (caller) await caller.close();
      else desktop!.disposeNetwork();
    }
  });
}
test('main makes failed permission reads unavailable before any new write; re-read renews observation and children remain read-only', async () => {
  const source = port(),
    caller = new NativeCaller(source.client, () => {});
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as NativeState;
    const first = (await caller.invoke({
        method: 'select',
        generation,
        sessionId: 'a',
      })) as NativeState,
      old = first.selection!.permissions!.observationId;
    source.unavailable = true;
    expect(await code(caller.invoke({ method: 'permission.refresh', generation }))).toBe(
      'read lost',
    );
    const failed = caller.state();
    expect(failed.selection!.permissionUnavailable).toBe(true);
    expect(failed.selection!.permissions).toBeUndefined();
    expect(
      await code(
        caller.invoke({
          method: 'permission.mode',
          generation,
          observationId: old,
          mode: 'full',
          makeDefault: false,
        }),
      ),
    ).toBe('permission_facts_unavailable');
    expect(source.writes).toBe(0);
    source.unavailable = false;
    const fresh = (await caller.invoke({
      method: 'permission.refresh',
      generation,
    })) as NativeState;
    expect(fresh.selection!.permissionUnavailable).toBe(false);
    expect(
      await code(
        caller.invoke({
          method: 'permission.mode',
          generation,
          observationId: old,
          mode: 'full',
          makeDefault: false,
        }),
      ),
    ).toBe('permission_observation_changed');
    const child = (await caller.invoke({
      method: 'select',
      generation,
      sessionId: 'child',
    })) as NativeState;
    expect(
      await code(
        caller.invoke({
          method: 'permission.mode',
          generation,
          observationId: child.selection!.permissions!.observationId,
          mode: 'full',
          makeDefault: false,
        }),
      ),
    ).toBe('child_session_readonly');
    expect(source.writes).toBe(0);
  } finally {
    await caller.close();
  }
});
test('main duplicate permission saves share one original request; unknown intent lookup remains on A after switching B', async () => {
  const source = port();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      entered = r;
    });
  let writes = 0,
    original: SetPermissionModeRequest | undefined,
    session: string | undefined,
    lookup: string | undefined;
  Object.assign(source.client, {
    async setPermissionMode(id: string, input: SetPermissionModeRequest) {
      writes++;
      original = structuredClone(input);
      session = id;
      entered();
      await gate;
      throw new ClientError('network_outcome_unknown');
    },
    async getPermissionMutation(id: string, options: { storeId: string }) {
      lookup = id;
      expect(options.storeId).toBe('store');
      return {
        commandId: id,
        kind: 'permission.mode',
        state: 'applied',
        receipt: {
          status: 'applied',
          mode: 'full',
          makeDefault: false,
          revision: '1',
          defaultRevision: '0',
        },
      };
    },
  });
  const caller = new NativeCaller(source.client, () => {});
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as NativeState;
    const state = (await caller.invoke({
      method: 'select',
      generation,
      sessionId: 'a',
    })) as NativeState;
    const intent = {
      method: 'permission.mode' as const,
      generation,
      observationId: state.selection!.permissions!.observationId,
      mode: 'full' as const,
      makeDefault: false,
    };
    const first = caller.invoke(intent).then(
        () => '',
        (error) => (error as ClientError).code,
      ),
      duplicate = caller.invoke(intent).then(
        () => '',
        (error) => (error as ClientError).code,
      );
    await ready;
    expect(writes).toBe(1);
    await caller.invoke({ method: 'select', generation, sessionId: 'b' });
    release();
    expect(await first).toBe('network_outcome_unknown');
    expect(await duplicate).toBe('network_outcome_unknown');
    const saved = caller.state().permissionSubmissions[0]!;
    expect(saved.phase).toBe('unknown');
    expect(saved.rootSessionId).toBe('a');
    expect(saved.sessionId).toBe('a');
    expect(session).toBe('a');
    expect(original!.ifRevision).toBe('0');
    expect(original!.ifDefaultRevision).toBe('0');
    await caller.invoke({ method: 'lookupPermission', generation, commandId: original!.commandId });
    expect(lookup).toBe(original!.commandId);
    expect(caller.state().selection!.session.id).toBe('b');
    expect(caller.state().permissionSubmissions[0]!.phase).toBe('applied');
    expect(writes).toBe(1);
  } finally {
    release();
    await caller.close();
  }
});

test('late failed permission read cannot poison a newly selected root; absent capability stays read-only', async () => {
  const source = port();
  const original = source.client.getPermissionMode.bind(source.client);
  let entered!: () => void, reject!: (error: Error) => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  let hold = false;
  Object.assign(source.client, {
    async getPermissionMode(id: string) {
      if (hold && id === 'a') {
        entered();
        return await new Promise((_resolve, r) => {
          reject = r;
        });
      }
      return original(id, { storeId: 'store' });
    },
  });
  const caller = new NativeCaller(source.client, () => {});
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as NativeState;
    await caller.invoke({ method: 'select', generation, sessionId: 'a' });
    hold = true;
    const failed = code(caller.invoke({ method: 'permission.refresh', generation }));
    await ready;
    await caller.invoke({ method: 'select', generation, sessionId: 'b' });
    reject(Error('old_read_failed'));
    await failed;
    expect(caller.state().selection!.session.id).toBe('b');
    expect(caller.state().selection!.permissionUnavailable).toBe(false);
    expect(caller.state().selection!.permissions!.mode.sessionId).toBe('b');
    expect(source.writes).toBe(0);
  } finally {
    await caller.close();
  }
  const readonly = port();
  readonly.client.serverInfo!.capabilities = [];
  const absent = new NativeCaller(readonly.client, () => {});
  try {
    const { generation } = (await absent.invoke({ method: 'attach' })) as NativeState;
    const selection = (await absent.invoke({
      method: 'select',
      generation,
      sessionId: 'a',
    })) as NativeState;
    expect(selection.selection!.permissions).toBeUndefined();
    expect(
      await code(
        absent.invoke({
          method: 'permission.mode',
          generation,
          observationId: 0,
          mode: 'full',
          makeDefault: false,
        }),
      ),
    ).toBe('permission_observation_changed');
    expect(readonly.writes).toBe(0);
  } finally {
    await absent.close();
  }
});

test('existing Session input keeps an unknown project grant queryable and never dispatches work', async () => {
  const source = port();
  let grants = 0,
    starts = 0;
  Object.assign(source.client, {
    async setWorkspaceTrust() {
      grants++;
      throw new ClientError('network_outcome_unknown');
    },
    async getPermissionMutation(commandId: string, options: { storeId: string }) {
      expect(options.storeId).toBe('store');
      return {
        commandId,
        kind: 'workspace.trust',
        state: 'applied',
        receipt: { status: 'applied' },
      };
    },
    async startRun() {
      starts++;
      throw Error('unexpected_work');
    },
  });
  const caller = new NativeCaller(source.client, () => {});
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as NativeState;
    await caller.invoke({ method: 'select', generation, sessionId: 'a' });
    const submit = () =>
      caller.invoke({
        method: 'submit',
        generation,
        sessionId: 'a',
        intent: {
          kind: 'run.start',
          expectedStoreId: 'store',
          commandId: 'original-input',
          content: 'original text',
        },
      });
    expect(await code(submit())).toBe('network_outcome_unknown');
    const saved = caller.state().permissionSubmissions[0]!;
    expect(saved).toMatchObject({
      sessionId: 'a',
      workspaceId: 'w',
      kind: 'workspace.trust',
      phase: 'unknown',
    });
    expect(saved.intent).toMatchObject({
      expectedStoreId: 'store',
      ifRevision: '0',
      canonicalIdentity: 'a'.repeat(64),
      externalReadScopeDigest: 'b'.repeat(64),
    });
    expect(await code(submit())).toBe('permission_intent_saved');
    await caller.invoke({
      method: 'lookupPermission',
      generation,
      commandId: saved.intent.commandId,
    });
    expect(caller.state().permissionSubmissions[0]!.phase).toBe('applied');
    expect(grants).toBe(1);
    expect(starts).toBe(0);
  } finally {
    await caller.close();
  }
});

test('an input waiting for its project grant cannot follow a later Session selection', async () => {
  const source = port();
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let grants = 0,
    starts = 0;
  Object.assign(source.client, {
    async setWorkspaceTrust(_workspace: string, input: { commandId: string }) {
      grants++;
      entered();
      await gate;
      return {
        commandId: input.commandId,
        kind: 'workspace.trust',
        state: 'applied',
        receipt: { status: 'applied' },
      };
    },
    async startRun() {
      starts++;
      throw Error('unexpected_work');
    },
  });
  const caller = new NativeCaller(source.client, () => {});
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as NativeState;
    await caller.invoke({ method: 'select', generation, sessionId: 'a' });
    const pending = code(
      caller.invoke({
        method: 'submit',
        generation,
        sessionId: 'a',
        intent: {
          kind: 'run.start',
          expectedStoreId: 'store',
          commandId: 'original-input',
          content: 'original text',
        },
      }),
    );
    await ready;
    await caller.invoke({ method: 'select', generation, sessionId: 'b' });
    release();
    expect(await pending).toBe('permission_observation_changed');
    expect(caller.state().selection!.session.id).toBe('b');
    expect(caller.state().permissionSubmissions[0]).toMatchObject({
      sessionId: 'a',
      phase: 'applied',
    });
    expect(grants).toBe(1);
    expect(starts).toBe(0);
  } finally {
    release();
    await caller.close();
  }
});

test('project preparation rejects a replaced permission observation before granting access', async () => {
  const source = port();
  let grants = 0;
  Object.assign(source.client, {
    async setWorkspaceTrust() {
      grants++;
      throw Error('unexpected_grant');
    },
  });
  const controller = createDesktopController({ admittedClient: source.client, onSnapshot() {} });
  try {
    await controller.selectSession('a');
    const old = controller.snapshot!.permissions!.observationId;
    await controller.refreshPermissions();
    expect(controller.snapshot!.permissions!.observationId).not.toBe(old);
    expect(await code(controller.prepareWorkspaceAccess(old))).toBe(
      'permission_observation_changed',
    );
    expect(grants).toBe(0);
  } finally {
    controller.disposeNetwork();
  }
});
