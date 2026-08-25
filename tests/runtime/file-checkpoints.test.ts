// ── ADR-0025 §4：文件原像恢复测试 / file pre-image restore tests ──
// 验证 restoreFilesToCheckpoint 将工作区文件恢复到命名检查点时刻的状态。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite/agent-kernel';
import { workspaceFilesystemContentHash as fileContentHash } from '@kite/builtin-runtime/filesystem';
import { createRuntimeHostStateInitialState } from '@kite/runtime-host/kernel-adapter';
import {
  createFilePreimageRecorder,
  previewFilesToCheckpoint,
  restoreFilesToCheckpoint,
} from '../../apps/kite/src/bootstrap/runtime/file-checkpoints';
import type { StateRuntimeStorage } from '../../apps/kite/src/bootstrap/runtime/state-runtime';
import {
  openStateStoreForTest,
  type TestRuntimeStore,
} from '../../scripts/support/runtime-storage';

let root: string;
let workspace: string;
let store: TestRuntimeStore<RuntimeEvent, ReturnType<typeof createRuntimeHostStateInitialState>>;
let revisions: Map<string, number>;

beforeEach(() => {
  root = mkdtempSync(join(process.cwd(), '.file-checkpoints-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  store = openStateStoreForTest(join(root, 'checkpoints.runtime.db'));
  revisions = new Map();
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function appendEvent(threadId: string, toolCallId: string): void {
  const revision = (revisions.get(threadId) ?? 0) + 1;
  revisions.set(threadId, revision);
  store.appendEventsAndSnapshot(
    threadId,
    [{ type: 'tool.started', toolCallId } as RuntimeEvent],
    { ...snapshotFor(threadId), revision },
    [{ eventId: `${threadId}-event-${revision}`, revision }],
  );
}

function snapshotFor(threadId: string): ReturnType<typeof createRuntimeHostStateInitialState> {
  return {
    ...createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId,
      userId: 'test',
      workspace,
    }),
    revision: revisions.get(threadId) ?? 0,
  };
}

describe('restoreFilesToCheckpoint', () => {
  test('previews exact line changes and the most affected path before restoring', () => {
    writeFileSync(join(workspace, 'notes.md'), 'before\nkeep\n', 'utf8');
    appendEvent('th-preview', 'a');
    store.saveNamedSnapshot('th-preview', 'cp', snapshotFor('th-preview'));

    appendEvent('th-preview', 'turn-2-tool');
    store.recordFilePreimage('th-preview', 'notes.md', 'before\nkeep\n', true);
    store.recordFilePreimage('th-preview', 'scratch.md', null, false);
    writeFileSync(join(workspace, 'notes.md'), 'after\nkeep\nextra\n', 'utf8');
    writeFileSync(join(workspace, 'scratch.md'), 'scratch\n', 'utf8');
    store.recordFilePostimage(
      'th-preview',
      'notes.md',
      fileContentHash('after\nkeep\nextra\n'),
      true,
    );
    store.recordFilePostimage('th-preview', 'scratch.md', fileContentHash('scratch\n'), true);

    expect(previewFilesToCheckpoint(store, 'th-preview', 'cp', workspace)).toEqual({
      files: [
        { path: 'notes.md', addedLines: 1, removedLines: 2 },
        { path: 'scratch.md', addedLines: 0, removedLines: 1 },
      ],
      lineStatsAvailable: true,
      addedLines: 1,
      removedLines: 3,
      conflictCount: 0,
      failureCount: 0,
    });
  });

  test('excludes manually changed files from the restore preview', () => {
    writeFileSync(join(workspace, 'notes.md'), 'before\n', 'utf8');
    appendEvent('th-preview-conflict', 'a');
    store.saveNamedSnapshot('th-preview-conflict', 'cp', snapshotFor('th-preview-conflict'));
    appendEvent('th-preview-conflict', 'turn-2-tool');
    store.recordFilePreimage('th-preview-conflict', 'notes.md', 'before\n', true);
    writeFileSync(join(workspace, 'notes.md'), 'manual\n', 'utf8');
    store.recordFilePostimage('th-preview-conflict', 'notes.md', fileContentHash('kite\n'), true);

    expect(previewFilesToCheckpoint(store, 'th-preview-conflict', 'cp', workspace)).toEqual({
      files: [],
      lineStatsAvailable: true,
      addedLines: 0,
      removedLines: 0,
      conflictCount: 1,
      failureCount: 0,
    });
  });

  test('restores overwritten files and deletes files created after the checkpoint', () => {
    writeFileSync(join(workspace, 'notes.md'), 'v1 content\n', 'utf8');
    appendEvent('th', 'a');
    store.saveNamedSnapshot('th', 'cp', snapshotFor('th'));

    // 模拟后续 turn 的写入：新 turn 事件推进位置，然后覆写 notes.md、新建 scratch.md
    appendEvent('th', 'turn-2-tool');
    store.recordFilePreimage('th', 'notes.md', 'v1 content\n', true);
    store.recordFilePreimage('th', 'scratch.md', null, false);
    writeFileSync(join(workspace, 'notes.md'), 'v2 content\n', 'utf8');
    writeFileSync(join(workspace, 'scratch.md'), 'scratch\n', 'utf8');
    store.recordFilePostimage('th', 'notes.md', fileContentHash('v2 content\n'), true);
    store.recordFilePostimage('th', 'scratch.md', fileContentHash('scratch\n'), true);

    const outcome = restoreFilesToCheckpoint(store, 'th', 'cp', workspace);

    expect(outcome.restored).toEqual(['notes.md']);
    expect(outcome.deleted).toEqual(['scratch.md']);
    expect(outcome.failed).toEqual([]);
    expect(outcome.conflicts).toEqual([]);
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('v1 content\n');
    expect(existsSync(join(workspace, 'scratch.md'))).toBe(false);
  });

  test('protects a file that was removed after the last Kite write', () => {
    mkdirSync(join(workspace, 'src', 'deep'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'deep', 'app.ts'), 'old\n', 'utf8');
    appendEvent('th-nested', 'a');
    store.saveNamedSnapshot('th-nested', 'cp', snapshotFor('th-nested'));

    appendEvent('th-nested', 'turn-2-tool');
    store.recordFilePreimage('th-nested', 'src/deep/app.ts', 'old\n', true);
    writeFileSync(join(workspace, 'src', 'deep', 'app.ts'), 'kite\n', 'utf8');
    store.recordFilePostimage('th-nested', 'src/deep/app.ts', fileContentHash('kite\n'), true);
    rmSync(join(workspace, 'src'), { recursive: true, force: true });

    const outcome = restoreFilesToCheckpoint(store, 'th-nested', 'cp', workspace);

    expect(outcome.restored).toEqual([]);
    expect(outcome.conflicts).toEqual([
      { path: 'src/deep/app.ts', reason: 'modified_after_kite_write' },
    ]);
    expect(existsSync(join(workspace, 'src', 'deep', 'app.ts'))).toBe(false);
  });

  test('returns an empty outcome for an unknown checkpoint', () => {
    const outcome = restoreFilesToCheckpoint(store, 'th-missing', 'nope', workspace);
    expect(outcome).toEqual({ restored: [], deleted: [], failed: [], conflicts: [] });
  });

  test('collects per-file failures without aborting the remaining restores', () => {
    appendEvent('th-fail', 'a');
    store.saveNamedSnapshot('th-fail', 'cp', snapshotFor('th-fail'));
    appendEvent('th-fail', 'turn-2-tool');
    store.recordFilePreimage('th-fail', 'blocked', 'x', true);
    store.recordFilePreimage('th-fail', 'ok.md', 'fine\n', true);
    // 目录无法按 UTF-8 文件读取，冲突检查把它归入逐文件失败。
    mkdirSync(join(workspace, 'blocked'));
    writeFileSync(join(workspace, 'ok.md'), 'changed\n', 'utf8');
    store.recordFilePostimage('th-fail', 'blocked', fileContentHash('changed\n'), true);
    store.recordFilePostimage('th-fail', 'ok.md', fileContentHash('changed\n'), true);

    const outcome = restoreFilesToCheckpoint(store, 'th-fail', 'cp', workspace);

    expect(outcome.restored).toEqual(['ok.md']);
    expect(outcome.failed.map((f) => f.path)).toEqual(['blocked']);
    expect(readFileSync(join(workspace, 'ok.md'), 'utf8')).toBe('fine\n');
  });

  test('skips a path changed manually after the last Kite write', () => {
    writeFileSync(join(workspace, 'notes.md'), 'v1\n', 'utf8');
    appendEvent('th-conflict', 'a');
    store.saveNamedSnapshot('th-conflict', 'cp', snapshotFor('th-conflict'));
    appendEvent('th-conflict', 'turn-2-tool');
    store.recordFilePreimage('th-conflict', 'notes.md', 'v1\n', true);
    writeFileSync(join(workspace, 'notes.md'), 'kite-v2\n', 'utf8');
    store.recordFilePostimage('th-conflict', 'notes.md', fileContentHash('kite-v2\n'), true);

    // 模拟随后发生的手动或 Bash 修改。
    writeFileSync(join(workspace, 'notes.md'), 'manual-v3\n', 'utf8');

    const outcome = restoreFilesToCheckpoint(store, 'th-conflict', 'cp', workspace);

    expect(outcome.restored).toEqual([]);
    expect(outcome.conflicts).toEqual([{ path: 'notes.md', reason: 'modified_after_kite_write' }]);
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('manual-v3\n');
  });

  test('fails closed for legacy pre-images without a post-write fingerprint', () => {
    writeFileSync(join(workspace, 'legacy.md'), 'before\n', 'utf8');
    appendEvent('th-legacy', 'a');
    store.saveNamedSnapshot('th-legacy', 'cp', snapshotFor('th-legacy'));
    appendEvent('th-legacy', 'turn-2-tool');
    store.recordFilePreimage('th-legacy', 'legacy.md', 'before\n', true);
    writeFileSync(join(workspace, 'legacy.md'), 'current\n', 'utf8');

    const outcome = restoreFilesToCheckpoint(store, 'th-legacy', 'cp', workspace);

    expect(outcome.conflicts).toEqual([{ path: 'legacy.md', reason: 'unverified_postimage' }]);
    expect(readFileSync(join(workspace, 'legacy.md'), 'utf8')).toBe('current\n');
  });
});

describe('createFilePreimageRecorder', () => {
  test('returns undefined without a store or threadId', () => {
    expect(createFilePreimageRecorder(undefined, 'th')).toBeUndefined();
    expect(createFilePreimageRecorder(store, '')).toBeUndefined();
  });

  test('never throws even when the store fails', () => {
    const throwing = {
      checkpoints: {
        recordFilePreimage: () => {
          throw new Error('boom');
        },
        recordFilePostimage: () => {
          throw new Error('boom');
        },
      },
    } as unknown as StateRuntimeStorage;
    const recorder = createFilePreimageRecorder(throwing, 'th');
    expect(recorder).toBeDefined();
    expect(() => recorder?.('a.md', 'x', true)).not.toThrow();
    expect(() => recorder?.recordPostimage?.('a.md', 'y', true)).not.toThrow();
  });
});
