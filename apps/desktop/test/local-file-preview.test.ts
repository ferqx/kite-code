import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFilePreview } from '../electron/local-file-preview';

async function fixture(run: (root: string, path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'kite-local-handle-test-'));
  const path = join(root, 'source.md');
  try {
    await writeFile(path, 'original');
    await run(root, path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('local handle reauthorizes reads, materializes only snapshot, and release revokes', async () =>
  fixture(async (root, path) => {
    let calls = 0;
    const handle = await LocalFilePreview.create(
      async (consume) => {
        calls++;
        await consume(path);
      },
      () => {},
    );
    const result = await handle.materialize(join(root, 'snapshot'));
    expect(result.name).toBe('source.md');
    expect(await readFile(join(root, 'snapshot'), 'utf8')).toBe('original');
    expect(calls).toBe(2);
    expect('target' in result).toBe(false);
    expect('fileId' in result).toBe(false);
    handle.release();
    await expect(handle.read()).rejects.toThrow('local_preview_released');
  }));
test('scope loss and permission revocation reject before source is delivered', async () =>
  fixture(async (_root, path) => {
    let scope = true,
      allowed = true;
    const handle = await LocalFilePreview.create(
      async (consume) => {
        if (!allowed) throw Error('permission_revoked');
        await consume(path);
      },
      () => {
        if (!scope) throw Error('scope_changed');
      },
    );
    allowed = false;
    await expect(handle.read()).rejects.toThrow('permission_revoked');
    await expect(handle.verifyAccess()).rejects.toThrow('permission_revoked');
    allowed = true;
    scope = false;
    await expect(handle.read()).rejects.toThrow('scope_changed');
  }));
test('file replacement, mutation, and substituted authorized path invalidate handle', async () =>
  fixture(async (root, path) => {
    let authorized = path;
    const create = () =>
      LocalFilePreview.create(
        async (consume) => consume(authorized),
        () => {},
      );
    const original = await create();
    await rename(path, join(root, 'old'));
    await writeFile(path, 'original');
    await expect(original.read()).rejects.toThrow('local_preview_changed');
    const changed = await create();
    await writeFile(path, 'modified');
    await expect(changed.read()).rejects.toThrow('local_preview_changed');
    const redirected = await create();
    authorized = join(root, 'old');
    await expect(redirected.read()).rejects.toThrow('local_preview_changed');
  }));
test('symlink replacement and release during authorization cannot deliver bytes', async () =>
  fixture(async (root, path) => {
    const handle = await LocalFilePreview.create(
      async (consume) => consume(path),
      () => {},
    );
    await rename(path, join(root, 'old'));
    await symlink(join(root, 'old'), path);
    await expect(handle.read()).rejects.toThrow();
    let revoke: (() => void) | undefined;
    const late = await LocalFilePreview.create(
      async (consume) => {
        revoke?.();
        await consume(join(root, 'old'));
      },
      () => {},
    );
    revoke = () => late.release();
    await expect(late.read()).rejects.toThrow('local_preview_released');
  }));

test('PDF receives only authorized bytes and rechecks revoked access after rendering', async () =>
  fixture(async (_root, path) => {
    let allowed = true;
    const handle = await LocalFilePreview.create(
      async (consume) => {
        if (!allowed) throw Error('permission_revoked');
        await consume(path);
      },
      () => {},
    );
    await expect(
      handle.renderPdf(1, new AbortController().signal, async (bytes, hash, page) => {
        expect(Buffer.from(bytes).toString()).toBe('original');
        expect(hash).toHaveLength(64);
        expect(page).toBe(1);
        allowed = false;
        return { data: 'PNG', totalPages: 1 };
      }),
    ).rejects.toThrow('permission_revoked');
  }));

test('Main-only original reference verifies source hash and never creates output identity', async () =>
  fixture(async (_root, path) => {
    const { createHash } = await import('node:crypto');
    const handle = await LocalFilePreview.create(
      async (consume) => consume(path),
      () => {},
    );
    const hash = createHash('sha256').update('original').digest('hex');
    expect(await handle.reference(hash)).toEqual({ path, name: 'source.md', sourceHash: hash });
    await expect(handle.reference('0'.repeat(64))).rejects.toThrow('local_preview_changed');
    handle.release();
    await expect(handle.reference(hash)).rejects.toThrow('local_preview_released');
  }));
