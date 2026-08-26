import { describe, expect, test } from 'bun:test';
import { rewindFileOutcomeNotes } from '../src/tui/hooks/useRewindHandler';

describe('rewindFileOutcomeNotes', () => {
  test('does not claim there were no files when every restore failed', () => {
    const notes = rewindFileOutcomeNotes('code_only', {
      restored: [],
      deleted: [],
      failed: [{ path: 'blocked.md', error: 'permission denied' }],
      conflicts: [],
    });

    expect(notes.map((note) => note.text)).toEqual([
      '未恢复任何文件，会话内容未更改。',
      '部分文件恢复失败：blocked.md',
    ]);
  });

  test('reports conflict skips separately from successful restores', () => {
    const notes = rewindFileOutcomeNotes('code_and_conversation', {
      restored: ['safe.md'],
      deleted: [],
      failed: [],
      conflicts: [{ path: 'manual.md', reason: 'modified_after_kite_write' }],
    });

    expect(notes.map((note) => note.text)).toEqual([
      '已从检查点创建新会话，并恢复 1 个文件。',
      '为保护后续修改，已跳过冲突文件：manual.md',
    ]);
  });
});
