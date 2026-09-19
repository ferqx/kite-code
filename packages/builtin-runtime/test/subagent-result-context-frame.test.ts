import { describe, expect, test } from 'bun:test';
import { buildCanonicalFrames } from '../src/model/context-frame-builder';
import { serializeFramesToMessages } from '../src/model/context-serializer';

describe('background sub-agent result context frame', () => {
  test('serializes the short report as a named user message and never system authority', () => {
    const messages = serializeFramesToMessages([
      {
        kind: 'subagent_result',
        notificationId: 'subagent:task-1:sha256:abc',
        taskId: 'task-1',
        content: 'Inspected the implementation.',
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'human',
      id: 'subagent:task-1:sha256:abc',
      name: 'subagent',
    });
    expect(messages[0]?.content).toContain('Inspected the implementation.');
    expect(messages[0]?.content).toContain('task_read');
    expect(messages.some((message) => message.type === 'system')).toBe(false);
    const rebuilt = buildCanonicalFrames(messages);
    expect(rebuilt).toEqual([
      {
        kind: 'subagent_result',
        notificationId: 'subagent:task-1:sha256:abc',
        taskId: 'task-1',
        content: 'Inspected the implementation.',
      },
    ]);
  });
});
