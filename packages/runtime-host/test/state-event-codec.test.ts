import { describe, expect, test } from 'bun:test';
import { runtimeHostStateAssertCurrentRuntimeEvent } from '@kite-ai/runtime-host';

describe('Runtime Host State event codec boundary', () => {
  test('preserves the current required-field and unknown-field admission semantics', () => {
    expect(() =>
      runtimeHostStateAssertCurrentRuntimeEvent({
        type: 'model.text_delta',
        text: 'ok',
      }),
    ).not.toThrow();
    expect(() =>
      runtimeHostStateAssertCurrentRuntimeEvent({
        type: 'model.text_delta',
        text: 'ok',
        unexpected: true,
      }),
    ).not.toThrow();
    expect(() =>
      runtimeHostStateAssertCurrentRuntimeEvent({
        type: 'model.text_delta',
      }),
    ).toThrow('Runtime event model.text_delta requires text.');
    expect(() =>
      runtimeHostStateAssertCurrentRuntimeEvent({
        type: 'runtime.future_event',
      }),
    ).toThrow('Runtime event type runtime.future_event is not part of the current format.');
  });
});
