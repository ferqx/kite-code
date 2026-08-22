import { describe, expect, test } from 'bun:test';
import { runtimeHostState26AssertCurrentRuntimeEventV1 } from '@kite/runtime-host';

describe('Runtime Host State26 event codec boundary', () => {
  test('preserves the current required-field and unknown-field admission semantics', () => {
    expect(() =>
      runtimeHostState26AssertCurrentRuntimeEventV1({
        type: 'model.text_delta',
        text: 'ok',
      }),
    ).not.toThrow();
    expect(() =>
      runtimeHostState26AssertCurrentRuntimeEventV1({
        type: 'model.text_delta',
        text: 'ok',
        unexpected: true,
      }),
    ).not.toThrow();
    expect(() =>
      runtimeHostState26AssertCurrentRuntimeEventV1({
        type: 'model.text_delta',
      }),
    ).toThrow('Runtime event model.text_delta requires text.');
    expect(() =>
      runtimeHostState26AssertCurrentRuntimeEventV1({
        type: 'runtime.future_event',
      }),
    ).toThrow('Runtime event type runtime.future_event is not part of the current format.');
  });
});
