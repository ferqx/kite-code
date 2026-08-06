import { describe, expect, test } from 'bun:test';
import { buildQualificationSuiteV1 } from '../../../scripts/evals/contracts/qualification/feature-matrix';
import {
  buildL1PublicProjectionEvaluatorV1,
  buildL1PublicProjectionReceiptV1,
  L1_PUBLIC_PROJECTION_ADAPTER_IMPLEMENTATIONS_V1,
  runL1PublicProjectionAdaptersV1,
  runL1PublicProjectionContractCorpusV1,
} from '../../../scripts/evals/contracts/qualification/l1-public-projection-adapter-v1';
import {
  buildL1PublicProjectionSourceOwnedBindingV1,
  buildL1PublicProjectionSuiteV1,
  L1_PUBLIC_PROJECTION_ADAPTERS_V1,
  L1_PUBLIC_PROJECTION_CASE_IDS_V1,
} from '../../../scripts/evals/contracts/qualification/l1-public-projection-schema-v1';

describe('L1 public CLI/TUI projection qualification', () => {
  test('calls only the real public projection functions and retains only stable outcome tokens', () => {
    expect(runL1PublicProjectionAdaptersV1()).toEqual(
      L1_PUBLIC_PROJECTION_ADAPTERS_V1.map((entry) => ({ ...entry, outcome: 'passed' })),
    );

    const report = runL1PublicProjectionContractCorpusV1({
      evaluator: buildL1PublicProjectionEvaluatorV1(),
    });
    expect(report.status).toBe('accepted');
    expect(report.rejectedCaseIds).toEqual([]);
    expect(report.observations.map((observation) => observation.caseId)).toEqual([
      ...L1_PUBLIC_PROJECTION_CASE_IDS_V1,
    ]);
  });

  test('keeps independently digest-bound public projection pairs and exact product provenance', () => {
    const suite = buildL1PublicProjectionSuiteV1();
    expect(suite.suiteId).toBe('qualification-l1-public-projection-v1');
    expect(suite.assertionIds).toEqual(
      L1_PUBLIC_PROJECTION_ADAPTERS_V1.map((entry) => entry.assertionId),
    );
    expect(suite.suiteDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(L1_PUBLIC_PROJECTION_ADAPTER_IMPLEMENTATIONS_V1).toEqual([
      {
        adapterId: 'cli-invalid-arguments-projection-v1',
        assertionId: 'l1.projection.cli.invalid-arguments.v1',
        sourceRef: 'src/app/cli/runtime-event-projection.ts#projectCliRuntimeEventV1',
      },
      {
        adapterId: 'cli-tool-approval-projection-v1',
        assertionId: 'l1.projection.cli.tool-approval.v1',
        sourceRef: 'src/app/cli/runtime-event-projection.ts#projectCliRuntimeEventV1',
      },
      {
        adapterId: 'tui-invalid-arguments-projection-v1',
        assertionId: 'l1.projection.tui.invalid-arguments.v1',
        sourceRef: 'src/app/tui/reducers/handleEvent.ts#handleRuntimeEventAction',
      },
      {
        adapterId: 'tui-provider-action-projection-v1',
        assertionId: 'l1.projection.tui.provider-action.v1',
        sourceRef: 'src/app/tui/reducers/handleEvent.ts#handleRuntimeEventAction',
      },
      {
        adapterId: 'tui-tool-approval-projection-v1',
        assertionId: 'l1.projection.tui.tool-approval.v1',
        sourceRef: 'src/app/tui/reducers/handleEvent.ts#handleRuntimeEventAction',
      },
    ]);
  });

  test('rejects unsafe source metadata before a source-owned projection binding can exist', () => {
    const declaration = L1_PUBLIC_PROJECTION_ADAPTERS_V1[0]!;
    expect(() =>
      buildL1PublicProjectionSourceOwnedBindingV1({
        sourceSurfaceId: 'https://provider.invalid/endpoint',
        declaration,
      }),
    ).toThrow('L1 projection identifier');
    expect(() =>
      buildL1PublicProjectionSourceOwnedBindingV1({
        sourceSurfaceId: 'C:/Users/fixture',
        declaration,
      }),
    ).toThrow('L1 projection identifier');
  });

  test('seals each projection receipt to a source-owned Matrix suite, not its local self-contract', () => {
    const matrixSuite = buildQualificationSuiteV1({
      suiteId: 'qualification-l1-public-projection-v1',
      sourceRefs: [
        {
          kind: 'corpus',
          ref: 'scripts/evals/contracts/qualification/l1-public-projection-schema-v1.ts#L1_PUBLIC_PROJECTION_CORPUS_V1',
        },
        {
          kind: 'evaluator',
          ref: 'scripts/evals/contracts/qualification/l1-public-projection-evaluator-v1.ts#evaluateL1PublicProjectionCorpusV1',
        },
        {
          kind: 'oracle',
          ref: 'scripts/evals/contracts/qualification/l1-public-projection-adapter-v1.ts#runL1PublicProjectionAdaptersV1',
        },
        {
          kind: 'test',
          ref: 'tests/evals/qualification/public-projection-adapter.test.ts',
        },
        {
          kind: 'verifier',
          ref: 'scripts/evals/contracts/qualification/l1-public-projection-evaluator-v1.ts#evaluateL1PublicProjectionCorpusV1',
        },
      ],
      assertionIds: L1_PUBLIC_PROJECTION_ADAPTERS_V1.map((entry) => entry.assertionId),
      sourceFact: { owner: 'source-owned-fixture-v1' },
      evaluatorFact: { evaluator: 'fixture-v1' },
      oracleFact: { oracle: 'fixture-v1' },
      corpusFact: { corpus: 'fixture-v1' },
    });
    const adapter = L1_PUBLIC_PROJECTION_ADAPTERS_V1[0]!;
    const binding = buildL1PublicProjectionSourceOwnedBindingV1({
      sourceSurfaceId: 'fixture:cli-runtime-event-projection',
      declaration: adapter,
    });
    const report = runL1PublicProjectionContractCorpusV1({
      evaluator: buildL1PublicProjectionEvaluatorV1(),
    });
    const receipt = buildL1PublicProjectionReceiptV1({
      sourceSurfaceId: 'fixture:cli-runtime-event-projection',
      featureId: 'CLI-RUNTIME_EVENT_PROJECTION-001',
      binding,
      matrixDigest: `sha256:${'a'.repeat(64)}`,
      matrixSuite,
      evaluatorReport: report,
      adapterResult: runL1PublicProjectionAdaptersV1()[0]!,
    });
    expect(receipt).toMatchObject({
      authority: 'diagnostic',
      evidenceEligible: false,
      suiteId: matrixSuite.suiteId,
      suiteDigest: matrixSuite.suiteDigest,
      sourceBindingDigest: binding.bindingDigest,
      outcome: 'passed',
    });
    expect(receipt.receiptDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
