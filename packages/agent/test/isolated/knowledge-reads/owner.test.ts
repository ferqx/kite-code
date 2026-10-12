import { expect, test } from 'bun:test';
import { constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKnowledgeReadScope, type KnowledgeFileAccess } from '../../../src/sources';

test('scoped knowledge close seals admission and waits the complete original composite read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-knowledge-composite-'));
  writeFileSync(join(root, 'first'), 'first full text');
  writeFileSync(join(root, 'second'), 'second full text');
  const scope = createKnowledgeReadScope();
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let access: KnowledgeFileAccess | undefined;
  const pending = scope.run(async (files) => {
    access = files;
    const first = await files.read(join(root, 'first'), constants.O_RDONLY, (handle) =>
      handle.readFile('utf8'),
    );
    enter();
    await held;
    const second = await files.read(join(root, 'second'), constants.O_RDONLY, (handle) =>
      handle.readFile('utf8'),
    );
    return { first, second };
  });
  try {
    await entered;
    let disposed = false;
    const closing = scope.dispose().then(() => {
      disposed = true;
    });
    await expect(scope.run(() => 'new read')).rejects.toMatchObject({
      code: 'knowledge_scope_closed',
    });
    expect(disposed).toBe(false);
    resume();
    expect(await pending).toEqual({ first: 'first full text', second: 'second full text' });
    await closing;
    expect(disposed).toBe(true);
    expect(() => access!.readSync(join(root, 'first'), constants.O_RDONLY, () => '')).toThrow(
      'knowledge_scope_closed',
    );
  } finally {
    resume();
    await pending;
    await scope.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('isolated actual FileHandle and fd close failures retain original bytes, errors and one close across knowledge consumers', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-install',
      fileURLToPath(new URL('../../fixtures/knowledge-read-custody.ts', import.meta.url)),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw Error(`knowledge fixture failed ${code}: ${stderr}`);
  const receipt = JSON.parse(stdout.trim());
  for (const key of [
    'asyncTyped',
    'asyncOriginal',
    'asyncCleanup',
    'asyncResource',
    'syncTyped',
    'syncOriginal',
    'syncCleanup',
    'syncResource',
    'firstFailurePreserved',
    'concurrentCustody',
    'cachedDisposal',
    'privateCause',
    'projectTyped',
    'skillTyped',
    'workflowTyped',
  ])
    expect(receipt[key]).toBe(true);
  expect(receipt.retainedText).toBe('Original instruction 中🙂');
  expect(receipt.retainedSyncText).toBe('Original instruction 中🙂');
  expect(receipt.asyncAttempts).toEqual([1, 1, 1, 1]);
  expect(receipt.syncAttempts).toEqual([1, 1]);
}, 10000);
