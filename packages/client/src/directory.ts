import { ClientError } from './decode';
import { parseCursorSequence } from './sse';

type Page = {
  storeId: string;
  items: { seq: string }[];
  highWaterSeq: string;
  upperSeq: string;
  nextAfterSeq: string | null;
  snapshotCursor: string;
};
export function validateDirectoryPage<T extends Page>(
  page: T,
  storeId: string,
  input: { afterSeq?: string; upperSeq?: string; snapshotCursor?: string; limit?: number },
): T {
  const after = parseCursorSequence(input.afterSeq ?? '0'),
    upper = parseCursorSequence(page.upperSeq),
    high = parseCursorSequence(page.highWaterSeq);
  if (
    page.storeId !== storeId ||
    upper > high ||
    (input.upperSeq !== undefined && page.upperSeq !== input.upperSeq) ||
    (input.snapshotCursor !== undefined && page.snapshotCursor !== input.snapshotCursor) ||
    after > upper ||
    page.items.length > (input.limit ?? 200)
  )
    throw new ClientError('directory_identity_conflict');
  let previous = after;
  for (const item of page.items) {
    const seq = parseCursorSequence(item.seq);
    if (seq <= previous || seq > upper) throw new ClientError('invalid_directory_cursor');
    previous = seq;
  }
  if (
    page.nextAfterSeq !== null &&
    (page.items.length === 0 ||
      page.nextAfterSeq !== page.items.at(-1)!.seq ||
      parseCursorSequence(page.nextAfterSeq) <= after)
  )
    throw new ClientError('invalid_directory_cursor');
  return page;
}
export async function collectDirectory<T>(
  read: (page: {
    afterSeq?: string;
    upperSeq?: string;
    limit: number;
  }) => Promise<{ items: T[]; upperSeq: string; nextAfterSeq: string | null }>,
  signal?: AbortSignal,
  identity?: (item: T) => string,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let afterSeq: string | undefined, upperSeq: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await read({ afterSeq, upperSeq, limit: 200 });
    signal?.throwIfAborted();
    upperSeq ??= page.upperSeq;
    for (const item of page.items) {
      if (identity) {
        const key = identity(item);
        if (seen.has(key)) throw new ClientError('directory_identity_conflict');
        seen.add(key);
      }
      items.push(item);
    }
    if (page.nextAfterSeq === null) return items;
    afterSeq = page.nextAfterSeq;
  } while (afterSeq !== undefined);
  return items;
}

/** A mutable directory is published only after every page shares the original observation. */
export async function collectSnapshotDirectory<T extends { seq: string }>(
  read: (page: {
    afterSeq?: string;
    upperSeq?: string;
    snapshotCursor?: string;
    limit: number;
  }) => Promise<Page & { items: T[] }>,
  signal?: AbortSignal,
  identity?: (item: T) => string,
): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    let snapshotCursor: string | undefined;
    try {
      return await collectDirectory(
        async (input) => {
          const page = await read({ ...input, snapshotCursor });
          if (snapshotCursor !== undefined && page.snapshotCursor !== snapshotCursor)
            throw new ClientError('directory_identity_conflict');
          snapshotCursor ??= page.snapshotCursor;
          return page;
        },
        signal,
        identity,
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof ClientError) || error.code !== 'directory_changed' || attempt >= 2)
        throw error;
    }
  }
}
