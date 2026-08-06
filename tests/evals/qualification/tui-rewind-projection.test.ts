import { describe, expect, test } from 'bun:test';
import { buildQualificationSuiteV1 } from '../../../scripts/evals/contracts/qualification/feature-matrix';
import {
  buildL1TuiRewindForkProjectionEvaluatorV1,
  runL1TuiRewindForkProjectionAdaptersV1,
  runL1TuiRewindForkProjectionContractCorpusV1,
} from '../../../scripts/evals/contracts/qualification/l1-tui-rewind-projection-adapter-v1';
import {
  buildL1TuiRewindForkProjectionReceiptV1,
  l1TuiRewindForkProjectionReceiptBindingV1,
} from '../../../scripts/evals/contracts/qualification/l1-tui-rewind-projection-evidence-v1';
import {
  buildL1TuiRewindForkProjectionSourceOwnedBindingV1,
  buildL1TuiRewindForkProjectionSuiteV1,
  L1_TUI_REWIND_FORK_PROJECTION_ADAPTER_IMPLEMENTATIONS_V1,
  L1_TUI_REWIND_FORK_PROJECTION_ADAPTERS_V1,
  L1_TUI_REWIND_FORK_PROJECTION_SUITE_ID_V1,
} from '../../../scripts/evals/contracts/qualification/l1-tui-rewind-projection-schema-v1';

describe('AQ-6 diagnostic TUI rewind fork projection', () => {
  test('runs the real parsed TUI hook bridge and RuntimeStore fork under a fresh synthetic root', async () => {
    const results = await runL1TuiRewindForkProjectionAdaptersV1();
    expect(results).toEqual(
      L1_TUI_REWIND_FORK_PROJECTION_ADAPTERS_V1.map((entry) => ({ ...entry, outcome: 'passed' })),
    );

    const evaluator = buildL1TuiRewindForkProjectionEvaluatorV1();
    const report = await runL1TuiRewindForkProjectionContractCorpusV1({ evaluator });
    expect(report.evaluator.evaluatorDigest).toBe(evaluator.evaluatorDigest);
    expect(report.status).toBe('accepted');
    expect(report.rejectedCaseIds).toEqual([]);
  });

  test('keeps its closed pair independent from AQ-4 and seals a diagnostic-only receipt', async () => {
    const suite = buildL1TuiRewindForkProjectionSuiteV1();
    expect(suite.suiteId).toBe(L1_TUI_REWIND_FORK_PROJECTION_SUITE_ID_V1);
    expect(suite.suiteId).not.toBe('qualification-l1-public-projection-v1');
    expect(L1_TUI_REWIND_FORK_PROJECTION_ADAPTER_IMPLEMENTATIONS_V1).toEqual([
      {
        adapterId: 'tui-rewind-fork-projection-v1',
        assertionId: 'l1.projection.tui.rewind-fork-tightening.v1',
        sourceRef: 'src/app/tui/hooks/useRewindHandler.ts#useRunRewind',
        pathRefs: [
          'src/app/tui/public-surface.ts#parseSlashCommand',
          'src/app/tui/hooks/useSlashCommand.ts#useSlashCommand',
          'src/app/tui/hooks/useRewindHandler.ts#dispatchTuiRewindRequest',
          'src/app/tui/hooks/useRewindHandler.ts#useRunRewind',
          'src/core/runtime/store.ts#forkSession',
        ],
      },
    ]);

    const matrixSuite = buildQualificationSuiteV1({
      suiteId: L1_TUI_REWIND_FORK_PROJECTION_SUITE_ID_V1,
      sourceRefs: [
        {
          kind: 'corpus',
          ref: 'scripts/evals/contracts/qualification/l1-tui-rewind-projection-schema-v1.ts#L1_TUI_REWIND_FORK_PROJECTION_CORPUS_V1',
        },
        {
          kind: 'evaluator',
          ref: 'scripts/evals/contracts/qualification/l1-tui-rewind-projection-evaluator-v1.ts#evaluateL1TuiRewindForkProjectionCorpusV1',
        },
        {
          kind: 'oracle',
          ref: 'scripts/evals/contracts/qualification/l1-tui-rewind-projection-adapter-v1.ts#runL1TuiRewindForkProjectionAdaptersV1',
        },
        {
          kind: 'test',
          ref: 'tests/evals/qualification/tui-rewind-projection.test.ts',
        },
        {
          kind: 'verifier',
          ref: 'scripts/evals/contracts/qualification/l1-tui-rewind-projection-evaluator-v1.ts#evaluateL1TuiRewindForkProjectionCorpusV1',
        },
      ],
      assertionIds: ['l1.projection.tui.rewind-fork-tightening.v1'],
      sourceFact: { owner: 'source-owned-fixture-v1' },
      evaluatorFact: { evaluator: 'fixture-v1' },
      oracleFact: { oracle: 'fixture-v1' },
      corpusFact: { corpus: 'fixture-v1' },
    });
    const binding = buildL1TuiRewindForkProjectionSourceOwnedBindingV1({
      sourceSurfaceId: 'tui:rewind-control',
      declaration: L1_TUI_REWIND_FORK_PROJECTION_ADAPTERS_V1[0],
    });
    const evaluator = buildL1TuiRewindForkProjectionEvaluatorV1();
    const report = await runL1TuiRewindForkProjectionContractCorpusV1({ evaluator });
    const result = (await runL1TuiRewindForkProjectionAdaptersV1())[0]!;
    const receipt = buildL1TuiRewindForkProjectionReceiptV1({
      sourceSurfaceId: 'tui:rewind-control',
      featureId: 'TUI-REWIND_CONTROL-001',
      binding,
      matrixDigest: `sha256:${'a'.repeat(64)}`,
      matrixSuite,
      evaluatorReport: report,
      adapterResult: result,
    });
    expect(receipt).toMatchObject({
      authority: 'diagnostic',
      evidenceEligible: false,
      sourceBindingDigest: binding.bindingDigest,
      suiteId: L1_TUI_REWIND_FORK_PROJECTION_SUITE_ID_V1,
      suiteDigest: matrixSuite.suiteDigest,
      outcome: 'passed',
    });
    expect(l1TuiRewindForkProjectionReceiptBindingV1(receipt)).toEqual({
      receiptId: receipt.receiptId,
      receiptDigest: receipt.receiptDigest,
    });
  });

  test('rejects unsafe source metadata before it can enter a receipt binding', () => {
    expect(() =>
      buildL1TuiRewindForkProjectionSourceOwnedBindingV1({
        sourceSurfaceId: 'https://provider.invalid/endpoint',
        declaration: L1_TUI_REWIND_FORK_PROJECTION_ADAPTERS_V1[0],
      }),
    ).toThrow('L1 TUI rewind projection identifier');
    expect(() =>
      buildL1TuiRewindForkProjectionSourceOwnedBindingV1({
        sourceSurfaceId: 'C:/Users/fixture',
        declaration: L1_TUI_REWIND_FORK_PROJECTION_ADAPTERS_V1[0],
      }),
    ).toThrow('L1 TUI rewind projection identifier');
  });
});
