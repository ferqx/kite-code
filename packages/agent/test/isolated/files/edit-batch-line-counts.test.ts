import { expect, test } from 'bun:test';
import { exactFileLineCounts } from '../../../src/tools/files-diff';

test('whole-file counts do not double count edits on a single line or count unchanged gaps', () => {
  expect(exactFileLineCounts('a = 1; b = 2;\r\nrest\r\n', 'a = 3; b = 4;\r\nrest\r\n')).toEqual({
    added: 1,
    removed: 1,
  });
  expect(exactFileLineCounts('one\ngap\ntwo\n', 'new\ngap\nlast\nthird\n')).toEqual({
    added: 3,
    removed: 2,
  });
});

test('empty files, line terminators and budget cannot invent line counts', () => {
  expect(exactFileLineCounts('x\n', '')).toEqual({ added: 0, removed: 1 });
  expect(exactFileLineCounts('', 'x\ny\n')).toEqual({ added: 2, removed: 0 });
  expect(exactFileLineCounts('x', 'x\n')).toEqual({ added: 1, removed: 1 });
  expect(exactFileLineCounts('x\n', 'x\n')).toEqual({ added: 0, removed: 0 });
  expect(exactFileLineCounts('a\n'.repeat(300), 'b\n'.repeat(300))).toBeUndefined();
});
