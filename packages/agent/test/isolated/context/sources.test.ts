import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceRequest } from '../../../src/context';
import { createProjectSources } from '../../../src/sources';

const roots: string[] = [];
const request: SourceRequest = {
  workspaceId: 'workspace',
  sessionId: 'session',
  definitionId: 'fixture.effect',
  input: {},
};
function fixture(targets?: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), 'kite-project-sources-'));
  roots.push(root);
  const sources = createProjectSources({
    async workspaceRoot() {
      return root;
    },
    ...(targets ? { targetPaths: () => targets } : {}),
  });
  return { root, sources, capture: () => sources.capture(request) };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function unavailable(promise: Promise<unknown>) {
  const failure = await promise.then(
    () => null,
    (error) => error,
  );
  expect(failure).toMatchObject({ code: 'context_source_unavailable' });
}

test('captures only root and trusted target ancestry in stable root-to-leaf order', async () => {
  const data = fixture(['src/deep/new.ts', 'src/deep', 'other/new.ts']);
  mkdirSync(join(data.root, 'src/deep'), { recursive: true });
  mkdirSync(join(data.root, 'other'));
  mkdirSync(join(data.root, 'unrelated'));
  writeFileSync(join(data.root, 'CLAUDE.md'), 'root Claude');
  writeFileSync(join(data.root, 'AGENTS.md'), 'root Agents');
  writeFileSync(join(data.root, 'src/AGENTS.md'), 'source Agents');
  writeFileSync(join(data.root, 'src/deep/CLAUDE.md'), 'deep Claude');
  writeFileSync(join(data.root, 'other/AGENTS.md'), 'other Agents');
  writeFileSync(join(data.root, 'unrelated/AGENTS.md'), 'must not enter context');
  const snapshot = await data.capture();
  expect(snapshot.map((source) => source.id)).toEqual([
    'project:workspace:CLAUDE.md',
    'project:workspace:AGENTS.md',
    'project:workspace:other/AGENTS.md',
    'project:workspace:src/AGENTS.md',
    'project:workspace:src/deep/CLAUDE.md',
  ]);
  expect(
    snapshot.every(
      (source) => source.kind === 'project_instruction' && /^[a-f0-9]{64}$/.test(source.digest),
    ),
  ).toBe(true);
  expect(await data.capture()).toEqual(snapshot);
  const rootOnly = createProjectSources({
    async workspaceRoot() {
      return data.root;
    },
  });
  expect((await rootOnly.capture(request)).map((source) => source.content)).toEqual([
    'root Claude',
    'root Agents',
  ]);
});

test('re-discovers addition, same-size rewrite with restored mtime, and deletion but ignores unrelated edits', async () => {
  const data = fixture(['src/new.ts']);
  mkdirSync(join(data.root, 'src'));
  mkdirSync(join(data.root, 'unrelated'));
  writeFileSync(join(data.root, 'AGENTS.md'), 'root');
  const initial = await data.capture();
  writeFileSync(join(data.root, 'unrelated/AGENTS.md'), 'unrelated rule');
  expect(await data.capture()).toEqual(initial);
  const path = join(data.root, 'src/AGENTS.md');
  writeFileSync(path, 'old rule');
  const added = await data.capture();
  expect(added).toHaveLength(2);
  const originalStat = statSync(path);
  writeFileSync(path, 'new rule');
  utimesSync(path, originalStat.atime, originalStat.mtime);
  expect(statSync(path).size).toBe(originalStat.size);
  const rewritten = await data.capture();
  expect(rewritten[1]!.content).toBe('new rule');
  expect(rewritten[1]!.digest).not.toBe(added[1]!.digest);
  rmSync(path);
  expect(await data.capture()).toEqual(initial);
});

test('discovers new target ancestry without recursively scanning other directories', async () => {
  const data = fixture(['future/deep/new.ts']);
  expect(await data.capture()).toEqual([]);
  mkdirSync(join(data.root, 'future/deep'), { recursive: true });
  writeFileSync(join(data.root, 'future/AGENTS.md'), 'new ancestor');
  writeFileSync(join(data.root, 'future/deep/AGENTS.md'), 'new target');
  expect((await data.capture()).map((source) => source.content)).toEqual([
    'new ancestor',
    'new target',
  ]);
});

test('rejects out-of-scope paths and symlink directories/files before reading escaped instructions', async () => {
  const outside = fixture();
  writeFileSync(join(outside.root, 'AGENTS.md'), 'private outside marker');
  for (const target of [
    outside.root,
    '../escape/new.ts',
    `${'a/'.repeat(33)}new.ts`,
    'x'.repeat(4097),
  ]) {
    const data = fixture([target]);
    await unavailable(data.capture());
  }
  const directory = fixture(['linked/new.ts']);
  symlinkSync(outside.root, join(directory.root, 'linked'), 'dir');
  await unavailable(directory.capture());
  const file = fixture();
  symlinkSync(join(outside.root, 'AGENTS.md'), join(file.root, 'AGENTS.md'), 'file');
  await unavailable(file.capture());
  expect(readFileSync(join(outside.root, 'AGENTS.md'), 'utf8')).toBe('private outside marker');
});

test('required sources fail locally for unreadable, invalid text or non-regular instruction entries', async () => {
  const data = fixture();
  const path = join(data.root, 'AGENTS.md');
  writeFileSync(path, 'required rule');
  chmodSync(path, 0);
  try {
    await unavailable(data.capture());
  } finally {
    chmodSync(path, 0o600);
  }
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0])]) {
    writeFileSync(path, bytes);
    await unavailable(data.capture());
  }
  rmSync(path);
  mkdirSync(path);
  await unavailable(data.capture());
});

test('file bytes, total bytes, target count and directory discovery have explicit bounds without truncation', async () => {
  const data = fixture();
  writeFileSync(join(data.root, 'AGENTS.md'), 'x'.repeat(1024 * 1024 + 1));
  await unavailable(data.capture());
  const count = fixture(Array.from({ length: 65 }, (_unused, index) => `target-${index}/new.ts`));
  await unavailable(count.capture());
  const directories = fixture(
    Array.from({ length: 64 }, (_unused, index) => `${index}/a/b/c/d/new.ts`),
  );
  await unavailable(directories.capture());
  const total = fixture(Array.from({ length: 9 }, (_unused, index) => `${index}/new.ts`));
  for (let index = 0; index < 9; index++) {
    mkdirSync(join(total.root, String(index)));
    writeFileSync(join(total.root, String(index), 'AGENTS.md'), 'x'.repeat(1024 * 1024));
  }
  await unavailable(total.capture());
});
