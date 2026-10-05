import { expect, test } from 'bun:test';
import { createBrowserClient } from '../../src/browser';
import { decodeResponse } from '../../src/decode';
import {
  verifyFileCheckpointDetail,
  verifyFileCheckpointPage,
  verifyFileRestoreStatus,
} from '../../src/file-checkpoints';
import type { FileCheckpointPage, FileRestoreStatus } from '../../src/generated/api';

const id = 'a'.repeat(64),
  identity = 'b'.repeat(64);
function page(): FileCheckpointPage {
  return {
    storeId: 'store',
    sessionId: 's',
    workspaceId: 'w',
    payload: {
      items: [
        {
          checkpoint: {
            id,
            boundary: {
              storeId: 'origin',
              sessionId: 'parent',
              workspaceId: 'w',
              runId: 'run',
              contextSelectionId: 'selection',
              messageId: null,
              messageSeq: '0',
              triggerMessageId: 'user',
              triggerSeq: '1',
            },
            workspace: { device: '1', inode: '2' },
          },
          revision: '3',
        },
      ],
      nextAfterKey: `checkpoint/${id}/point`,
    },
  };
}
test('closed checkpoint metadata rejects private effects and preserves original boundaries, versioned journal and exact keyset', () => {
  expect(decodeResponse('FileCheckpointPage', page())).toEqual(page());
  expect(verifyFileCheckpointPage(page(), { limit: 1 })).toEqual(page());
  for (const value of [
    { ...page(), actions: [] },
    { ...page(), payload: { ...page().payload, raw: 'SECRET' } },
    {
      ...page(),
      payload: {
        ...page().payload,
        items: [
          {
            ...page().payload.items[0]!,
            checkpoint: { ...page().payload.items[0]!.checkpoint, authority: 'grant' },
          },
        ],
      },
    },
  ])
    expect(() => decodeResponse('FileCheckpointPage', value)).toThrow();
  for (const value of [
    { ...page(), payload: { ...page().payload, items: [] } },
    {
      ...page(),
      payload: { ...page().payload, nextAfterKey: `checkpoint/${'c'.repeat(64)}/point` },
    },
    {
      ...page(),
      payload: { ...page().payload, items: [page().payload.items[0]!, page().payload.items[0]!] },
    },
  ])
    expect(() => verifyFileCheckpointPage(value, { limit: 1 })).toThrow();
  expect(() =>
    verifyFileCheckpointPage(page(), { limit: 1, afterKey: `checkpoint/${id}/point` }),
  ).toThrow();
  expect(() =>
    verifyFileCheckpointPage(
      {
        ...page(),
        payload: {
          ...page().payload,
          items: [{ ...page().payload.items[0]!, revision: '9223372036854775808' }],
        },
      },
      { limit: 1 },
    ),
  ).toThrow();
  const journal = {
    id: 'restore',
    checkpointId: id,
    executionId: 'job',
    planDigest: id,
    phase: 'restored' as const,
    files: [
      {
        path: 'file',
        operation: 'remove' as const,
        state: 'removed' as const,
        expected: { hash: id, size: 1, device: '1', inode: '2' },
        original: null,
        preimage: null,
        error: null,
      },
    ],
  };
  const legacy: FileRestoreStatus = {
    storeId: 'store',
    sessionId: 's',
    workspaceId: 'w',
    payload: { journal, execution: { id: 'job', status: 'outcome_unknown', resultRevision: '4' } },
  };
  expect(decodeResponse('FileRestoreStatus', legacy)).toEqual(legacy);
  expect(verifyFileRestoreStatus(legacy, id, 'restore')).toEqual(legacy);
  const modern = {
    ...legacy,
    payload: {
      ...legacy.payload,
      journal: {
        ...journal,
        rootWorkSeq: '9007199254740993',
        files: [{ ...journal.files[0]!, expected: null, confirmedPost: { baseline: null } }],
      },
    },
  };
  expect(decodeResponse('FileRestoreStatus', modern)).toEqual(modern);
  expect(() =>
    verifyFileRestoreStatus(
      {
        ...modern,
        payload: {
          ...modern.payload,
          journal: { ...modern.payload.journal, rootWorkSeq: '9223372036854775808' },
        },
      },
      id,
      'restore',
    ),
  ).toThrow();
  for (const value of [
    {
      ...modern,
      payload: { ...modern.payload, journal: { ...modern.payload.journal, originStoreId: 'FAKE' } },
    },
    { ...legacy, payload: { ...legacy.payload, journal: { ...journal, rootWorkSeq: '1' } } },
    {
      ...legacy,
      payload: {
        ...legacy.payload,
        journal: { ...journal, files: [{ ...journal.files[0]!, confirmedPost: null }] },
      },
    },
  ])
    expect(() => decodeResponse('FileRestoreStatus', value)).toThrow();
  expect(() => verifyFileRestoreStatus(legacy, id, 'wrong')).toThrow();
  expect(() =>
    verifyFileRestoreStatus(
      {
        ...legacy,
        payload: {
          ...legacy.payload,
          execution: { id: 'other', status: 'succeeded', resultRevision: '4' },
        },
      },
      id,
      'restore',
    ),
  ).toThrow();
  const detail = {
    ...page(),
    payload: { checkpoint: page().payload.items[0]!.checkpoint, files: [] },
  };
  expect(verifyFileCheckpointDetail(decodeResponse('FileCheckpointDetail', detail), id)).toEqual(
    detail,
  );
  expect(() =>
    verifyFileCheckpointDetail(decodeResponse('FileCheckpointDetail', detail), 'c'.repeat(64)),
  ).toThrow();
});

test('Cookie SDK finite read targets and optional query values, wrong scopes and read cancellation stay closed', async () => {
  let reads = 0,
    shape: unknown = page();
  let barrier: Promise<void> | undefined,
    release: (() => void) | undefined,
    started: (() => void) | undefined;
  const requests: { url: string; method: string; authorization: string | null }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      requests.push({
        url: url.pathname + url.search,
        method: request.method,
        authorization: request.headers.get('authorization'),
      });
      if (url.pathname === '/browser/v1/server')
        return Response.json(
          {
            instanceId: 'instance',
            buildId: 'build',
            pageIdentity: identity,
            storeId: 'store',
            dataAvailability: 'available',
            capabilities: ['file_checkpoints'],
          },
          { headers: { 'x-kite-web-identity': identity } },
        );
      reads++;
      started?.();
      await barrier;
      return Response.json(shape, { headers: { 'x-kite-web-identity': identity } });
    },
  });
  try {
    const client = createBrowserClient({ origin: server.url.href, pageIdentity: identity });
    await client.connect();
    const full = { ...page(), payload: { ...page().payload, nextAfterKey: null } };
    shape = full;
    expect(
      await client.listFileCheckpoints('s', { afterKey: undefined, limit: undefined }),
    ).toEqual(full);
    expect(requests.at(-1)!.url).toBe('/browser/v1/sessions/s/file-checkpoints');
    const before = reads;
    for (const act of [
      () => client.listFileCheckpoints('s', { limit: 201 }),
      () => client.listFileCheckpoints('s', { afterKey: 'bad' }),
      () => client.getFileCheckpoint('s', 'bad'),
      () => client.getFileRestoreStatus('s', id, '../wrong'),
    ]) {
      let denied = false;
      try {
        await act();
      } catch {
        denied = true;
      }
      expect(denied).toBe(true);
    }
    expect(reads).toBe(before);
    for (const changed of [
      { ...full, storeId: 'foreign' },
      { ...full, sessionId: 'other' },
    ]) {
      shape = changed;
      let denied = false;
      try {
        await client.listFileCheckpoints('s');
      } catch {
        denied = true;
      }
      expect(denied).toBe(true);
    }
    const abort = new AbortController();
    abort.abort();
    let cancelled = false;
    try {
      await client.listFileCheckpoints('s', { signal: abort.signal });
    } catch {
      cancelled = true;
    }
    expect(cancelled).toBe(true);
    expect(
      requests.every((request) => request.method === 'GET' && request.authorization === null),
    ).toBe(true);
    const limited = createBrowserClient({
      origin: server.url.href,
      pageIdentity: identity,
      maxResponseBytes: 512,
    });
    await limited.connect();
    shape = {
      ...full,
      payload: {
        ...full.payload,
        items: [
          {
            ...full.payload.items[0]!,
            checkpoint: {
              ...full.payload.items[0]!.checkpoint,
              boundary: { ...full.payload.items[0]!.checkpoint.boundary, runId: 'r'.repeat(128) },
            },
          },
        ],
      },
    };
    let budgetCode: string | undefined;
    try {
      await limited.listFileCheckpoints('s');
    } catch (error) {
      budgetCode =
        error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : undefined;
    }
    expect(budgetCode).toBe('response_too_large');
    shape = full;
    barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrived = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = client.listFileCheckpoints('s').then(
      () => 'published',
      () => 'cancelled',
    );
    await arrived;
    client.disposeNetwork();
    release!();
    expect(await pending).toBe('cancelled');
    limited.disposeNetwork();
  } finally {
    release?.();
    server.stop(true);
  }
});
