import { createHash, randomUUID } from 'node:crypto';
import { type BigIntStats, constants, statSync } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

type Identity = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };
const identity = (value: Identity) =>
  [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
type Authorize = (consume: (path: string) => Promise<void>) => Promise<void>;
/** A revocable read capability, never an output delivery or write capability. */
export class LocalFilePreview {
  readonly id = randomUUID();
  readonly name: string;
  private released = false;
  private readonly path: string;
  private readonly baseline: string;
  private readonly authorize: Authorize;
  private readonly scope: () => void;
  private constructor(path: string, baseline: string, authorize: Authorize, scope: () => void) {
    this.path = path;
    this.baseline = baseline;
    this.authorize = authorize;
    this.scope = scope;
    this.name = basename(path);
  }
  async verifyAccess() {
    this.check();
    await this.authorize(async (path) => {
      if (path !== this.path) throw Error('local_preview_changed');
      this.check();
    });
    this.check();
  }
  async renderPdf(
    page: number,
    signal: AbortSignal,
    render: (
      bytes: Uint8Array,
      sourceHash: string,
      page: number,
      signal: AbortSignal,
    ) => Promise<{ data: string; totalPages: number }>,
  ) {
    if (!Number.isSafeInteger(page) || page < 1) throw Error('invalid_native_request');
    const bytes = await this.read();
    signal.throwIfAborted();
    const result = await render(
      bytes,
      createHash('sha256').update(bytes).digest('hex'),
      page,
      signal,
    );
    signal.throwIfAborted();
    await this.verifyAccess();
    return result;
  }
  static async create(authorize: Authorize, scope: () => void) {
    let result: LocalFilePreview | undefined;
    await authorize(async (path) => {
      scope();
      const file = statSync(path, { bigint: true });
      if (!file.isFile() || file.size > 64n * 1024n * 1024n)
        throw Error('local_preview_unavailable');
      result = new LocalFilePreview(path, identity(file), authorize, scope);
    });
    if (!result) throw Error('local_preview_unavailable');
    result.check();
    return result;
  }
  check() {
    if (this.released) throw Error('local_preview_released');
    this.scope();
    let current: BigIntStats;
    try {
      current = statSync(this.path, { bigint: true });
    } catch {
      throw Error('local_preview_changed');
    }
    if (!current.isFile() || identity(current) !== this.baseline)
      throw Error('local_preview_changed');
  }
  async read() {
    this.check();
    let bytes: Buffer | undefined;
    await this.authorize(async (path) => {
      this.check();
      if (path !== this.path) throw Error('local_preview_changed');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (identity(await file.stat({ bigint: true })) !== this.baseline)
          throw Error('local_preview_changed');
        const size = Number((await file.stat({ bigint: true })).size);
        const buffer = Buffer.alloc(size + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const read = await file.read(buffer, offset, buffer.length - offset, offset);
          if (!read.bytesRead) break;
          offset += read.bytesRead;
        }
        if (offset !== size) throw Error('local_preview_changed');
        bytes = buffer.subarray(0, size);
        if (
          bytes.length > 64 * 1024 * 1024 ||
          identity(await file.stat({ bigint: true })) !== this.baseline
        )
          throw Error('local_preview_changed');
        this.check();
      } finally {
        await file.close();
      }
    });
    this.check();
    if (!bytes) throw Error('local_preview_unavailable');
    return bytes;
  }
  async materialize(destination: string) {
    const bytes = await this.read();
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    this.check();
    return {
      name: this.name,
      size: String(bytes.length),
      mediaType: this.mediaType,
      sourceHash: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  get mediaType() {
    return /\.pdf$/i.test(this.name) ? 'application/pdf' : 'application/octet-stream';
  }
  release() {
    this.released = true;
  }
}
