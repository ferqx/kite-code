import { describe, expect, test } from 'bun:test';
import { parseCanonicalJson } from '../../../scripts/release/canonical-json';
import {
  computePlatformCapabilityEvidenceDigest,
  encodePlatformCapabilityEvidence,
  type GithubHostedRunnerClass,
  githubEvidenceSource,
  type PlatformCapabilityEvidence,
  runPlatformCapabilityProbe,
} from '../../../scripts/release/platform-capability-probe';
import { verifyPlatformCapabilityEvidence } from '../../../scripts/release/verify-platform-capability-evidence';

const runnerClassByRuntime: Partial<
  Record<NodeJS.Platform, Partial<Record<string, GithubHostedRunnerClass>>>
> = {
  darwin: { arm64: 'macos-15-arm64-github-hosted' },
  linux: { x64: 'ubuntu-24.04-x64-github-hosted' },
  win32: { x64: 'windows-2025-x64-github-hosted' },
};

describe('independent platform capability artifact verifier', () => {
  test('rebuilds the report and rejects source, payload, and conclusion splices', async () => {
    const runnerClass = runnerClassByRuntime[process.platform]?.[process.arch];
    if (!runnerClass) return;
    const source = githubEvidenceSource(
      { platform: process.platform, arch: process.arch },
      {
        QUALIFICATION_REPOSITORY: 'ferqx/kite-code',
        QUALIFICATION_REPOSITORY_ID: '1218896626',
        QUALIFICATION_HEAD_SHA: 'a'.repeat(40),
        QUALIFICATION_REF: 'refs/heads/main',
        QUALIFICATION_WORKFLOW: '.github/workflows/platform-capability-probe.yml',
        QUALIFICATION_WORKFLOW_REF:
          'ferqx/kite-code/.github/workflows/platform-capability-probe.yml@refs/heads/main',
        QUALIFICATION_WORKFLOW_SHA: 'b'.repeat(40),
        QUALIFICATION_RUN_ID: '123',
        QUALIFICATION_RUN_ATTEMPT: '1',
        QUALIFICATION_RUNNER_CLASS: runnerClass,
      },
    ).source!;
    const local = await runPlatformCapabilityProbe();
    const { digest: _localDigest, ...localWithoutDigest } = local;
    const withoutDigest = { ...localWithoutDigest, source };
    const evidence: PlatformCapabilityEvidence = {
      ...withoutDigest,
      digest: computePlatformCapabilityEvidenceDigest(withoutDigest),
    };

    const encoded = encodePlatformCapabilityEvidence(evidence);
    expect(parseCanonicalJson(encoded)).toEqual(evidence);
    expect(new TextDecoder().decode(encoded)).not.toEndWith('\n');

    expect(verifyPlatformCapabilityEvidence({ evidence, expectedSource: source })).toMatchObject({
      status: 'verified_non_production_candidate',
      source,
      productionSupported: false,
    });

    const attackerSource = { ...source, runId: '999' };
    const attackerWithoutDigest = { ...withoutDigest, source: attackerSource };
    const attackerEvidence = {
      ...attackerWithoutDigest,
      digest: computePlatformCapabilityEvidenceDigest(attackerWithoutDigest),
    };
    expect(() =>
      verifyPlatformCapabilityEvidence({ evidence: attackerEvidence, expectedSource: source }),
    ).toThrow('source identity mismatch');
    expect(() =>
      githubEvidenceSource(
        { platform: process.platform, arch: process.arch },
        {
          QUALIFICATION_REPOSITORY: source.repository,
          QUALIFICATION_REPOSITORY_ID: source.repositoryId,
          QUALIFICATION_HEAD_SHA: source.headSha,
          QUALIFICATION_REF: source.ref,
          QUALIFICATION_WORKFLOW: source.workflow,
          QUALIFICATION_WORKFLOW_REF:
            'ferqx/kite-code/.github/workflows/platform-capability-probe.yml@refs/heads/other',
          QUALIFICATION_WORKFLOW_SHA: source.workflowSha,
          QUALIFICATION_RUN_ID: source.runId,
          QUALIFICATION_RUN_ATTEMPT: source.runAttempt,
          QUALIFICATION_RUNNER_CLASS: source.runnerClass,
        },
      ),
    ).toThrow('does not match the source ref');
    expect(() =>
      verifyPlatformCapabilityEvidence({
        evidence: { ...evidence, prompt: 'SECRET' },
        expectedSource: source,
      }),
    ).toThrow('schema is invalid');
    const invalidPrimitive = { ...evidence, evidenceId: { prompt: 'SECRET' } } as unknown as Record<
      string,
      unknown
    >;
    const { digest: _invalidDigest, ...invalidMaterial } = invalidPrimitive;
    invalidPrimitive.digest = computePlatformCapabilityEvidenceDigest(invalidMaterial as never);
    expect(() =>
      verifyPlatformCapabilityEvidence({ evidence: invalidPrimitive, expectedSource: source }),
    ).toThrow('schema is invalid');
    const falseConclusionWithoutDigest = { ...withoutDigest, outcome: 'supported' as const };
    const falseConclusion = {
      ...falseConclusionWithoutDigest,
      digest: computePlatformCapabilityEvidenceDigest(falseConclusionWithoutDigest),
    };
    expect(() =>
      verifyPlatformCapabilityEvidence({ evidence: falseConclusion, expectedSource: source }),
    ).toThrow('outcome mismatch');
  }, 30_000);
});
