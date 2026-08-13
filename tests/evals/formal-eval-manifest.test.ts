import { describe, expect, test } from 'bun:test';
import { FORMAL_EVAL_POLICY_REVISION } from '../../scripts/evals/formal-eval-identity';
import { buildFormalEvaluationManifestV1 } from '../../scripts/evals/formal-eval-manifest';

describe('formal evaluation evidence manifest', () => {
  const commit = 'a'.repeat(40);
  const report = (status = 'completed') =>
    JSON.stringify({
      schema: 'FirstDecisionEvalV1',
      status,
      evaluationIdentity: {
        formal: true,
        policyRevision: FORMAL_EVAL_POLICY_REVISION,
        candidateCommit: commit,
      },
    });

  test('binds accepted reports and a manual Go usage window without retaining paths', () => {
    const manifest = buildFormalEvaluationManifestV1({
      candidateCommit: commit,
      usageWindowStartedAt: '2026-08-13T01:00:00.000Z',
      usageWindowEndedAt: '2026-08-13T02:00:00.000Z',
      reports: [{ label: 'first_decision', content: report() }],
    });
    expect(manifest).toMatchObject({
      schema: 'FormalPromptEvaluationEvidenceV1',
      policyRevision: FORMAL_EVAL_POLICY_REVISION,
      candidateCommit: commit,
      goUsageChecked: true,
      contentLogged: false,
    });
    expect(JSON.stringify(manifest)).not.toContain('/tmp/');
  });

  test('rejects identity mismatches and failed reports', () => {
    expect(() =>
      buildFormalEvaluationManifestV1({
        candidateCommit: 'b'.repeat(40),
        usageWindowStartedAt: '2026-08-13T01:00:00.000Z',
        usageWindowEndedAt: '2026-08-13T02:00:00.000Z',
        reports: [{ label: 'first_decision', content: report() }],
      }),
    ).toThrow('manifest_report_identity_mismatch');
    expect(() =>
      buildFormalEvaluationManifestV1({
        candidateCommit: commit,
        usageWindowStartedAt: '2026-08-13T01:00:00.000Z',
        usageWindowEndedAt: '2026-08-13T02:00:00.000Z',
        reports: [{ label: 'first_decision', content: report('candidate_rejected') }],
      }),
    ).toThrow('manifest_report_not_accepted');
  });
});
