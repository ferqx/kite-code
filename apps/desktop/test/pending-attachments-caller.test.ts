import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  type AgentClient,
  canonicalCallerCommandRequest,
  type StartCommandRequest,
} from '@kite-ai/client';
import { callerDigest, callerTarget, callerTextDigest } from '../electron/caller-journal';
import { NativeCaller } from '../electron/native-caller';
import {
  createPendingAttachments,
  pendingAttachmentSchemas,
} from '../electron/pending-attachments';
import type { NativeCallerRecord } from '../src/native-bridge';
import { memoryPrivateData } from './private-data.fixture';

function client() {
  let writes = 0;
  return {
    get writes() {
      return writes;
    },
    serverInfo: { storeId: 'store', subjectId: 'local-user', capabilities: [] },
    connect: async () => ({}),
    verifyConnection: async () => ({ dataAvailability: 'available' }),
    async observe({ signal }: { signal: AbortSignal }) {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
    async getView(id: string) {
      return {
        storeId: 'store',
        snapshotCursor: '0',
        session: {
          id,
          workspaceId: 'w',
          rootSessionId: id,
          parentSessionId: null,
          title: id,
          nextSeq: '0',
          contextSelectionId: 'selection',
          controlRevision: '0',
          deletedAt: null,
        },
        runs: [],
        executions: [],
        messages: [],
      };
    },
    listWorkspaces: async () => [],
    listAllWorkspaces: async () => [],
    listAllSessions: async () => [],
    listSessions: async () => [],
    disposeNetwork() {},
    startRun: async () => {
      writes++;
    },
  } as unknown as AgentClient & { writes: number };
}

function fixture() {
  const db = new Database(':memory:');
  const data = memoryPrivateData();
  data.attachments = createPendingAttachments(
    () => db as unknown as DatabaseSync,
    (fn) => db.transaction(fn)(),
    () => {
      if (
        Number((db.query('PRAGMA user_version').get() as { user_version: number }).user_version) <
        13
      ) {
        for (const schema of pendingAttachmentSchemas) db.exec(schema);
        db.exec('PRAGMA user_version=13');
      }
    },
  );
  const port = client(),
    caller = new NativeCaller(port, () => {}, data);
  return { db, data, port, caller };
}
const bytes = Buffer.from('image bytes');
const hash = createHash('sha256').update(bytes).digest('hex');
const scope = { storeId: 'store', workspaceId: 'w', rootSessionId: 's' };
const item = (id: string) => ({
  id,
  kind: 'image' as const,
  state: 'ready' as const,
  name: id,
  size: bytes.length,
  hash,
  mediaType: 'image/png',
  chunks: [bytes],
});
async function stage(caller: NativeCaller, id: string, generation = 1) {
  await caller.invoke({
    method: 'input.images.begin',
    generation,
    id,
    name: id,
    size: bytes.length,
    hash,
    mediaType: 'image/png',
  });
  await caller.invoke({
    method: 'input.images.append',
    generation,
    id,
    offset: 0,
    data: bytes.toString('base64'),
  });
  await caller.invoke({ method: 'input.images.finish', generation, id });
}
test('Main restores persisted images after attach reset and admits only exact fresh root scope', async () => {
  const f = fixture();
  try {
    await f.caller.invoke({ method: 'attach' });
    await stage(f.caller, 'a');
    await f.caller.invoke({
      method: 'input.attachments.write',
      generation: 1,
      sessionId: 's',
      revision: 0,
      attachments: [{ id: 'a', kind: 'image', name: 'a' }],
    });
    await f.caller.invoke({ method: 'attach' });
    await f.caller.invoke({ method: 'input.attachments.read', generation: 2, sessionId: 's' });
    expect(
      await f.caller.invoke({
        method: 'input.attachments.preview',
        generation: 2,
        sessionId: 's',
        id: 'a',
        offset: 0,
      }),
    ).toMatchObject({ data: bytes.toString('base64'), done: true });
    const original = f.port.getView.bind(f.port);
    for (const override of [
      { storeId: 'other' },
      { session: { ...(await original('s')).session, parentSessionId: 'parent' } },
      { session: { ...(await original('s')).session, id: 'other' } },
    ]) {
      f.port.getView = async (id) => ({ ...(await original(id)), ...override });
      await expect(
        f.caller.invoke({ method: 'input.attachments.read', generation: 2, sessionId: 's' }),
      ).rejects.toThrow('attachment_scope_unavailable');
    }
    expect(f.port.writes).toBe(0);
  } finally {
    await f.caller.close();
    f.db.close();
  }
});
test('Main failed multi-image restore rolls back its partial budget reservation', async () => {
  const f = fixture();
  try {
    await f.caller.invoke({ method: 'attach' });
    for (let i = 0; i < 127; i++) await stage(f.caller, `held-${i}`);
    f.data.attachments!.save(scope, 0, [item('a'), item('b')]);
    await expect(
      f.caller.invoke({ method: 'input.attachments.read', generation: 1, sessionId: 's' }),
    ).rejects.toThrow('native_image_budget_unavailable');
    expect(f.data.attachments!.read(scope).attachments.map((entry) => entry.state)).toEqual([
      'ready',
      'ready',
    ]);
    await f.caller.invoke({ method: 'input.images.release', generation: 1, id: 'held-0' });
    expect(
      await f.caller.invoke({ method: 'input.attachments.read', generation: 1, sessionId: 's' }),
    ).toMatchObject({
      attachments: [
        { id: 'a', state: 'ready' },
        { id: 'b', state: 'ready' },
      ],
    });
  } finally {
    await f.caller.close();
    f.db.close();
  }
});
test('Main delayed admission tolerates released saved bytes but cannot resurrect deleted first writes', async () => {
  const f = fixture();
  try {
    await f.caller.invoke({ method: 'attach' });
    await stage(f.caller, 'a');
    f.data.attachments!.save(scope, 0, [item('a')]);
    const original = f.port.getView.bind(f.port);
    let release!: () => void;
    f.port.getView = async (id) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(id);
    };
    const pending = f.caller.invoke({
      method: 'input.attachments.write',
      generation: 1,
      sessionId: 's',
      revision: 1,
      attachments: [{ id: 'a', kind: 'image', name: 'a' }],
    });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
    await f.caller.invoke({ method: 'input.images.release', generation: 1, id: 'a' });
    release();
    expect(await pending).toMatchObject({
      revision: 2,
      attachments: [{ id: 'a', state: 'ready' }],
    });
    await stage(f.caller, 'b');
    const previousRelease = release;
    const doomed = f.caller.invoke({
      method: 'input.attachments.write',
      generation: 1,
      sessionId: 'never',
      revision: 0,
      attachments: [{ id: 'b', kind: 'image', name: 'b' }],
    });
    while (release === previousRelease) await new Promise((resolve) => setTimeout(resolve, 0));
    f.data.attachments!.deleteSession('store', 'never');
    release();
    await expect(doomed).rejects.toThrow('attachment_scope_unavailable');
  } finally {
    await f.caller.close();
    f.db.close();
  }
});

test('Main exposes an interrupted durable rejection as unresolved attachment recovery without a POST', async () => {
  const f = fixture();
  try {
    const request: StartCommandRequest = {
      kind: 'run.start',
      commandId: 'crash-gap',
      expectedStoreId: 'store',
      content: 'original rejected content',
    };
    const callerScope = { storeId: 'store', workspaceId: 'w', sessionId: 's' };
    const original: NativeCallerRecord = {
      phase: 'submitting',
      intent: {
        scope: callerScope,
        subjectId: 'local-user',
        request,
        target: callerTarget(callerScope, request),
        bodyDigest: callerDigest(request),
        requestDigest: callerTextDigest(canonicalCallerCommandRequest(request)),
      },
    };
    f.data.attachments!.save(scope, 0, [item('a')]);
    f.data.attachments!.bind(request.commandId, scope, 1, ['a'], []);
    f.data.beginCaller(original);
    f.data.attachments!.consume({ ...original, phase: 'accepted' });
    // Deliberately omit the post-receipt helper and marker, as an older interrupted client did.
    f.data.finishCaller(request.commandId, 'rejected');
    expect(f.data.attachments!.proof(request.commandId)?.recovery).toBeUndefined();
    const state = await f.caller.invoke({ method: 'attach' });
    expect(state).toMatchObject({
      callerSubmissions: [
        {
          phase: 'rejected',
          attachmentRecovery: {
            phase: 'unavailable',
            sessionId: 's',
            workspaceId: 'w',
            error: 'attachment_recovery_pending',
          },
        },
      ],
    });
    expect(f.data.attachments!.read(scope).attachments).toHaveLength(0);
    expect(f.data.attachments!.recoveryItems(request.commandId)?.map((entry) => entry.id)).toEqual([
      'a',
    ]);
    expect(f.port.writes).toBe(0);
  } finally {
    await f.caller.close();
    f.db.close();
  }
});
