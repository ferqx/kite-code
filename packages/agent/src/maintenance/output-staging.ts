import type { Database } from 'bun:sqlite';
import { isAbsolute, relative } from 'node:path';
import { removeRuntimeTempAsync } from '../jobs/launch-identity';
import type { OutputCollection } from '../output-files';
/** Profile EX lock excludes active collectors; persisted uncertain producers still retain staging. */
export async function collectOutputStaging(
  db: Database,
  coordinationPath: string,
  now: number,
  signal?: AbortSignal,
) {
  for (const row of db
    .query<{ json: string }, []>(
      "SELECT json FROM extension_record WHERE extension_id='builtin.files' AND content_type='builtin.files.collection' AND fork_provenance_json IS NULL",
    )
    .all()) {
    signal?.throwIfAborted();
    const c = JSON.parse(row.json) as OutputCollection;
    const path = relative(coordinationPath, c.allocation.identity.canonical);
    if (!path || path.startsWith('..') || isAbsolute(path)) continue;
    const producer = db
      .query<{ state: string; dispatched: number }, [string]>(
        'SELECT state,dispatched FROM execution WHERE id=?',
      )
      .get(c.source.producerExecutionId);
    if (!producer || !['succeeded', 'failed', 'cancelled'].includes(producer.state)) continue;
    if (c.collectorExecutionId) {
      const collector = db
        .query<{ state: string }, [string]>('SELECT state FROM execution WHERE id=?')
        .get(c.collectorExecutionId);
      if (collector && !['succeeded', 'failed', 'cancelled'].includes(collector.state)) continue;
    }
    if (
      c.state === 'ready' ||
      (c.state === 'failed' &&
        (c.errorCode === 'producer_failed' ||
          Date.parse(c.cleanupAfter ?? c.retryUntil ?? '') <= now))
    )
      await removeRuntimeTempAsync(c.allocation.identity);
  }
}
