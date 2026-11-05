import { expect, test } from 'bun:test';
import { authorizationCheckAnswer } from '../../../src/authorization-check-output';
import {
  AuthorizationCheckUnavailableError,
  authorizationCheckInstructions,
} from '../../../src/execution/authorization-check-feedback';

test('review guidance distinguishes authorized staging from conditional final fallback without allowing relabelled writes', () => {
  // This freezes the missing instruction from a real false rejection; it does
  // not assert that a fixed or real model will follow that instruction.
  expect(authorizationCheckInstructions).toContain(
    'A condition restricting final delivery is not a precondition for this allowed write',
  );
  expect(authorizationCheckInstructions).toContain(
    "Neither a key named fallback nor an assistant's premature completion plan revokes the user's staging permission",
  );
  expect(authorizationCheckInstructions).toContain(
    'If the user instead forbids creating or modifying the fallback file before refusal, honor that actual write condition',
  );
  expect(authorizationCheckInstructions).toContain(
    'Calling a forbidden write staging does not authorize it',
  );
});

test('risk and authorization stay in the original explanation contract, never extra score or timeout decisions', () => {
  expect(authorizationCheckInstructions).toContain(
    'Separate intrinsic risk from user authorization',
  );
  expect(authorizationCheckInstructions).toContain('the timeout itself grants no authority');
  expect(authorizationCheckInstructions).toContain(
    'Keep reason to one concise English sentence of at most 30 words',
  );
  const answer = {
    decision: 'approve_once' as const,
    reason: 'Bounded intermediate write explicitly authorized by the user.',
  };
  expect(authorizationCheckAnswer(answer)).toEqual(answer);
  for (const extra of [{ risk_level: 'low' }, { user_authorization: 'high' }])
    expect(authorizationCheckAnswer({ ...answer, ...extra })).toBeNull();
  expect(authorizationCheckAnswer({ ...answer, decision: 'timeout_continue' })).toBeNull();
});

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
  const limited = new AuthorizationCheckUnavailableError('check-3', 'check_not_succeeded', {
    code: 'authorization_check_output_limit',
  });
  expect(limited.check.failureCode).toBe('authorization_check_output_limit');
  expect(limited.message).toContain('reached its output token limit without a complete response');
  expect(limited.message).toContain('This operation was not executed');
});
