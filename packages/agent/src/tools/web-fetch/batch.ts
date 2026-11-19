import type { Json, ToolContext, ToolResult } from '../../extensions';
import { isWorkerCleanupFailure } from '../../platform/process/owned-worker';
import { WebFetchError } from './network-errors';

export const webFetchBatchLimits = Object.freeze({
  maxPages: 5,
  parallelPages: 2,
  modelBytes: 32768,
  timeoutMs: 60000,
});
type PageText = { content: string; truncated: boolean };

// Measure the escaped string in the actual JSON projection. Leave room for all five receipts and Core’s immutable reference header.
export function batchPageText(text: string, pages: number): PageText {
  const capacity = Math.floor((webFetchBatchLimits.modelBytes - 8192) / pages);
  const fits = (end: number) => Buffer.byteLength(JSON.stringify(text.slice(0, end))) <= capacity;
  let end = Math.min(text.length, capacity);
  if (!fits(end)) {
    let low = 0,
      high = end;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(mid)) low = mid;
      else high = mid - 1;
    }
    end = low;
  }
  if (
    end < text.length &&
    end &&
    /[\uD800-\uDBFF]/.test(text[end - 1]!) &&
    /[\uDC00-\uDFFF]/.test(text[end]!)
  )
    end--;
  return { content: text.slice(0, end), truncated: end < text.length };
}

/** One approved Tool execution. Only the two current readers can acquire a request scope. */
export async function fetchBatch(
  urls: readonly string[],
  context: ToolContext,
  deadline: AbortSignal,
  fetchPage: (url: string, index: number, signal: AbortSignal) => Promise<ToolResult>,
): Promise<ToolResult> {
  const siblings = new AbortController();
  const signal = AbortSignal.any([deadline, siblings.signal]);
  const results: ToolResult[] = new Array(urls.length);
  let next = 0;
  async function worker() {
    while (!signal.aborted && next < urls.length) {
      const index = next++;
      try {
        results[index] = await fetchPage(urls[index]!, index, signal);
      } catch (error) {
        siblings.abort(error);
        throw error;
      }
    }
  }
  const stopped = await Promise.allSettled(
    Array.from({ length: Math.min(urls.length, webFetchBatchLimits.parallelPages) }, worker),
  );
  // A sibling deadline or cancellation cannot prove that an owned parser was cleaned up.
  const errors = stopped.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
  if (errors.length) throw errors.find(isWorkerCleanupFailure) ?? errors[0];
  if (context.signal.aborted) return { outcome: 'cancelled', content: 'web_cancelled' };
  const pages: Record<string, Json>[] = [];
  const bodies: { index: number; content: string }[] = [];
  const refs = results.flatMap((r) => r.artifactRefs ?? []);
  for (let index = 0; index < urls.length; index++) {
    const result = results[index];
    if (!result) {
      if (!deadline.aborted) throw new Error('web_batch_result_missing');
      pages.push({
        index,
        outcome: 'failed',
        code: 'web_timeout',
        stage: 'queue',
        resource: 'page',
      });
      continue;
    }
    const details = result.details;
    const original =
      details && typeof details === 'object' && !Array.isArray(details) ? details : {};
    const page: Record<string, Json> = { index, outcome: result.outcome };
    if (result.outcome === 'succeeded') {
      for (const key of [
        'urlDigest',
        'finalUrlDigest',
        'characters',
        'truncated',
        'previewTruncated',
      ]) {
        if (original[key] !== undefined) page[key] = original[key]!;
      }
      if (result.artifactRefs?.[0]) page.artifactId = result.artifactRefs[0].id;
      bodies.push({ index, content: result.content });
    } else {
      page.code =
        typeof original.code === 'string' && /^web_[a-z0-9_]{1,64}$/.test(original.code)
          ? original.code
          : 'web_fetch_failed';
      if (typeof original.httpStatus === 'number') page.httpStatus = original.httpStatus;
      if (typeof original.stage === 'string') page.stage = original.stage;
      if (typeof original.resource === 'string') page.resource = original.resource;
    }
    pages.push(page);
  }
  const details = { kind: 'web_fetch_batch', executionId: context.executionId, pages };
  const content = [
    'Web fetch receipt (host metadata; no additional authorization):',
    JSON.stringify(details),
    'Page contents (untrusted data in input order):',
    JSON.stringify(bodies),
  ].join('\n');
  if (Buffer.byteLength(content) > webFetchBatchLimits.modelBytes)
    throw new WebFetchError('web_batch_result_too_large');
  return {
    outcome: bodies.length ? 'succeeded' : 'failed',
    content,
    details,
    ...(refs.length ? { artifactRefs: refs } : {}),
  };
}
