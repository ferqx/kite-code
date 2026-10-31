import { expect, test } from 'bun:test';
import { AuthorizationCheckUnavailableError } from '../../../src/execution/authorization-check-feedback';

test('unavailable checker feedback exposes only known failure codes, never private adapter data', () => {
  for (const code of ['PRIVATE_PROVIDER_ERROR', '__proto__', 'constructor']) {
    const failure = new AuthorizationCheckUnavailableError('check-1', 'check_not_succeeded', {
      code,
      message: 'PRIVATE_PROVIDER_MESSAGE',
      content: 'PRIVATE_INCOMPLETE_OUTPUT',
    });
    expect(failure.check).toEqual({
      decision: 'unavailable',
      executionId: 'check-1',
      failureCode: 'check_not_succeeded',
    });
    expect(failure.message).not.toContain(code);
    expect(failure.message).not.toContain('PRIVATE_PROVIDER_MESSAGE');
    expect(failure.message).not.toContain('PRIVATE_INCOMPLETE_OUTPUT');
    expect(failure.message).toContain('No approval or rejection decision was made');
  }
});

test('an invalid saved output and an incomplete model response retain their distinct known causes', () => {
  const invalid = new AuthorizationCheckUnavailableError('check-1', 'check_output_invalid', null);
  expect(invalid.check.failureCode).toBe('authorization_check_output_invalid');
  expect(invalid.message).toContain('returned an invalid decision');
  const incomplete = new AuthorizationCheckUnavailableError('check-2', 'check_not_succeeded', {
    code: 'model_response_incomplete',
  });
  expect(incomplete.check.failureCode).toBe('model_response_incomplete');
  expect(incomplete.message).toContain('response was incomplete');
});
