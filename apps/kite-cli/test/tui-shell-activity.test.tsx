import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import OutputArea from '../src/tui/OutputArea';
import type { OutputBlock } from '../src/tui/types';

type Shell = Extract<OutputBlock, { kind: 'tool_card' }>;
function shell(id: number, label: string, status: Shell['status'], startedAt?: number): Shell {
  return {
    id,
    kind: 'tool_card',
    callId: label,
    name: 'shell_execute',
    args: { command: label },
    preview: label,
    status,
    summary: '',
    startedAt,
    presentationState: status === 'done' ? 'sealed' : 'live',
  };
}

test('staggered approved shells share animation phase but retain their own execution clocks', async () => {
  const first = shell(1, 'FIRST', 'running', Date.now() - 10_000);
  const secondQueued = shell(2, 'SECOND', 'queued');
  const thirdQueued = shell(3, 'THIRD', 'queued');
  const area = (blocks: OutputBlock[]) => (
    <OutputArea
      activeDynamicBlocks={blocks}
      mergedStaticBlocks={[]}
      columns={80}
      rows={40}
      awaitingApproval
      overlayActive
      onToggleReason={() => {}}
    />
  );
  const view = render(area([first, secondQueued, thirdQueued]));
  try {
    expect(view.lastFrame()).toContain('○ Bash SECOND (queued)');
    expect(view.lastFrame()).toContain('○ Bash THIRD (queued)');
    expect(view.lastFrame()).not.toContain('awaiting approval');
    const before = view.frames.length;
    await Bun.sleep(650);
    expect(view.frames.length).toBeGreaterThan(before);

    const second = shell(2, 'SECOND', 'running', Date.now());
    view.rerender(area([first, second, thirdQueued]));
    const phases = new Set<string>();
    for (let sample = 0; sample < 6; sample++) {
      await Bun.sleep(250);
      const frame = view.lastFrame() ?? '';
      const a = frame.match(/^(● | {2})Bash FIRST \((\d+)s\)/m);
      const b = frame.match(/^(● | {2})Bash SECOND \((\d+)s\)/m);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a![1]).toBe(b![1]);
      phases.add(a![1]!);
      expect(Number(a![2]) - Number(b![2])).toBeGreaterThanOrEqual(9);
      expect(frame).toContain('○ Bash THIRD (queued)');
    }
    expect(phases.size).toBe(2);

    view.rerender(
      area([
        { ...first, status: 'done', elapsedMs: 12_000, summary: 'Completed' },
        second,
        thirdQueued,
      ]),
    );
    const runningFrames = view.frames.length;
    await Bun.sleep(600);
    expect(view.frames.length).toBeGreaterThan(runningFrames);
    expect(view.lastFrame()).toContain('Bash SECOND');
    expect(view.lastFrame()).toContain('○ Bash THIRD (queued)');
  } finally {
    view.unmount();
  }
});
