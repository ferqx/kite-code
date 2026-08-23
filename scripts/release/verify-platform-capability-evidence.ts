import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJsonBytes, parseCanonicalJson } from './canonical-json';
import {
  collectLimitations,
  computePlatformCapabilityEvidenceDigest,
  evaluatePlatformSupport,
  githubEvidenceSource,
  type PlatformCapabilityEvidence,
  platformCapabilityEvidenceSchema,
  platformCapabilitySourceSchema,
} from './platform-capability-probe';

type FormalSource = NonNullable<PlatformCapabilityEvidence['source']>;

const SOURCE_KEYS = [
  'headSha',
  'ref',
  'repository',
  'repositoryId',
  'runAttempt',
  'runId',
  'runnerClass',
  'workflow',
  'workflowRef',
  'workflowSha',
] as const;

export interface VerifiedPlatformCapabilityEvidence {
  version: 1;
  status: 'verified_non_production_candidate';
  source: FormalSource;
  evidenceDigest: string;
  outcome: PlatformCapabilityEvidence['outcome'];
  productionSupported: false;
}

/**
 * Independent artifact-side verifier. `expectedSource` must be constructed
 * from GitHub run/job metadata after download; no self-reported source field
 * is accepted as its own authority.
 */
export function verifyPlatformCapabilityEvidence(input: {
  evidence: unknown;
  expectedSource: FormalSource;
}): VerifiedPlatformCapabilityEvidence {
  const evidence = strictEvidence(input.evidence);
  const expectedSource = platformCapabilitySourceSchema.parse(input.expectedSource);
  if (canonical(expectedSource) !== canonical(evidence.source)) {
    throw new Error('Platform capability evidence source identity mismatch.');
  }
  const withoutDigest = { ...evidence } as Omit<PlatformCapabilityEvidence, 'digest'> & {
    digest?: string;
  };
  delete withoutDigest.digest;
  if (computePlatformCapabilityEvidenceDigest(withoutDigest) !== evidence.digest) {
    throw new Error('Platform capability evidence digest mismatch.');
  }
  const probeInput = { ...withoutDigest } as Omit<
    typeof withoutDigest,
    'outcome' | 'productionSupported' | 'limitations'
  > & {
    outcome?: PlatformCapabilityEvidence['outcome'];
    productionSupported?: false;
    limitations?: string[];
  };
  delete probeInput.outcome;
  delete probeInput.productionSupported;
  delete probeInput.limitations;
  const rebuiltOutcome = evaluatePlatformSupport(probeInput);
  const rebuiltLimitations = collectLimitations(probeInput);
  if (evidence.outcome !== rebuiltOutcome) {
    throw new Error('Platform capability evidence outcome mismatch.');
  }
  if (canonical(evidence.limitations) !== canonical(rebuiltLimitations)) {
    throw new Error('Platform capability evidence limitations mismatch.');
  }
  if (evidence.productionSupported !== false) {
    throw new Error('Platform capability probe cannot grant production support.');
  }
  return Object.freeze({
    version: 1,
    status: 'verified_non_production_candidate',
    source: Object.freeze({ ...evidence.source }),
    evidenceDigest: evidence.digest,
    outcome: evidence.outcome,
    productionSupported: false,
  });
}

function strictEvidence(value: unknown): PlatformCapabilityEvidence & { source: FormalSource } {
  const parsed = platformCapabilityEvidenceSchema.safeParse(value);
  if (!parsed.success || !parsed.data.source) {
    throw new Error(
      `Platform capability evidence schema is invalid: ${parsed.success ? 'source missing' : parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  const evidence: PlatformCapabilityEvidence & { source: FormalSource } = {
    ...parsed.data,
    source: parsed.data.source,
  };
  assertExactKeys(evidence.source, SOURCE_KEYS, 'platform capability source');
  for (const [label, nested, keys] of [
    ['environmentIdentity', evidence.environmentIdentity, ['exactOsVersion']],
    ['backendIsolation', evidence.backendIsolation, ['syscallFilter']],
    ['entrypoints', evidence.entrypoints, ['foregroundCli', 'tui']],
    [
      'processCapabilitySurface',
      evidence.processCapabilitySurface,
      ['forkedSkill', 'localStdioMcp', 'shell'],
    ],
    [
      'processTree',
      evidence.processTree,
      ['hardCountLimit', 'hardCountMechanism', 'killWithoutResidualDescendants'],
    ],
    [
      'inheritance',
      evidence.inheritance,
      ['forkedSkill', 'localStdioMcp', 'shellDescendant', 'shellGrandchild'],
    ],
    ['network', evidence.network, ['allowlist', 'off']],
  ] as const) {
    assertExactKeys(nested, keys, label);
  }
  assertExactKeys(
    evidence.filesystem,
    [
      'inProcessReadOnly',
      'protectedAgentConfigReadDeny',
      'protectedAgentConfigWriteDeny',
      'protectedCredentialReadDeny',
      'protectedCredentialWriteDeny',
      'protectedGitReadDeny',
      'protectedGitWriteDeny',
      'protectedShellProfileReadDeny',
      'protectedShellProfileWriteDeny',
      'symlinkEscapeReadDeny',
      'symlinkEscapeWriteDeny',
      'workspaceOutsideReadDeny',
      'workspaceOutsideWriteDeny',
      'workspaceRead',
      'workspaceReadOnly',
      'workspaceWrite',
    ],
    'filesystem',
  );
  if (evidence.version !== 1 || !/^sha256:[a-f0-9]{64}$/.test(evidence.digest)) {
    throw new Error('Platform capability evidence version or digest is invalid.');
  }
  if (
    !Array.isArray(evidence.limitations) ||
    evidence.limitations.some((item) => typeof item !== 'string')
  ) {
    throw new Error('Platform capability evidence limitations are invalid.');
  }
  // Reuse the producer's closed GitHub identity parser, but match it against
  // the artifact-declared platform/architecture rather than this verifier host.
  const parsedSource = githubEvidenceSource(
    { platform: evidence.platform, arch: evidence.arch },
    sourceEnvironment(evidence.source),
  ).source;
  if (!parsedSource || canonical(parsedSource) !== canonical(evidence.source)) {
    throw new Error('Platform capability evidence GitHub source is invalid.');
  }
  return evidence;
}

function sourceEnvironment(source: FormalSource): NodeJS.ProcessEnv {
  return {
    QUALIFICATION_REPOSITORY: source.repository,
    QUALIFICATION_REPOSITORY_ID: source.repositoryId,
    QUALIFICATION_HEAD_SHA: source.headSha,
    QUALIFICATION_REF: source.ref,
    QUALIFICATION_WORKFLOW: source.workflow,
    QUALIFICATION_WORKFLOW_REF: source.workflowRef,
    QUALIFICATION_WORKFLOW_SHA: source.workflowSha,
    QUALIFICATION_RUN_ID: source.runId,
    QUALIFICATION_RUN_ATTEMPT: source.runAttempt,
    QUALIFICATION_RUNNER_CLASS: source.runnerClass,
  };
}

function assertExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has missing or unknown fields.`);
  }
}

function canonical(value: unknown): string {
  return new TextDecoder().decode(canonicalJsonBytes(value));
}

if (import.meta.main) {
  const evidencePath = resolve(process.argv[2] ?? 'platform-capability-evidence.json');
  const outputPath = process.argv[3] ? resolve(process.argv[3]) : undefined;
  const evidence = parseCanonicalJson(readFileSync(evidencePath));
  const expectedPath = process.argv[4];
  const expectedSource = expectedPath
    ? (parseCanonicalJson(readFileSync(resolve(expectedPath))) as FormalSource)
    : githubEvidenceSource(
        {
          platform: (evidence as PlatformCapabilityEvidence).platform,
          arch: (evidence as PlatformCapabilityEvidence).arch,
        },
        process.env,
      ).source;
  if (!expectedSource) throw new Error('Expected GitHub source identity is required.');
  const report = verifyPlatformCapabilityEvidence({ evidence, expectedSource });
  const encoded = canonicalJsonBytes(report);
  if (outputPath) writeFileSync(outputPath, encoded, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${new TextDecoder().decode(encoded)}\n`);
}
