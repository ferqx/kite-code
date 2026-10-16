import { mock } from 'bun:test';
import { constants as bufferConstants } from 'node:buffer';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const mode = process.argv[2]!;
const consume = process.argv[3] ?? 'full';
const operations = {
  open: fs.openSync.bind(fs),
  lstat: fs.lstatSync.bind(fs) as (...input: unknown[]) => fs.BigIntStats,
  fstat: fs.fstatSync.bind(fs) as (...input: unknown[]) => fs.BigIntStats,
  close: fs.closeSync.bind(fs),
  read: fs.readSync.bind(fs) as (...input: unknown[]) => number,
};
const originalAlloc = Buffer.alloc.bind(Buffer);
const originalConcat = Buffer.concat.bind(Buffer);
let measuring = false;
let reads = 0;
const allocations: number[] = [];
let concatenations = 0;
const descriptors = new Set<number>();
const observedStat = (stat: fs.BigIntStats) =>
  measuring && mode === 'runtime_limit'
    ? (Object.assign(Object.create(stat), {
        size: BigInt(bufferConstants.MAX_LENGTH) + 1n,
      }) as fs.BigIntStats)
    : stat;
const io = {
  ...fs,
  lstatSync: ((...input: unknown[]) =>
    observedStat(operations.lstat(...input))) as typeof fs.lstatSync,
  fstatSync: ((...input: unknown[]) =>
    observedStat(operations.fstat(...input))) as typeof fs.fstatSync,
  openSync: ((...input: unknown[]) => {
    if (measuring && mode === 'inode') {
      fs.renameSync(path, `${path}.old`);
      fs.writeFileSync(path, data, { mode: 0o444 });
    }
    const fd = (operations.open as (...input: unknown[]) => number)(...input);
    if (measuring) descriptors.add(fd);
    return fd;
  }) as typeof fs.openSync,
  closeSync(fd: number) {
    operations.close(fd);
    descriptors.delete(fd);
  },
  readSync: ((...input: unknown[]) => {
    if (measuring) {
      reads++;
      if (mode === 'io_error' && reads === 2)
        throw Object.assign(new Error('owned I/O fault'), { code: 'EIO' });
      if (reads === 2 && consume !== 'chunks' && ['growth', 'truncation', 'ctime'].includes(mode)) {
        fs.chmodSync(path, 0o644);
        if (mode === 'growth') fs.appendFileSync(path, 'growth');
        if (mode === 'truncation') fs.truncateSync(path, 0);
        fs.chmodSync(path, 0o444);
      }
      if (mode === 'short') input[3] = Math.min(Number(input[3]), 3);
    }
    return operations.read(...input);
  }) as typeof fs.readSync,
};
mock.module('node:fs', () => io);
Buffer.alloc = ((size: number, fill?: string | number | Uint8Array, encoding?: BufferEncoding) => {
  if (measuring) allocations.push(size);
  return originalAlloc(size, fill, encoding);
}) as typeof Buffer.alloc;
Buffer.concat = ((...input: Parameters<typeof Buffer.concat>) => {
  if (measuring) concatenations++;
  return originalConcat(...input);
}) as typeof Buffer.concat;
const {
  artifactPath,
  readPublishedArtifactChunks,
  readPublishedArtifact,
  verifyPublishedArtifact,
} = await import('../../../src/artifacts-files');
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'kite-artifact-reader-')));
const data = Buffer.from(
  mode === 'tiny'
    ? '中文🙂artifact'
    : mode.startsWith('empty')
      ? ''
      : '中文🙂'.repeat(mode === 'short' ? 9 : 20000),
);
const hash = createHash('sha256')
  .update(mode === 'empty_bad_hash' ? 'not-empty' : data)
  .digest('hex');
const expectedSize =
  mode === 'invalid_size'
    ? '01'
    : mode === 'runtime_limit'
      ? String(BigInt(bufferConstants.MAX_LENGTH) + 1n)
      : String(data.length + (mode === 'size' ? 1 : 0));
const path = artifactPath(root, hash);
fs.mkdirSync(dirname(path), { recursive: true });
fs.writeFileSync(path, data, { mode: 0o444 });
let error: string | null = null;
let matches = true;
let yieldedBytes = 0;
let isolatedChunks = true;
let openAfterYield = 0;
const captured: Uint8Array[] = [];
try {
  if (mode === 'mutable') fs.chmodSync(path, 0o644);
  if (mode === 'hash') {
    fs.chmodSync(path, 0o644);
    fs.writeFileSync(path, Buffer.alloc(data.length, 1));
    fs.chmodSync(path, 0o444);
  }
  if (mode === 'symlink') {
    const outside = join(root, 'outside');
    fs.writeFileSync(outside, data, { mode: 0o444 });
    fs.unlinkSync(path);
    fs.symlinkSync(outside, path);
  }
  measuring = true;
  if (consume === 'verify') verifyPublishedArtifact(root, hash, expectedSize);
  else if (consume === 'full')
    matches = Buffer.compare(readPublishedArtifact(root, hash, expectedSize), data) === 0;
  else {
    const iterator = readPublishedArtifactChunks(root, hash, expectedSize);
    const first = iterator.next();
    if (!first.done) {
      openAfterYield = descriptors.size;
      const copy = Uint8Array.from(first.value);
      yieldedBytes += first.value.byteLength;
      captured.push(copy);
      if (mode === 'early') iterator.return(undefined);
      else if (mode === 'throw') iterator.throw(new Error('owned_abort'));
      else {
        if (['growth', 'truncation', 'ctime'].includes(mode)) {
          fs.chmodSync(path, 0o644);
          if (mode === 'growth') fs.appendFileSync(path, 'growth');
          if (mode === 'truncation') fs.truncateSync(path, first.value.byteLength);
          fs.chmodSync(path, 0o444);
        }
        for (const chunk of iterator) {
          yieldedBytes += chunk.byteLength;
          captured.push(Uint8Array.from(chunk));
          isolatedChunks &&= Buffer.compare(first.value, copy) === 0;
          if (chunk.length) chunk[0] = chunk[0]! ^ 1;
          isolatedChunks &&= Buffer.compare(first.value, copy) === 0;
        }
        matches = Buffer.compare(originalConcat(captured), data) === 0;
      }
    }
  }
} catch (caught) {
  error = (caught as { code?: string }).code ?? (caught as Error).message;
} finally {
  measuring = false;
  for (const fd of descriptors) operations.close(fd);
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    mode,
    consume,
    dataBytes: data.length,
    allocations,
    concatenations,
    reads,
    error,
    matches,
    yieldedBytes,
    isolatedChunks,
    openAfterYield,
    remainingDescriptors: descriptors.size,
  }),
);
