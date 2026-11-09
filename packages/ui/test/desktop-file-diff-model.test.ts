import { expect, test } from 'bun:test';
import {
  DIFF_LINE_UNITS,
  DIFF_PREVIEW_ROWS,
  fileDiffRows,
  parseFileDiff,
} from '../src/desktop/file-diff-model';

test('numbered operation previews preserve the producer positions without guessing old context numbers', () => {
  const model = parseFileDiff(
    [
      'Line diff (bounded alignment; unchanged gaps omitted)',
      ' 7  const unchanged = true;',
      ' 8 -old one',
      ' 9 -old two',
      ' 8 +new one',
      ' 9 +new two',
      '10 +extra',
      '11  tail',
      '... unchanged lines omitted ...',
      '99 -old remote',
      '100 +new remote',
    ].join('\n'),
    'src/a.ts',
  );
  expect(model.format).toBe('operation');
  expect(model.added).toBe(4);
  expect(model.removed).toBe(3);
  expect(model.split[1]).toMatchObject({
    kind: 'context',
    before: { number: undefined },
    after: { number: 7 },
  });
  expect(model.split[2]).toMatchObject({
    kind: 'change',
    before: { number: 8, text: 'old one' },
    after: { number: 8, text: 'new one' },
  });
  expect(model.split[3]).toMatchObject({ before: { number: 9 }, after: { number: 9 } });
  expect(model.split[4]).toMatchObject({ before: undefined, after: { number: 10 } });
  expect(model.split[5]).toMatchObject({
    kind: 'context',
    before: { number: undefined },
    after: { number: 11 },
  });
  expect(model.omitted).toBe(true);
  expect(fileDiffRows(model.split, new Set()).filter((row) => row.kind === 'fold')).toHaveLength(0);
});

test('Git hunk headers drive distinct old/new numbering, header paths and renames stay metadata', () => {
  const model = parseFileDiff(
    [
      'diff --git "a/old name.ts" "b/new name.ts"',
      'similarity index 80%',
      'rename from old name.ts',
      'rename to new name.ts',
      '--- "a/old name.ts"',
      '+++ "b/new name.ts"',
      '@@ -10,3 +12,4 @@ function heading()',
      ' context',
      '-old one',
      '-old two',
      '+new one',
      '+new two',
      '+new three',
      '@@ -40 +43 @@',
      '-last',
      '+tail',
      '\\ No newline at end of file',
    ].join('\n'),
    'new name.ts',
  );
  expect(model.format).toBe('git');
  expect(model.split.slice(0, 7).every((row) => row.kind === 'meta')).toBe(true);
  expect(model.split[7]).toMatchObject({ before: { number: 10 }, after: { number: 12 } });
  expect(model.split[8]).toMatchObject({ before: { number: 11 }, after: { number: 13 } });
  expect(model.split[10]).toMatchObject({ before: undefined, after: { number: 15 } });
  expect(model.split[12]).toMatchObject({ before: { number: 40 }, after: { number: 43 } });
  expect(model.added).toBe(4);
  expect(model.removed).toBe(3);
  expect(model.unified.at(-1)).toMatchObject({
    kind: 'meta',
    text: '\\ No newline at end of file',
  });
});

test('Git additions/deletions and exhausted or malformed hunks never invent positions', () => {
  const added = parseFileDiff('--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n+outside');
  expect(added.added).toBe(2);
  expect(added.split.at(-1)).toEqual({ kind: 'meta', text: '+outside' });
  const removed = parseFileDiff('@@ -1,2 +0,0 @@\n-one\n-two');
  expect(removed.removed).toBe(2);
  expect(removed.added).toBe(0);
  const malformed = parseFileDiff('@@ -9007199254740990,2 +1,2 @@\n-unknown\n+unknown');
  expect(malformed.added).toBe(0);
  expect(malformed.removed).toBe(0);
  expect(malformed.split.every((row) => row.kind === 'meta')).toBe(true);
});

test('write receipts, unchanged bodies and unknown legacy text keep honest counts', () => {
  const write = parseFileDiff('Wrote 2 lines to new.ts\n 1 +one\n 2 +two');
  expect(write.added).toBe(2);
  const unchanged = parseFileDiff('Wrote 2 lines to a.ts (content unchanged)\n 1  one\n 2  two');
  expect(unchanged.added).toBe(0);
  expect(unchanged.split[1]).toMatchObject({
    before: { text: 'one', number: undefined },
    after: { number: 1 },
  });
  const unknown = parseFileDiff('--- before\n+++ after\n-old\n+new\n<script>alert(1)</script>');
  expect(unknown.format).toBe('plain');
  expect(unknown.added).toBe(0);
  expect(unknown.removed).toBe(0);
  expect(unknown.split.at(-1)).toEqual({ kind: 'raw', text: '<script>alert(1)</script>' });
});

test('byte, row and UTF-16 limits are independent and never split surrogate pairs', () => {
  const byteLimited = parseFileDiff(`1 +${'🙂'.repeat(40_000)}`);
  expect(byteLimited.truncated).toBe(true);
  const row = byteLimited.split[0]!;
  expect(row.kind).toBe('change');
  if (row.kind === 'change') {
    expect(row.after!.text.length).toBeLessThanOrEqual(DIFF_LINE_UNITS);
    expect(row.after!.text).not.toMatch(/[\uD800-\uDBFF]…$/);
    expect(row.after!.text).not.toContain('\uFFFD');
  }
  const multiByte = parseFileDiff(
    Array.from({ length: 400 }, (_, i) => `${i + 1} +${'漢'.repeat(100)}`).join('\n'),
  );
  expect(multiByte.unified.length).toBeLessThan(220);
  expect(multiByte.truncated).toBe(true);
  const lines = parseFileDiff('1 +x\n'.repeat(100_000));
  expect(lines.unified).toHaveLength(DIFF_PREVIEW_ROWS);
  expect(lines.truncated).toBe(true);
  const exact = parseFileDiff('1 +x\n'.repeat(400));
  expect(exact.truncated).toBe(false);
  expect(exact.unified).toHaveLength(400);
});

test('producer truncation markers survive as notices, never as expandable context', () => {
  for (const source of [
    'Line diff (bounded alignment; unchanged gaps omitted)\n1 +x\n... preview truncated (64 KiB / 400 line limit) ...',
    'Wrote 1 lines to a.ts\n1 +x … [line truncated at 2048 UTF-16 units]',
  ]) {
    const model = parseFileDiff(source);
    expect(model.truncated).toBe(true);
    expect(fileDiffRows(model.split, new Set()).some((row) => row.kind === 'fold')).toBe(false);
  }
});

test('folding only retained context expands to at most 400 rows in either layout', () => {
  const source = [
    '@@ -1,399 +1,399 @@',
    ...Array.from({ length: 399 }, (_, i) => ` line ${i}`),
  ].join('\n');
  const model = parseFileDiff(source);
  for (const layout of ['split', 'unified'] as const) {
    const collapsed = fileDiffRows(model[layout], new Set());
    const fold = collapsed.find((row) => row.kind === 'fold');
    expect(fold).toMatchObject({ kind: 'fold', count: 393 });
    if (fold?.kind !== 'fold') throw new Error('missing_fold');
    const expanded = fileDiffRows(model[layout], new Set([fold.id]));
    expect(expanded).toHaveLength(400);
    expect(expanded.some((row) => row.kind === 'fold')).toBe(false);
    expect(fileDiffRows(model[layout], new Set())).toEqual(collapsed);
  }
});

test('syntax work and DOM span budget remain bounded and unknown languages stay plain', () => {
  const body = Array.from(
    { length: 399 },
    (_, i) => `${i + 1}  ${'const A = "x"; '.repeat(8)}`,
  ).join('\n');
  const model = parseFileDiff(body, 'src/a.ts');
  let spans = 0;
  for (const row of model.split) {
    if (row.kind === 'context' || row.kind === 'change') {
      for (const line of [row.before, row.after]) {
        if (!line) continue;
        expect(line.tokens.length).toBeLessThanOrEqual(48);
        expect(line.tokens.map((token) => token.text).join('')).toBe(line.text);
        spans += line.tokens.filter((token) => token.kind).length;
      }
    }
  }
  expect(spans).toBeLessThanOrEqual(2048);
  const plain = parseFileDiff('1 +const A = "x";', 'text.unknown');
  expect(plain.split[0]).toMatchObject({ after: { tokens: [{ text: 'const A = "x";' }] } });
});

test('rename-only and mode-only Git patches retain paths without pretending headers changed file lines', () => {
  const model = parseFileDiff(
    'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\nold mode 100644\nnew mode 100755',
  );
  expect(model.format).toBe('git');
  expect(model.added).toBe(0);
  expect(model.removed).toBe(0);
  expect(model.split.every((row) => row.kind === 'meta')).toBe(true);
  expect(model.split[2]).toEqual({ kind: 'meta', text: 'rename from old.ts' });
  expect(model.split[3]).toEqual({ kind: 'meta', text: 'rename to new.ts' });
});

test('a full 2048-unit code line is not reported as omitted just because its gutter has digits', () => {
  const text = 'a'.repeat(2048);
  const operation = parseFileDiff(`123 +${text}`);
  const git = parseFileDiff(`@@ -0,0 +123 @@\n+${text}`);
  for (const model of [operation, git]) {
    expect(model.truncated).toBe(false);
    expect(model.split.at(-1)).toMatchObject({ after: { text } });
  }
  expect(parseFileDiff(`123 +${text}x`).truncated).toBe(true);
});
