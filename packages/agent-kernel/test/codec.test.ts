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
