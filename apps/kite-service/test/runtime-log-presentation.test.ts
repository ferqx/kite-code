import { describe, expect, test } from 'bun:test';
import { projectRuntimeLogEvent } from '../src/logs/runtime-log-presentation';

describe('RuntimeLogPresentationProjector', () => {
  test('bounds and redacts user-visible text without returning arbitrary event fields', () => {
    const entry = projectRuntimeLogEvent({
      sessionId: 'session-1',
      sequence: 1,
      eventId: 'event-1',
      createdAt: 1,
      event: {
        type: 'user.message_appended',
        messageId: 'message-1',
        content: `<img src=x onerror=alert(1)> api_key=super-secret ${'x'.repeat(5_000)}\u001b[2J`,
      },
    });
    expect(entry.detail).toEqual({
      kind: 'message',
      fields: {
        content: expect.stringContaining('[redacted]'),
        message_id: 'message-1',
      },
    });
    const content = (entry.detail?.fields?.content as string) ?? '';
    expect(content).not.toContain('super-secret');
    expect(content).not.toContain('\u001b');
    expect(Array.from(content).length).toBeGreaterThan(4_000);
    expect(Array.from(content).length).toBeLessThanOrEqual(65_537);
    expect(JSON.stringify(entry)).not.toContain('messageId');
  });

  test('projects only bounded safe model identifiers and text for Public History mapping', () => {
    const entry = projectRuntimeLogEvent({
      sessionId: 'session-1',
      sequence: 2,
      eventId: 'event-model',
      createdAt: 2,
      event: {
        type: 'model.responded',
        messageId: 'message-model',
        invocationId: 'request-model',
        reasoningText: 'token=hidden reasoning',
        text: 'api_key=hidden answer',
        toolCalls: [{ id: 'tool-private', name: 'private', args: { path: '/private' } }],
      },
    });
    expect(entry.detail).toEqual({
      kind: 'model',
      fields: {
        message_id: 'message-model',
        request_id: 'request-model',
        reasoning_text: '[redacted] reasoning',
        text: '[redacted] answer',
      },
    });
    expect(JSON.stringify(entry)).not.toContain('/private');
    expect(JSON.stringify(entry)).not.toContain('tool-private');
  });

  test('shows artifact kind only, never its locator or body', () => {
    const entry = projectRuntimeLogEvent({
      sessionId: 'session-1',
      sequence: 2,
      eventId: 'event-2',
      createdAt: 2,
      event: {
        type: 'model.invocation_completed',
        invocationId: 'model-1',
        finishReason: 'stop',
        responseArtifact: {
          kind: 'model_response',
          artifactId: '/private/path',
          integrityIdentifier: 'sha256:x',
          byteLength: 1,
        },
      },
    });
    expect(JSON.stringify(entry)).not.toContain('/private/path');
    expect(JSON.stringify(entry)).not.toContain('sha256:x');
  });
});
