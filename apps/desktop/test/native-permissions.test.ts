import { expect, test } from 'bun:test';
import {
  type AgentClient,
  ClientError,
  type PermissionMutation,
  type SetPermissionModeRequest,
} from '@kite-ai/client';
import { NativeCaller } from '../electron/native-caller';
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
