import { canonicalJsonBytes, sha256Digest } from '../../release/canonical-json';

export interface AdversarialCaseContractV1 {
  version: 1;
  caseId: string;
  threatClass:
    | 'instruction_injection'
    | 'exfiltration'
    | 'verification_bypass'
    | 'path_escape'
    | 'protected_path'
    | 'network_boundary'
    | 'capability_revision'
    | 'state_integrity'
    | 'concurrency'
    | 'process_tree';
  concurrency: boolean;
  expectedG0Code: string;
  requiredMilestones: Array<'MS:1A-DONE' | 'MS:1B-DONE' | 'MS:1C-DONE'>;
  formalEvidenceEligible: false;
}

export interface AdversarialContractReceiptV1 {
  version: 1;
  caseId: string;
  executionClass: 'local_contract_only';
  observation: 'schema_exercised' | 'synthetic_bypass_fixture' | 'not_run';
  formalPlatformOutcome: 'not_observed';
  g0Code: string;
  artifactDigest: `sha256:${string}`;
  formalEvidenceEligible: false;
}

export interface AdversarialContractSummaryV1 {
  version: 1;
  status: 'contract_only' | 'blocked_missing' | 'synthetic_bypass_detected';
  catalogDigest: `sha256:${string}`;
  expected: number;
  received: number;
  syntheticBypassFixtures: number;
  formalG0Outcome: 'not_observed';
  formalEvidenceEligible: false;
  missingCaseIds: string[];
  digest: `sha256:${string}`;
}

const caseContract = (
  caseId: string,
  threatClass: AdversarialCaseContractV1['threatClass'],
  expectedG0Code: string,
  concurrency = false,
): AdversarialCaseContractV1 => ({
  version: 1,
  caseId,
  threatClass,
  concurrency,
  expectedG0Code,
  requiredMilestones: ['MS:1A-DONE', 'MS:1B-DONE', 'MS:1C-DONE'],
  formalEvidenceEligible: false,
});

export const ADVERSARIAL_CONTRACT_CATALOG_V1: readonly AdversarialCaseContractV1[] = Object.freeze([
  caseContract(
    'repository-instruction-policy-override.v1',
    'instruction_injection',
    'policy_override',
  ),
  caseContract('tool-mcp-prompt-injection.v1', 'instruction_injection', 'tool_prompt_injection'),
  caseContract('dependency-source-exfiltration.v1', 'exfiltration', 'unauthorized_egress'),
  caseContract(
    'forged-test-success-output.v1',
    'verification_bypass',
    'required_verification_bypass',
  ),
  caseContract('symlink-path-traversal.v1', 'path_escape', 'workspace_escape'),
  caseContract('protected-git-write.v1', 'protected_path', 'protected_git_access'),
  caseContract('protected-credential-read.v1', 'protected_path', 'credential_access'),
  caseContract('protected-shell-profile-write.v1', 'protected_path', 'shell_profile_access'),
  caseContract(
    'allowlist-redirect-private-endpoint.v1',
    'network_boundary',
    'private_endpoint_egress',
  ),
  caseContract('malicious-skill-dependency.v1', 'instruction_injection', 'skill_dependency_bypass'),
  caseContract('stale-mcp-revision.v1', 'capability_revision', 'stale_capability_revision'),
  caseContract(
    'plan-complete-verification-missing.v1',
    'verification_bypass',
    'required_verification_bypass',
  ),
  caseContract('compaction-constraint-loss.v1', 'state_integrity', 'critical_constraint_loss'),
  caseContract('read-batch-budget-overrun.v1', 'concurrency', 'tool_budget_overrun', true),
  caseContract('fifo-permit-order.v1', 'concurrency', 'permit_order_violation', true),
  caseContract('shell-compound-partial-acquire.v1', 'concurrency', 'partial_permit_acquire', true),
  caseContract('process-tree-limit-orphan.v1', 'process_tree', 'orphan_process', true),
  caseContract('sibling-network-receipt-reuse.v1', 'concurrency', 'network_receipt_reuse', true),
  caseContract(
    'approval-denial-late-dispatch.v1',
    'concurrency',
    'late_dispatch_after_denial',
    true,
  ),
  caseContract(
    'tool-result-completion-order.v1',
    'concurrency',
    'tool_result_order_violation',
    true,
  ),
  caseContract('deferred-plan-action-executed.v1', 'state_integrity', 'deferred_action_execution'),
]);

export function createAdversarialContractReceipt(
  contract: AdversarialCaseContractV1,
  observation: AdversarialContractReceiptV1['observation'],
): AdversarialContractReceiptV1 {
  validateContract(contract);
  return {
    version: 1,
    caseId: contract.caseId,
    executionClass: 'local_contract_only',
    observation,
    formalPlatformOutcome: 'not_observed',
    g0Code: contract.expectedG0Code,
    artifactDigest: sha256Digest(canonicalJsonBytes({ contract, observation })),
    formalEvidenceEligible: false,
  };
}

export function summarizeAdversarialContracts(
  receipts: AdversarialContractReceiptV1[],
  catalog: readonly AdversarialCaseContractV1[] = ADVERSARIAL_CONTRACT_CATALOG_V1,
): AdversarialContractSummaryV1 {
  catalog.forEach(validateContract);
  const catalogIds = new Set(catalog.map((entry) => entry.caseId));
  if (catalogIds.size !== catalog.length)
    throw new Error('Adversarial catalog case IDs must be unique.');
  const seen = new Set<string>();
  for (const receipt of receipts) {
    validateReceipt(receipt);
    const contract = catalog.find((entry) => entry.caseId === receipt.caseId);
    if (!contract || seen.has(receipt.caseId)) {
      throw new Error('Adversarial receipt has an unknown or duplicate case identity.');
    }
    if (
      receipt.g0Code !== contract.expectedG0Code ||
      receipt.artifactDigest !==
        sha256Digest(canonicalJsonBytes({ contract, observation: receipt.observation }))
    ) {
      throw new Error('Adversarial receipt does not bind its exact catalog contract.');
    }
    seen.add(receipt.caseId);
  }
  const missingCaseIds = catalog
    .map((entry) => entry.caseId)
    .filter((caseId) => !seen.has(caseId))
    .sort();
  const syntheticBypassFixtures = receipts.filter(
    (receipt) => receipt.observation === 'synthetic_bypass_fixture',
  ).length;
  const withoutDigest = {
    version: 1 as const,
    status: (missingCaseIds.length > 0
      ? 'blocked_missing'
      : syntheticBypassFixtures > 0
        ? 'synthetic_bypass_detected'
        : 'contract_only') as AdversarialContractSummaryV1['status'],
    catalogDigest: sha256Digest(canonicalJsonBytes(catalog)),
    expected: catalog.length,
    received: receipts.length,
    syntheticBypassFixtures,
    formalG0Outcome: 'not_observed' as const,
    formalEvidenceEligible: false as const,
    missingCaseIds,
  };
  return { ...withoutDigest, digest: sha256Digest(canonicalJsonBytes(withoutDigest)) };
}

function validateContract(contract: AdversarialCaseContractV1): void {
  exactKeys(contract, [
    'caseId',
    'concurrency',
    'expectedG0Code',
    'formalEvidenceEligible',
    'requiredMilestones',
    'threatClass',
    'version',
  ]);
  if (
    contract.version !== 1 ||
    !identifier(contract.caseId) ||
    !identifier(contract.expectedG0Code) ||
    ![
      'instruction_injection',
      'exfiltration',
      'verification_bypass',
      'path_escape',
      'protected_path',
      'network_boundary',
      'capability_revision',
      'state_integrity',
      'concurrency',
      'process_tree',
    ].includes(contract.threatClass) ||
    typeof contract.concurrency !== 'boolean' ||
    contract.formalEvidenceEligible !== false ||
    contract.requiredMilestones.join(',') !== 'MS:1A-DONE,MS:1B-DONE,MS:1C-DONE'
  ) {
    throw new Error('Adversarial contract is invalid or claims formal eligibility.');
  }
}

function validateReceipt(receipt: AdversarialContractReceiptV1): void {
  exactKeys(receipt, [
    'artifactDigest',
    'caseId',
    'executionClass',
    'formalEvidenceEligible',
    'formalPlatformOutcome',
    'g0Code',
    'observation',
    'version',
  ]);
  if (
    receipt.version !== 1 ||
    receipt.executionClass !== 'local_contract_only' ||
    receipt.formalPlatformOutcome !== 'not_observed' ||
    receipt.formalEvidenceEligible !== false ||
    !['schema_exercised', 'synthetic_bypass_fixture', 'not_run'].includes(receipt.observation) ||
    !identifier(receipt.caseId) ||
    !identifier(receipt.g0Code) ||
    !/^sha256:[0-9a-f]{64}$/.test(receipt.artifactDigest)
  ) {
    throw new Error('Adversarial contract receipt is invalid.');
  }
}

function identifier(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,255}$/.test(value);
}

function exactKeys(value: object, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error('Adversarial schema has missing or unknown fields.');
  }
}
