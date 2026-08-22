import { describe, expect, test } from 'bun:test';
import { runtimeHostState25AssertCurrentRuntimeEventV1 } from '@kite/runtime-host';

describe('Runtime Host State25 event codec boundary', () => {
  test('preserves the current required-field and unknown-field admission semantics', () => {
    expect(() =>
      runtimeHostState25AssertCurrentRuntimeEventV1({
        type: 'model.text_delta',
        text: 'ok',
      }),
    ).not.toThrow();
    expect(() =>
      runtimeHostState25AssertCurrentRuntimeEventV1({
        type: 'model.text_delta',
        text: 'ok',
        unexpected: true,
      }),
    ).not.toThrow();
    expect(() =>
      runtimeHostState25AssertCurrentRuntimeEventV1({
        type: 'model.text_delta',
      }),
    ).toThrow('Runtime event model.text_delta requires text.');
    expect(() =>
      runtimeHostState25AssertCurrentRuntimeEventV1({
        type: 'runtime.future_event',
      }),
    ).toThrow('Runtime event type runtime.future_event is not part of the current format.');
  });
});
