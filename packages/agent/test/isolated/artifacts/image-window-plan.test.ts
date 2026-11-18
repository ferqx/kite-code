import { expect, test } from 'bun:test';
import {
  ImageWindowPlanError,
  imageMemberKey,
  planImageWindow,
  type WindowBatch,
} from '../../../src/model-body/image-window-plan';

const batch = (id: string, sizes: number[]): WindowBatch => ({
  executionId: id,
  members: sizes.map((size, i) => ({
    executionId: id,
    ordinal: i + 1,
    size,
    hash: 'a'.repeat(64),
  })),
});
test('preserves whole fresh batches in maximal fitting business suffix', () => {
  const a = batch('a', [3, 3]),
    b = batch('b', [2, 2]),
    c = batch('c', [2]);
  expect(planImageWindow([a, b, c], new Set(), 6)).toEqual({
    observe: [[...a.members]],
    business: [...b.members, ...c.members],
  });
  expect(planImageWindow([a], new Set(), 6)).toEqual({ observe: [], business: [...a.members] });
});
test('single oversized group splits only into observations; identical pixels retain ordinals', () => {
  const a = batch('a', [4, 4, 4, 4]);
  const p = planImageWindow([a], new Set(), 12);
  expect(p.observe.map((x) => x.map((m) => m.ordinal))).toEqual([[1, 2, 3], [4]]);
  expect(p.business).toEqual([]);
  expect(new Set(a.members.map(imageMemberKey)).size).toBe(4);
});
test('partial confirmed group never masquerades as complete business result', () => {
  const a = batch('a', [2, 2, 2]),
    b = batch('b', [2]);
  const known = new Set([imageMemberKey(a.members[0]!)]);
  expect(planImageWindow([a, b], known, 8)).toEqual({
    observe: [[a.members[1]!, a.members[2]!]],
    business: [...b.members],
  });
});
test('budget reduction, repeated planning and confirmation make bounded progress', () => {
  const groups = [batch('a', [3, 3, 3, 3]), batch('b', [3, 3])];
  const known = new Set<string>();
  for (const budget of [8, 4, 3]) {
    const plan = planImageWindow(groups, known, budget);
    for (const frame of [...plan.observe, plan.business]) {
      expect(frame.reduce((n, m) => n + m.size, 0)).toBeLessThanOrEqual(budget);
      for (const m of frame) expect(known.has(imageMemberKey(m))).toBe(false);
    }
    const first = plan.observe[0] ?? plan.business;
    for (const m of first) known.add(imageMemberKey(m));
  }
  const rest = planImageWindow(groups, known, 3);
  for (const m of [...rest.observe.flat(), ...rest.business]) known.add(imageMemberKey(m));
  expect(known.size).toBe(6);
  expect(planImageWindow(groups, known, 1)).toEqual({ observe: [], business: [] });
});
test('oversized single member returns structured failure, no plan', () => {
  try {
    planImageWindow([batch('a', [9])], new Set(), 8);
    throw Error('expected');
  } catch (e) {
    expect(e).toBeInstanceOf(ImageWindowPlanError);
    expect((e as ImageWindowPlanError).details).toEqual({
      executionId: 'a',
      ordinal: 1,
      size: 9,
      budget: 8,
    });
    expect((e as ImageWindowPlanError).code).toBe('image_window_member_too_large');
  }
});
test('keys bind source, ordinal, bytes and hash; unknown confirmations do not suppress', () => {
  const a = batch('a', [2]);
  const m = a.members[0]!;
  for (const altered of [
    { ...m, executionId: 'b' },
    { ...m, ordinal: 2 },
    { ...m, size: 3 },
    { ...m, hash: 'b'.repeat(64) },
  ])
    expect(planImageWindow([a], new Set([imageMemberKey(altered)]), 2).business).toEqual([
      ...a.members,
    ]);
});
test('rejects malformed orders, duplicate batches, unsafe bytes and budgets', () => {
  const a = batch('a', [2, 2]);
  const invalid: unknown[] = [
    [a, a],
    [{ ...a, members: [...a.members].reverse() }],
    [{ ...a, members: [{ ...a.members[0], executionId: 'b' }] }],
    [batch('a', [])],
    [batch('', [1])],
    [batch('a', [0])],
    [batch('a', [Number.MAX_SAFE_INTEGER, 1])],
    [{ ...a, members: [{ ...a.members[0], hash: 'bad' }] }],
  ];
  for (const x of invalid)
    expect(() => planImageWindow(x as WindowBatch[], new Set(), 10)).toThrow(
      'image_window_invalid_input',
    );
  for (const n of [0, -1, 1.5, NaN, Infinity])
    expect(() => planImageWindow([], new Set(), n)).toThrow('image_window_invalid_input');
});
test('inputs remain immutable and each unconfirmed ordinal appears exactly once in order', () => {
  const a = batch('a', [2, 3, 2]),
    b = batch('b', [3]);
  const inputs = [a, b];
  const before = JSON.stringify(inputs);
  for (const m of inputs.flatMap((x) => x.members)) Object.freeze(m);
  Object.freeze(a.members);
  Object.freeze(b.members);
  Object.freeze(inputs);
  const p = planImageWindow(inputs, new Set(), 5);
  expect([...p.observe.flat(), ...p.business].map(imageMemberKey)).toEqual(
    inputs.flatMap((x) => x.members).map(imageMemberKey),
  );
  expect(JSON.stringify(inputs)).toBe(before);
  p.observe[0]![0]!.size = 1;
  expect(JSON.stringify(inputs)).toBe(before);
});

test('129 members in one original group split into bounded observers, never truncated', () => {
  const a = batch('a', Array(129).fill(1));
  const p = planImageWindow([a], new Set(), 1000);
  expect(p.observe.map((f) => f.length)).toEqual([128, 1]);
  expect(p.business).toEqual([]);
  expect(p.observe.flat().map(imageMemberKey)).toEqual(a.members.map(imageMemberKey));
});
test('129 separate small groups obey both business and observation cardinality limits', () => {
  const groups = Array.from({ length: 257 }, (_, i) => batch(String(i), [1]));
  const p = planImageWindow(groups, new Set(), 1000);
  expect(p.observe.map((f) => f.length)).toEqual([128, 1]);
  expect(p.business.length).toBe(128);
  expect([...p.observe.flat(), ...p.business].map(imageMemberKey)).toEqual(
    groups.flatMap((b) => b.members).map(imageMemberKey),
  );
});
