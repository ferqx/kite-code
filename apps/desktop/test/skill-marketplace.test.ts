import { createHash } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from '#kite-test';
import { createSkillMarketplace } from '../electron/skill-marketplace';
import { installedSkillIdPrefix } from '../src/skill-marketplace-contract';

const selection = { source: 'example/skills', skillId: 'first-skill' };
const document = { path: 'SKILL.md', contents: '---\nname: First Skill\n---\n# Instructions\n' };
const script = { path: 'scripts/setup.sh', contents: 'exit 1\n' };
const snapshot = { files: [script, document], hash: 'a'.repeat(64) };
const removal = {
  skillId: `${installedSkillIdPrefix}${selection.skillId}`,
  skillVersion: createHash('sha256').update(document.contents).digest('hex'),
};
const temporary = new Set<string>();

async function root() {
  const home = await mkdtemp(join(tmpdir(), 'kite-skill-marketplace-'));
  temporary.add(home);
  return join(home, '.kite-code', 'skills');
}

afterEach(async () => {
  await Promise.all([...temporary].map((path) => rm(path, { recursive: true, force: true })));
  temporary.clear();
});

test('search sends a bounded query to Skills.sh and projects only valid public GitHub rows', async () => {
  const userSkillRoot = await root();
  const row = { ...selection, id: 'example/skills/first-skill', name: 'First Skill', installs: 35 };
  const market = createSkillMarketplace({
    userSkillRoot,
    fetch: async (url, init) => {
      expect(url.origin).toBe('https://www.skills.sh');
      expect(url.pathname).toBe('/api/search');
      expect(url.searchParams.get('q')).toBe('React & UI');
      expect(url.searchParams.get('limit')).toBe('30');
      expect(init.credentials).toBe('omit');
      expect(init.redirect).toBe('error');
      return Response.json({
        skills: [
          { ...row, installUrl: 'https://ignored.test', metadata: { secret: 1 } },
          row,
          { ...row, source: 'https://example.test/skills' },
          {
            ...row,
            source: 'other/skills',
            id: 'other/skills/first-skill',
            sourceType: 'well-known',
          },
          { ...row, skillId: '../../bad' },
          { ...row, skillId: 'other', id: 'example/skills/other', installs: -1 },
        ],
      });
    },
  });
  expect(await market.search('React & UI')).toEqual([
    { ...selection, name: 'First Skill', installs: 35 },
  ]);
  await expect(market.search('a')).rejects.toThrow('invalid_skill_marketplace_query');
  await expect(lstat(userSkillRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('installs only the selected snapshot as private data and does not replace an existing skill', async () => {
  const userSkillRoot = await root();
  let downloads = 0;
  const market = createSkillMarketplace({
    userSkillRoot,
    fetch: async (url, init) => {
      downloads++;
      expect(url.href).toBe('https://www.skills.sh/api/download/example/skills/first-skill');
      expect(init.redirect).toBe('error');
      return Response.json(snapshot);
    },
  });
  const [first, second] = await Promise.all([
    market.install(selection),
    market.install({ ...selection, source: 'another/skills' }),
  ]);
  expect(first).toEqual({ status: 'installed', name: selection.skillId });
  expect(second).toEqual({ status: 'already-installed', name: selection.skillId });
  expect(downloads).toBe(1);
  expect(await readdir(userSkillRoot)).toEqual([selection.skillId]);
  const target = join(userSkillRoot, selection.skillId);
  expect(await readFile(join(target, document.path), 'utf8')).toBe(document.contents);
  expect(await readFile(join(target, script.path), 'utf8')).toBe(script.contents);
  if (process.platform !== 'win32')
    expect((await lstat(join(target, script.path))).mode & 0o777).toBe(0o600);
});

test('an unrelated empty directory created during download survives publication unchanged', async () => {
  const userSkillRoot = await root();
  const target = join(userSkillRoot, selection.skillId);
  const market = createSkillMarketplace({
    userSkillRoot,
    fetch: async () => {
      await mkdir(target);
      return Response.json(snapshot);
    },
  });
  await expect(market.install(selection)).rejects.toThrow('skill_marketplace_target_occupied');
  expect(await readdir(target)).toEqual([]);
  expect(await readdir(userSkillRoot)).toEqual([selection.skillId]);
});

test('rejects linked configuration, skill roots and occupied linked skill directories', async () => {
  const userSkillRoot = await root();
  const parent = dirname(userSkillRoot);
  const foreign = join(dirname(parent), 'foreign');
  const target = join(userSkillRoot, selection.skillId);
  await mkdir(foreign);
  await writeFile(join(foreign, 'SKILL.md'), 'local data');
  const market = createSkillMarketplace({
    userSkillRoot,
    fetch: async () => {
      throw new Error('unexpected fetch');
    },
  });
  await symlink(foreign, parent, 'junction');
  await expect(market.install(selection)).rejects.toThrow('skill_marketplace_unsafe_directory');
  await rm(parent);
  await mkdir(parent);
  await symlink(foreign, userSkillRoot, 'junction');
  await expect(market.install(selection)).rejects.toThrow('skill_marketplace_unsafe_directory');
  await rm(userSkillRoot);
  await mkdir(userSkillRoot);
  await symlink(foreign, target, 'junction');
  await expect(market.install(selection)).rejects.toThrow('skill_marketplace_target_occupied');
  expect(await readFile(join(foreign, 'SKILL.md'), 'utf8')).toBe('local data');
});

test('refuses to publish if the skill root was replaced during download', async () => {
  const userSkillRoot = await root();
  const moved = `${userSkillRoot}-moved`;
  const foreign = join(dirname(userSkillRoot), 'foreign');
  await mkdir(foreign, { recursive: true });
  const market = createSkillMarketplace({
    userSkillRoot,
    fetch: async () => {
      await rename(userSkillRoot, moved);
      await symlink(foreign, userSkillRoot, 'junction');
      return Response.json(snapshot);
    },
  });
  await expect(market.install(selection)).rejects.toThrow('skill_marketplace_unsafe_directory');
  expect(await readdir(foreign)).toEqual([]);
  expect(await readdir(moved)).toEqual([]);
});

test('rejects unsafe or ambiguous snapshot paths before creating any skill', async () => {
  const userSkillRoot = await root();
  const invalidPaths = [
    '../outside',
    '/absolute',
    'C:\\outside',
    'scripts/../../outside',
    'scripts\\outside',
    'references/file.md:stream',
    'a/CON.txt',
    'a/com².md',
    'folder /b.txt',
    '.git/config',
    'skill.md',
    'SKILL.md',
    'scripts',
    'SCRIPTS/other',
    'scripts/setup.sh/child',
  ];
  for (const path of invalidPaths) {
    const market = createSkillMarketplace({
      userSkillRoot,
      fetch: async () => Response.json({ files: [...snapshot.files, { path, contents: 'bad' }] }),
    });
    await expect(market.install(selection)).rejects.toThrow('skill_marketplace_invalid_snapshot');
    expect(await readdir(userSkillRoot)).toEqual([]);
  }
});

test('keeps failed downloads distinct from an empty search and retries without leftover skills', async () => {
  const userSkillRoot = await root();
  let status = 404;
  const market = createSkillMarketplace({
    userSkillRoot,
    fetch: async (url) => {
      if (url.pathname === '/api/search') return Response.json({ skills: [] });
      if (status === 200) return Response.json(snapshot);
      return new Response('external error', { status });
    },
  });
  expect(await market.search('unlisted')).toEqual([]);
  await expect(market.install(selection)).rejects.toThrow('skill_marketplace_snapshot_unavailable');
  status = 429;
  await expect(market.install(selection)).rejects.toThrow('skill_marketplace_rate_limited');
  expect(await readdir(userSkillRoot)).toEqual([]);
  status = 200;
  expect(await market.install(selection)).toEqual({ status: 'installed', name: selection.skillId });
});

test('enforces the actual response byte limit and cancels a pending installation on shutdown', async () => {
  const userSkillRoot = await root();
  const market = createSkillMarketplace({
    userSkillRoot,
    fetch: async () => new Response(new Uint8Array(256 * 1024 + 1)),
  });
  await expect(market.search('large')).rejects.toThrow('skill_marketplace_invalid_response');
  const controller = new AbortController();
  const pending = createSkillMarketplace({
    userSkillRoot,
    fetch: async () => {
      controller.abort();
      return Response.json(snapshot);
    },
  });
  await expect(pending.install(selection, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(await readdir(userSkillRoot)).toEqual([]);
});

test('uninstall moves the selected skill and assets to Trash, with an idempotent retry', async () => {
  const userSkillRoot = await root();
  const target = join(userSkillRoot, selection.skillId);
  const trashed = join(dirname(dirname(userSkillRoot)), 'trashed');
  const bomDocument = { ...document, contents: `\uFEFF${document.contents}` };
  let downloads = 0;
  const market = createSkillMarketplace({
    userSkillRoot,
    fetch: async () => {
      downloads++;
      return Response.json({ ...snapshot, files: [script, bomDocument] });
    },
    trashItem: async (path) => {
      expect(path).toBe(await realpath(target));
      await rename(path, trashed);
    },
  });
  expect(await market.uninstall(removal)).toEqual({
    status: 'already-uninstalled',
    skillId: removal.skillId,
  });
  await expect(lstat(dirname(userSkillRoot))).rejects.toMatchObject({ code: 'ENOENT' });
  await market.install(selection);
  await mkdir(join(userSkillRoot, 'other-skill'));
  expect(await market.uninstall(removal)).toEqual({
    status: 'uninstalled',
    skillId: removal.skillId,
  });
  expect(await readdir(userSkillRoot)).toEqual(['other-skill']);
  expect(await readFile(join(trashed, document.path), 'utf8')).toBe(bomDocument.contents);
  expect(await readFile(join(trashed, script.path), 'utf8')).toBe(script.contents);
  expect(await market.uninstall(removal)).toEqual({
    status: 'already-uninstalled',
    skillId: removal.skillId,
  });
  expect(downloads).toBe(1);
});

test('uninstall rejects built-in IDs, path inputs, stale versions and occupied targets', async () => {
  const userSkillRoot = await root();
  const target = join(userSkillRoot, selection.skillId);
  let moves = 0;
  const market = createSkillMarketplace({
    userSkillRoot,
    trashItem: async () => {
      moves++;
    },
  });
  for (const skillId of [
    'computer-use',
    'user-skill.computer-use',
    'user-skill.//other',
    'first-skill',
  ])
    await expect(market.uninstall({ ...removal, skillId })).rejects.toThrow(
      'invalid_skill_marketplace_selection',
    );
  await mkdir(target, { recursive: true });
  await expect(market.uninstall(removal)).rejects.toThrow('skill_marketplace_version_changed');
  await writeFile(join(target, document.path), '# Changed');
  await expect(market.uninstall(removal)).rejects.toThrow('skill_marketplace_version_changed');
  expect(await readFile(join(target, document.path), 'utf8')).toBe('# Changed');
  expect(moves).toBe(0);
});

test('uninstall refuses links at the app root, installed directory and entrypoint', async () => {
  const userSkillRoot = await root();
  const parent = dirname(userSkillRoot);
  const target = join(userSkillRoot, selection.skillId);
  const outside = join(dirname(parent), 'outside');
  const outsideDocument = join(outside, document.path);
  await mkdir(outside);
  await writeFile(outsideDocument, document.contents);
  let moves = 0;
  const market = createSkillMarketplace({
    userSkillRoot,
    trashItem: async () => {
      moves++;
    },
  });
  await symlink(outside, parent, 'junction');
  await expect(market.uninstall(removal)).rejects.toThrow('skill_marketplace_unsafe_directory');
  await rm(parent);
  await mkdir(parent);
  await symlink(join(outside, 'missing'), userSkillRoot, 'junction');
  await expect(market.uninstall(removal)).rejects.toThrow('skill_marketplace_unsafe_directory');
  await rm(userSkillRoot);
  await mkdir(userSkillRoot);
  await symlink(outside, target, 'junction');
  await expect(market.uninstall(removal)).rejects.toThrow('skill_marketplace_unsafe_directory');
  await rm(target);
  await mkdir(target);
  await link(outsideDocument, join(target, document.path));
  await expect(market.uninstall(removal)).rejects.toThrow('skill_marketplace_version_changed');
  expect(await readFile(outsideDocument, 'utf8')).toBe(document.contents);
  expect(moves).toBe(0);
});

test('failed Trash operation retains the installation and reinstall waits for a pending uninstall', async () => {
  const userSkillRoot = await root();
  const target = join(userSkillRoot, selection.skillId);
  const trashed = join(dirname(dirname(userSkillRoot)), 'trashed');
  const enteredTrash = Promise.withResolvers<void>();
  const allowTrash = Promise.withResolvers<void>();
  let fail = true;
  let downloads = 0;
  const market = createSkillMarketplace({
    userSkillRoot,
    fetch: async () => {
      downloads++;
      return Response.json(snapshot);
    },
    trashItem: async (path) => {
      if (fail) throw Error('Trash unavailable');
      enteredTrash.resolve();
      await allowTrash.promise;
      await rename(path, trashed);
    },
  });
  await market.install(selection);
  await expect(market.uninstall(removal)).rejects.toThrow('skill_marketplace_uninstall_failed');
  expect(await readFile(join(target, document.path), 'utf8')).toBe(document.contents);
  fail = false;
  const uninstalling = market.uninstall(removal);
  await enteredTrash.promise;
  const reinstalling = market.install(selection);
  expect(downloads).toBe(1);
  allowTrash.resolve();
  expect(await uninstalling).toEqual({ status: 'uninstalled', skillId: removal.skillId });
  expect(await reinstalling).toEqual({ status: 'installed', name: selection.skillId });
  expect(await readFile(join(target, document.path), 'utf8')).toBe(document.contents);
  expect(downloads).toBe(2);
});
