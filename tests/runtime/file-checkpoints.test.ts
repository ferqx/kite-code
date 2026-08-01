// ── ADR-0025 §4：文件原像恢复测试 / file pre-image restore tests ──
// 验证 restoreFilesToCheckpoint 将工作区文件恢复到命名检查点时刻的状态。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEvent } from '../../src/core/runtime/events.js';
import {
  createFilePreimageRecorder,
  restoreFilesToCheckpoint,
} from '../../src/core/runtime/file-checkpoints';
import type { RuntimeStore } from '../../src/core/runtime/store.js';
import { createRuntimeStore } from '../../src/core/runtime/store.js';

let root: string;
let workspace: string;
let store: RuntimeStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'file-checkpoints-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  store = createRuntimeStore(join(root, 'checkpoints.runtime.db'));
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function appendEvent(threadId: string, toolCallId: string): void {
  store.appendEvents(threadId, [{ type: 'tool.started', toolCallId } as RuntimeEvent]);
}

describe('restoreFilesToCheckpoint', () => {
  test('restores overwritten files and deletes files created after the checkpoint', () => {
    writeFileSync(join(workspace, 'notes.md'), 'v1 content\n', 'utf8');
    appendEvent('th', 'a');
    store.saveNamedSnapshot('th', 'cp', { version: 1 });

    // 模拟后续 turn 的写入：新 turn 事件推进位置，然后覆写 notes.md、新建 scratch.md
    appendEvent('th', 'turn-2-tool');
    store.recordFilePreimage('th', 'notes.md', 'v1 content\n', true);
    store.recordFilePreimage('th', 'scratch.md', null, false);
    writeFileSync(join(workspace, 'notes.md'), 'v2 content\n', 'utf8');
    writeFileSync(join(workspace, 'scratch.md'), 'scratch\n', 'utf8');

    const outcome = restoreFilesToCheckpoint(store, 'th', 'cp', workspace);

    expect(outcome.restored).toEqual(['notes.md']);
    expect(outcome.deleted).toEqual(['scratch.md']);
    expect(outcome.failed).toEqual([]);
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('v1 content\n');
    expect(existsSync(join(workspace, 'scratch.md'))).toBe(false);
  });

  test('recreates missing parent directories when restoring', () => {
    mkdirSync(join(workspace, 'src', 'deep'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'deep', 'app.ts'), 'old\n', 'utf8');
    appendEvent('th-nested', 'a');
    store.saveNamedSnapshot('th-nested', 'cp', { version: 1 });

    appendEvent('th-nested', 'turn-2-tool');
    store.recordFilePreimage('th-nested', 'src/deep/app.ts', 'old\n', true);
    rmSync(join(workspace, 'src'), { recursive: true, force: true });

    const outcome = restoreFilesToCheckpoint(store, 'th-nested', 'cp', workspace);

    expect(outcome.restored).toEqual(['src/deep/app.ts']);
    expect(readFileSync(join(workspace, 'src', 'deep', 'app.ts'), 'utf8')).toBe('old\n');
  });

  test('returns an empty outcome for an unknown checkpoint', () => {
    const outcome = restoreFilesToCheckpoint(store, 'th-missing', 'nope', workspace);
    expect(outcome).toEqual({ restored: [], deleted: [], failed: [] });
  });

  test('collects per-file failures without aborting the remaining restores', () => {
    appendEvent('th-fail', 'a');
    store.saveNamedSnapshot('th-fail', 'cp', { version: 1 });
    appendEvent('th-fail', 'turn-2-tool');
    store.recordFilePreimage('th-fail', 'blocked/nested.md', 'x', true);
    store.recordFilePreimage('th-fail', 'ok.md', 'fine\n', true);
    // 'blocked' 是文件而非目录 → 恢复 blocked/nested.md 必然失败
    writeFileSync(join(workspace, 'blocked'), 'i am a file, not a dir', 'utf8');
    writeFileSync(join(workspace, 'ok.md'), 'changed\n', 'utf8');

    const outcome = restoreFilesToCheckpoint(store, 'th-fail', 'cp', workspace);

    expect(outcome.restored).toEqual(['ok.md']);
    expect(outcome.failed.map((f) => f.path)).toEqual(['blocked/nested.md']);
    expect(readFileSync(join(workspace, 'ok.md'), 'utf8')).toBe('fine\n');
  });
});

describe('createFilePreimageRecorder', () => {
  test('returns undefined without a store or threadId', () => {
    expect(createFilePreimageRecorder(undefined, 'th')).toBeUndefined();
    expect(createFilePreimageRecorder(store, '')).toBeUndefined();
  });

  test('never throws even when the store fails', () => {
    const throwing = {
      recordFilePreimage: () => {
        throw new Error('boom');
      },
    } as unknown as RuntimeStore;
    const recorder = createFilePreimageRecorder(throwing, 'th');
    expect(recorder).toBeDefined();
    expect(() => recorder?.('a.md', 'x', true)).not.toThrow();
  });
});
