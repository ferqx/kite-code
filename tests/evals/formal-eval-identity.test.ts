import { describe, expect, test } from 'bun:test';
import {
  FORMAL_EVAL_POLICY_REVISION,
  validateFormalEvaluationIdentityV1,
} from '../../scripts/evals/formal-eval-identity';

describe('formal evaluation candidate identity', () => {
  const commit = 'a'.repeat(40);

  test('keeps diagnostic runs explicitly unbound', () => {
    expect(validateFormalEvaluationIdentityV1({ formal: false })).toEqual({
      formal: false,
      policyRevision: FORMAL_EVAL_POLICY_REVISION,
      candidateCommit: null,
    });
  });

  test('binds formal evidence only to the exact clean HEAD', () => {
    expect(
      validateFormalEvaluationIdentityV1({
        formal: true,
        expectedCandidateCommit: commit,
        headCommit: commit,
        worktreeDirty: false,
      }),
    ).toEqual({
      formal: true,
      policyRevision: FORMAL_EVAL_POLICY_REVISION,
      candidateCommit: commit,
    });
  });

  test.each([
    [
      { formal: true, headCommit: commit, worktreeDirty: false },
      'formal_candidate_commit_required',
    ],
    [
      {
        formal: true,
        expectedCandidateCommit: commit,
        headCommit: 'b'.repeat(40),
        worktreeDirty: false,
      },
      'formal_candidate_commit_mismatch',
    ],
    [
      { formal: true, expectedCandidateCommit: commit, headCommit: commit, worktreeDirty: true },
      'formal_candidate_worktree_dirty',
    ],
  ] as const)('fails closed for invalid formal identity: %s', (input, message) => {
    expect(() => validateFormalEvaluationIdentityV1(input)).toThrow(message);
  });
});
