import { describe, expect, test } from 'bun:test';
import { readWithProgress } from '../src/core/tools/shell';
import {
  BoundedOutputBuffer,
  BoundedProgressLineBuffer,
  SHELL_CAPTURE_MAX_CHARS,
  SHELL_PROGRESS_LINE_MAX_CHARS,
} from '../src/core/tools/stream-output';

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

  test('readWithProgress drains large output with bounded capture and progress', async () => {
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
    const lines: string[] = [];

    const captured = await readWithProgress(stream, (line) => lines.push(line));

    expect(captured).toStartWith('HEAD');
    expect(captured).toEndWith('\nlast');
    expect(captured).toContain('omitted during shell capture');
    expect(captured.length).toBeLessThanOrEqual(SHELL_CAPTURE_MAX_CHARS + 100);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEndWith('TAIL');
    expect(lines[0]!.length).toBeLessThanOrEqual(SHELL_PROGRESS_LINE_MAX_CHARS + 100);
    expect(lines[1]).toBe('last');
  });
});
