import { expect, test } from 'bun:test';

test('receives its file-specific fault-soak repeat count', () => {
  expect(process.env.KITE_FAULT_SOAK_REPEAT_COUNT).toBe(
    process.env.KITE_FAULT_SOAK_EXPECTED_REPEAT_COUNT,
  );
});
