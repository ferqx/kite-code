import { describe, expect, test } from 'bun:test';
import {
  assertCurrentRuntimeEvent,
  assertCurrentRuntimeEventForWrite,
  decodeCurrentRuntimeEventJson,
  encodeCurrentRuntimeEventJson,
} from '../src/codec';
import type { KernelEvent } from '../src/events';

describe('State event codec', () => {
  test('round-trips a canonical accepted event with identical JSON bytes', () => {
    const event: KernelEvent = {
      type: 'user.message_appended',
      messageId: 'message-1',
      content: { kind: 'user', text: 'hello', parts: ['one', 'two'] },
    } as unknown as KernelEvent;

    assertCurrentRuntimeEvent(event);
    const encoded = encodeCurrentRuntimeEventJson(event);

    expect(encoded).toBe(JSON.stringify(event));
    expect(decodeCurrentRuntimeEventJson(encoded)).toEqual(event);
  });

  test('keeps JSON.stringify Uint8Array conversion compatible with the root codec', () => {
    const event = {
      type: 'user.message_appended',
      messageId: new Uint8Array([0xde, 0xad]),
      content: 'hello',
    } as unknown as KernelEvent;

    assertCurrentRuntimeEvent(event);
    const encoded = encodeCurrentRuntimeEventJson(event);

    expect(encoded).toBe(JSON.stringify(event));
    expect(decodeCurrentRuntimeEventJson(encoded)).toEqual(JSON.parse(encoded));
  });

  test('retains root required-field and unknown-field admission semantics', () => {
    expect(() =>
      assertCurrentRuntimeEvent({ type: 'user.message_appended', content: 'missing id' }),
    ).toThrow('Runtime event user.message_appended requires messageId.');

    const withUnknownField = {
      type: 'user.message_appended',
      messageId: 'message-1',
      content: 'hello',
      unknownParityField: null,
    } as unknown as KernelEvent;
    expect(decodeCurrentRuntimeEventJson(encodeCurrentRuntimeEventJson(withUnknownField))).toEqual(
      withUnknownField,
    );
  });

  test('keeps approval batch and session-clear facts exact and receipt-safe', () => {
    const commandIdentity = {
      sessionId: 'session-1',
      threadId: 'session-1',
      workspace: '/workspace',
      canonicalWorkspaceIdentity: 'sha256:workspace',
      cwd: '/workspace',
      executor: 'shell',
      environment: 'sha256:environment',
      scope: 'sha256:scope',
      effects: 'sha256:effects',
      parserRevision: 'parser-v1',
      executorRevision: 'executor-v1',
      commandDigest: 'sha256:command',
    };
    const batch = {
      type: 'approval.batch_released',
      interactionId: 'approval-1',
      toolCallId: 'tool-1',
      grant: 'same_command',
      grantKey: 'grant-key',
      sessionRevision: 4,
      generation: 2,
      commandIdentity,
      matches: [
        {
          interactionId: 'approval-1',
          toolCallId: 'tool-1',
          receiptId: 'receipt-1',
          generation: 2,
          bindingDigest: 'binding-1',
        },
        {
          interactionId: 'approval-2',
          toolCallId: 'tool-2',
          receiptId: 'receipt-2',
          generation: 2,
          bindingDigest: 'binding-2',
        },
      ],
      cancelledReviewIds: ['approval-2'],
      createdAt: '2026-08-25T00:00:00.000Z',
    } as const;
    expect(() => assertCurrentRuntimeEvent(batch)).not.toThrow();
    expect(() => assertCurrentRuntimeEvent({ ...batch, extraAuthority: true })).toThrow(
      'invalid shape',
    );
    expect(() =>
      assertCurrentRuntimeEvent({
        ...batch,
        matches: [{ ...batch.matches[0], extraAuthority: true }],
      }),
    ).toThrow('match is invalid');
    expect(() =>
      assertCurrentRuntimeEvent({
        ...batch,
        matches: [batch.matches[0], { ...batch.matches[1], receiptId: 'receipt-1' }],
      }),
    ).toThrow('match is invalid');
    expect(() =>
      assertCurrentRuntimeEvent({ ...batch, cancelledReviewIds: ['approval-2', 'approval-2'] }),
    ).toThrow('cancelled review identities are invalid');

    const cleared = {
      type: 'approval.session_grants_cleared',
      sessionId: 'session-1',
      sessionRevision: 5,
      generation: 3,
      clearedAt: '2026-08-25T00:00:01.000Z',
    } as const;
    expect(() => assertCurrentRuntimeEvent(cleared)).not.toThrow();
    expect(() => assertCurrentRuntimeEvent({ ...cleared, localOnly: true })).toThrow(
      'invalid shape',
    );
  });

  test('keeps retired session events readable but rejects them from current writes', () => {
    const retiredAdmission = {
      type: 'provider.admission_status',
      status: 'ready',
      reason: 'admitted',
      admissionRevision: 'legacy-policy-v1',
    };
    expect(() => assertCurrentRuntimeEvent(retiredAdmission)).not.toThrow();
    expect(() => assertCurrentRuntimeEventForWrite(retiredAdmission)).toThrow(
      'read-only compatibility data',
    );

    const retiredReviewer = {
      type: 'verification.requested',
      verificationId: 'legacy-verification',
      mode: 'required',
      spec: {
        checks: [{ type: 'reviewer', instructions: 'Review the legacy result.' }],
      },
      requestedAt: '2026-08-24T00:00:00.000Z',
    };
    expect(() => assertCurrentRuntimeEvent(retiredReviewer)).not.toThrow();
    expect(() => assertCurrentRuntimeEventForWrite(retiredReviewer)).toThrow(
      'read-only compatibility data',
    );

    const retiredSubagentTitle = {
      type: 'subagent.started',
      subagent: { id: 'child-1', role: 'explore', task: 'Inspect callers' },
    };
    expect(() => assertCurrentRuntimeEvent(retiredSubagentTitle)).not.toThrow();
    expect(() => assertCurrentRuntimeEventForWrite(retiredSubagentTitle)).toThrow(
      'read-only compatibility data',
    );
    expect(() =>
      assertCurrentRuntimeEventForWrite({
        type: 'subagent.started',
        subagent: { id: 'child-1', role: 'explore', name: 'Inspect callers' },
      }),
    ).not.toThrow();
  });
});
