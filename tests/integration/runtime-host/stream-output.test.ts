import { describe, expect, test } from 'bun:test';
import {
  BoundedOutputBuffer,
  BoundedProgressLineBuffer,
  SHELL_CAPTURE_MAX_CHARS,
} from '@kite-ai/runtime-host';
import { readWithProgress } from '../../helpers/shell-executor';

describe('bounded shell output', () => {
  test('retains exact output below the capture limit', () => {
    const output = new BoundedOutputBuffer(16);
    output.append('hello');
    output.append(' world');

    expect(output.value()).toBe('hello world');
    expect(output.isTruncated).toBe(false);
  });

  test('retains a fixed-memory head and tail after the capture limit', () => {
    const output = new BoundedOutputBuffer(16);
    output.append('HEAD');
    output.append('x'.repeat(100));
    output.append('TAIL');

    expect(output.value()).toStartWith('HEAD');
    expect(output.value()).toEndWith('TAIL');
    expect(output.value()).toContain('92 chars omitted during shell capture');
    expect(output.isTruncated).toBe(true);
  });

  test('assembles logical lines across arbitrary chunks', () => {
    const lines: string[] = [];
    const progress = new BoundedProgressLineBuffer(32);

    progress.push('first par', (line) => lines.push(line));
    progress.push('t\nsecond\nthi', (line) => lines.push(line));
    progress.push('rd', (line) => lines.push(line));
    progress.flush((line) => lines.push(line));

    expect(lines).toEqual(['first part', 'second', 'third']);
  });

  test('normalizes CRLF without leaking carriage returns into progress', () => {
    const lines: string[] = [];
    const progress = new BoundedProgressLineBuffer();

    progress.push('one\r\ntwo\r', (line) => lines.push(line));
    progress.push('\n', (line) => lines.push(line));

    expect(lines).toEqual(['one', 'two']);
  });

  test('bounds an unterminated progress line while preserving its tail', () => {
    const lines: string[] = [];
    const progress = new BoundedProgressLineBuffer(8);
    progress.push(`HEAD${'x'.repeat(100)}TAIL`, (line) => lines.push(line));
    progress.flush((line) => lines.push(line));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toEndWith('xxxxTAIL');
    expect(lines[0]).toContain('earlier chars omitted');
    expect(lines[0]!.length).toBeLessThan(80);
  });

  test('readWithProgress retains a bounded preview and emits the complete UTF-8 output', async () => {
    const encoder = new TextEncoder();
    const longLine = `HEAD${'界'.repeat(SHELL_CAPTURE_MAX_CHARS)}TAIL`;
    const bytes = encoder.encode(`${longLine}\nlast`);
    const splitInsideUtf8 = 6;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, splitInsideUtf8));
        controller.enqueue(bytes.slice(splitInsideUtf8));
        controller.close();
      },
    });
    const chunks: string[] = [];

    const captured = await readWithProgress(stream, (chunk) => chunks.push(chunk));

    expect(captured).toStartWith('HEAD');
    expect(captured).toEndWith('\nlast');
    expect(captured).toContain('omitted during shell capture');
    expect(captured.length).toBeLessThanOrEqual(SHELL_CAPTURE_MAX_CHARS + 100);
    expect(chunks.join('')).toBe(`${longLine}\nlast`);
    expect(chunks.join('')).not.toContain('\ufffd');
  });

  test('a pre-aborted output read cancels the stream without waiting for data', async () => {
    let cancellations = 0;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancellations++;
      },
    });
    const controller = new AbortController();
    controller.abort();
    const chunks: string[] = [];
    expect(await readWithProgress(stream, (chunk) => chunks.push(chunk), controller.signal)).toBe(
      '',
    );
    expect(cancellations).toBe(1);
    expect(chunks).toEqual([]);
  });
});
