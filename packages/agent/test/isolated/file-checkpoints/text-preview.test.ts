import { expect, test } from 'bun:test';
import { checkpointTextChange } from '../../../src/business/file-checkpoints';

const bytes = (value: string) => new TextEncoder().encode(value);
test('complete text comparison describes current to restored lines without changing original bytes', () => {
  const current = bytes('new\nsame\n'),
    restored = bytes('old\nsame\n');
  const before = current.slice(),
    target = restored.slice();
  expect(checkpointTextChange(current, restored)).toEqual({
    addedLines: 1,
    removedLines: 1,
    preview: '- new\n+ old\n  same\n  \n',
    truncated: false,
  });
  expect(current).toEqual(before);
  expect(restored).toEqual(target);
  expect(checkpointTextChange(current, current)).toMatchObject({
    addedLines: 0,
    removedLines: 0,
    truncated: false,
  });
  expect(checkpointTextChange(bytes('created\n'), null)).toMatchObject({
    addedLines: 0,
    removedLines: 1,
  });
});
test('binary and invalid UTF-8 remain unavailable; long Unicode previews are byte-bounded while complete line counts survive', () => {
  expect(checkpointTextChange(Uint8Array.of(0, 1, 2), bytes('text'))).toBeNull();
  expect(checkpointTextChange(bytes('text'), Uint8Array.of(0xff))).toBeNull();
  const actual = checkpointTextChange(bytes('😀'.repeat(40000)), bytes('restored'))!;
  expect(actual).toMatchObject({ addedLines: 1, removedLines: 1, truncated: true });
  expect(new TextEncoder().encode(actual.preview).byteLength).toBeLessThanOrEqual(65536);
  expect(actual.preview).not.toContain('\uFFFD');
  expect(/[\uD800-\uDFFF]/u.test(actual.preview)).toBe(false);
});
