import { expect, test } from '#kite-test';
import type { FileSnapshot } from '../../../src/tools/files';
import { fileChangePreview } from '../../../src/tools/files-diff';

function snapshot(content: string): FileSnapshot {
  return {
    path: 'example.txt',
    content,
    baseline: { hash: 'test', size: Buffer.byteLength(content), device: '1', inode: '1' },
  };
}

function preview(before: string | null, after: string) {
  return fileChangePreview(before === null ? null : snapshot(before), snapshot(after));
}

function expectBounded(text: string) {
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(65536);
  expect(text.split('\n').length).toBeLessThanOrEqual(401);
  expect(Buffer.from(text).toString('utf8')).toBe(text);
  expect(text).not.toContain('\ufffd');
}

test('large common prefix and suffix leave context around the actual change', () => {
  const prefix = 'same\n'.repeat(100000);
  const suffix = 'same end\n'.repeat(100000);
  const result = preview(`${prefix}old\n${suffix}`, `${prefix}new\n${suffix}`);
  expect(result.truncated).toBe(false);
  expect(result.text).toContain('100001 -old\n');
  expect(result.text).toContain('100001 +new\n');
  expect(result.text.length).toBeLessThan(1000);
  expectBounded(result.text);
});

test('distant edits and insertions retain actual old and new line numbers', () => {
  const middle = Array.from({ length: 10000 }, (_, i) => `middle ${i}\n`).join('');
  const result = preview(`head\n${middle}old tail\nend\n`, `added\nhead\n${middle}new tail\nend\n`);
  expect(result.truncated).toBe(false);
  expect(result.text).toContain(' 1 +added\n');
  expect(result.text).not.toContain('-head');
  expect(result.text).toContain('10002 -old tail\n');
  expect(result.text).toContain('10003 +new tail\n');
  expect(result.text).toContain('10004  end\n');
  expectBounded(result.text);
});

test('very long Unicode lines are clipped independently without hiding the next edit', () => {
  const result = preview(
    `${'雪🙂'.repeat(100000)}old\nend\n`,
    `${'雪🙂'.repeat(100000)}new\nchanged\n`,
  );
  expect(result.truncated).toBe(true);
  expect(result.text).toContain('line truncated at 2048 UTF-16 units');
  expect(result.text).toContain(' 2 -end\n');
  expect(result.text).toContain(' 2 +changed\n');
  expectBounded(result.text);
});

test('byte and rendered line budgets stop replacement previews and content previews', () => {
  for (const line of ['short', '雪🙂'.repeat(600)]) {
    for (const before of [null, 'old\n'.repeat(10000)]) {
      const result = preview(before, `${line}\n`.repeat(10000));
      expect(result.truncated).toBe(true);
      expect(result.text).toContain('64 KiB / 400 line limit');
      expectBounded(result.text);
    }
  }
});

test('new and unchanged files retain distinct semantics including empty files', () => {
  const created = preview(null, 'new\n');
  expect(created.format).toBe('file_content');
  expect(created.text).toContain(' 1 +new\n');
  expect(created.truncated).toBe(false);
  const same = preview('new\n', 'new\n');
  expect(same.format).toBe('file_content');
  expect(same.text).toContain('content unchanged');
  expect(same.text).toContain(' 1  new\n');
  expect(same.text).not.toContain('+new');
  expect(preview(null, '').text).toContain('Wrote 0 lines');
  expect(preview('', '').text).toContain('content unchanged');
  expect(preview('', 'new\n').text).toContain(' 1 +new\n');
  expect(preview('old\n', '').text).toContain(' 1 -old\n');
  const largeSame = preview('same\n'.repeat(10000), 'same\n'.repeat(10000));
  expect(largeSame.truncated).toBe(true);
  expectBounded(largeSame.text);
});

test('terminal newline changes are explicit and CRLF and Unicode content are retained', () => {
  const result = preview('雪🙂\r\n', '雪🙂\r');
  expect(result.format).toBe('line_diff');
  expect(result.truncated).toBe(false);
  expect(result.text).toContain(' 1 -雪🙂\r\n');
  expect(result.text).toContain(' 1 +雪🙂\r\n');
  expect(result.text).toContain('\\ No newline at end of file');
  expectBounded(result.text);
});

test('long paths do not split surrogate pairs or bypass the rendered line budget', () => {
  const after = snapshot('body\n');
  after.path = `${'\n'.repeat(2047)}🙂suffix`;
  const result = fileChangePreview(null, after);
  expect(result.truncated).toBe(true);
  expect(result.text).toContain('[path truncated]');
  expectBounded(result.text);
});
