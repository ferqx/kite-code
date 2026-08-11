import { DEFAULT_FEATURE_FLAGS } from '@/core/config/features';
import { RUNTIME_STATE_SCHEMA_VERSION } from '@/core/runtime/state';
import { builtinToolSpecs } from '@/core/tools/registry/builtins';
import {
  type ContextPreparationPurposeV2,
  canonicalContextDigestV2,
} from './context-preparation-v2';

export const CONTEXT_REDUCTION_SLICE_A_LIMITS_V1 = Object.freeze({
  fixtureSettledToolBlocks: 2_000,
  fixtureMinimumCanonicalModelContentBytes: 8 * 1_024 * 1_024,
  fixtureEligiblePercent: 10,
  fixtureIneligiblePercent: 90,
  prepareLiveP95Ms: 50,
  additionalPeakHeapBytes: 64 * 1_024 * 1_024,
  primaryCommitMetadataMaxUtf8Bytes: 16 * 1_024,
  verifiedTerminalMetadataMaxUtf8Bytes: 8 * 1_024,
  offPathP95RegressionPercent: 5,
  payloadByteMismatchMax: 0,
});

export const CONTEXT_REDUCTION_SLICE_A_FIXTURE_V1 = Object.freeze({
  fixtureId: 'context-reduction-slice-a-2000-blocks-8mib:v1',
  warmupRuns: 2,
  sampleRuns: 7,
  gcMode: 'bun-gc-full-before-sample',
  eligibleTool: 'read_file',
  ineligibleTool: 'web_fetch',
  contentPattern: 'block-{index}:0123456789abcdef',
});

const CONTEXT_PURPOSES: readonly ContextPreparationPurposeV2[] = Object.freeze([
  'normal',
  'context_inspection',
  'candidate_validation',
  'restore_debug',
  'summary_source',
]);

const TERMINAL_VARIANTS = Object.freeze([
  'tool.finished',
  'tool.failed',
  'tool.rejected',
  'tool.cancelled',
] as const);

const PROVIDER_DISPATCH_ENTRYPOINTS = Object.freeze([
  'primary_model:src/core/controllers/model-controller.ts',
  'compaction:src/core/model/compaction-summary.ts',
  'subagent:src/core/subagent/runner.ts',
  'auto_review:src/core/execution/reviewer.ts',
  'verification_review:src/core/execution/reviewer.ts',
] as const);

function finiteBudgetIdentity(spec: (typeof builtinToolSpecs)[number]) {
  return {
    name: spec.name,
    kind: spec.kind,
    budget: structuredClone(spec.modelResultBudgetV2),
  };
}

/** Machine-readable A01 inventory derived from the production ToolSpec registry. */
export function contextReductionContractInventoryV1() {
  const inventory = {
    version: 1 as const,
    productionTools: builtinToolSpecs.map(finiteBudgetIdentity),
    terminalVariants: TERMINAL_VARIANTS,
    contextPurposes: CONTEXT_PURPOSES,
    providerDispatchEntrypoints: PROVIDER_DISPATCH_ENTRYPOINTS,
    runtimeSchema: {
      writer: RUNTIME_STATE_SCHEMA_VERSION,
      legacyReaders: Array.from({ length: 20 }, (_, index) => index + 2),
    },
    defaults: {
      toolResultBudgetV2: DEFAULT_FEATURE_FLAGS.toolResultBudgetV2,
      contextReclaimV1: DEFAULT_FEATURE_FLAGS.contextReclaimV1,
      contextCompactionV2: DEFAULT_FEATURE_FLAGS.contextCompactionV2,
      contextCompactionManualV1: DEFAULT_FEATURE_FLAGS.contextCompactionManualV1,
      contextCompactionAutoV1: DEFAULT_FEATURE_FLAGS.contextCompactionAutoV1,
      reclaimMode: 'off' as const,
    },
    limits: CONTEXT_REDUCTION_SLICE_A_LIMITS_V1,
    fixture: CONTEXT_REDUCTION_SLICE_A_FIXTURE_V1,
  };
  return Object.freeze({
    ...inventory,
    inventoryDigest: canonicalContextDigestV2('context-reduction-contract-inventory:v1', inventory),
  });
}
