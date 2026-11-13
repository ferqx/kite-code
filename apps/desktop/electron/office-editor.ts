import { createHash } from 'node:crypto';
import { closeSync, constants, createReadStream, fstatSync, lstatSync, openSync } from 'node:fs';
import { copyFile, lstat, readFile, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { officeEnvironment, verifyOfficeRuntimeAssets } from '@kite-ai/agent/documents';
import type { OfficeEditorSnapshot } from '../src/office-editor-bridge';
import { NativeProcessOwner } from './native-processes';
import type { WindowsOfficeGuard, WindowsOfficeStorage } from './windows-access';

type Node = { type: string; format?: Record<string, unknown>; children?: Node[] };
type Revision = { snapshot: OfficeEditorSnapshot; path: string; nodes: Node[]; size: number };
type Session = {
  sourceKey: string;
  current: Revision;
  revisions: Map<number, Revision>;
};
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
async function hashFile(path: string) {
  const digest = createHash('sha256');
  let size = 0;
  for await (const bytes of createReadStream(path)) {
    size += bytes.length;
    if (size > 256 * 1024 * 1024) throw Error('office_editor_document_invalid');
    digest.update(bytes);
  }
  return digest.digest('hex');
}
/** Read-only retained Office history. Never initializes, edits or repairs stored copies. */
export class NativeOfficeEditor {
  private readonly owner = new NativeProcessOwner();
  private readonly sessions = new Map<string, Session>();
  private readonly opening = new Map<string, Promise<OfficeEditorSnapshot>>();
  private readonly active = new Set<Promise<unknown>>();
  private readonly streams = new Set<ReturnType<typeof createReadStream>>();
  private readonly closeFailures: unknown[] = [];
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly options: { root: string; assetsRoot?: string; storage?: WindowsOfficeStorage };
  constructor(options: { root: string; assetsRoot?: string; storage?: WindowsOfficeStorage }) {
    this.options = options;
  }
  private track<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(Error('office_editor_closed'));
    const promise = Promise.resolve().then(work);
    this.active.add(promise);
    void promise.then(
      () => this.active.delete(promise),
      () => this.active.delete(promise),
    );
    return promise;
  }
  private storage() {
    if (!this.options.storage) throw Error('office_editor_windows_storage_unavailable');
    return this.options.storage;
  }
  private relative(path: string) {
    const value = relative(resolve(this.options.root), resolve(path)).replaceAll('\\', '/');
    return value || 'root';
  }
  private releaseGuard(guard?: WindowsOfficeGuard) {
    try {
      guard?.release();
    } catch (error) {
      this.closeFailures.push(error);
      throw error;
    }
  }
  private async withAccess<T>(path: string, work: () => Promise<T>): Promise<T> {
    const guard =
      process.platform === 'win32' ? this.storage().access(this.relative(path)) : undefined;
    try {
      guard?.verify();
      if (process.platform !== 'win32') {
        const root = resolve(this.options.root);
        let ancestor = dirname(resolve(path));
        while (true) {
          const stat = await lstat(ancestor);
          if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            ((ancestor === root || ancestor.startsWith(`${root}/`)) &&
              (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
          )
            throw Error('office_editor_storage_unsafe');
          const parent = dirname(ancestor);
          if (parent === ancestor) break;
          ancestor = parent;
        }
      }
      const result = await work();
      guard?.verify();
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw Error('office_editor_revision_unavailable');
      throw error;
    } finally {
      this.releaseGuard(guard);
    }
  }
  private async metadata(path: string) {
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (process.platform !== 'win32' &&
        (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) ||
      stat.size > 2 * 1024 * 1024
    )
      throw Error('office_editor_recovery_invalid');
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) throw Error('office_editor_recovery_invalid');
      throw error;
    }
  }
  private matches(value: unknown, expected: OfficeEditorSnapshot): boolean {
    return (
      !!value &&
      typeof value === 'object' &&
      Object.keys(value).length === Object.keys(expected).length &&
      Object.entries(expected).every(
        ([key, item]) =>
          JSON.stringify((value as Record<string, unknown>)[key]) === JSON.stringify(item),
      )
    );
  }
  private async query(path: string) {
    const assets = await verifyOfficeRuntimeAssets(this.options.assetsRoot);
    const operation = this.owner.start(
      assets.officecli,
      ['query', path, 'slide', '--json'],
      {
        env: { ...process.env, ...officeEnvironment() },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
      {
        timeoutMs: 60000,
        timeoutError: 'office_editor_timeout',
        launchError: 'office_editor_launch_failed',
      },
    );
    const collect = async (stream: AsyncIterable<Uint8Array>) => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          operation.stop(Error('office_editor_output_limit'));
          throw Error('office_editor_output_limit');
        }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString('utf8');
    };
    let result: [number | null, string, string];
    try {
      result = await Promise.all([
        operation.result,
        collect(operation.child.stdout!),
        collect(operation.child.stderr!),
      ]);
    } catch (error) {
      operation.stop(error instanceof Error ? error : Error('office_editor_operation_failed'));
      await operation.result.catch(() => {});
      throw error;
    }
    const [code, stdout] = result;
    if (code !== 0) throw Error('office_editor_operation_failed');
    const parsed = JSON.parse(stdout);
    if (parsed?.success !== true) throw Error('office_editor_operation_failed');
    return parsed.data;
  }
  private async inspect(path: string): Promise<Node[]> {
    const data = await this.query(path);
    const nodes = data?.results;
    if (!Array.isArray(nodes) || nodes.length > 500 || nodes.some((n: Node) => n.type !== 'slide'))
      throw Error('office_editor_document_invalid');
    return nodes;
  }
  private async revision(
    path: string,
    editorId: string,
    revision: number,
    name: string,
  ): Promise<Revision> {
    return this.withAccess(path, async () => {
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (process.platform !== 'win32' &&
          (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) ||
        stat.size < 1 ||
        stat.size > 256 * 1024 * 1024
      )
        throw Error('office_editor_document_invalid');
      const sourceHash = await hashFile(path);
      const nodes = await this.inspect(path);
      if ((await hashFile(path)) !== sourceHash) throw Error('office_editor_recovery_invalid');
      const snapshot = {
        editorId,
        revision,
        name,
        slideCount: nodes.length,
        notes: nodes.map((n) => String(n.format?.notes ?? '')),
        sourceHash,
      };
      return { path, snapshot, nodes, size: stat.size };
    });
  }
  open(input: { sourceKey: string; name: string; check(): void }): Promise<OfficeEditorSnapshot> {
    return this.track(async () => {
      input.check();
      if (!/\.pptx$/i.test(input.name)) throw Error('office_editor_format_unavailable');
      const editorId = hash(input.sourceKey);
      const existing = this.sessions.get(editorId);
      if (existing) return structuredClone(existing.current.snapshot);
      let promise = this.opening.get(editorId);
      if (!promise) {
        promise = this.openHistory(input, editorId);
        this.opening.set(editorId, promise);
        void promise.finally(() => this.opening.delete(editorId)).catch(() => {});
      }
      const snapshot = await promise;
      input.check();
      return structuredClone(snapshot);
    });
  }
  private async historical(dir: string, id: string, revision: number, name: string) {
    const metadataPath = join(dir, `${String(revision)}.json`);
    // Archive metadata and immutable bytes stay pinned together through query and hashing.
    return this.withAccess(metadataPath, async () => {
      const metadata = await this.metadata(metadataPath);
      const value = await this.revision(join(dir, `${String(revision)}.pptx`), id, revision, name);
      if (!this.matches(metadata, value.snapshot)) throw Error('office_editor_recovery_invalid');
      return value;
    });
  }
  private async openHistory(
    input: { sourceKey: string; name: string; check(): void },
    editorId: string,
  ) {
    const dir = join(this.options.root, editorId);
    const current = join(dir, 'current.json');
    return this.withAccess(current, async () => {
      const metadata = await this.metadata(current);
      if (
        !metadata ||
        !Number.isSafeInteger(metadata.revision) ||
        metadata.revision < 0 ||
        metadata.revision > 100
      )
        throw Error('office_editor_recovery_invalid');
      const revision = await this.historical(
        dir,
        editorId,
        metadata.revision,
        input.name.replace(/[\\/]/g, '_'),
      );
      if (
        !this.matches(metadata, revision.snapshot) ||
        !this.matches(await this.metadata(current), revision.snapshot)
      )
        throw Error('office_editor_recovery_invalid');
      input.check();
      // Shared opening preserves this Session and all concurrently resolved historical revisions.
      this.sessions.set(editorId, {
        sourceKey: input.sourceKey,
        current: revision,
        revisions: new Map([[revision.snapshot.revision, revision]]),
      });
      return structuredClone(revision.snapshot);
    });
  }
  private get(id: string, revision: number) {
    const session = this.sessions.get(id);
    const value = session?.revisions.get(revision);
    if (!session || !value) throw Error('office_editor_revision_unavailable');
    return { session, value };
  }
  /** Only host-selected destination paths; never expose through arbitrary renderer arguments. */
  materialize(...args: Parameters<NativeOfficeEditor['materializeOwned']>) {
    return this.track(() => this.materializeOwned(...args));
  }
  private async materializeOwned(
    id: string,
    revision: number,
    destination: string,
    check: () => void,
  ) {
    check();
    const { value } = this.get(id, revision);
    let ownedDestination = false;
    try {
      await this.withAccess(value.path, async () => {
        if ((await hashFile(value.path)) !== value.snapshot.sourceHash)
          throw Error('office_editor_revision_changed');
        await copyFile(value.path, destination, constants.COPYFILE_EXCL);
        ownedDestination = true;
      });
      if ((await hashFile(destination)) !== value.snapshot.sourceHash)
        throw Error('office_editor_revision_changed');
      check();
    } catch (error) {
      // COPYFILE_EXCL failure never authorizes removing a pre-existing destination.
      if (ownedDestination) await rm(destination, { force: true });
      throw error;
    }
    return {
      ...structuredClone(value.snapshot),
      size: String(value.size),
      mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
  }
  resolve(...args: Parameters<NativeOfficeEditor['resolveOwned']>) {
    return this.track(() => this.resolveOwned(...args));
  }
  private async resolveOwned(id: string, revision: number) {
    const session = this.sessions.get(id);
    if (!session || !Number.isSafeInteger(revision) || revision < 0 || revision > 100)
      throw Error('office_editor_revision_unavailable');
    if (!session.revisions.has(revision)) {
      const dir = join(this.options.root, id);
      const value = await this.historical(dir, id, revision, session.current.snapshot.name);
      session.revisions.set(revision, value);
    }
    return this.read(id, revision);
  }
  assertSource(id: string, sourceKey: string) {
    if (id !== hash(sourceKey) || this.sessions.get(id)?.sourceKey !== sourceKey)
      throw Error('office_editor_source_mismatch');
  }
  read(id: string, revision: number) {
    const { value } = this.get(id, revision);
    return {
      path: value.path,
      hash: value.snapshot.sourceHash,
      size: value.size,
      snapshot: structuredClone(value.snapshot),
      openStream: () => {
        if (this.closing) throw Error('office_editor_closed');
        const guard =
          process.platform === 'win32'
            ? this.storage().access(this.relative(value.path))
            : undefined;
        let stream: ReturnType<typeof createReadStream>;
        try {
          guard?.verify();
          if (process.platform === 'win32') stream = createReadStream(value.path);
          else {
            const fd = openSync(value.path, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const stat = fstatSync(fd),
                current = lstatSync(value.path);
              if (
                !stat.isFile() ||
                current.isSymbolicLink() ||
                stat.nlink !== 1 ||
                stat.uid !== process.getuid?.() ||
                (stat.mode & 0o077) !== 0 ||
                stat.dev !== current.dev ||
                stat.ino !== current.ino ||
                stat.size !== value.size
              )
                throw Error('office_editor_storage_unsafe');
              stream = createReadStream(value.path, { fd, autoClose: true });
            } catch (error) {
              closeSync(fd);
              throw error;
            }
          }
        } catch (error) {
          this.releaseGuard(guard);
          throw error;
        }
        this.streams.add(stream);
        const closed = new Promise<void>((resolve) => {
          // Consumers still receive the original stream error; lifetime waits for actual close.
          stream.on('error', () => {});
          stream.once('close', () => {
            try {
              this.releaseGuard(guard);
            } catch {
              // releaseGuard records an unknown lifetime for close().
            }
            this.streams.delete(stream);
            resolve();
          });
        });
        this.active.add(closed);
        void closed.then(() => this.active.delete(closed));
        return stream;
      },
    };
  }
  /** Keep committed drafts. Closing tabs or draining processes must not erase user edits. */
  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const stream of this.streams) stream.destroy(Error('office_editor_closed'));
    this.closePromise = (async () => {
      const stopped = await Promise.allSettled([this.owner.close()]);
      while (this.active.size) await Promise.allSettled([...this.active]);
      if (this.closeFailures.length)
        throw new AggregateError(this.closeFailures, 'office_editor_close_unknown');
      if (stopped[0]?.status === 'rejected') throw stopped[0].reason;
    })();
    return this.closePromise;
  }
}
