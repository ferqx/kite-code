import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { openSqliteStore } from '@kite-ai/agent/sqlite';

type Store = Awaited<ReturnType<typeof openSqliteStore>>;
function requireFact(value: unknown, name: string): asserts value {
  if (!value) throw Error(`live_agent_events_${name}`);
}
function encoded(value: unknown) {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? { sqliteInteger: String(item) } : item,
  );
}
/** Isolated test artifact. Production has no retention-floor mutation API.
 * Reads are actual Store calls; only the explicitly labelled retained-floor control writes SQL.
 * This does not qualify natural production compaction or Model-selected small page limits.
 */
export async function probeFiniteAgentMailbox(options: {
  store: Store;
  databasePath: string;
  expectedStoreId: string;
  sessionId: string;
  subjectId: string;
  childSessionId: string;
  counts(): unknown;
}) {
  const { store } = options;
  const scope = {
    expectedStoreId: options.expectedStoreId,
    sessionId: options.sessionId,
    subjectId: options.subjectId,
    extensionId: 'builtin.task',
  };
  const db = new Database(options.databasePath, { safeIntegers: true });
  const snapshots: { phase: string; sha256: string; counts: unknown }[] = [];
  function snapshot(phase: string) {
    const tables = db
      .query(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const value = tables.map(({ name }) => ({
      name,
      rows: db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
    }));
    const counts = structuredClone(options.counts());
    const body = encoded({ value, counts });
    snapshots.push({ phase, sha256: createHash('sha256').update(body).digest('hex'), counts });
    return body;
  }
  const originalFloor = (await store.getMetadata()).replayFloor;
  requireFact(originalFloor === '0', 'fresh_store_floor_zero');
  let floorChanged = false;
  try {
    const before = snapshot('before_finite_reads');
    const all = await store.listAgentEvents({ ...scope, afterSeq: '0', limit: 200 });
    requireFact(
      all.events.length >= 2 && all.events.length < 200,
      'finite_genuine_events_not_reached',
    );
    requireFact(
      all.events.every((event) => event.agentId === options.childSessionId),
      'exact_child_events',
    );
    requireFact(
      all.events.some((event) => event.kind === 'message') &&
        all.events.some((event) => event.kind === 'completed'),
      'real_message_and_completion',
    );
    const pages = [];
    let afterSeq = '0';
    for (let index = 0; index < all.events.length; index++) {
      const page = await store.listAgentEvents({ ...scope, afterSeq, limit: 1 });
      requireFact(
        page.events.length === 1 && isDeepStrictEqual(page.events[0], all.events[index]),
        'page_one_actual_next_item',
      );
      requireFact(
        page.nextSeq === page.events[0]!.seq && BigInt(page.nextSeq) > BigInt(afterSeq),
        'next_seq_only_returned_item',
      );
      requireFact(page.highWaterSeq === all.highWaterSeq, 'stable_observed_high_water');
      requireFact(
        isDeepStrictEqual(page, await store.listAgentEvents({ ...scope, afterSeq, limit: 1 })),
        'same_cursor_identical_page',
      );
      pages.push(page);
      afterSeq = page.nextSeq;
    }
    const empty = await store.listAgentEvents({ ...scope, afterSeq, limit: 1 });
    requireFact(
      empty.events.length === 0 && empty.nextSeq === afterSeq,
      'empty_page_unchanged_cursor',
    );
    requireFact(snapshot('after_finite_and_repeat_reads') === before, 'finite_reads_zero_effect');
    const floor = pages[0]!.nextSeq;
    db.run('UPDATE storage_meta SET replay_floor=? WHERE singleton=1', [BigInt(floor)]);
    floorChanged = true;
    const retainedBefore = snapshot('after_explicit_test_retention_floor');
    const errors = [];
    for (const stale of ['0', String(BigInt(floor) - 1n)]) {
      let caught: unknown;
      try {
        await store.listAgentEvents({ ...scope, afterSeq: stale, limit: 1 });
      } catch (error) {
        caught = error;
      }
      requireFact(
        caught instanceof Error &&
          'code' in caught &&
          caught.code === 'cursor_expired' &&
          caught.message === floor,
        'explicit_cursor_expired_exact_resume_boundary',
      );
      errors.push({ afterSeq: stale, code: caught.code, resumeAfterSeq: caught.message });
    }
    const adopted = await store.listAgentEvents({ ...scope, afterSeq: floor, limit: 200 });
    requireFact(
      isDeepStrictEqual(adopted.events, all.events.slice(1)) && adopted.nextSeq === all.nextSeq,
      'adopted_boundary_only_retained_events',
    );
    requireFact(
      isDeepStrictEqual(
        adopted,
        await store.listAgentEvents({ ...scope, afterSeq: floor, limit: 200 }),
      ),
      'adopted_repeat_identical',
    );
    requireFact(
      snapshot('after_expired_adopted_repeat_reads') === retainedBefore,
      'gap_reads_zero_ack_consume_Source_Model',
    );
    db.run('UPDATE storage_meta SET replay_floor=? WHERE singleton=1', [BigInt(originalFloor)]);
    floorChanged = false;
    requireFact(
      snapshot('after_restored_test_floor') === before,
      'only_explicit_test_floor_changed_and_restored',
    );
    return {
      qualification: 'host_Store_finite_pages_and_explicit_SQL_retention_boundary_control',
      actualModelGapCalls: 0,
      productionNaturalRetentionLifecycle: 'not_run_no_public_floor_mutation_API',
      modelSmallPageSelection: 'not_applicable_current_Task_schema_has_no_limit',
      all,
      pages,
      empty,
      floor,
      errors,
      adopted,
      snapshots,
    };
  } finally {
    if (floorChanged)
      db.run('UPDATE storage_meta SET replay_floor=? WHERE singleton=1', [BigInt(originalFloor)]);
    db.close();
  }
}
