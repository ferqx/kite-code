import { BROKERED_GIT_FEATURE_REVISION_, type GitShellDenyEvidence } from '@kite-ai/runtime-spi';

export type BrokeredGitQualificationDecision =
  | { outcome: 'qualified'; evidence: GitShellDenyEvidence }
  | {
      outcome: 'excluded';
      reason:
        | 'feature_revision_mismatch'
        | 'backend_none'
        | 'metadata_read_deny_unproven'
        | 'metadata_write_deny_unproven'
        | 'evidence_excluded';
    };

export function qualifyBrokeredGitNativeDeny(
  evidence: GitShellDenyEvidence,
): BrokeredGitQualificationDecision {
  if (evidence.featureRevision !== BROKERED_GIT_FEATURE_REVISION_) {
    return { outcome: 'excluded', reason: 'feature_revision_mismatch' };
  }
  if (evidence.outcome !== 'qualified') {
    return { outcome: 'excluded', reason: 'evidence_excluded' };
  }
  if (evidence.backend === 'none') return { outcome: 'excluded', reason: 'backend_none' };
  if (!evidence.metadataReadDeny) {
    return { outcome: 'excluded', reason: 'metadata_read_deny_unproven' };
  }
  if (!evidence.metadataWriteDeny) {
    return { outcome: 'excluded', reason: 'metadata_write_deny_unproven' };
  }
  return { outcome: 'qualified', evidence };
}
