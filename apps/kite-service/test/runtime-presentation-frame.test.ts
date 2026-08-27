import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '../src/bootstrap/runtime/state-runtime';
import { RuntimePresentationFrame } from '../src/runtime-client/presentation-frame';

describe('Runtime presentation frame', () => {
  test('coalesces cumulative model packets in canonical reasoning-then-text order', () => {
    const frame = new RuntimePresentationFrame();
    const output: RuntimeEvent[] = [];
    const sink = (event: RuntimeEvent) => output.push(event);

    frame.push(
      { type: 'model.reasoning_delta', requestId: 'request-1', segmentId: 'segment-1', text: 'a' },
      sink,
    );
    frame.push(
      {
        type: 'model.reasoning_delta',
        requestId: 'request-1',
        segmentId: 'segment-1',
        text: 'a complete thought',
      },
      sink,
    );
    frame.push({ type: 'model.text_delta', requestId: 'request-1', text: 'first' }, sink);
    frame.push({ type: 'model.text_delta', requestId: 'request-1', text: 'first paragraph' }, sink);
    frame.flush();

    expect(output).toEqual([
      {
        type: 'model.reasoning_delta',
        requestId: 'request-1',
        segmentId: 'segment-1',
        text: 'a complete thought',
      },
      { type: 'model.text_delta', requestId: 'request-1', text: 'first paragraph' },
    ]);
  });

  test('flushes reasoning before completion and merges progress per tool stream', () => {
    const frame = new RuntimePresentationFrame();
    const output: RuntimeEvent[] = [];
    const sink = (event: RuntimeEvent) => output.push(event);
    frame.push(
      { type: 'model.reasoning_delta', requestId: 'request-1', segmentId: 'segment-1', text: 'x' },
      sink,
    );
    frame.push(
      {
        type: 'model.reasoning_completed',
        requestId: 'request-1',
        segmentId: 'segment-1',
        text: 'x',
      },
      sink,
    );
    frame.push(
      { type: 'tool.progress', toolCallId: 'tool-1', chunk: 'one', stream: 'stdout' },
      sink,
    );
    frame.push(
      { type: 'tool.progress', toolCallId: 'tool-1', chunk: 'two', stream: 'stdout' },
      sink,
    );
    frame.push(
      { type: 'tool.progress', toolCallId: 'tool-1', chunk: 'warning', stream: 'stderr' },
      sink,
    );
    frame.flush();

    expect(output).toEqual([
      { type: 'model.reasoning_delta', requestId: 'request-1', segmentId: 'segment-1', text: 'x' },
      {
        type: 'model.reasoning_completed',
        requestId: 'request-1',
        segmentId: 'segment-1',
        text: 'x',
      },
      {
        type: 'tool.progress',
        toolCallId: 'tool-1',
        chunk: 'one\ntwo',
        stream: 'stdout',
        lineCount: 2,
      },
      {
        type: 'tool.progress',
        toolCallId: 'tool-1',
        chunk: 'warning',
        stream: 'stderr',
        lineCount: 1,
      },
    ]);
  });
});
