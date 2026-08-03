import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  createCapabilityContractInputV1,
  produceUnsignedCapabilityEvidenceV1,
} from '../../../scripts/evals/capability-evidence-producer';
import {
  CAPABILITY_EVALUATION_REPOSITORY,
  CAPABILITY_EVALUATION_REPOSITORY_ID,
  CAPABILITY_EVALUATION_WORKFLOW_PATH,
} from '../../../scripts/evals/contracts/capability-evaluation-evidence';
import { verifyFormalCapabilityEvidenceV1 } from '../../../scripts/evals/verify-capability-evidence';

const HEAD = 'a'.repeat(40);
const REF = 'refs/heads/main';

function fixture(
  capability: 'verification' | 'mcp_write' | 'skills_readonly' | 'skills_effectful',
) {
  const retainedInput = createCapabilityContractInputV1({
    capability,
    repository: CAPABILITY_EVALUATION_REPOSITORY,
    repositoryId: CAPABILITY_EVALUATION_REPOSITORY_ID,
    headSha: HEAD,
    startedAt: '2026-08-03T00:00:00.000Z',
  });
  const expectedSource = {
    schema: 'CapabilityEvaluationSourceV1' as const,
    canonicalRepository: CAPABILITY_EVALUATION_REPOSITORY,
    repositoryId: CAPABILITY_EVALUATION_REPOSITORY_ID,
    headSha: HEAD,
    ref: REF,
    workflowPath: CAPABILITY_EVALUATION_WORKFLOW_PATH,
    workflowRef: `${CAPABILITY_EVALUATION_REPOSITORY}/${CAPABILITY_EVALUATION_WORKFLOW_PATH}@${REF}`,
    workflowSha: 'b'.repeat(40),
    runId: '30820000000',
    runAttempt: 1,
    job: `capability-evidence-${capability}`,
    retainedArtifactId: '8860000000',
    retainedArtifactName: `capability-retained-${capability}-30820000000-1`,
    startedAt: retainedInput.startedAt,
    endedAt: retainedInput.endedAt,
  };
  const evidence = produceUnsignedCapabilityEvidenceV1({ retainedInput, source: expectedSource });
  return { retainedInput, expectedSource, evidence };
}

describe('formal capability evidence producer and independent verifier', () => {
  test.each([
    'verification',
    'mcp_write',
    'skills_readonly',
    'skills_effectful',
  ] as const)('rebuilds %s contract evidence but preserves the production authority block', (capability) => {
    const value = fixture(capability);
    const report = verifyFormalCapabilityEvidenceV1({
      ...value,
      now: value.evidence.observedAt,
    });
    expect(report).toMatchObject({
      status: 'blocked',
      evidenceEligible: false,
      sourceIdentityVerified: true,
      retainedInputVerified: true,
    });
    expect(report.verification.reasonCodes).toContain(
      'production_oidc_sigstore_authority_unconfigured',
    );
  });

  test('rejects retained-input and source identity splicing', () => {
    const value = fixture('verification');
    value.retainedInput.routeDigest = `sha256:${'0'.repeat(64)}`;
    expect(() =>
      verifyFormalCapabilityEvidenceV1({ ...value, now: value.evidence.observedAt }),
    ).toThrow('retained evaluation input');

    const fresh = fixture('verification');
    fresh.expectedSource.runId = '30820000001';
    expect(() =>
      verifyFormalCapabilityEvidenceV1({ ...fresh, now: fresh.evidence.observedAt }),
    ).toThrow('independent workflow expectations');
  });

  test('workflow remains manual, no-publish and authority-ineligible', () => {
    const workflow = readFileSync('.github/workflows/capability-evaluation.yml', 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toContain('schedule:');
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).not.toContain('id-token: write');
    expect(workflow).not.toContain('contents: write');
    expect(workflow).toContain('--require-blocked=true');
    expect(workflow).toContain('production_oidc_sigstore_authority_unconfigured');
  });
});
