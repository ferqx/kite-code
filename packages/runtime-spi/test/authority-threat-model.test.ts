import { describe, expect, test } from 'bun:test';
import {
  assertRav1AuthorityThreatModelV1,
  RAV1_AUTHORITY_SEQUENCE_V1,
  RAV1_AUTHORITY_THREAT_MODEL_SCHEMA_V1,
  type Rav1AuthorityBoundaryDescriptorV1,
  type Rav1AuthorityThreatModelV1,
} from '../src';

const boundary = (
  input: Partial<Rav1AuthorityBoundaryDescriptorV1> &
    Pick<Rav1AuthorityBoundaryDescriptorV1, 'boundaryId'>,
): Rav1AuthorityBoundaryDescriptorV1 => {
  const { boundaryId, ...overrides } = input;
  return {
    boundaryId,
    carrier: 'in_process_typed',
    runtimeActors: ['agent_kernel', 'runtime_host'],
    boundaryActors: [],
    sourceTrust: ['trusted_runtime'],
    serialized: false,
    persisted: false,
    authorityBearing: true,
    secretMaterialAllowed: false,
    authenticity: 'not_applicable_schema_and_identity_only',
    keyCustody: 'none',
    attackerClasses: ['identity_mixup_or_trusted_code_bug'],
    ...overrides,
  };
};

const model = (
  boundaries: readonly Rav1AuthorityBoundaryDescriptorV1[],
): Rav1AuthorityThreatModelV1 => ({
  schema: RAV1_AUTHORITY_THREAT_MODEL_SCHEMA_V1,
  trustedInProcessActors: ['agent_kernel', 'runtime_host', 'builtin_runtime'],
  sequence: RAV1_AUTHORITY_SEQUENCE_V1,
  excludedAttackers: [
    'malicious_trusted_in_process_runtime',
    'compromised_operating_system_or_kernel',
    'arbitrary_process_memory_read',
  ],
  boundaries,
});

describe('RAV1-00 authority threat-model contract', () => {
  test('accepts typed, persisted, process, and OS-broker boundary classifications', () => {
    expect(() =>
      assertRav1AuthorityThreatModelV1(
        model([
          boundary({ boundaryId: 'kernel_host_typed' }),
          boundary({
            boundaryId: 'runtime_store',
            carrier: 'persisted_serialized',
            runtimeActors: ['runtime_host'],
            boundaryActors: ['storage_adapter'],
            sourceTrust: ['trusted_runtime', 'local_same_user_state'],
            serialized: true,
            persisted: true,
            authenticity: 'keyless_integrity_only',
            keyCustody: 'none',
            attackerClasses: ['same_user_persisted_state_tamper', 'stale_or_replayed_record'],
          }),
          boundary({
            boundaryId: 'sandbox_worker_protocol',
            carrier: 'out_of_process_protocol',
            runtimeActors: ['runtime_host', 'sandbox_supervisor'],
            boundaryActors: ['sandbox_worker'],
            sourceTrust: ['trusted_runtime', 'untrusted_child_process'],
            serialized: true,
            authenticity: 'peer_or_message_authentication_required',
            keyCustody: 'invocation_local_material',
            attackerClasses: ['untrusted_child_process', 'stale_or_replayed_record'],
          }),
          boundary({
            boundaryId: 'credential_vault',
            carrier: 'persisted_serialized',
            runtimeActors: ['builtin_runtime'],
            boundaryActors: ['credential_broker'],
            sourceTrust: ['trusted_runtime', 'trusted_os_broker'],
            serialized: true,
            persisted: true,
            authenticity: 'external_transport_or_os_broker',
            keyCustody: 'os_credential_vault',
            attackerClasses: ['identity_mixup_or_trusted_code_bug'],
          }),
        ]),
      ),
    ).not.toThrow();
  });

  test('rejects cryptographic authenticity on trusted in-process typed calls', () => {
    expect(() =>
      assertRav1AuthorityThreatModelV1(
        model([
          boundary({
            boundaryId: 'fake_typed_hmac',
            authenticity: 'peer_or_message_authentication_required',
            keyCustody: 'invocation_local_material',
          }),
        ]),
      ),
    ).toThrow(/in_process_crypto_invalid/u);
  });

  test('rejects persisted carriers that are not serialized even with keyless integrity', () => {
    expect(() =>
      assertRav1AuthorityThreatModelV1(
        model([
          boundary({
            boundaryId: 'invalid_persisted_record',
            carrier: 'persisted_serialized',
            runtimeActors: ['runtime_host'],
            boundaryActors: ['storage_adapter'],
            sourceTrust: ['local_same_user_state'],
            persisted: true,
            authenticity: 'keyless_integrity_only',
            keyCustody: 'none',
            attackerClasses: ['same_user_persisted_state_tamper'],
          }),
        ]),
      ),
    ).toThrow(/serialized_boundary_invalid/u);
  });

  test('rejects duplicate boundary identities and any secret-bearing authority material', () => {
    expect(() =>
      assertRav1AuthorityThreatModelV1(
        model([boundary({ boundaryId: 'duplicate' }), boundary({ boundaryId: 'duplicate' })]),
      ),
    ).toThrow(/boundary_duplicate/u);
    expect(() =>
      assertRav1AuthorityThreatModelV1(
        model([
          {
            ...boundary({ boundaryId: 'secret_grant' }),
            secretMaterialAllowed: true,
          } as unknown as Rav1AuthorityBoundaryDescriptorV1,
        ]),
      ),
    ).toThrow(/secret_material_invalid/u);
  });

  test('rejects authority-bearing notification projections', () => {
    expect(() =>
      assertRav1AuthorityThreatModelV1(
        model([
          boundary({
            boundaryId: 'notification_projection',
            carrier: 'non_authoritative_projection',
            runtimeActors: ['runtime_host'],
            boundaryActors: ['client'],
            authorityBearing: true,
            authenticity: 'not_authority',
          }),
        ]),
      ),
    ).toThrow(/boundary_invalid/u);
  });
});
