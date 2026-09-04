import { describe, expect, test } from 'bun:test';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { useStaticContent } from '../src/tui/OutputArea';
import type { OutputBlock, Turn } from '../src/tui/types';

function makeTurn(ids: number[], kind: 'user' | 'text'): Turn {
  return {
    blocks: ids.map(
      (id): OutputBlock =>
        kind === 'user'
          ? { id, kind: 'user', content: `prompt ${id}` }
          : { id, kind: 'text', content: `response ${id} `.repeat(20), streaming: false },
    ),
  };
}

function Harness({
  turns,
  running,
  sessionKey,
  presentationKey,
}: {
  turns: Turn[];
  running: boolean;
  sessionKey: number;
  presentationKey?: string;
}) {
  const result = useStaticContent({
    turns,
    running,
    sessionKey,
    presentationKey,
    header: React.createElement(Text, null, 'HEADER'),
  });
  const summary =
    `key=${result.staticKey}` +
    `|static=${result.mergedStaticBlocks.length}` +
    `|dynamic=${result.activeDynamicBlocks.length}` +
    `|staticIds=${result.mergedStaticBlocks.map((b) => b.id).join(',')}` +
    `|dynamicIds=${result.activeDynamicBlocks.map((b) => b.id).join(',')}`;
  return React.createElement(Text, null, summary);
}

describe('useStaticContent session remount promotion', () => {
  test('promotes finalized response text before later local commands', () => {
    const runningTurn: Turn = {
      blocks: [
        { id: 1, kind: 'user', content: '你好' },
        { id: 2, kind: 'text', content: '你好！', streaming: true },
      ],
    };
    const view = render(
      React.createElement(Harness, {
        turns: [runningTurn],
        running: true,
        sessionKey: 6,
      }),
    );

    const completedTurn: Turn = {
      blocks: [
        runningTurn.blocks[0]!,
        { ...runningTurn.blocks[1]!, streaming: false } as OutputBlock,
      ],
    };
    view.rerender(
      React.createElement(Harness, {
        turns: [completedTurn],
        running: false,
        sessionKey: 6,
      }),
    );
    expect(view.lastFrame()).toContain('staticIds=1,2');
    expect(view.lastFrame()).toContain('dynamicIds=');

    const localCommandTurn: Turn = {
      blocks: [
        ...completedTurn.blocks,
        { id: 3, kind: 'user', content: '/status' },
        { id: 4, kind: 'text', content: 'Service PID: 42', streaming: false },
      ],
    };
    view.rerender(
      React.createElement(Harness, {
        turns: [localCommandTurn],
        running: false,
        sessionKey: 6,
      }),
    );

    const frame = view.lastFrame();
    expect(frame).toContain('staticIds=1,2,3,4');
    expect(frame).toContain('dynamicIds=');
  });

  test('single-turn idle session is fully promoted to Static after remount', async () => {
    const turns = [makeTurn([1, 2], 'text')];
    const { lastFrame } = render(
      React.createElement(Harness, { turns, running: false, sessionKey: 7 }),
    );
    const frame = lastFrame();
    expect(frame).toContain('static=2');
    expect(frame).toContain('dynamic=0');
    expect(frame).toContain('staticIds=1,2');
  });

  test('multi-turn idle session is fully promoted to Static after remount', async () => {
    const turns = [makeTurn([1, 2], 'text'), makeTurn([3, 4], 'text')];
    const { lastFrame } = render(
      React.createElement(Harness, { turns, running: false, sessionKey: 8 }),
    );
    const frame = lastFrame();
    expect(frame).toContain('static=4');
    expect(frame).toContain('dynamic=0');
  });

  test('running session still promotes text whose response owner is final', async () => {
    const turns = [makeTurn([1, 2], 'text'), makeTurn([3, 4], 'text')];
    const { lastFrame } = render(
      React.createElement(Harness, { turns, running: true, sessionKey: 9 }),
    );
    const frame = lastFrame();
    expect(frame).toContain('static=4');
    expect(frame).toContain('dynamic=0');
  });

  test('running session promotes only the completed prefix before a streaming tail', async () => {
    const live = makeTurn([3, 4], 'text');
    live.blocks[1] = { ...live.blocks[1]!, streaming: true } as OutputBlock;
    const turns = [makeTurn([1, 2], 'text'), live];
    const { lastFrame } = render(
      React.createElement(Harness, { turns, running: true, sessionKey: 10 }),
    );
    const frame = lastFrame();
    expect(frame).toContain('static=3');
    expect(frame).toContain('dynamic=1');
    expect(frame).toContain('staticIds=1,2,3');
    expect(frame).toContain('dynamicIds=4');
  });

  test('changes the Static identity when the presentation language changes', () => {
    const turns = [makeTurn([1, 2], 'text')];
    const view = render(
      React.createElement(Harness, {
        turns,
        running: false,
        sessionKey: 11,
        presentationKey: 'en-US',
      }),
    );
    expect(view.lastFrame()).toContain('key=s-11-en-US');

    view.rerender(
      React.createElement(Harness, {
        turns,
        running: false,
        sessionKey: 11,
        presentationKey: 'zh-CN',
      }),
    );
    expect(view.lastFrame()).toContain('key=s-11-zh-CN');
  });
});
