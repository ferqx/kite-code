import { describe, expect, test } from 'bun:test';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { useStaticContent } from '../src/tui/OutputArea';
import {
  advanceOutputBlockTimeline,
  canonicalRenderSerialization,
  projectApprovalViewport,
  projectOutputBlockTimeline,
  visualDigest,
} from '../src/tui/presentation/timeline';
import type { OutputBlock, Turn } from '../src/tui/types';

function makeTurn(ids: number[], kind: 'user' | 'text'): Turn {
  return {
    blocks: ids.map(
      (id): OutputBlock =>
        kind === 'user'
          ? { id, kind: 'user', content: `prompt ${id}`, presentationState: 'sealed' }
          : {
              id,
              kind: 'text',
              content: `response ${id} `.repeat(20),
              streaming: false,
              presentationState: 'sealed',
            },
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
  test('canonical visual digest is order independent and sensitive to every block field', () => {
    expect(canonicalRenderSerialization({ b: 2, a: 1 })).toBe(
      canonicalRenderSerialization({ a: 1, b: 2 }),
    );
    expect(canonicalRenderSerialization({ a: 1, optional: undefined })).toBe(
      canonicalRenderSerialization({ a: 1 }),
    );
    const base: OutputBlock = { id: 1, kind: 'text', content: 'same', streaming: false };
    expect(visualDigest(base)).not.toBe(visualDigest({ ...base, isError: true }));
    expect(visualDigest(base)).not.toBe(visualDigest({ ...base, thoughtContent: 'late thought' }));
  });

  test('advancing a sealed item never reopens it for a late packet', () => {
    const first: OutputBlock = {
      id: 1,
      kind: 'text',
      content: 'sealed',
      streaming: false,
      presentationState: 'sealed',
    };
    const previous = projectOutputBlockTimeline([first], 3);
    const next = advanceOutputBlockTimeline(previous, [{ ...first, content: 'late mutation' }], 3);
    expect(next.items[0]?.state).toBe('sealed');
    expect(next.items[0]?.renderModel.block).toBe(first);
    const nextItem = next.items[0];
    const previousItem = previous.items[0];
    if (nextItem?.state !== 'sealed' || previousItem?.state !== 'sealed') {
      throw new Error('Expected the timeline items to be sealed.');
    }
    expect(nextItem.visualDigest).toBe(previousItem.visualDigest);
  });

  test('live and replay projections converge on the same sealed digest', () => {
    const live = projectOutputBlockTimeline([
      {
        id: 1,
        kind: 'text',
        content: 'same answer',
        streaming: false,
        presentationState: 'sealed',
      },
    ]);
    const replay = projectOutputBlockTimeline([
      {
        presentationState: 'sealed',
        streaming: false,
        content: 'same answer',
        kind: 'text',
        id: 1,
      },
    ]);
    expect(live.items[0]?.state).toBe('sealed');
    expect(replay.items[0]?.state).toBe('sealed');
    const liveItem = live.items[0];
    const replayItem = replay.items[0];
    if (liveItem?.state !== 'sealed' || replayItem?.state !== 'sealed') {
      throw new Error('Expected sealed live and replay items.');
    }
    expect(liveItem.visualDigest).toBe(replayItem.visualDigest);
  });

  test('approval viewport frontier is projected from Timeline items', () => {
    const timeline = projectOutputBlockTimeline([
      { id: 1, kind: 'text', content: 'before', presentationState: 'sealed' },
      {
        id: 2,
        kind: 'tool_card',
        callId: 'tool-1',
        name: 'shell_execute',
        args: { command: 'waiting' },
        status: 'running',
        summary: '',
        presentationState: 'live',
      },
      {
        id: 3,
        kind: 'approval',
        approval: {
          scope: 'once',
          callId: 'tool-1',
          cwd: '/tmp',
          threadId: 'thread-1',
          tool: 'shell_execute',
          command: 'waiting',
          risk: 'execute_code',
          approvalHash: 'approval-1',
          summary: 'Approval required',
          reason: 'Test fixture',
          expectedEffects: [],
          grantOptions: ['approve_once'],
          recommendedGrant: 'approve_once',
        },
        presentationState: 'live',
      },
      { id: 4, kind: 'text', content: 'after', presentationState: 'live' },
    ]);
    const viewport = projectApprovalViewport(timeline.items, true);
    expect(viewport.visibleItems.map((item) => item.sourceIdentity.blockId)).toEqual([1, 2]);
    expect(viewport.hiddenItems.map((item) => item.sourceIdentity.blockId)).toEqual([3, 4]);
  });

  test('clear creates a new render epoch before a reused local block id can commit', () => {
    const first = makeTurn([1], 'text');
    const view = render(
      React.createElement(Harness, { turns: [first], running: false, sessionKey: 12 }),
    );
    const firstFrame = view.lastFrame() ?? '';
    view.rerender(React.createElement(Harness, { turns: [], running: false, sessionKey: 12 }));
    const clearedFrame = view.lastFrame() ?? '';
    view.rerender(
      React.createElement(Harness, {
        turns: [makeTurn([1], 'text')],
        running: false,
        sessionKey: 12,
      }),
    );
    const nextFrame = view.lastFrame() ?? '';
    expect(clearedFrame).not.toBe(firstFrame);
    expect(nextFrame).toMatch(/key=s-12-.*-e/);
    view.unmount();
  });

  test('promotes finalized response text before later local commands', () => {
    const runningTurn: Turn = {
      blocks: [
        { id: 1, kind: 'user', content: '你好', presentationState: 'live' },
        {
          id: 2,
          kind: 'text',
          content: '你好！',
          streaming: true,
          presentationState: 'live',
        },
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
        { ...runningTurn.blocks[0]!, presentationState: 'sealed' },
        { ...runningTurn.blocks[1]!, streaming: false, presentationState: 'sealed' } as OutputBlock,
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
        { id: 3, kind: 'user', content: '/status', presentationState: 'sealed' },
        {
          id: 4,
          kind: 'text',
          content: 'Service PID: 42',
          streaming: false,
          presentationState: 'sealed',
        },
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
    live.blocks[1] = {
      ...live.blocks[1]!,
      streaming: true,
      presentationState: 'live',
    } as OutputBlock;
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
