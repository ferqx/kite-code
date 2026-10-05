import { expect, test } from 'bun:test';
import type { SessionView } from '@kite-ai/client';
import {
  fileReference,
  fileToken,
  TuiController,
  type TuiFilePage,
  type TuiPort,
} from '../../src/tui';
import { ComposerBuffer } from '../../src/tui/composer';

test('file token middle cursor replaces entire quoted original token with exact escaped UTF8, preserving surrounding text and pasted blocks', () => {
  const b = new ComposerBuffer();
  b.sync('读 @"目录/旧 空格.txt" 后🙂');
  b.cursor = 7;
  const token = b.fileToken!;
  expect(token.query).toBe('目录/');
  expect(b.completeFile('目录/中文 空格"\\.txt', token.key)).toBe(true);
  expect(b.text).toBe('读 @"目录/中文 空格\\"\\\\.txt" 后🙂');
  expect(b.fileToken).toBeUndefined();
  b.horizontal(-1);
  b.insert('x');
  expect(b.fileToken).toBeDefined();
  expect(b.completeFile('foreign', token.key)).toBe(false);
  b.sync('');
  b.insert('@source\nopaque pasted content', true);
  expect(b.fileToken).toBeUndefined();
  expect(fileReference('plain/中文.txt')).toBe('@plain/中文.txt');
  expect(fileToken('prefix @foo suffix', 10)?.query).toBe('fo');
});
function fixture() {
  let mutations = 0;
  const reads: {
    scope: { storeId: string; sessionId: string; workspaceId: string };
    query: string;
    signal: AbortSignal;
    resolve(page: TuiFilePage): void;
  }[] = [];
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => 'never',
    listSessions: async () => [],
    readSession: async (id) => ({
      storeId: 'store',
      view: {
        storeId: 'store',
        snapshotCursor: '1',
        session: {
          id,
          workspaceId: id === 'a' ? 'wa' : 'wb',
          rootSessionId: id,
          parentSessionId: null,
          contextSelectionId: 'ctx',
          controlRevision: '0',
          nextSeq: '0',
          title: id,
          deletedAt: null,
        },
        runs: [],
        executions: [],
        messages: [],
      } as SessionView,
      messages: [],
      interactions: [],
    }),
    submit: async () => {
      mutations++;
      throw Error('no mutation');
    },
    answer: async () => {
      mutations++;
      throw Error('no mutation');
    },
    cancel: async () => {
      mutations++;
      throw Error('no mutation');
    },
    getCommand: async () => {
      throw Error('no command');
    },
    fileCandidates: {
      read: (scope, input, signal) =>
        new Promise((resolve) => reads.push({ scope, query: input.query, signal, resolve })),
    },
  };
  return { controller: new TuiController(port), reads, mutations: () => mutations };
}
const page = (
  read: ReturnType<typeof fixture>['reads'][number],
  paths: string[],
  cursor: string | null = null,
): TuiFilePage => ({
  scope: read.scope,
  query: read.query,
  snapshotId: 'original',
  paths,
  nextCursor: cursor,
  unavailable: [],
});
test('exhausts candidate pages and freezes original scope/revision; stale cross Workspace response never replaces selected draft; cancel has zero mutation', async () => {
  const f = fixture(),
    c = f.controller;
  await c.select('a');
  c.setDraft('@');
  const read = c.readFileCandidates(fileToken('@', 1));
  f.reads[0]!.resolve(
    page(
      f.reads[0]!,
      Array.from({ length: 200 }, (_, i) => `目录/${i}.txt`),
      'next',
    ),
  );
  await Bun.sleep(0);
  expect(c.state.fileCandidates?.phase).toBe('reading');
  expect(f.reads).toHaveLength(2);
  f.reads[1]!.resolve(page(f.reads[1]!, ['目录/尾部 空格.txt']));
  await read;
  expect(c.state.fileCandidates?.paths).toHaveLength(201);
  const late = c.readFileCandidates(fileToken('@', 1));
  await c.select('b');
  c.setDraft('@other');
  f.reads[2]!.resolve(page(f.reads[2]!, ['FOREIGN.txt']));
  await late;
  expect(f.reads[2]!.signal.aborted).toBe(true);
  expect(c.state.fileCandidates).toBeUndefined();
  expect(c.state.draft).toBe('@other');
  const cancelled = c.readFileCandidates(fileToken('@other', 6));
  await c.readFileCandidates();
  f.reads[3]!.resolve(page(f.reads[3]!, ['other.txt']));
  await cancelled;
  expect(c.state.fileCandidates).toBeUndefined();
  expect(f.mutations()).toBe(0);
  c.dispose();
});
test('wrong page scope fails closed, edited revision and late pages cannot resurrect original candidates', async () => {
  const f = fixture(),
    c = f.controller;
  await c.select('a');
  c.setDraft('@');
  const first = c.readFileCandidates(fileToken('@', 1));
  f.reads[0]!.resolve({
    ...page(f.reads[0]!, ['x']),
    scope: { ...f.reads[0]!.scope, storeId: 'foreign' },
  });
  await first;
  expect(c.state.fileCandidates?.phase).toBe('failed');
  expect(c.state.fileCandidates?.paths).toEqual([]);
  const second = c.readFileCandidates(fileToken('@', 1));
  c.setDraft('@new');
  f.reads[1]!.resolve(page(f.reads[1]!, ['x']));
  await second;
  expect(c.state.fileCandidates).toBeUndefined();
  expect(f.mutations()).toBe(0);
  c.dispose();
});
