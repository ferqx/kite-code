import assert from 'node:assert/strict';

/** Prove the exact idempotent activation requests separately from management actions. */
export function managementActionWire<
  T extends { phase: string; method: string; path: string; body?: object },
>(rows: readonly T[], expected: Record<string, number>, sessionId = 'a'): T[] {
  const activation = rows.filter(
    (row) =>
      row.method === 'POST' &&
      row.path === `/v1/sessions/${encodeURIComponent(sessionId)}/reconcile`,
  );
  const counts: Record<string, number> = {};
  const bodies = new Map<string, object>();
  for (const row of activation) {
    counts[row.phase] = (counts[row.phase] ?? 0) + 1;
    const body = row.body as { commandId?: string; kind?: string; actionId?: string };
    assert.match(body.commandId ?? '', /^session-reconcile-[a-f0-9]{64}$/u);
    assert.equal(body.kind, undefined);
    assert.equal(body.actionId, undefined);
    if (bodies.has(row.phase)) assert.deepEqual(body, bodies.get(row.phase));
    else bodies.set(row.phase, body);
  }
  assert.deepEqual(counts, expected);
  const requests = new Set(activation);
  return rows.filter((row) => !requests.has(row));
}
