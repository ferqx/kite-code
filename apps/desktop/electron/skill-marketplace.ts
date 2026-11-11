import { createHash } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import {
  installedSkillIdPrefix,
  isSkillMarketplaceQuery,
  isSkillMarketplaceSelection,
  isSkillMarketplaceUninstallSelection,
  type SkillMarketplaceInstallResult,
  type SkillMarketplaceResult,
  type SkillMarketplaceSelection,
  type SkillMarketplaceUninstallResult,
  type SkillMarketplaceUninstallSelection,
} from '../src/skill-marketplace-contract';

const registry = 'https://www.skills.sh';
const resultLimit = 30;
const searchBytes = 256 * 1024;
const snapshotBytes = 8 * 1024 * 1024;
const documentBytes = 1024 * 1024;
const fileLimit = 256;
const documentName = 'SKILL.md';

type ErrorCode =
  | 'invalid_skill_marketplace_query'
  | 'invalid_skill_marketplace_selection'
  | 'skill_marketplace_unavailable'
  | 'skill_marketplace_rate_limited'
  | 'skill_marketplace_invalid_response'
  | 'skill_marketplace_snapshot_unavailable'
  | 'skill_marketplace_invalid_snapshot'
  | 'skill_marketplace_unsafe_directory'
  | 'skill_marketplace_target_occupied'
  | 'skill_marketplace_install_failed'
  | 'skill_marketplace_version_changed'
  | 'skill_marketplace_uninstall_failed';

class SkillMarketplaceError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(code);
    this.code = code;
  }
}

type Fetch = (url: URL, init: RequestInit) => Promise<Response>;
type SnapshotFile = { path: string; contents: string };
type Directory = { path: string; stat: BigIntStats };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function registryJson(
  fetch: Fetch,
  url: URL,
  action: 'search' | 'download',
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(12_000);
  const download = action === 'download';
  const byteLimit = download ? snapshotBytes : searchBytes;
  const invalid = download
    ? 'skill_marketplace_invalid_snapshot'
    : 'skill_marketplace_invalid_response';
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 429)
        throw new SkillMarketplaceError('skill_marketplace_rate_limited');
      if (download && response.status === 404)
        throw new SkillMarketplaceError('skill_marketplace_snapshot_unavailable');
      throw new SkillMarketplaceError('skill_marketplace_unavailable');
    }
    const body = response.body;
    if (!body) throw new SkillMarketplaceError(invalid);
    if (Number(response.headers.get('content-length')) > byteLimit) {
      void body.cancel().catch(() => {});
      throw new SkillMarketplaceError(invalid);
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > byteLimit) {
          void reader.cancel().catch(() => {});
          throw new SkillMarketplaceError(invalid);
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    signal?.throwIfAborted();
    try {
      const contents = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks, size),
      );
      const decoded = record(JSON.parse(contents) as unknown);
      if (!decoded) throw new SkillMarketplaceError(invalid);
      return decoded;
    } catch {
      throw new SkillMarketplaceError(invalid);
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof SkillMarketplaceError) throw error;
    throw new SkillMarketplaceError('skill_marketplace_unavailable');
  }
}

function readResults(value: unknown): SkillMarketplaceResult[] {
  if (!Array.isArray(value)) throw new SkillMarketplaceError('skill_marketplace_invalid_response');
  const results = new Map<string, SkillMarketplaceResult>();
  for (const item of value) {
    const row = record(item);
    if (!row || (row.sourceType !== undefined && row.sourceType !== 'github')) continue;
    const selection = { source: row.source, skillId: row.skillId };
    if (!isSkillMarketplaceSelection(selection)) continue;
    const id = `${selection.source}/${selection.skillId}`;
    const key = id.toLowerCase();
    if (row.id !== id || results.has(key)) continue;
    const { name, installs } = row;
    if (
      typeof name !== 'string' ||
      name.length > 160 ||
      !name.trim() ||
      /[\p{C}\p{Zl}\p{Zp}]/u.test(name) ||
      typeof installs !== 'number' ||
      !Number.isSafeInteger(installs) ||
      installs < 0
    )
      continue;
    results.set(key, { ...selection, name: name.trim(), installs });
    if (results.size === resultLimit) break;
  }
  return [...results.values()];
}

function safeSegment(segment: string): boolean {
  return (
    !!segment &&
    Buffer.byteLength(segment) <= 200 &&
    !/[<>:"\\|?*\p{C}]|[. ]$/u.test(segment) &&
    !/^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(segment) &&
    segment.toLowerCase() !== '.git'
  );
}

function readSnapshot(value: Record<string, unknown>): SnapshotFile[] {
  const invalid = 'skill_marketplace_invalid_snapshot';
  const files = value.files;
  if (!Array.isArray(files) || !files.length || files.length > fileLimit)
    throw new SkillMarketplaceError(invalid);
  const paths = new Map<string, { spelling: string; file: boolean }>();
  const snapshot: SnapshotFile[] = [];
  let hasDocument = false;
  for (const item of files) {
    const row = record(item);
    if (typeof row?.path !== 'string' || typeof row.contents !== 'string')
      throw new SkillMarketplaceError(invalid);
    const { path, contents } = row;
    const parts = path.split('/');
    if (Buffer.byteLength(path) > 512 || parts.length > 12 || !parts.every(safeSegment))
      throw new SkillMarketplaceError(invalid);
    for (let index = 0; index < parts.length; index++) {
      const spelling = parts.slice(0, index + 1).join('/');
      const key = spelling.normalize('NFC').toLowerCase();
      const file = index === parts.length - 1;
      const existing = paths.get(key);
      if (existing && (existing.file || file || existing.spelling !== spelling))
        throw new SkillMarketplaceError(invalid);
      paths.set(key, { spelling, file });
    }
    if (path === documentName) {
      if (
        !contents.trim() ||
        contents.includes('\0') ||
        Buffer.byteLength(contents) > documentBytes
      )
        throw new SkillMarketplaceError(invalid);
      hasDocument = true;
    }
    snapshot.push({ path, contents });
  }
  if (!hasDocument) throw new SkillMarketplaceError(invalid);
  return snapshot;
}

async function statIfPresent(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function checkDirectory(path: string, expected?: BigIntStats): Promise<Directory> {
  const stat = await statIfPresent(path);
  if (
    !stat?.isDirectory() ||
    stat.isSymbolicLink() ||
    relative(path, await realpath(path)) !== '' ||
    (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino))
  )
    throw new SkillMarketplaceError('skill_marketplace_unsafe_directory');
  return { path, stat };
}

async function ensureDirectory(path: string): Promise<Directory> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return checkDirectory(path);
}

async function userDirectoryPaths(root: string) {
  // The host selects the user root. Canonicalize its trusted home ancestor, then
  // create only the fixed application and skill directories below that ancestor.
  const configuration = dirname(root);
  const home = await realpath(dirname(configuration));
  const parent = join(home, basename(configuration));
  return { parent, skills: join(parent, basename(root)) };
}

async function userDirectories(root: string) {
  const paths = await userDirectoryPaths(root);
  const parent = await ensureDirectory(paths.parent);
  const skills = await ensureDirectory(paths.skills);
  return { parent, skills };
}

async function checkRoot({ parent, skills }: Awaited<ReturnType<typeof userDirectories>>) {
  await checkDirectory(parent.path, parent.stat);
  await checkDirectory(skills.path, skills.stat);
}

async function removeOwnedDirectory(
  root: Awaited<ReturnType<typeof userDirectories>>,
  directory: Directory,
) {
  await checkRoot(root);
  await checkDirectory(directory.path, directory.stat);
  await rm(directory.path, { recursive: true });
}

async function occupied(path: string): Promise<boolean> {
  const stat = await statIfPresent(path);
  if (!stat) return false;
  if (stat.isDirectory() && !stat.isSymbolicLink() && relative(path, await realpath(path)) === '') {
    const document = await statIfPresent(join(path, documentName));
    if (document?.isFile() && document.nlink === 1n && document.size > 0) return true;
  }
  throw new SkillMarketplaceError('skill_marketplace_target_occupied');
}

function verifyUninstallDocument(stat: BigIntStats | undefined, expected?: BigIntStats) {
  if (
    !stat?.isFile() ||
    stat.nlink !== 1n ||
    stat.size === 0n ||
    stat.size > documentBytes ||
    (expected &&
      (stat.dev !== expected.dev ||
        stat.ino !== expected.ino ||
        stat.size !== expected.size ||
        stat.mtimeNs !== expected.mtimeNs ||
        stat.ctimeNs !== expected.ctimeNs))
  )
    throw new SkillMarketplaceError('skill_marketplace_version_changed');
  return stat;
}

async function verifyUninstallVersion(path: string, version: string) {
  const expected = verifyUninstallDocument(await statIfPresent(path));
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    verifyUninstallDocument(await handle.stat({ bigint: true }), expected);
    const bytes = Buffer.alloc(Number(expected.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new SkillMarketplaceError('skill_marketplace_version_changed');
      offset += bytesRead;
    }
    verifyUninstallDocument(await handle.stat({ bigint: true }), expected);
    let body: string;
    try {
      // Match the Service's catalogue version, including UTF-8 BOM handling.
      body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new SkillMarketplaceError('skill_marketplace_version_changed');
    }
    if (body.includes('\0') || createHash('sha256').update(body).digest('hex') !== version)
      throw new SkillMarketplaceError('skill_marketplace_version_changed');
    return expected;
  } finally {
    await handle.close();
  }
}

async function stageSnapshot(stage: Directory, files: SnapshotFile[], signal?: AbortSignal) {
  const directories = new Set<string>();
  for (const { path, contents } of files) {
    signal?.throwIfAborted();
    await checkDirectory(stage.path, stage.stat);
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const directory = join(stage.path, ...parts.slice(0, index));
      if (directories.has(directory)) continue;
      await mkdir(directory, { mode: 0o700 });
      directories.add(directory);
    }
    await writeFile(join(stage.path, ...parts), contents, { flag: 'wx', mode: 0o600 });
  }
}

async function publishSnapshot(
  root: Awaited<ReturnType<typeof userDirectories>>,
  name: string,
  files: SnapshotFile[],
  signal?: AbortSignal,
): Promise<SkillMarketplaceInstallResult> {
  await checkRoot(root);
  signal?.throwIfAborted();
  const stage = await checkDirectory(await mkdtemp(join(root.skills.path, '.install-')));
  const destination = join(root.skills.path, name);
  try {
    await stageSnapshot(stage, files, signal);
    const entries = (await readdir(stage.path)).filter((entry) => entry !== documentName);
    await checkRoot(root);
    await checkDirectory(stage.path, stage.stat);
    signal?.throwIfAborted();
    try {
      await mkdir(destination, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await occupied(destination)) return { status: 'already-installed', name };
      throw new SkillMarketplaceError('skill_marketplace_target_occupied');
    }
    const target = await checkDirectory(destination);
    try {
      // The exclusive reservation never replaces an existing directory. Readers
      // can only discover the skill once its complete entrypoint is published.
      for (const entry of [...entries, documentName]) {
        await checkRoot(root);
        await checkDirectory(stage.path, stage.stat);
        await checkDirectory(target.path, target.stat);
        const output = join(target.path, entry);
        if (await statIfPresent(output))
          throw new SkillMarketplaceError('skill_marketplace_target_occupied');
        await rename(join(stage.path, entry), output);
      }
    } catch (error) {
      if (
        !(
          error instanceof SkillMarketplaceError &&
          error.code === 'skill_marketplace_target_occupied'
        )
      )
        await removeOwnedDirectory(root, target).catch(() => {});
      throw error;
    }
    return { status: 'installed', name };
  } finally {
    await removeOwnedDirectory(root, stage).catch(() => {});
  }
}

export function createSkillMarketplace(options: {
  userSkillRoot: string;
  fetch?: Fetch;
  trashItem?: (path: string) => Promise<void>;
}) {
  if (!isAbsolute(options.userSkillRoot))
    throw new SkillMarketplaceError('skill_marketplace_unsafe_directory');
  const fetch = options.fetch ?? globalThis.fetch;
  const mutations = new Map<string, Promise<unknown>>();

  async function mutate<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const next = (mutations.get(name) ?? Promise.resolve()).then(operation, operation);
    mutations.set(name, next);
    try {
      return await next;
    } finally {
      if (mutations.get(name) === next) mutations.delete(name);
    }
  }

  async function install(
    selection: SkillMarketplaceSelection,
    signal?: AbortSignal,
  ): Promise<SkillMarketplaceInstallResult> {
    const name = selection.skillId;
    try {
      signal?.throwIfAborted();
      const root = await userDirectories(options.userSkillRoot);
      await checkRoot(root);
      if (await occupied(join(root.skills.path, name)))
        return { status: 'already-installed', name };
      const url = new URL(`/api/download/${selection.source}/${name}`, registry);
      const files = readSnapshot(await registryJson(fetch, url, 'download', signal));
      return await publishSnapshot(root, name, files, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof SkillMarketplaceError) throw error;
      throw new SkillMarketplaceError('skill_marketplace_install_failed');
    }
  }

  async function uninstall(
    { skillId, skillVersion }: SkillMarketplaceUninstallSelection,
    name: string,
  ): Promise<SkillMarketplaceUninstallResult> {
    if (!options.trashItem) throw new SkillMarketplaceError('skill_marketplace_uninstall_failed');
    const absent = { status: 'already-uninstalled', skillId } as const;
    try {
      const paths = await userDirectoryPaths(options.userSkillRoot);
      if (!(await statIfPresent(paths.parent))) return absent;
      const parent = await checkDirectory(paths.parent);
      if (!(await statIfPresent(paths.skills))) return absent;
      const skills = await checkDirectory(paths.skills);
      const destination = join(skills.path, name);
      if (!(await statIfPresent(destination))) return absent;
      const target = await checkDirectory(destination);
      const document = join(target.path, documentName);
      const expected = await verifyUninstallVersion(document, skillVersion);
      await checkRoot({ parent, skills });
      await checkDirectory(target.path, target.stat);
      verifyUninstallDocument(await statIfPresent(document), expected);
      await options.trashItem(target.path);
      return { status: 'uninstalled', skillId };
    } catch (error) {
      if (error instanceof SkillMarketplaceError) throw error;
      throw new SkillMarketplaceError('skill_marketplace_uninstall_failed');
    }
  }

  return {
    async search(query: string, signal?: AbortSignal): Promise<readonly SkillMarketplaceResult[]> {
      if (!isSkillMarketplaceQuery(query))
        throw new SkillMarketplaceError('invalid_skill_marketplace_query');
      const url = new URL('/api/search', registry);
      url.search = new URLSearchParams({ q: query, limit: String(resultLimit) }).toString();
      return readResults((await registryJson(fetch, url, 'search', signal)).skills);
    },
    async install(
      selection: SkillMarketplaceSelection,
      signal?: AbortSignal,
    ): Promise<SkillMarketplaceInstallResult> {
      if (!isSkillMarketplaceSelection(selection))
        throw new SkillMarketplaceError('invalid_skill_marketplace_selection');
      return mutate(selection.skillId, () => install(selection, signal));
    },
    async uninstall(
      selection: SkillMarketplaceUninstallSelection,
    ): Promise<SkillMarketplaceUninstallResult> {
      if (!isSkillMarketplaceUninstallSelection(selection))
        throw new SkillMarketplaceError('invalid_skill_marketplace_selection');
      const name = selection.skillId.slice(installedSkillIdPrefix.length);
      return mutate(name, () => uninstall(selection, name));
    },
  };
}
