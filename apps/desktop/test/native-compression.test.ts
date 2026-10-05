import { expect, test } from 'bun:test';
import {
  type AgentClient,
  ClientError,
  type Command,
  type SelectedContextPage,
} from '@kite-ai/client';
import { NativeContext } from '../electron/context';
import { decodeNativeRequest } from '../electron/native-ipc';

function fixture() {
  const scope = { generation: 1, selection: 1, storeId: 'store', sessionId: 's', workspaceId: 'w' };
  let child = false,
    active = false,
    failed = false,
    compressionId: string | null = null;
  let posts = 0,
    lookups = 0;
  let input:
    | { commandId: string; focus?: string; expectedCompressionId?: string | null }
    | undefined;
  const page = () =>
    ({
      selection: {
        id: 'selection',
        sessionId: 's',
        previousSelectionId: null,
        boundaryMessageId: null,
        boundarySeq: '0',
        tailFromSeq: '0',
        ranges: [],
      },
      highWaterSeq: '2',
      snapshotCursor: '3',
      messages: [],
      resultSources: [],
      nextAfterSeq: null,
      nextAfterSourceId: null,
      ...(compressionId ? { compression: { id: compressionId } } : {}),
    }) as SelectedContextPage;
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['context', 'commands'] },
    getContext: async () => page(),
    getView: async () => {
      if (failed) throw new ClientError('worker_unavailable');
      return {
        storeId: 'store',
        session: {
          id: 's',
          rootSessionId: child ? 'parent' : 's',
          parentSessionId: child ? 'parent' : null,
          workspaceId: 'w',
          contextSelectionId: 'selection',
          deletedAt: null,
        },
        executions: [],
        runs: active ? [{ isActive: true }] : [],
      };
    },
    async compressContext(_id: string, value: typeof input) {
      posts++;
      input = value;
      throw new ClientError('network_outcome_unknown');
    },
    async resetCompressionContext(_id: string, value: NonNullable<typeof input>) {
      posts++;
      input = value;
      return {
        id: value.commandId,
        sessionId: 's',
        originStoreId: 'store',
        kind: 'context.compression.reset',
        status: 'applied',
        receipt: { outcome: 'no_active_compression' },
        cancelRequestedAt: null,
      };
    },
    async getCommand(id: string) {
      lookups++;
      return {
        id,
        sessionId: 's',
        originStoreId: 'store',
        kind: 'context.compress',
        status: 'applied',
        receipt: null,
        cancelRequestedAt: null,
      };
    },
  } as unknown as AgentClient;
  const host = new NativeContext(
    client,
    () => scope,
    () => {},
  );
  return {
    host,
    client,
    scope,
    page,
    get posts() {
      return posts;
    },
    get lookups() {
      return lookups;
    },
    get input() {
      return input;
    },
    set child(value: boolean) {
      child = value;
    },
    set active(value: boolean) {
      active = value;
    },
    set failed(value: boolean) {
      failed = value;
    },
    set compressionId(value: string | null) {
      compressionId = value;
    },
  };
}
async function code(promise: Promise<unknown>) {
  try {
    await promise;
    return 'success';
  } catch (error) {
    return (error as { code: string }).code;
  }
}
test('Native compression freezes full focus and original command; lost answer can only query that ID after view change', async () => {
  const f = fixture(),
    focus = `${'完整说明。'.repeat(3000)} FULL_FOCUS_TAIL`,
    facts = await f.host.read('s');
  expect(await code(f.host.maintainCompression(facts.observationId, 'compress', focus))).toBe(
    'network_outcome_unknown',
  );
  expect(f.input?.focus).toBe(focus);
  expect(f.posts).toBe(1);
  const intent = f.host.compressionSubmissions[0]!;
  expect(intent.intent.focusBytes).toBe(Buffer.byteLength(focus));
  expect(intent.phase).toBe('unknown');
  f.scope.sessionId = 'other';
  f.scope.selection++;
  await f.host.lookupCompression(intent.intent.commandId);
  expect(f.lookups).toBe(1);
  expect(f.posts).toBe(1);
  expect(f.host.compressionSubmissions[0]?.phase).toBe('applied');
});
test('Native compression refuses child/active/failed refresh/stale compression locally; null reset is explicit original scoped command', async () => {
  for (const kind of ['child', 'active', 'failed', 'compressionId'] as const) {
    const f = fixture(),
      facts = await f.host.read('s');
    if (kind === 'compressionId') f.compressionId = 'changed';
    else f[kind] = true;
    expect(await code(f.host.maintainCompression(facts.observationId, 'reset'))).toBe(
      kind === 'child'
        ? 'child_session_readonly'
        : kind === 'active'
          ? 'input_busy'
          : kind === 'failed'
            ? 'worker_unavailable'
            : 'compression_selection_changed',
    );
    expect(f.posts).toBe(0);
  }
  const f = fixture(),
    facts = await f.host.read('s');
  await f.host.maintainCompression(facts.observationId, 'reset');
  expect(f.posts).toBe(1);
  expect(f.input?.expectedCompressionId).toBeNull();
  expect(f.host.compressionSubmissions[0]?.phase).toBe('applied');
  expect(() =>
    decodeNativeRequest({
      method: 'context.compress',
      generation: 1,
      observationId: 1,
      focus: 'ok',
      expectedStoreId: 'other',
    }),
  ).toThrow('invalid_native_request');
  expect(() =>
    decodeNativeRequest({
      method: 'context.resetCompression',
      generation: 1,
      observationId: 1,
      expectedCompressionId: 'other',
    }),
  ).toThrow('invalid_native_request');
});
test('Native accepted compression never invents successful Run; original Run facts remain separate', async () => {
  const f = fixture();
  let command!: Command;
  Object.assign(f.client, {
    compressContext: async (_id: string, input: { commandId: string }) =>
      (command = {
        id: input.commandId,
        sessionId: 's',
        originStoreId: 'store',
        kind: 'context.compress',
        status: 'accepted',
        receipt: null,
        cancelRequestedAt: null,
      }),
  });
  const facts = await f.host.read('s');
  await f.host.maintainCompression(facts.observationId, 'compress');
  expect(f.host.compressionSubmissions[0]).toMatchObject({
    phase: 'accepted',
    command: { status: 'accepted' },
  });
  expect(f.host.compressionSubmissions[0]?.run).toBeUndefined();
  Object.assign(f.client, {
    getCommand: async () => ({
      ...command,
      status: 'rejected',
      receipt: { code: 'permission_denied' },
    }),
  });
  await f.host.lookupCompression(command.id);
  expect(f.host.compressionSubmissions[0]?.phase).toBe('failed');
});
