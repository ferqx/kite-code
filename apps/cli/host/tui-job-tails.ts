import type { AgentClient, Execution, ExecutionOutputPage, SessionView } from '@kite-ai/client';

export interface TuiJobTail {
  readonly executionId: string;
  readonly content: string;
  readonly totalLines?: number;
  readonly incomplete?: boolean;
}
type Client = Pick<AgentClient, 'getExecution' | 'listExecutionOutput'> & {
  readonly serverInfo?: { storeId?: string; instanceId: string };
};
type Cache = {
  key: string;
  after: string;
  highWater: string;
  tail: string;
  newlines: number;
  knownLines: boolean;
  lost: boolean;
  lastStream?: string;
  streamEnds: Map<string, bigint>;
};
const decimal = (value: string): bigint => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw Error('tui_job_tail_cursor_invalid');
  return BigInt(value);
};
const identity = (job: Execution) =>
  JSON.stringify([
    job.id,
    job.kind,
    job.originStoreId,
    job.sessionId,
    job.runId,
    job.definitionId,
    job.definitionVersion,
    job.parentExecutionId ?? null,
    job.childSessionId ?? null,
  ]);
const MAX_BYTES = 256 * 1024,
  MAX_TAIL_BYTES = 16 * 1024,
  PAGE_LIMIT = 32,
  MAX_PAGES = 2;
/** Trim by newline boundaries without retaining a split array proportional to full history. */
function append(cache: Cache, content: string, stream: string) {
  if (
    cache.lastStream !== undefined &&
    cache.lastStream !== stream &&
    cache.tail &&
    !cache.tail.endsWith('\n')
  ) {
    cache.tail += '\n';
    cache.knownLines = false;
    cache.lost = true;
  }
  cache.lastStream = stream;
  let at = content.indexOf('\n');
  while (at >= 0) {
    cache.newlines++;
    at = content.indexOf('\n', at + 1);
  }
  const combined = cache.tail + content;
  const keepLines = combined.endsWith('\n') ? 6 : 5;
  let boundary = combined.length,
    found = 0;
  while (found < keepLines) {
    const prior = combined.lastIndexOf('\n', boundary - 1);
    if (prior < 0) {
      boundary = 0;
      break;
    }
    boundary = prior;
    found++;
  }
  const tail = combined.slice(found === keepLines ? boundary + 1 : 0);
  if (Buffer.byteLength(tail) > MAX_TAIL_BYTES) {
    // One pathological long row remains a qualified partial line, never a full output claim.
    const bytes = Buffer.from(tail);
    let start = bytes.length - MAX_TAIL_BYTES;
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    cache.tail = bytes.subarray(start).toString('utf8');
    cache.lost = true;
  } else cache.tail = tail;
}
function validate(
  cache: Cache,
  page: ExecutionOutputPage,
  executionId: string,
  upper: string,
): ExecutionOutputPage['items'] {
  if (
    decimal(page.highWaterSeq) < decimal(upper) ||
    decimal(page.highWaterSeq) < decimal(cache.highWater)
  )
    throw Error('tui_job_tail_high_water_changed');
  const items = [...page.items].sort((a, b) =>
      decimal(a.seq) < decimal(b.seq) ? -1 : decimal(a.seq) > decimal(b.seq) ? 1 : 0,
    ),
    seen = new Set<string>(),
    ends = new Map(cache.streamEnds);
  let covered = decimal(cache.after);
  for (const item of items) {
    const first = decimal(item.seq),
      last = decimal(item.throughSeq),
      dropped = item.droppedBytes === null ? null : decimal(item.droppedBytes),
      gap = dropped === null || dropped > 0n || last > first;
    if (
      item.executionId !== executionId ||
      first <= decimal(cache.after) ||
      first > covered + 1n ||
      last < first ||
      last > decimal(upper) ||
      (gap && (item.content !== '' || dropped === 0n)) ||
      (!gap && seen.has(item.seq)) ||
      (ends.has(item.stream) && first <= ends.get(item.stream)!)
    )
      throw Error('tui_job_tail_page_invalid');
    seen.add(item.seq);
    ends.set(item.stream, last);
    if (last > covered) covered = last;
  }
  if (
    (!items.length && covered !== decimal(upper)) ||
    (covered < decimal(upper) && covered <= decimal(cache.after))
  )
    throw Error('tui_job_tail_page_incomplete');
  return items;
}
/** No timer or history replay. Each refresh forwards bounded pages and retains only current-view tails. */
export function createTuiJobTailReader(client: Client, storeId: string) {
  const cache = new Map<string, Cache>();
  let revision = 0;
  const server = () => {
    const info = client.serverInfo;
    if (info?.storeId !== storeId) throw Error('tui_job_tail_store_mismatch');
    return info.instanceId;
  };
  return {
    clear() {
      revision++;
      cache.clear();
    },
    async read(view: SessionView, signal: AbortSignal): Promise<readonly TuiJobTail[]> {
      signal.throwIfAborted();
      const instance = server();
      const readId = ++revision;
      if (view.storeId !== storeId) throw Error('tui_job_tail_store_mismatch');
      const jobs = view.executions.filter(
        (job) =>
          job.kind === 'job' && job.originStoreId === storeId && job.sessionId === view.session.id,
      );
      const keys = new Set(jobs.map(identity));
      for (const key of cache.keys()) if (!keys.has(key)) cache.delete(key);
      const tails: TuiJobTail[] = [];
      for (const job of jobs) {
        signal.throwIfAborted();
        if (readId !== revision || server() !== instance)
          throw Error('tui_job_tail_connection_changed');
        const key = identity(job),
          old = cache.get(key);
        const entry: Cache = old
          ? { ...old, streamEnds: new Map(old.streamEnds) }
          : {
              key,
              after: '0',
              highWater: '0',
              tail: '',
              newlines: 0,
              knownLines: true,
              lost: false,
              streamEnds: new Map(),
            };
        const exact = async () => {
          const fresh = await client.getExecution(job.id, { signal });
          signal.throwIfAborted();
          if (readId !== revision || server() !== instance || identity(fresh) !== key)
            throw Error('tui_job_tail_identity_mismatch');
        };
        await exact();
        let upper: string | undefined,
          bytes = 0,
          pages = 0,
          budgetExhausted = false;
        while (pages < MAX_PAGES && bytes < MAX_BYTES) {
          const page = await client.listExecutionOutput(job.id, {
            afterSeq: entry.after,
            ...(upper === undefined ? {} : { upperSeq: upper }),
            limit: PAGE_LIMIT,
            signal,
          });
          signal.throwIfAborted();
          if (readId !== revision || server() !== instance)
            throw Error('tui_job_tail_connection_changed');
          upper ??= page.highWaterSeq;
          const items = validate(entry, page, job.id, upper);
          pages++;
          for (const item of items) {
            const size = Buffer.byteLength(item.content);
            if (size <= MAX_BYTES && bytes + size > MAX_BYTES) {
              budgetExhausted = true;
              break;
            }
            if (size > MAX_BYTES) {
              entry.lost = true;
              entry.knownLines = false;
              entry.tail = '';
              entry.after = String(
                decimal(item.throughSeq) > decimal(entry.after)
                  ? decimal(item.throughSeq)
                  : decimal(entry.after),
              );
              entry.streamEnds.set(item.stream, decimal(item.throughSeq));
              continue;
            }
            bytes += size;
            const gap =
              item.droppedBytes === null ||
              item.droppedBytes !== '0' ||
              item.throughSeq !== item.seq;
            if (gap) {
              entry.lost = true;
              entry.knownLines = false;
              entry.tail = '';
              entry.lastStream = undefined;
            } else append(entry, item.content, item.stream);
            entry.streamEnds.set(item.stream, decimal(item.throughSeq));
            if (decimal(item.throughSeq) > decimal(entry.after)) entry.after = item.throughSeq;
          }
          entry.highWater = page.highWaterSeq;
          if (budgetExhausted || decimal(entry.after) >= decimal(upper)) break;
        }
        await exact();
        cache.set(key, entry);
        const incomplete =
          entry.lost ||
          upper === undefined ||
          decimal(entry.after) < decimal(upper) ||
          decimal(entry.after) < decimal(entry.highWater);
        tails.push({
          executionId: job.id,
          content: entry.tail,
          ...(entry.knownLines
            ? { totalLines: entry.newlines + (entry.tail && !entry.tail.endsWith('\n') ? 1 : 0) }
            : {}),
          ...(incomplete ? { incomplete: true } : {}),
        });
      }
      return tails;
    },
  };
}
