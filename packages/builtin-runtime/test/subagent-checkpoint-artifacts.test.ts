import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiMessage, humanMessage, systemMessage } from '../src/model/messages';
import { SubagentCheckpointArtifactStore } from '../src/subagent/checkpoint-artifacts';

test('private child checkpoint preserves the terminal transcript and exact identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-child-checkpoint-'));
  try {
    const store = new SubagentCheckpointArtifactStore({ root: join(root, 'subagent-checkpoints') });
    const messages = [
      systemMessage('governed child'),
      humanMessage('inspect the file'),
      aiMessage({ content: 'finished' }),
    ];
    const ref = store.write({
      ownerKey: 'owner-one',
      taskId: 'child-one',
      modelInvocationOrdinal: 3,
      messages,
    });
    expect(ref).toMatchObject({ kind: 'subagent_checkpoint' });
    expect(store.read(ref, 'owner-one', 'child-one')).toMatchObject({
      ownerKey: 'owner-one',
      taskId: 'child-one',
      modelInvocationOrdinal: 3,
      messages,
    });
    expect(() => store.read(ref, 'owner-two', 'child-one')).toThrow();
    expect(() => store.read(ref, 'owner-one', 'child-two')).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
