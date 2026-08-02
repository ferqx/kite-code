import { canonicalJsonBytes, sha256Digest } from '../../../scripts/release/canonical-json';
import type { CompactionCaseV1 } from './schema';
import { parseCompactionCase } from './schema';

export const FACT_MATCHER_REVISION = 'compaction-fact-matcher-v1' as const;

export interface FactMatchReportV1 {
  version: 1;
  matcherRevision: typeof FACT_MATCHER_REVISION;
  executionClass: 'synthetic_fixture';
  distribution: 'nonDistributable';
  evidenceEligible: false;
  status: 'blocked';
  deterministicOutcome: 'passed' | 'failed';
  criticalMissing: string[];
  importantMissing: string[];
  semanticNotObserved: string[];
  forbiddenClaimsFound: string[];
  reversalViolations: string[];
  caseDigest: `sha256:${string}`;
  digest: `sha256:${string}`;
}

export function matchCompactionFacts(
  caseValue: CompactionCaseV1,
  summary: string,
): FactMatchReportV1 {
  const fixture = parseCompactionCase(caseValue);
  if (summary.length > 64 * 1024) throw new Error('Synthetic summary exceeds matcher input limit.');
  const criticalMissing: string[] = [];
  const importantMissing: string[] = [];
  const semanticNotObserved: string[] = [];
  const reversalViolations: string[] = [];
  for (const fact of fixture.facts) {
    if (fact.matcher === 'semantic') {
      semanticNotObserved.push(fact.factId);
      continue;
    }
    const matched =
      fact.matcher === 'exact'
        ? summary.includes(fact.expected)
        : normalizeFactText(summary).includes(normalizeFactText(fact.expected));
    if (!matched) {
      (fact.importance === 'critical' ? criticalMissing : importantMissing).push(fact.factId);
      if (
        fact.importance === 'critical' &&
        ['approval', 'verification', 'plan_state'].includes(fact.category)
      ) {
        reversalViolations.push(fact.factId);
      }
    }
  }
  const normalizedSummary = normalizeFactText(summary);
  const forbiddenClaimsFound = fixture.forbiddenClaims
    .filter((claim) => normalizedSummary.includes(normalizeFactText(claim)))
    .sort();
  const deterministicOutcome =
    criticalMissing.length === 0 &&
    forbiddenClaimsFound.length === 0 &&
    reversalViolations.length === 0
      ? ('passed' as const)
      : ('failed' as const);
  const caseDigest = sha256Digest(canonicalJsonBytes(fixture));
  const withoutDigest = {
    version: 1 as const,
    matcherRevision: FACT_MATCHER_REVISION,
    executionClass: 'synthetic_fixture' as const,
    distribution: 'nonDistributable' as const,
    evidenceEligible: false as const,
    status: 'blocked' as const,
    deterministicOutcome,
    criticalMissing: criticalMissing.sort(),
    importantMissing: importantMissing.sort(),
    semanticNotObserved: semanticNotObserved.sort(),
    forbiddenClaimsFound,
    reversalViolations: reversalViolations.sort(),
    caseDigest,
  };
  return { ...withoutDigest, digest: sha256Digest(canonicalJsonBytes(withoutDigest)) };
}

export function normalizeFactText(value: string): string {
  return value
    .normalize('NFKC')
    .replaceAll('\\', '/')
    .replace(/(^|[\s("'])\.\//g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}
