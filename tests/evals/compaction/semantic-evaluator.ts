import { canonicalJsonBytes, sha256Digest } from '../../../scripts/release/canonical-json';
import type { CompactionCaseV1 } from './schema';
import { parseCompactionCase } from './schema';
import { SEMANTIC_RUBRIC_VERSION } from './semantic-evidence';

export { SEMANTIC_RUBRIC_VERSION };

export interface BlindSemanticItemV1 {
  version: 1;
  blindId: string;
  reference: string;
  candidate: string;
}

export interface SyntheticSemanticContractV1 {
  version: 1;
  kind: 'blind_semantic_contract';
  source: 'synthetic_fixture';
  distribution: 'nonDistributable';
  evidenceEligible: false;
  rubricVersion: typeof SEMANTIC_RUBRIC_VERSION;
  evaluatorRoute: 'unconfigured';
  evaluatorConfigDigest: null;
  evaluatorOutcome: 'not_observed';
  status: 'blocked';
  uncertainty: null;
  items: BlindSemanticItemV1[];
  reasonCodes: ['evaluator_unconfigured', 'live_evaluation_not_observed'];
  digest: `sha256:${string}`;
}

export function buildSyntheticBlindSemanticContract(
  caseValue: CompactionCaseV1,
  candidateSummary: string,
): SyntheticSemanticContractV1 {
  const fixture = parseCompactionCase(caseValue);
  if (candidateSummary.length > 64 * 1024) {
    throw new Error('Synthetic semantic candidate exceeds input limit.');
  }
  const items = fixture.facts
    .filter((fact) => fact.matcher === 'semantic')
    .map((fact, index) => ({
      version: 1 as const,
      blindId: `item-${String(index + 1).padStart(3, '0')}`,
      reference: fact.expected,
      candidate: candidateSummary,
    }));
  if (items.length === 0) throw new Error('Case has no semantic facts to evaluate.');
  const withoutDigest = {
    version: 1 as const,
    kind: 'blind_semantic_contract' as const,
    source: 'synthetic_fixture' as const,
    distribution: 'nonDistributable' as const,
    evidenceEligible: false as const,
    rubricVersion: SEMANTIC_RUBRIC_VERSION,
    evaluatorRoute: 'unconfigured' as const,
    evaluatorConfigDigest: null,
    evaluatorOutcome: 'not_observed' as const,
    status: 'blocked' as const,
    uncertainty: null,
    items,
    reasonCodes: [
      'evaluator_unconfigured',
      'live_evaluation_not_observed',
    ] as SyntheticSemanticContractV1['reasonCodes'],
  };
  return { ...withoutDigest, digest: sha256Digest(canonicalJsonBytes(withoutDigest)) };
}
