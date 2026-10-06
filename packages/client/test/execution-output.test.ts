import { expect, test } from 'bun:test';
import { type ExecutionOutputPage, ExecutionOutputPages } from '../src';

const row = (
  seq: string,
  stream: 'stdout' | 'stderr' | 'progress' = 'stdout',
  patch: Partial<ExecutionOutputPage['items'][number]> = {},
) => ({
  executionId: 'job',
  seq,
  throughSeq: seq,
  stream,
  content: `原内容🙂 ${seq}\n`,
  droppedBytes: '0',
  ...patch,
});

test('fixed output upper preserves private additive values and complete cross-stream gap facts beyond Number precision', () => {
  const read = new ExecutionOutputPages('job');
  const first = {
    highWaterSeq: '9007199254740995',
    future: { nested: ['原字段'] },
    items: [
      row('1', 'stdout', { throughSeq: '9007199254740992', content: '', droppedBytes: '123' }),
      row('2', 'stderr'),
    ],
  };
  const saved = read.accept(first);
  expect(saved).toEqual(first);
  first.items[1]!.content = '后来修改';
  first.future.nested[0] = '后来修改';
  expect(saved.items[1]!.content).toContain('原内容🙂');
  expect((saved as typeof first).future.nested[0]).toBe('原字段');
  expect(read.afterSeq).toBe('9007199254740992');
  expect(read.complete).toBe(false);
  const last = read.accept({
    highWaterSeq: '9007199254741000',
    items: [
      row('9007199254740993', 'stderr', {
        throughSeq: '9007199254740995',
        content: '',
        droppedBytes: null,
      }),
      row('9007199254740994', 'stdout'),
    ],
  });
  expect(last.items).toHaveLength(2);
  expect(last.items[0]!.droppedBytes).toBeNull();
  expect(last.items[1]!.content).toContain('原内容🙂');
  expect(read.afterSeq).toBe('9007199254740995');
  expect(read.upperSeq).toBe('9007199254740995');
  expect(read.complete).toBe(true);
  expect(() => read.accept(last)).toThrow('execution_output_page_conflict');
});

test('malformed interval coverage, same-stream overlap, duplicate ordinary seq and wrong Job cannot complete a prefix', () => {
  for (const items of [
    [row('2')],
    [row('1', 'stdout', { executionId: 'foreign' })],
    [row('1', 'stdout', { throughSeq: '4' })],
    [row('1', 'stdout', { throughSeq: '2', content: '', droppedBytes: '0' })],
    [row('1', 'stdout', { droppedBytes: null })],
    [row('1', 'stdout', { throughSeq: '2', content: '', droppedBytes: '1' }), row('2')],
    [row('1'), row('1', 'stderr')],
    [row('01')],
    [row('9223372036854775808')],
  ]) {
    const read = new ExecutionOutputPages('job');
    expect(() => read.accept({ items, highWaterSeq: '3' })).toThrow();
    expect(read.complete).toBe(false);
    expect(read.afterSeq).toBe('0');
  }
  const read = new ExecutionOutputPages('job');
  read.accept({ items: [row('1')], highWaterSeq: '3' });
  expect(() => read.accept({ items: [], highWaterSeq: '3' })).toThrow(
    'execution_output_page_conflict',
  );
  expect(() => read.accept({ items: [row('2')], highWaterSeq: '2' })).toThrow(
    'execution_output_page_conflict',
  );
  expect(read.afterSeq).toBe('1');
  expect(read.complete).toBe(false);
});

test('empty saved output is complete only at zero and an externally frozen first upper survives a smaller transport retry', () => {
  const empty = new ExecutionOutputPages('job');
  expect(empty.accept({ items: [], highWaterSeq: '0' })).toEqual({ items: [], highWaterSeq: '0' });
  expect(empty.complete).toBe(true);
  const fixed = new ExecutionOutputPages('job', '2');
  fixed.accept({ items: [row('1')], highWaterSeq: '9' });
  expect(fixed.upperSeq).toBe('2');
  fixed.accept({ items: [row('2')], highWaterSeq: '11' });
  expect(fixed.complete).toBe(true);
  expect(fixed.afterSeq).toBe('2');
});
