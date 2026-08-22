/**
 * RAV1-00 architecture contract. It classifies where authority crosses a real
 * serialization or execution boundary; it does not issue grants, authenticate
 * messages, or change the production State/Store format.
 */

export const RAV1_AUTHORITY_THREAT_MODEL_SCHEMA_V1 =
  'kite.runtime-authority-threat-model.v1' as const;

export const RAV1_AUTHORITY_SEQUENCE_V1 = Object.freeze([
  'proposal',
  'kernel_intent',
  'required_authority',
  'approval_decision',
  'durable_grant',
  'execution_materialization',
  'attempt_acknowledgement',
  'external_dispatch',
  'bounded_receipt',
  'mailbox_fact',
  'kernel_receipt_acceptance',
] as const);

export type Rav1AuthoritySequenceStageV1 = (typeof RAV1_AUTHORITY_SEQUENCE_V1)[number];

export type Rav1AuthorityActorV1 =
  | 'client'
  | 'agent_kernel'
  | 'runtime_host'
  | 'builtin_runtime'
  | 'storage_adapter'
  | 'artifact_store'
  | 'sandbox_supervisor'
  | 'sandbox_worker'
  | 'filesystem_or_process'
  | 'mcp_endpoint'
  | 'model_endpoint'
  | 'credential_broker';

export type Rav1AuthorityCarrierV1 =
  | 'in_process_typed'
  | 'persisted_serialized'
  | 'out_of_process_protocol'
  | 'external_resource'
  | 'non_authoritative_projection';

export type Rav1AuthorityProducerTrustV1 =
  | 'untrusted_input'
  | 'trusted_runtime'
  | 'local_same_user_state'
  | 'untrusted_child_process'
  | 'untrusted_remote_endpoint'
  | 'trusted_os_broker';

export type Rav1AuthorityAuthenticityDispositionV1 =
  | 'not_applicable_schema_and_identity_only'
  | 'keyless_integrity_only'
  | 'existing_authenticated_storage'
  | 'peer_or_message_authentication_required'
  | 'external_transport_or_os_broker'
  | 'not_authority';

export type Rav1AuthorityKeyCustodyV1 =
  | 'none'
  | 'invocation_local_material'
  | 'installation_owner_file'
  | 'os_credential_vault'
  | 'transport_or_os_peer_identity';

export type Rav1AuthorityAttackerClassV1 =
  | 'untrusted_client_input'
  | 'same_user_persisted_state_tamper'
  | 'stale_or_replayed_record'
  | 'untrusted_child_process'
  | 'untrusted_remote_endpoint'
  | 'identity_mixup_or_trusted_code_bug'
  | 'clock_rollback'
  | 'cross_host_or_process_race';

export type Rav1AuthorityExcludedAttackerV1 =
  | 'malicious_trusted_in_process_runtime'
  | 'compromised_operating_system_or_kernel'
  | 'arbitrary_process_memory_read';

export interface Rav1AuthorityBoundaryDescriptorV1 {
  readonly boundaryId: string;
  readonly carrier: Rav1AuthorityCarrierV1;
  readonly runtimeActors: readonly Rav1AuthorityActorV1[];
  readonly boundaryActors: readonly Rav1AuthorityActorV1[];
  readonly sourceTrust: readonly Rav1AuthorityProducerTrustV1[];
  readonly serialized: boolean;
  readonly persisted: boolean;
  readonly authorityBearing: boolean;
  readonly secretMaterialAllowed: false;
  readonly authenticity: Rav1AuthorityAuthenticityDispositionV1;
  readonly keyCustody: Rav1AuthorityKeyCustodyV1;
  readonly attackerClasses: readonly Rav1AuthorityAttackerClassV1[];
}

export interface Rav1AuthorityThreatModelV1 {
  readonly schema: typeof RAV1_AUTHORITY_THREAT_MODEL_SCHEMA_V1;
  readonly trustedInProcessActors: readonly ['agent_kernel', 'runtime_host', 'builtin_runtime'];
  readonly sequence: typeof RAV1_AUTHORITY_SEQUENCE_V1;
  readonly excludedAttackers: readonly Rav1AuthorityExcludedAttackerV1[];
  readonly boundaries: readonly Rav1AuthorityBoundaryDescriptorV1[];
}

export type Rav1AuthorityThreatModelFailureCodeV1 =
  | 'schema_invalid'
  | 'trusted_domain_invalid'
  | 'sequence_invalid'
  | 'excluded_attacker_invalid'
  | 'boundary_invalid'
  | 'boundary_duplicate'
  | 'in_process_crypto_invalid'
  | 'serialized_boundary_invalid'
  | 'key_custody_invalid'
  | 'secret_material_invalid';

export class Rav1AuthorityThreatModelErrorV1 extends Error {
  readonly code: Rav1AuthorityThreatModelFailureCodeV1;

  constructor(code: Rav1AuthorityThreatModelFailureCodeV1) {
    super(`RAV1 authority threat model rejected: ${code}.`);
    this.name = 'Rav1AuthorityThreatModelErrorV1';
    this.code = code;
  }
}

/**
 * Exact, side-effect-free RAV1-00 fixture validator. It intentionally makes no
 * cryptographic choice: algorithms, canonical bytes, issuers, rotation, and
 * revocation are RAV1-02 work after this boundary inventory is frozen.
 */
export function assertRav1AuthorityThreatModelV1(
  value: Readonly<Rav1AuthorityThreatModelV1>,
): void {
  if (value.schema !== RAV1_AUTHORITY_THREAT_MODEL_SCHEMA_V1) fail('schema_invalid');
  if (
    !exactArray(value.trustedInProcessActors, ['agent_kernel', 'runtime_host', 'builtin_runtime'])
  ) {
    fail('trusted_domain_invalid');
  }
  if (!exactArray(value.sequence, RAV1_AUTHORITY_SEQUENCE_V1)) fail('sequence_invalid');
  if (
    value.excludedAttackers.length !== 3 ||
    !value.excludedAttackers.includes('malicious_trusted_in_process_runtime') ||
    !value.excludedAttackers.includes('compromised_operating_system_or_kernel') ||
    !value.excludedAttackers.includes('arbitrary_process_memory_read')
  ) {
    fail('excluded_attacker_invalid');
  }
  if (value.boundaries.length === 0) fail('boundary_invalid');

  const ids = new Set<string>();
  for (const boundary of value.boundaries) {
    assertBoundaryV1(boundary);
    if (ids.has(boundary.boundaryId)) fail('boundary_duplicate');
    ids.add(boundary.boundaryId);
  }
}

function assertBoundaryV1(boundary: Readonly<Rav1AuthorityBoundaryDescriptorV1>): void {
  if (
    !/^[a-z][a-z0-9_]{2,63}$/u.test(boundary.boundaryId) ||
    boundary.runtimeActors.length === 0 ||
    boundary.sourceTrust.length === 0 ||
    boundary.attackerClasses.length === 0
  ) {
    fail('boundary_invalid');
  }
  if (boundary.secretMaterialAllowed !== false) fail('secret_material_invalid');

  if (boundary.carrier === 'in_process_typed') {
    if (boundary.serialized || boundary.persisted) fail('serialized_boundary_invalid');
    if (
      boundary.authenticity !== 'not_applicable_schema_and_identity_only' ||
      boundary.keyCustody !== 'none'
    ) {
      fail('in_process_crypto_invalid');
    }
    return;
  }

  if (boundary.carrier === 'non_authoritative_projection') {
    if (boundary.authorityBearing || boundary.authenticity !== 'not_authority') {
      fail('boundary_invalid');
    }
    if (boundary.keyCustody !== 'none') fail('key_custody_invalid');
    return;
  }

  if (boundary.carrier === 'persisted_serialized') {
    if (!boundary.serialized || !boundary.persisted) fail('serialized_boundary_invalid');
    if (
      boundary.authenticity !== 'existing_authenticated_storage' &&
      boundary.authenticity !== 'keyless_integrity_only' &&
      boundary.authenticity !== 'external_transport_or_os_broker'
    ) {
      fail('boundary_invalid');
    }
  }

  if (boundary.carrier === 'out_of_process_protocol' && !boundary.serialized) {
    fail('serialized_boundary_invalid');
  }

  if (boundary.authenticity === 'keyless_integrity_only' && boundary.keyCustody !== 'none') {
    fail('key_custody_invalid');
  }
  if (
    (boundary.authenticity === 'existing_authenticated_storage' ||
      boundary.authenticity === 'external_transport_or_os_broker') &&
    boundary.keyCustody === 'none'
  ) {
    fail('key_custody_invalid');
  }
  if (
    boundary.authenticity === 'peer_or_message_authentication_required' &&
    boundary.keyCustody !== 'invocation_local_material'
  ) {
    fail('key_custody_invalid');
  }
}

function exactArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fail(code: Rav1AuthorityThreatModelFailureCodeV1): never {
  throw new Rav1AuthorityThreatModelErrorV1(code);
}
