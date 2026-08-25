import { describe, expect, test } from 'bun:test';
import {
  evaluateReleaseCandidateAssembly,
  RC_CRITICAL_INPUTS_,
  RC_DEPENDENCIES_,
} from '../../scripts/release/assemble-rc';

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const artifactIdentity = {
  canonicalRepository: 'ferqx/kite-code',
  repositoryId: 'R_kgDOSKbi8g',
  commit: 'a'.repeat(40),
  payloadSha256: digest('1'),
  canonicalManifestDigest: digest('2'),
  behaviorDigest: digest('3'),
  profileDigest: digest('4'),
  gatePolicyDigest: digest('5'),
} as const;

function input() {
  const criticalDigests = {
    detached_manifest: digest('6'),
    evidence_bundle: digest('7'),
    release_gate_decision: digest('8'),
    supply_chain_verification: digest('9'),
    gate_replay: digest('a'),
    schema_rollback_report: digest('b'),
  } as const;
  return {
    schema: 'ReleaseCandidateAssemblyInput' as const,
    candidateId: 'rc-local-contract-v1',
    artifactIdentity,
    detachedManifestDigest: criticalDigests.detached_manifest,
    evidenceBundleDigest: criticalDigests.evidence_bundle,
    releaseGateDecisionDigest: criticalDigests.release_gate_decision,
    supplyChainVerificationDigest: criticalDigests.supply_chain_verification,
    gateReplayDigest: criticalDigests.gate_replay,
    schemaRollbackReportDigest: criticalDigests.schema_rollback_report,
    criticalInputs: RC_CRITICAL_INPUTS_.map((kind) => ({
      schema: 'ReleaseCandidateCriticalInputVerification' as const,
      kind,
      digest: criticalDigests[kind],
      artifactIdentity,
      verifierIdentity: `fixture:${kind}`,
      verificationReceiptDigest: digest('c'),
      verifiedAt: '2026-08-03T00:00:00.000Z',
    })),
    dependencies: RC_DEPENDENCIES_.map((dependency, index) => ({
      schema: 'ReleaseCandidateDependencyDecision' as const,
      dependency,
      status: 'passed' as const,
      artifactIdentity,
      verifiedAt: '2026-08-03T00:00:00.000Z',
      verifierIdentity: 'fixture-verifier',
      decisionDigest: digest(((index + 1) % 10).toString()),
      attestationDigest: digest(((index + 2) % 10).toString()),
    })),
  };
}

describe('Release Candidate assembly Gate', () => {
  test('binds all dependencies but refuses to write or publish without production authority', () => {
    expect(evaluateReleaseCandidateAssembly(input())).toMatchObject({
      status: 'blocked',
      candidateEligible: false,
      distributable: false,
      bundleWritten: false,
      milestone: null,
      reasonCodes: [
        'authenticated_rc_assembly_authority_not_configured',
        'authenticated_rc_critical_input_authority_not_configured',
      ],
    });
  });

  test('lists missing dependencies and detects artifact identity splicing', () => {
    const candidate = input();
    candidate.dependencies = candidate.dependencies.slice(0, 1);
    candidate.dependencies[0]!.artifactIdentity = {
      ...artifactIdentity,
      payloadSha256: digest('0'),
    };
    const result = evaluateReleaseCandidateAssembly(candidate);
    expect(result.reasonCodes).toContain(
      `dependency_artifact_identity_mismatch:${candidate.dependencies[0]!.dependency}`,
    );
    expect(result.reasonCodes).toContain('dependency_missing:ms_1b_done');
  });

  test('rejects duplicate dependency records', () => {
    const candidate = input();
    candidate.dependencies[candidate.dependencies.length - 1] = {
      ...candidate.dependencies[0]!,
    };
    expect(() => evaluateReleaseCandidateAssembly(candidate)).toThrow('duplicated');
  });

  test('binds every critical input and rejects digest or identity splicing', () => {
    const originalAssemblyDigest = evaluateReleaseCandidateAssembly(input()).assemblyDigest;
    for (const [index, kind] of RC_CRITICAL_INPUTS_.entries()) {
      const candidate = input();
      candidate.criticalInputs[index] = {
        ...candidate.criticalInputs[index]!,
        digest: digest('d'),
      };
      const result = evaluateReleaseCandidateAssembly(candidate);
      expect(result.reasonCodes).toContain(`critical_input_digest_mismatch:${kind}`);
      expect(result.assemblyDigest).not.toBe(originalAssemblyDigest);
    }

    const identitySplice = input();
    identitySplice.criticalInputs[0] = {
      ...identitySplice.criticalInputs[0]!,
      artifactIdentity: { ...artifactIdentity, behaviorDigest: digest('e') },
    };
    expect(evaluateReleaseCandidateAssembly(identitySplice).reasonCodes).toContain(
      'critical_input_artifact_identity_mismatch:detached_manifest',
    );
  });
});
