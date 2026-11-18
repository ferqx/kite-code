import { expect, test } from 'bun:test';
import {
  deliveryFacts,
  deliveryPlan,
  type LocalImageSource,
} from '../../../src/model-body/image-delivery';
import type { Store } from '../../../src/storage/port';
import type { ArtifactReference } from '../../../src/storage/types';

const MB = 1024 * 1024;
const archive = (id: string, sizes: number[]): LocalImageSource => ({
  definition: 'files.view_images',
  locator: { executionId: id, messageId: 'm' + id, seq: '1' },
  root: {
    locator: { executionId: id, messageId: 'm' + id, seq: '1' },
    ordinals: sizes.map((_, i) => i + 1),
    sourceCount: sizes.length,
  },
  refs: sizes.map(
    (n, i) => ({ hash: String(i + 1).repeat(64), size: String(n * MB) }) as ArtifactReference,
  ),
});
const members = (s: LocalImageSource) =>
  s.refs.map((r, i) => ({
    executionId: s.locator.executionId,
    ordinal: i + 1,
    hash: r.hash,
    size: Number(r.size),
  }));
const reject = (kind: 'business' | 'observation', s: LocalImageSource, n?: number) => ({
  attemptId: 'rejection',
  kind,
  members: n === undefined ? members(s) : [members(s)[n - 1]!],
});

test('realistic 8MiB receiver: reject 7+1+1, observe 7 alone then 1+1, no unseen ordinal disappears', () => {
  const s = archive('registered', [7, 1, 1]),
    facts: Awaited<ReturnType<Store['readImageWindowFacts']>> = { confirmed: [], rejected: [] };
  let p = deliveryPlan([s], facts);
  expect(p.business.reduce((n, m) => n + m.size, 0)).toBeGreaterThan(8 * MB);
  facts.rejected.push(reject('business', s));
  const got: number[][] = [];
  for (;;) {
    p = deliveryPlan([s], facts);
    if (!p.observe.length) break;
    const frame = p.observe[0]!;
    expect(frame.reduce((n, m) => n + m.size, 0)).toBeLessThanOrEqual(8 * MB);
    got.push(frame.map((m) => m.ordinal));
    facts.confirmed.push(...frame);
  }
  expect(got).toEqual([[1], [2, 3]]);
  expect(p.business).toEqual([]);
});
test('one rich 413 gets one minimal single probe; only same missing member plus confirmed minimal 413 stops', () => {
  const s = archive('x', [7]),
    other = archive('other', [2]);
  const many = reject('business', s),
    irreducible = reject('observation', s, 1);
  const reroute = deliveryPlan([s], { confirmed: [], rejected: [many] });
  expect(reroute.business).toBeEmpty();
  expect(reroute.observe).toEqual([members(s)]);
  expect(() => deliveryPlan([s], { confirmed: [], rejected: [many, irreducible] })).toThrow(
    'image_member_provider_limit',
  );
  expect(deliveryPlan([other], { confirmed: [], rejected: [irreducible] }).business).toEqual(
    members(other),
  );
  expect(
    deliveryPlan([s], { confirmed: members(s), rejected: [irreducible] }).business,
  ).toBeEmpty();
});
test('delivery evidence is independent from note authority for all original observer sources', async () => {
  const a = archive('A', [1]),
    b = archive('B', [1]);
  const facts = {
    confirmed: [{ ...members(a)[0]!, note: 'A and B private details', noteSources: ['A', 'B'] }],
    rejected: [],
  };
  const store = {
    async readImageWindowFacts() {
      return facts;
    },
  } as unknown as Store;
  const scope = {
    runId: 'r',
    expectedStoreId: 'db',
    subjectId: 's',
    selectionId: 'sel',
    sessionId: 'sess',
    route: 'model',
  };
  expect((await deliveryFacts(store, scope, [a, b])).confirmed[0]?.note).toBe(
    facts.confirmed[0]!.note,
  );
  expect((await deliveryFacts(store, scope, [a])).confirmed).toEqual(members(a));
});
