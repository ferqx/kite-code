export const FORMAL_EVAL_POLICY_REVISION = 'ACORE-EVAL-POLICY-02-r2' as const;

export interface FormalEvaluationIdentityV1 {
  formal: boolean;
  policyRevision: typeof FORMAL_EVAL_POLICY_REVISION;
  candidateCommit: string | null;
}

export function validateFormalEvaluationIdentityV1(input: {
  formal: boolean;
  expectedCandidateCommit?: string;
  headCommit?: string;
  worktreeDirty?: boolean;
}): FormalEvaluationIdentityV1 {
  if (!input.formal) {
    return {
      formal: false,
      policyRevision: FORMAL_EVAL_POLICY_REVISION,
      candidateCommit: null,
    };
  }
  const expected = input.expectedCandidateCommit?.trim().toLowerCase();
  const head = input.headCommit?.trim().toLowerCase();
  if (!expected || !/^[0-9a-f]{40}$/u.test(expected)) {
    throw new Error('formal_candidate_commit_required');
  }
  if (!head || head !== expected) throw new Error('formal_candidate_commit_mismatch');
  if (input.worktreeDirty !== false) throw new Error('formal_candidate_worktree_dirty');
  return {
    formal: true,
    policyRevision: FORMAL_EVAL_POLICY_REVISION,
    candidateCommit: expected,
  };
}

function gitOutput(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  if (result.exitCode !== 0) throw new Error('formal_candidate_git_unavailable');
  return result.stdout.toString().trim();
}

export function resolveFormalEvaluationIdentityV1(input?: {
  formal?: boolean;
  expectedCandidateCommit?: string;
  cwd?: string;
}): FormalEvaluationIdentityV1 {
  const formal = input?.formal ?? process.env.KITE_FORMAL_EVAL === '1';
  if (!formal) return validateFormalEvaluationIdentityV1({ formal: false });
  const cwd = input?.cwd ?? process.cwd();
  return validateFormalEvaluationIdentityV1({
    formal: true,
    expectedCandidateCommit:
      input?.expectedCandidateCommit ?? process.env.KITE_FORMAL_EVAL_CANDIDATE_COMMIT,
    headCommit: gitOutput(cwd, ['rev-parse', 'HEAD']),
    worktreeDirty: gitOutput(cwd, ['status', '--porcelain', '--untracked-files=all']).length > 0,
  });
}
