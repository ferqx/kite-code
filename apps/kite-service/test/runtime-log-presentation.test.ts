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

  test('correlates a prepared model invocation without exposing its Surface Artifact ref', () => {
    const privateDigest = `sha256:${'a'.repeat(64)}` as const;
    const entry = projectRuntimeLogEvent({
      sessionId: 'session-1',
      sequence: 3,
      eventId: 'event-prepared',
      createdAt: 3,
      event: {
        type: 'model.invocation_prepared',
        invocationId: 'invocation-1',
        purpose: 'primary_agent',
        surfaceArtifact: {
          kind: 'model_surface',
          artifactId: 'private-artifact-id',
          integrityIdentifier: privateDigest,
          byteLength: 128,
        },
        surfaceIntegrityIdentifier: privateDigest,
        routeFingerprint: privateDigest,
        budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
        limits: { maxAttempts: 5, perAttemptTimeoutMs: 0, totalTimeBudgetMs: 60_000 },
        preparedStateRevision: 2,
        parentInvocationId: null,
        parentToolCallId: null,
      },
    });
    expect(entry.detail).toEqual({
      kind: 'model',
      fields: { invocation_id: 'invocation-1', purpose: 'primary_agent' },
    });
    expect(JSON.stringify(entry)).not.toContain('private-artifact-id');
    expect(JSON.stringify(entry)).not.toContain(privateDigest);
  });

  test('projects a stable pre-dispatch rejection without exposing its private reason', () => {
    const entry = projectRuntimeLogEvent({
      sessionId: 'session-1',
      sequence: 4,
      eventId: 'event-rejected',
      createdAt: 4,
      event: {
        type: 'tool.rejected',
        toolCallId: 'tool-shell',
        reason: 'Policy denied access to /private/secret.',
        failure: {
          kind: 'policy_denied',
          message: 'Policy denied access to /private/secret.',
          retryable: false,
          modelFixable: true,
          needsUserIntervention: false,
          terminatesTurn: false,
          journal: true,
        },
      },
    });

    expect(entry).toMatchObject({
      summary: 'Tool execution was rejected by policy before dispatch.',
      detail: {
        kind: 'tool',
        fields: {
          tool_call_id: 'tool-shell',
          reason_code: 'policy_denied',
          rejection_summary: 'Tool execution was rejected by policy before dispatch.',
        },
      },
    });
    expect(JSON.stringify(entry)).not.toContain('/private/secret');
  });
});
