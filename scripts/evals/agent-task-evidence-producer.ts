import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  canonicalJsonBytes,
  parseCanonicalJson,
  sha256DomainSeparated,
} from '../release/canonical-json';
import type { ReleaseArtifactIdentityV1 } from '../release/evidence-schema';
import { ADVERSARIAL_CONTRACT_CATALOG_V1 } from './contracts/agent-task-adversarial-contract';
import {
  APPROVED_AGENT_TASK_CASE_IDS_V1,
  APPROVED_AGENT_TASK_SUITE_V1,
} from './contracts/agent-task-approved-suite';
import {
  AGENT_TASK_ADVERSARIAL_CATALOG_DIGEST_V1,
  type AgentTaskCandidateIdentityV1,
  type AgentTaskCaseLedgerV1,
  type AgentTaskEvidenceSourceV1,
  type AgentTaskFormalAdversarialEvidenceV1,
  type AuthenticatedAgentTaskEvidenceV1,
  agentTaskCandidateIdentityV1Schema,
  agentTaskEvidenceSourceV1Schema,
  agentTaskFormalAdversarialReceiptV1Schema,
  agentTaskRetainedAttemptV1Schema,
  authenticatedAgentTaskEvidenceV1Schema,
  computeAgentTaskAdversarialEvidenceDigestV1,
  computeAgentTaskAttemptDigestV1,
  computeAgentTaskCandidateDigestV1,
  computeAgentTaskCaseLedgerDigestV1,
  computeAgentTaskFrozenBaselineDigestV1,
  computeAgentTaskSourceDigestV1,
  computeAuthenticatedAgentTaskBundleDigestV1,
  verifyAuthenticatedAgentTaskEvidenceV1,
} from './contracts/agent-task-authenticated-evidence';

const timestampSchema = z.iso.datetime({ offset: true });
const rawAttemptSchema = agentTaskRetainedAttemptV1Schema.omit({
  sourceDigest: true,
  candidateDigest: true,
  attemptDigest: true,
});
const rawLedgerSchema = z
  .object({
    caseId: z.enum(APPROVED_AGENT_TASK_CASE_IDS_V1),
    attempts: z.array(rawAttemptSchema),
  })
  .strict();

export const formalAgentTaskRetainedInputV1Schema = z
  .object({
    schema: z.literal('FormalAgentTaskRetainedInputV1'),
    executionClass: z.enum(['contract_conformance', 'production_route_run']),
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    candidate: agentTaskCandidateIdentityV1Schema,
    caseLedgers: z.array(rawLedgerSchema),
    adversarialReceipts: z.array(agentTaskFormalAdversarialReceiptV1Schema),
  })
  .strict();

export type FormalAgentTaskRetainedInputV1 = z.infer<typeof formalAgentTaskRetainedInputV1Schema>;

export interface AgentTaskContractInputIdentityV1 {
  repository: string;
  repositoryId: string;
  headSha: string;
  stage: AgentTaskCandidateIdentityV1['stage'];
  startedAt: string;
}

export function createAgentTaskContractConformanceInputV1(
  identity: AgentTaskContractInputIdentityV1,
): FormalAgentTaskRetainedInputV1 {
  const startedAt = timestampSchema.parse(identity.startedAt);
  const startMs = Date.parse(startedAt);
  const attemptsPerCase = identity.stage === 'release_candidate' ? 20 : 8;
  const candidateArtifact = contractArtifactIdentity(
    identity.repository,
    identity.repositoryId,
    identity.headSha,
    'candidate',
  );
  const baselineWithoutDigest = {
    schema: 'AgentTaskRealFrozenBaselineV1' as const,
    baselineId: 'agent-task-contract-conformance-baseline-v1',
    routeIdentity: 'unconfigured:contract-conformance',
    routeDigest: digest('contract-route'),
    releaseArtifactIdentity: contractArtifactIdentity(
      identity.repository,
      identity.repositoryId,
      identity.headSha,
      'baseline',
    ),
    oracleDigest: digest('contract-baseline-oracle'),
    configDigest: digest('contract-baseline-config'),
    frozenAt: new Date(startMs - 86_400_000).toISOString(),
    p95: { latencyMs: 1_000, totalTokens: 1_000, userCorrections: 4 },
  };
  const candidate: AgentTaskCandidateIdentityV1 = {
    schema: 'AgentTaskCandidateIdentityV1',
    stage: identity.stage,
    suiteId: APPROVED_AGENT_TASK_SUITE_V1.suiteId,
    suiteRevision: APPROVED_AGENT_TASK_SUITE_V1.revision,
    suiteDigest: APPROVED_AGENT_TASK_SUITE_V1.suiteDigest,
    routeIdentity: baselineWithoutDigest.routeIdentity,
    routeDigest: baselineWithoutDigest.routeDigest,
    releaseArtifactIdentity: candidateArtifact,
    oracleDigest: digest('contract-oracle'),
    configDigest: digest('contract-config'),
    frozenBaseline: {
      ...baselineWithoutDigest,
      baselineDigest: computeAgentTaskFrozenBaselineDigestV1(baselineWithoutDigest),
    },
  };
  const caseLedgers: FormalAgentTaskRetainedInputV1['caseLedgers'] =
    APPROVED_AGENT_TASK_CASE_IDS_V1.map((caseId, caseIndex) => ({
      caseId,
      attempts: Array.from({ length: attemptsPerCase }, (_, attemptIndex) => {
        const ordinal = caseIndex * attemptsPerCase + attemptIndex;
        return {
          schema: 'AgentTaskRetainedAttemptV1' as const,
          caseId,
          attemptIndex,
          attemptId: `contract-${caseIndex + 1}-${attemptIndex + 1}`,
          startedAt: new Date(startMs + ordinal * 2).toISOString(),
          endedAt: new Date(startMs + ordinal * 2 + 1).toISOString(),
          retained: true as const,
          outcome: 'passed' as const,
          checksPassed: true,
          verificationStatus: 'passed' as const,
          oracleResultDigest: digest(`contract-oracle-${caseIndex}-${attemptIndex}`),
          metrics: { latencyMs: 100, totalTokens: 500, userCorrections: 0 },
          g0: emptyG0(),
        };
      }),
    }));
  const attemptCount = attemptsPerCase * APPROVED_AGENT_TASK_CASE_IDS_V1.length;
  return formalAgentTaskRetainedInputV1Schema.parse({
    schema: 'FormalAgentTaskRetainedInputV1',
    executionClass: 'contract_conformance',
    startedAt,
    endedAt: new Date(startMs + attemptCount * 2).toISOString(),
    candidate,
    caseLedgers,
    adversarialReceipts: ADVERSARIAL_CONTRACT_CATALOG_V1.map((entry, index) => ({
      schema: 'AgentTaskFormalAdversarialReceiptV1' as const,
      caseId: entry.caseId,
      reportDigest: digest(`contract-adversarial-${index}`),
      outcome: 'passed' as const,
      g0: emptyG0(),
    })),
  });
}

export function produceUnsignedAgentTaskEvidenceV1(input: {
  retainedInput: unknown;
  source: Omit<AgentTaskEvidenceSourceV1, 'startedAt' | 'endedAt'>;
  signedAt: string;
}): AuthenticatedAgentTaskEvidenceV1 {
  const retained = formalAgentTaskRetainedInputV1Schema.parse(input.retainedInput);
  const source = agentTaskEvidenceSourceV1Schema.parse({
    ...input.source,
    startedAt: retained.startedAt,
    endedAt: retained.endedAt,
  });
  const signedAt = timestampSchema.parse(input.signedAt);
  const sourceDigest = computeAgentTaskSourceDigestV1(source);
  const candidateDigest = computeAgentTaskCandidateDigestV1(retained.candidate);
  const caseLedgers: AgentTaskCaseLedgerV1[] = retained.caseLedgers.map((ledger) => {
    const attempts = ledger.attempts.map((attempt) => {
      const material = {
        ...attempt,
        sourceDigest,
        candidateDigest,
      };
      return { ...material, attemptDigest: computeAgentTaskAttemptDigestV1(material) };
    });
    const material = {
      schema: 'AgentTaskCaseLedgerV1' as const,
      caseId: ledger.caseId,
      attempts,
    };
    return { ...material, ledgerDigest: computeAgentTaskCaseLedgerDigestV1(material) };
  });
  const adversarialMaterial: Omit<AgentTaskFormalAdversarialEvidenceV1, 'evidenceDigest'> = {
    schema: 'AgentTaskFormalAdversarialEvidenceV1',
    sourceDigest,
    candidateDigest,
    catalogDigest: AGENT_TASK_ADVERSARIAL_CATALOG_DIGEST_V1,
    status: retained.adversarialReceipts.every((receipt) => receipt.outcome === 'passed')
      ? 'passed'
      : 'failed',
    receipts: retained.adversarialReceipts,
  };
  const evidenceWithoutDigest = {
    schema: 'AuthenticatedAgentTaskEvidenceV1' as const,
    executionClass: retained.executionClass,
    source,
    candidate: retained.candidate,
    caseLedgers,
    adversarial: {
      ...adversarialMaterial,
      evidenceDigest: computeAgentTaskAdversarialEvidenceDigestV1(adversarialMaterial),
    },
    signedAt,
    signerIdentity: 'unconfigured:github-oidc-keyless-sigstore',
    keyId: 'unconfigured:production-agent-task-sigstore-verifier',
  };
  const evidence = authenticatedAgentTaskEvidenceV1Schema.parse({
    ...evidenceWithoutDigest,
    bundleDigest: computeAuthenticatedAgentTaskBundleDigestV1(evidenceWithoutDigest),
    signature: {
      kind: 'unconfigured',
      algorithm: 'none',
      reason: 'production_sigstore_unconfigured',
    },
  });
  verifyAuthenticatedAgentTaskEvidenceV1(evidence);
  return evidence;
}

function contractArtifactIdentity(
  repository: string,
  repositoryId: string,
  commit: string,
  label: string,
): ReleaseArtifactIdentityV1 {
  return {
    canonicalRepository: repository,
    repositoryId,
    commit,
    payloadSha256: digest(`${label}-payload`),
    canonicalManifestDigest: digest(`${label}-manifest`),
    behaviorDigest: digest(`${label}-behavior`),
    profileDigest: digest(`${label}-profile`),
    gatePolicyDigest: digest(`${label}-gate`),
  };
}

function emptyG0() {
  return {
    unauthorizedEffects: 0,
    secretOrContentExfiltration: 0,
    sandboxEscape: 0,
    falseCompletion: 0,
    requiredVerificationBypass: 0,
    concurrencyOrOrderingBypass: 0,
  };
}

function digest(label: string): `sha256:${string}` {
  return sha256DomainSeparated('kite.evals.agent-task-contract-conformance.v1', label);
}

function readArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (const entry of argv) {
    const match = /^--([a-z0-9-]+)=(.+)$/.exec(entry);
    if (!match?.[1] || match[2] === undefined) throw new Error(`Invalid argument: ${entry}`);
    args.set(match[1], match[2]);
  }
  return args;
}

function required(args: Map<string, string>, name: string): string {
  const value = args.get(name);
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

function sourceFromArgs(
  args: Map<string, string>,
): Omit<AgentTaskEvidenceSourceV1, 'startedAt' | 'endedAt'> {
  return {
    schema: 'AgentTaskEvidenceSourceV1',
    repository: required(args, 'repository'),
    repositoryId: required(args, 'repository-id'),
    headSha: required(args, 'head-sha'),
    ref: required(args, 'ref'),
    workflowPath: required(args, 'workflow-path'),
    workflowRef: required(args, 'workflow-ref'),
    workflowSha: required(args, 'workflow-sha'),
    runId: required(args, 'run-id'),
    runAttempt: Number(required(args, 'run-attempt')),
    job: required(args, 'job'),
    artifactId: required(args, 'artifact-id'),
    artifactName: required(args, 'artifact-name'),
  };
}

if (import.meta.main) {
  const args = readArgs(process.argv.slice(2));
  const mode = required(args, 'mode');
  const output = resolve(required(args, 'output'));
  if (mode === 'contract-input') {
    const stage = required(args, 'stage');
    if (stage !== 'pinned_route_or_baseline_change' && stage !== 'release_candidate') {
      throw new Error('Unknown Agent task qualification stage.');
    }
    const retained = createAgentTaskContractConformanceInputV1({
      repository: required(args, 'repository'),
      repositoryId: required(args, 'repository-id'),
      headSha: required(args, 'head-sha'),
      stage,
      startedAt: required(args, 'started-at'),
    });
    writeFileSync(output, canonicalJsonBytes(retained));
  } else if (mode === 'produce') {
    const retainedInput = parseCanonicalJson(readFileSync(resolve(required(args, 'input'))));
    const evidence = produceUnsignedAgentTaskEvidenceV1({
      retainedInput,
      source: sourceFromArgs(args),
      signedAt: required(args, 'signed-at'),
    });
    writeFileSync(output, canonicalJsonBytes(evidence));
  } else {
    throw new Error(`Unknown producer mode: ${mode}`);
  }
}
