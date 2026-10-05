import { expect, test } from 'bun:test';
import { ClientError } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  type FileCheckpointPort,
  FileCheckpointReader,
  type FileCheckpointScope,
  FileCheckpoints,
} from '../src/file-checkpoints';

const scope: FileCheckpointScope = {
  storeId: 'current-B',
  sessionId: 's',
  workspaceId: 'w',
  contextSelectionId: 'selection',
  revision: '1',
};
function item(n = 1, revision = '1') {
  return {
    checkpoint: {
      id: n.toString(16).padStart(64, '0'),
      workspace: { device: '1', inode: '2' },
      boundary: {
        storeId: 'original-A',
        workspaceId: 'w',
        sessionId: 's',
        runId: 'original-run',
        contextSelectionId: 'original-selection',
        messageId: null,
        messageSeq: '0',
        triggerMessageId: 'trigger',
        triggerSeq: '2',
      },
    },
    revision,
  };
}
function page(items = [item()], nextAfterKey: string | null = null) {
  return { ...scope, payload: { items, nextAfterKey } };
}
function detail(n = 1) {
  return {
    ...scope,
    payload: {
      checkpoint: item(n).checkpoint,
      files: [
        {
          path: '完整 file.txt',
          recordRevision: '1',
          status: 'conflict' as const,
          reason: 'file_path_protected',
          preimage: null,
          original: null,
          expected: null,
        },
      ],
    },
  };
}
function port(overrides: Partial<FileCheckpointPort> = {}): FileCheckpointPort {
  return {
    serverInfo: {
      storeId: scope.storeId,
      dataAvailability: 'available',
      capabilities: ['file_checkpoints'],
    },
    async listFileCheckpoints() {
      return page();
    },
    async getFileCheckpoint() {
      return detail();
    },
    async getFileRestoreStatus() {
      return { ...scope, payload: { journal: null, execution: null } };
    },
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function domFixture(client: FileCheckpointPort) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const old = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    old.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const element = dom.window.document.getElementById('root')!,
    root = createRoot(element);
  const render = async (nextScope = scope, suspended = false) => {
    await act(async () =>
      root.render(
        <FileCheckpoints
          client={client}
          scope={nextScope}
          window={dom.window as unknown as Window}
          suspended={suspended}
        />,
      ),
    );
  };
  await render();
  return {
    dom,
    element,
    render,
    async click(name: string) {
      const b = Array.from(element.querySelectorAll('button')).find((b) => b.textContent === name);
      if (!b) throw Error(`missing_button:${name}`);
      await act(async () => b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    },
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, value] of old) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('reader preserves original A/current B and all 200+1 keyset rows through final empty page without snapshot fiction', async () => {
  const calls: (string | undefined)[] = [];
  const rows = Array.from({ length: 200 }, (_, n) => item(n + 1));
  const key = (n: number) => `checkpoint/${item(n).checkpoint.id}/point`;
  const reader = new FileCheckpointReader(
    port({
      async listFileCheckpoints(session, input) {
        expect(session).toBe('s');
        expect(Object.keys(input!).sort()).toEqual(
          input?.afterKey ? ['afterKey', 'limit', 'signal'] : ['limit', 'signal'],
        );
        calls.push(input?.afterKey);
        return calls.length === 1
          ? page(rows, key(200))
          : calls.length === 2
            ? page([item(201)], key(201))
            : page([], null);
      },
    }),
    scope,
    () => {},
  );
  await reader.list(true);
  await reader.list(false);
  await reader.list(false);
  expect(reader.state.items).toHaveLength(201);
  expect(reader.state.nextAfterKey).toBeNull();
  expect(calls).toEqual([undefined, key(200), key(201)]);
  expect(reader.state.items?.at(-1)?.checkpoint.boundary.storeId).toBe('original-A');
  expect(reader.scope.storeId).toBe('current-B');
  reader.dispose();
});

test('reader keeps same-scope stale metadata on network/overbudget and rejects wrong W/nonprogress/oversized page without clipping', async () => {
  let mode = 'good';
  const reader = new FileCheckpointReader(
    port({
      async listFileCheckpoints() {
        if (mode === 'network') throw Error('offline');
        if (mode === 'wrong') return { ...page(), workspaceId: 'other' };
        if (mode === 'over') return page([item(1, 'x'.repeat(8 * 1024 * 1024))]);
        if (mode === 'many') return page(Array.from({ length: 201 }, (_, n) => item(n + 1)));
        return page();
      },
    }),
    scope,
    () => {},
  );
  await reader.list(true);
  for (const value of ['network', 'wrong', 'over', 'many']) {
    mode = value;
    await reader.list(true);
    expect(reader.state.items).toHaveLength(1);
    expect(reader.state.items?.[0]?.revision).toBe('1');
    expect(reader.state.error.list).toBe(
      value === 'over'
        ? 'file_checkpoint_metadata_budget_exceeded'
        : value === 'network'
          ? 'file_checkpoint_read_unavailable'
          : 'file_checkpoint_scope_conflict',
    );
  }
  const bad = new FileCheckpointReader(
    port({
      async listFileCheckpoints() {
        return page([item()], `checkpoint/${item(2).checkpoint.id}/point`);
      },
    }),
    scope,
    () => {},
  );
  await bad.list(true);
  expect(bad.state.items).toBeUndefined();
  expect(bad.state.error.list).toBe('file_checkpoint_scope_conflict');
  reader.dispose();
  bad.dispose();
});

test('point revision refresh aborts old detail/status; late success/error and mutated selected objects cannot retarget', async () => {
  const pending = deferred<ReturnType<typeof detail>>();
  let signal: AbortSignal | undefined,
    revision = '1';
  const reader = new FileCheckpointReader(
    port({
      async listFileCheckpoints() {
        return page([item(1, revision)]);
      },
      async getFileCheckpoint(_s, id, options) {
        expect(id).toBe(item().checkpoint.id);
        signal = options?.signal;
        return pending.promise;
      },
    }),
    scope,
    () => {},
  );
  await reader.list(true);
  const selected = item();
  const reading = reader.select(selected);
  selected.checkpoint.id = item(2).checkpoint.id;
  revision = '2';
  await reader.list(true);
  expect(signal?.aborted).toBe(true);
  expect(reader.state.point).toBeUndefined();
  pending.resolve(detail());
  await reading;
  expect(reader.state.detail).toBeUndefined();
  reader.dispose();
  const late = deferred<ReturnType<typeof page>>();
  const disposed = new FileCheckpointReader(
    port({
      async listFileCheckpoints() {
        return late.promise;
      },
    }),
    scope,
    () => {},
  );
  const waiting = disposed.list(true);
  disposed.dispose();
  late.reject(new ClientError('wrong_scope'));
  await waiting;
  expect(disposed.state.error.list).toBeUndefined();
});

test('DOM exposes original scope/protected reason, closed metadata only and no restoration/media/action controls', async () => {
  let reads = 0;
  const f = await domFixture(
    port({
      async listFileCheckpoints() {
        reads++;
        return page();
      },
    }),
  );
  try {
    await f.click('File checkpoints');
    expect(f.element.textContent).toContain('Current observation: Store current-B');
    expect(f.element.textContent).toContain('Original Store original-A');
    await f.click(`Point ${item().checkpoint.id} · revision 1`);
    expect(f.element.textContent).toContain('conflict');
    expect(f.element.textContent).toContain('protected');
    expect(f.element.textContent).toContain('file_path_protected');
    expect(f.element.querySelectorAll('a,form')).toHaveLength(0);
    expect(
      Array.from(f.element.querySelectorAll('button')).some((b) =>
        /approve|download|open file|restore files|execute/i.test(b.textContent ?? ''),
      ),
    ).toBe(false);
    expect(reads).toBe(1);
    await f.click('Close File checkpoints');
    expect(f.element.textContent).not.toContain('Current observation');
  } finally {
    await f.close();
  }
});

test('DOM hides/aborts reads on scope/selection/revision/hide/close and never publishes late other-session responses', async () => {
  const pending: ReturnType<typeof deferred<ReturnType<typeof page>>>[] = [];
  const signals: AbortSignal[] = [];
  const f = await domFixture(
    port({
      async listFileCheckpoints(_s, input) {
        const p = deferred<ReturnType<typeof page>>();
        pending.push(p);
        signals.push(input!.signal!);
        return p.promise;
      },
    }),
  );
  try {
    await f.click('File checkpoints');
    await f.render({ ...scope, contextSelectionId: 'new-selection' });
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => pending[0]!.resolve(page()));
    expect(f.element.textContent).not.toContain('Original Store original-A');
    await f.click('File checkpoints');
    await f.render({ ...scope, revision: '2' });
    expect(signals[1]?.aborted).toBe(true);
    await act(async () => pending[1]!.reject(Error('late')));
    expect(f.element.textContent).not.toContain('late');
    await f.click('File checkpoints');
    Object.defineProperty(f.dom.window.document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    await act(async () =>
      f.dom.window.document.dispatchEvent(new f.dom.window.Event('visibilitychange')),
    );
    expect(signals[2]?.aborted).toBe(true);
    await act(async () => pending[2]!.resolve(page()));
    expect(f.element.textContent).not.toContain('Current observation');
    Object.defineProperty(f.dom.window.document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    await f.render({ ...scope, sessionId: 'other' });
    await f.click('File checkpoints');
    await f.click('Close File checkpoints');
    expect(signals[3]?.aborted).toBe(true);
    await act(async () => pending[3]!.resolve(page()));
    expect(f.element.textContent).not.toContain('Original Store original-A');
  } finally {
    await f.close();
  }
});

test('original restore lookup separates restored journal/unknown carrier, legacy blocked and exact IDs; same lookup failures stay stale', async () => {
  let mode = 'known';
  const calls: string[] = [];
  const reader = new FileCheckpointReader(
    port({
      async getFileRestoreStatus(session, pointId, restoreId) {
        calls.push(`${session}:${pointId}:${restoreId}`);
        if (mode === 'network') throw Error('offline');
        if (mode === 'wrong')
          return {
            ...scope,
            payload: {
              journal: {
                id: 'other',
                checkpointId: pointId,
                phase: 'blocked',
                reason: 'checkpoint_restore_boundary_unavailable',
                headRevision: '1',
                fileRevisions: [],
              },
              execution: null,
            },
          };
        if (mode === 'blocked')
          return {
            ...scope,
            payload: {
              journal: {
                id: restoreId,
                checkpointId: pointId,
                phase: 'blocked',
                reason: 'checkpoint_restore_boundary_unavailable',
                headRevision: '1',
                fileRevisions: [{ path: 'original.txt', revision: '2' }],
              },
              execution: null,
            },
          };
        return {
          ...scope,
          payload: {
            journal: {
              id: restoreId,
              checkpointId: pointId,
              executionId: 'original-job',
              planDigest: 'a'.repeat(64),
              phase: 'restored',
              files: [],
            },
            execution: { id: 'original-job', status: 'outcome_unknown', resultRevision: '3' },
          },
        };
      },
    }),
    scope,
    () => {},
  );
  await reader.list(true);
  await reader.select(item());
  await reader.restoreStatus('original-restore');
  expect(reader.state.status?.journal?.phase).toBe('restored');
  expect(reader.state.status?.execution?.status).toBe('outcome_unknown');
  mode = 'network';
  await reader.restoreStatus('original-restore');
  expect(reader.state.error.status).toBe('file_checkpoint_read_unavailable');
  expect(reader.state.status?.execution?.status).toBe('outcome_unknown');
  mode = 'wrong';
  await reader.restoreStatus('original-restore');
  expect(reader.state.error.status).toBe('file_checkpoint_scope_conflict');
  expect(reader.state.status?.requestedRestoreId).toBe('original-restore');
  mode = 'blocked';
  await reader.restoreStatus('blocked-original');
  expect(reader.state.status?.journal?.phase).toBe('blocked');
  expect(reader.state.status?.execution).toBeNull();
  expect(reader.state.status?.journal && 'files' in reader.state.status.journal).toBe(false);
  const count = calls.length;
  await reader.restoreStatus('../unsafe');
  expect(calls).toHaveLength(count);
  reader.dispose();
});

test('valid large detail metadata fails explicit budget and preserves old complete same-point detail', async () => {
  let large = false;
  const reader = new FileCheckpointReader(
    port({
      async getFileCheckpoint() {
        if (!large) return detail();
        return {
          ...detail(),
          payload: {
            ...detail().payload,
            files: Array.from({ length: 2100 }, (_, n) => ({
              path: `${n}-${'x'.repeat(4090)}`,
              recordRevision: '1',
              status: 'unavailable' as const,
              reason: 'checkpoint_artifact_invalid',
              preimage: null,
              original: null,
              expected: null,
            })),
          },
        };
      },
    }),
    scope,
    () => {},
  );
  await reader.list(true);
  await reader.select(item());
  large = true;
  await reader.select(item());
  expect(reader.state.error.detail).toBe('file_checkpoint_metadata_budget_exceeded');
  expect(reader.state.detail?.files).toHaveLength(1);
  expect(reader.state.detail?.files[0]?.path).toBe('完整 file.txt');
  reader.dispose();
});

test('fork source boundary remains original while only outer current Store/S/W authorizes observation', async () => {
  const original = item();
  original.checkpoint.boundary.sessionId = 'parent-session';
  original.checkpoint.boundary.workspaceId = 'parent-workspace';
  let changed = false;
  const reader = new FileCheckpointReader(
    port({
      async listFileCheckpoints() {
        return page([original]);
      },
      async getFileCheckpoint() {
        return {
          ...scope,
          payload: {
            ...detail().payload,
            checkpoint: {
              ...original.checkpoint,
              boundary: {
                ...original.checkpoint.boundary,
                runId: changed ? 'different-run' : original.checkpoint.boundary.runId,
              },
            },
          },
        };
      },
    }),
    scope,
    () => {},
  );
  await reader.list(true);
  await reader.select(reader.state.items![0]!);
  expect(reader.state.detail?.checkpoint.boundary.sessionId).toBe('parent-session');
  expect(reader.state.detail?.checkpoint.boundary.workspaceId).toBe('parent-workspace');
  changed = true;
  await reader.select(reader.state.items![0]!);
  expect(reader.state.error.detail).toBe('file_checkpoint_scope_conflict');
  expect(reader.state.detail?.checkpoint.boundary.runId).toBe('original-run');
  reader.dispose();
});

test('DOM reads explicit original restore metadata and editing its target aborts late status without a write', async () => {
  const calls: string[] = [];
  let signal: AbortSignal | undefined;
  const pending =
    deferred<Awaited<ReturnType<NonNullable<FileCheckpointPort['getFileRestoreStatus']>>>>();
  const f = await domFixture(
    port({
      async getFileRestoreStatus(session, point, id, options) {
        calls.push(`${session}:${point}:${id}`);
        signal = options?.signal;
        return pending.promise;
      },
    }),
  );
  try {
    await f.click('File checkpoints');
    await f.click(`Point ${item().checkpoint.id} · revision 1`);
    const input = f.element.querySelector('input')!;
    await act(async () => {
      input.value = 'original-restore';
      input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    });
    await f.click('Read original restore status');
    expect(calls).toEqual([`s:${item().checkpoint.id}:original-restore`]);
    await act(async () => {
      input.value = 'different-original';
      input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    });
    expect(signal?.aborted).toBe(true);
    await act(async () =>
      pending.resolve({ ...scope, payload: { journal: null, execution: null } }),
    );
    expect(f.element.querySelector('[aria-label="Original restore status"]')).toBeNull();
    expect(f.element.querySelectorAll('a,form')).toHaveLength(0);
    expect(calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('DOM presents all five preview states and v2 journal independently from unknown carrier', async () => {
  const f = await domFixture(
    port({
      async getFileCheckpoint() {
        return {
          ...detail(),
          payload: {
            ...detail().payload,
            files: (['restore', 'remove', 'unchanged', 'conflict', 'unavailable'] as const).map(
              (status) => ({
                ...detail().payload.files[0]!,
                path: `${status}.txt`,
                status,
                reason:
                  status === 'unavailable'
                    ? 'artifact_missing'
                    : status === 'conflict'
                      ? 'file_path_protected'
                      : null,
              }),
            ),
          },
        };
      },
      async getFileRestoreStatus(_session, point, id) {
        return {
          ...scope,
          payload: {
            journal: {
              id,
              checkpointId: point,
              executionId: 'original-job',
              planDigest: 'a'.repeat(64),
              phase: 'restored',
              rootWorkSeq: '9223372036854775806',
              files: [
                {
                  path: 'restore.txt',
                  operation: 'restore',
                  state: 'outcome_unknown',
                  expected: null,
                  original: null,
                  preimage: null,
                  confirmedPost: { baseline: null },
                  error: 'physical_outcome_unknown',
                },
              ],
            },
            execution: { id: 'original-job', status: 'outcome_unknown', resultRevision: '3' },
          },
        };
      },
    }),
  );
  try {
    await f.click('File checkpoints');
    await f.click(`Point ${item().checkpoint.id} · revision 1`);
    for (const status of ['restore', 'remove', 'unchanged', 'conflict', 'unavailable'])
      expect(f.element.textContent).toContain(`preview ${status}`);
    expect(f.element.textContent).toContain('artifact_missing');
    const input = f.element.querySelector('input')!;
    await act(async () => {
      input.value = 'original-restore';
      input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    });
    await f.click('Read original restore status');
    expect(f.element.textContent).toContain('Journal phase: restored');
    expect(f.element.textContent).toContain(
      'Actual carrier: original-job · outcome_unknown · revision 3',
    );
    expect(f.element.textContent).toContain('Original root Work sequence 9223372036854775806');
    expect(f.element.textContent).toContain('Confirmed post baseline: not recorded');
    expect(f.element.textContent).toContain('physical_outcome_unknown');
    expect(f.element.textContent).toContain('Journal phase does not establish carrier success');
  } finally {
    await f.close();
  }
});
