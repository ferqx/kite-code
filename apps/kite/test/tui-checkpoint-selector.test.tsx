import { describe, expect, test } from 'bun:test';
import type { RuntimeCheckpointEntry as RuntimeSnapshotEntry } from '@kite-ai/runtime-host/storage';
import { render } from 'ink-testing-library';
import type { MutableRefObject } from 'react';
import type { FileRestorePreview } from '../src/bootstrap/runtime/file-checkpoints';
import CheckpointSelector from '../src/tui/components/CheckpointSelector';
import type { RewindScope } from '../src/tui/types';

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

const filePreview: FileRestorePreview = {
  files: [
    { path: 'types.ts', addedLines: 881, removedLines: 3921 },
    { path: 'config.ts', addedLines: 2, removedLines: 1 },
  ],
  lineStatsAvailable: true,
  addedLines: 883,
  removedLines: 3922,
  conflictCount: 1,
  failureCount: 0,
};

const noChangePreview: FileRestorePreview = {
  files: [],
  lineStatsAvailable: true,
  addedLines: 0,
  removedLines: 0,
  conflictCount: 0,
  failureCount: 0,
};

describe('CheckpointSelector', () => {
  test('shows human-readable message boundaries instead of internal checkpoint metadata', () => {
    const { lastFrame } = render(
      <CheckpointSelector checkpoints={checkpoints} onConfirm={() => {}} onClose={() => {}} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('── Rewind');
    expect(frame).not.toContain('◆ Kite Code');
    expect(frame).toContain('嗯，我觉得没啥问题');
    expect(frame).toContain('先提交这轮代码，然后出设计');
    expect(frame).toContain('Jul 30, 2026');
    expect(frame).toContain('17 recorded files');
    expect(frame).toContain('No recorded file changes');
    expect(frame).not.toContain('事件 #');
    expect(frame).not.toContain('[turn-');
    expect(frame).not.toContain('more');
  });

  test('uses a confirmation step before executing a rewind', async () => {
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
    expect(confirmFrame).toContain('── Rewind · Before this message');
    expect(confirmFrame).not.toContain('恢复到这条消息发送之前');
    expect(confirmFrame).toContain('❯ Restore code and conversation');
    expect(confirmFrame).toContain('Restore conversation only');
    expect(confirmFrame).toContain('Restore code only');
    expect(confirmFrame).toContain(
      'A new session will be created and recorded workspace files restored. This session is kept.',
    );
    expect(confirmFrame).not.toContain('返回检查点列表');
    expect(layeredEscRef.current).toBe(true);

    // Enter from the list only opens the confirmation step. The second Enter
    // confirms the default recovery scope.
    expect(confirmed).toEqual([]);
    stdin.write('\r');
    await Bun.sleep(10);
    expect(confirmed).toEqual([{ checkpointId: 'turn-2c123456', scope: 'code_and_conversation' }]);
    expect(layeredEscRef.current).toBe(true);
  });

  test('previews the selected recovery scope without a static impact summary', async () => {
    const confirmed: Array<{ checkpointId: string; scope: RewindScope }> = [];
    const { stdin, lastFrame } = render(
      <CheckpointSelector
        checkpoints={checkpoints}
        onConfirm={(checkpointId, scope) => confirmed.push({ checkpointId, scope })}
        onClose={() => {}}
        getRewindPreview={() => filePreview}
      />,
    );

    stdin.write('\r');
    await Bun.sleep(10);

    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('影响');
    expect(frame).not.toContain('尚未执行');
    expect(frame).not.toContain('将创建一个新会话；当前会话保留。');
    expect(frame).toContain('Code will restore +883 −3922 across types.ts and 1 more files.');
    expect(frame).toContain('Skip 1 files changed after this checkpoint.');
    expect(frame).not.toContain('只恢复 Kite Code 已记录');

    stdin.write('\r');
    await Bun.sleep(10);
    expect(confirmed).toEqual([{ checkpointId: 'turn-2c123456', scope: 'code_and_conversation' }]);
  });

  test('hides the preview when code-only recovery would make no change', async () => {
    const { stdin, lastFrame } = render(
      <CheckpointSelector
        checkpoints={checkpoints}
        onConfirm={() => {}}
        onClose={() => {}}
        getRewindPreview={() => noChangePreview}
      />,
    );

    stdin.write('\r');
    await Bun.sleep(10);
    stdin.write('\u001b[B');
    await Bun.sleep(10);
    stdin.write('\u001b[B');
    await Bun.sleep(10);

    const frame = lastFrame() ?? '';
    expect(frame).toContain('❯ Restore code only');
    expect(frame).not.toContain('会话将保持不变。');
    expect(frame).not.toContain('代码将保持不变。');
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
    expect(lastFrame()).not.toContain('Rewind · Before this message');

    stdin.write('\u001b');
    await Bun.sleep(100);
    expect(closed).toBe(1);
  });
});
