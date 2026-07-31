import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import type { MutableRefObject } from 'react';
import CheckpointSelector from '../src/app/tui/components/CheckpointSelector';
import type { RewindScope } from '../src/app/tui/types';
import type { RuntimeSnapshotEntry } from '../src/core/runtime/store';

const checkpoints: RuntimeSnapshotEntry[] = [
  {
    snapshotId: 'turn-2c123456',
    eventPosition: 20647,
    createdAt: new Date(2026, 6, 30, 21, 3, 5).getTime() / 1000,
    targetMessage:
      '嗯，我觉得没啥问题，但是要注意的是，不能光支持流式输出，在 TUI 渲染时也要支持。',
    targetMessageCreatedAt: new Date(2026, 6, 30, 21, 3, 0).getTime() / 1000,
    affectedFileCount: 17,
  },
  {
    snapshotId: 'turn-d3f654321',
    eventPosition: 20495,
    createdAt: new Date(2026, 6, 30, 21, 2, 48).getTime() / 1000,
    targetMessage: '先提交这轮代码，然后出设计',
    targetMessageCreatedAt: new Date(2026, 6, 30, 21, 2, 43).getTime() / 1000,
    affectedFileCount: 0,
  },
];

describe('CheckpointSelector', () => {
  test('shows human-readable message boundaries instead of internal checkpoint metadata', () => {
    const { lastFrame } = render(
      <CheckpointSelector checkpoints={checkpoints} onConfirm={() => {}} onClose={() => {}} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('◆ Kite Code · 回退');
    expect(frame).toContain('嗯，我觉得没啥问题');
    expect(frame).toContain('先提交这轮代码，然后出设计');
    expect(frame).toContain('2026-07-30 21:03:00');
    expect(frame).toContain('17 个已记录文件');
    expect(frame).toContain('无已记录文件变更');
    expect(frame).not.toContain('事件 #');
    expect(frame).not.toContain('[turn-');
    expect(frame).not.toContain('more');
  });

  test('uses a safe confirmation step before executing a rewind', async () => {
    const confirmed: Array<{ checkpointId: string; scope: RewindScope }> = [];
    const layeredEscRef = { current: false } as MutableRefObject<boolean>;
    const { stdin, lastFrame } = render(
      <CheckpointSelector
        checkpoints={checkpoints}
        onConfirm={(checkpointId, scope) => confirmed.push({ checkpointId, scope })}
        onClose={() => {}}
        layeredEscRef={layeredEscRef}
      />,
    );

    stdin.write('\r');
    await Bun.sleep(10);

    const confirmFrame = lastFrame() ?? '';
    expect(confirmFrame).toContain('◆ Kite Code · 回退 · 确认');
    expect(confirmFrame).toContain('恢复到这条消息发送之前');
    expect(confirmFrame).toContain('❯ 返回检查点列表');
    expect(confirmFrame).toContain('恢复代码和会话');
    expect(confirmFrame).toContain('仅恢复会话');
    expect(confirmFrame).toContain('仅恢复代码');
    expect(layeredEscRef.current).toBe(true);

    // The default choice only returns to the list; two Enter presses cannot
    // accidentally mutate the workspace.
    stdin.write('\r');
    await Bun.sleep(10);
    expect(confirmed).toEqual([]);
    expect(lastFrame()).not.toContain('回退 · 确认');
    expect(layeredEscRef.current).toBe(false);
  });

  test('confirms the selected recovery scope and explains its impact', async () => {
    const confirmed: Array<{ checkpointId: string; scope: RewindScope }> = [];
    const { stdin, lastFrame } = render(
      <CheckpointSelector
        checkpoints={checkpoints}
        onConfirm={(checkpointId, scope) => confirmed.push({ checkpointId, scope })}
        onClose={() => {}}
      />,
    );

    stdin.write('\r');
    await Bun.sleep(10);
    stdin.write('\u001b[B');
    await Bun.sleep(10);

    const frame = lastFrame() ?? '';
    expect(frame).toContain('从此处创建新会话；当前会话保留');
    expect(frame).toContain('恢复 17 个已记录文件');
    expect(frame).toContain('冲突路径会跳过并提示');

    stdin.write('\r');
    stdin.write('\r');
    await Bun.sleep(10);
    expect(confirmed).toEqual([{ checkpointId: 'turn-2c123456', scope: 'code_and_conversation' }]);
  });

  test('Esc returns from confirmation before closing the overlay', async () => {
    let closed = 0;
    const { stdin, lastFrame } = render(
      <CheckpointSelector
        checkpoints={checkpoints}
        onConfirm={() => {}}
        onClose={() => {
          closed += 1;
        }}
      />,
    );

    stdin.write('\r');
    await Bun.sleep(10);
    stdin.write('\u001b');
    await Bun.sleep(100);

    expect(closed).toBe(0);
    expect(lastFrame()).not.toContain('回退 · 确认');

    stdin.write('\u001b');
    await Bun.sleep(100);
    expect(closed).toBe(1);
  });
});
