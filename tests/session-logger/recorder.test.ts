import { describe, expect, test } from 'bun:test';
import { recordContentRuntimeEvent } from '#app/session-logger/recorder';

const TRACE = 'aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb';
const PARENT = 'cccccccccccccccc';

describe('recordContentRuntimeEvent', () => {
  test('projects only allowlisted user text and redacts credential shapes', () => {
    const record = recordContentRuntimeEvent(
      {
        type: 'user.message_appended',
        messageId: 'private-message-id',
        content: 'Use password="super-secret-value".',
      },
      TRACE,
      PARENT,
    );

    expect(record).toMatchObject({
      traceId: TRACE,
      parentSpanId: PARENT,
      name: 'user.message',
      kind: 1,
      attributes: {
        'kite_code.text.length': 34,
        'kite_code.text.content': 'Use password="[REDACTED]".',
      },
      status: { code: 'OK', message: '' },
    });
    expect(JSON.stringify(record)).not.toContain('private-message-id');
    expect(JSON.stringify(record)).not.toContain('super-secret-value');
  });

  test('projects model-visible text without reasoning or tool data', () => {
    const record = recordContentRuntimeEvent(
      {
        type: 'model.responded',
        messageId: 'private-model-id',
        text: 'Visible answer',
        reasoningText: 'PRIVATE_REASONING',
        toolCalls: [
          {
            id: 'private-tool-call',
            name: 'read_file',
            args: { path: '/private/path' },
          },
        ],
      },
      TRACE,
      PARENT,
    );

    expect(record.name).toBe('model.message');
    expect(record.kind).toBe(3);
    expect(record.attributes).toEqual({
      'kite_code.text.length': 14,
      'kite_code.text.content': 'Visible answer',
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('PRIVATE_REASONING');
    expect(serialized).not.toContain('private-tool-call');
    expect(serialized).not.toContain('/private/path');
  });

  test('caps retained content without admitting arbitrary RuntimeEvent fields', () => {
    const content = 'x'.repeat(10_001);
    const record = recordContentRuntimeEvent(
      { type: 'model.responded', messageId: 'model-long', text: content },
      TRACE,
      PARENT,
    );

    expect(record.attributes['kite_code.text.length']).toBe(10_001);
    expect(record.attributes['kite_code.text.content']).toBe(
      `${'x'.repeat(10_000)}…(truncated, 10001 total)`,
    );
  });
});
