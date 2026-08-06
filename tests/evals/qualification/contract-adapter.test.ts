import { describe, expect, test } from 'bun:test';
import {
  buildL0ContractReceiptV1,
  l0ContractReceiptV1Schema,
  runL0ContractAdapterV1,
  runL0ContractCorpusV1,
} from '../../../scripts/evals/contracts/qualification/l0-contract-adapter-v1';
import {
  buildL0EvaluatorIdentityV1,
  buildL0SourceOwnedBindingV1,
  L0_CONTRACT_ADAPTERS_V1,
} from '../../../scripts/evals/contracts/qualification/l0-contract-schema-v1';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../scripts/release/canonical-json';

const evaluator = buildL0EvaluatorIdentityV1({
  oracle: { source: 'contract-adapter-test' },
  verifier: { source: 'contract-adapter-test' },
  adapterDependency: { source: 'contract-adapter-test' },
  runnerDependency: {
    fixtureId: 'l0-contract-fixture-v1',
    runner: 'qualification-l0-contract-runner-v1',
  },
});

describe('source-owned L0 contract adapter', () => {
  test('runs every registered product adapter through its matching source-owned pair', () => {
    for (const adapter of L0_CONTRACT_ADAPTERS_V1) {
      const result = runL0ContractAdapterV1(
        buildL0SourceOwnedBindingV1({
          sourceSurfaceId: `fixture:${adapter.adapterId}`,
          declaration: adapter,
        }),
      );
      expect(result).toEqual({
        adapterId: adapter.adapterId,
        assertionId: adapter.assertionId,
        outcome: 'passed',
      });
    }
  });

  test('passes the complete Good/Bad and mutation corpus only when every guard rejects its mutation', () => {
    const report = runL0ContractCorpusV1({ evaluator });
    expect(report.status).toBe('accepted');
    expect(report.falseRejectCaseIds).toEqual([]);
    expect(report.acceptedNegativeCaseIds).toEqual([]);
  });

  test('rejects endpoint and absolute-path metadata before an L0 receipt can be persisted', () => {
    const adapter = L0_CONTRACT_ADAPTERS_V1[0]!;
    const binding = buildL0SourceOwnedBindingV1({
      sourceSurfaceId: 'fixture:approval',
      declaration: adapter,
    });
    for (const unsafeSourceSurfaceId of [
      'https://provider.invalid/full-endpoint',
      'https:/provider.invalid/normalized-uri',
      'file:/private/tmp/secret',
      'http:provider.invalid',
      'C:/Users/fixture',
    ]) {
      expect(() =>
        buildL0ContractReceiptV1({
          sourceSurfaceId: unsafeSourceSurfaceId,
          featureId: 'AUTHORIZATION-APPROVAL-001',
          binding,
          matrixDigest: `sha256:${'a'.repeat(64)}`,
          suiteDigest: `sha256:${'b'.repeat(64)}`,
          evaluatorReport: runL0ContractCorpusV1({ evaluator }),
          adapterResult: runL0ContractAdapterV1(binding),
        }),
      ).toThrow('L0 identifier');
    }
    const receipt = buildL0ContractReceiptV1({
      sourceSurfaceId: 'fixture:approval',
      featureId: 'AUTHORIZATION-APPROVAL-001',
      binding,
      matrixDigest: `sha256:${'a'.repeat(64)}`,
      suiteDigest: `sha256:${'b'.repeat(64)}`,
      evaluatorReport: runL0ContractCorpusV1({ evaluator }),
      adapterResult: runL0ContractAdapterV1(binding),
    });
    const { receiptDigest: _receiptDigest, ...receiptMaterial } = receipt;
    expect(
      l0ContractReceiptV1Schema.safeParse({
        ...receiptMaterial,
        sourceBindingDigest: `sha256:${'f'.repeat(64)}`,
        receiptDigest: sha256DomainSeparated(
          'kite.qualification.l0.contract-receipt.v1',
          canonicalJsonBytes({
            ...receiptMaterial,
            sourceBindingDigest: `sha256:${'f'.repeat(64)}`,
          }),
        ),
      }).success,
    ).toBeFalse();
  });
});
