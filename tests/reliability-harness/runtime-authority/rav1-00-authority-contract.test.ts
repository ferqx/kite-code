import { describe, expect, test } from 'bun:test';
import { assertRav1AuthorityThreatModelV1, RAV1_AUTHORITY_SEQUENCE_V1 } from '@kite/runtime-spi';
import { RAV1_00_BOUNDARY_INVENTORY_V1 } from './rav1-00-boundary-inventory';

const EXPECTED_BOUNDARIES = Object.freeze([
  'client_command',
  'trusted_runtime_typed_authority',
  'runtime_store_records',
  'private_artifact_files',
  'posix_sandbox_control_protocol',
  'windows_sandbox_runner_protocol',
  'filesystem_and_process_effect',
  'mcp_http_transport',
  'mcp_stdio_transport',
  'model_provider_transport',
  'credential_vault',
  'client_notification_projection',
] as const);

describe('RAV1-00 real authority boundary inventory', () => {
  test('freezes the exact authority sequence and current boundary set', () => {
    expect(() => assertRav1AuthorityThreatModelV1(RAV1_00_BOUNDARY_INVENTORY_V1)).not.toThrow();
    expect(RAV1_00_BOUNDARY_INVENTORY_V1.sequence).toEqual(RAV1_AUTHORITY_SEQUENCE_V1);
    expect(RAV1_00_BOUNDARY_INVENTORY_V1.boundaries.map((item) => item.boundaryId)).toEqual([
      ...EXPECTED_BOUNDARIES,
    ]);
  });

  test('uses keyless persistence and invocation-local material only at real boundaries', () => {
    const sameProcess = RAV1_00_BOUNDARY_INVENTORY_V1.boundaries.filter(
      (item) => item.carrier === 'in_process_typed',
    );
    expect(sameProcess.length).toBe(2);
    expect(
      sameProcess.every(
        (item) =>
          item.authenticity === 'not_applicable_schema_and_identity_only' &&
          item.keyCustody === 'none',
      ),
    ).toBe(true);

    expect(
      RAV1_00_BOUNDARY_INVENTORY_V1.boundaries.find(
        (item) => item.boundaryId === 'runtime_store_records',
      ),
    ).toMatchObject({ authenticity: 'keyless_integrity_only', keyCustody: 'none' });

    const ephemeral = RAV1_00_BOUNDARY_INVENTORY_V1.boundaries
      .filter((item) => item.keyCustody === 'invocation_local_material')
      .map((item) => item.boundaryId);
    expect(ephemeral).toEqual([
      'posix_sandbox_control_protocol',
      'windows_sandbox_runner_protocol',
      'mcp_stdio_transport',
    ]);
  });

  test('documents existing custody without treating notifications as authority', () => {
    const existing = new Map(
      RAV1_00_BOUNDARY_INVENTORY_V1.boundaries.map((item) => [item.boundaryId, item]),
    );
    expect(existing.get('private_artifact_files')).toMatchObject({
      authenticity: 'existing_authenticated_storage',
      keyCustody: 'installation_owner_file',
    });
    expect(existing.get('credential_vault')).toMatchObject({
      authenticity: 'external_transport_or_os_broker',
      keyCustody: 'os_credential_vault',
    });
    expect(existing.get('client_notification_projection')).toMatchObject({
      authorityBearing: false,
      authenticity: 'not_authority',
    });
  });

  test('forbids secret material in every authority carrier', () => {
    expect(
      RAV1_00_BOUNDARY_INVENTORY_V1.boundaries.every(
        (item) => item.secretMaterialAllowed === false,
      ),
    ).toBe(true);
  });
});
