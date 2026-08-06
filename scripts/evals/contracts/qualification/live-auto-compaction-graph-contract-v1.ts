/**
 * AQ-9B intentionally executes the product Runtime chain.  Product executor
 * modules bring static Tool/MCP/Skill/Subagent code with them, so this contract
 * distinguishes those unavoidable transitive imports from a runner directly
 * acquiring a capability.  The companion runner test proves the second half:
 * empty model tools, denied execution surface, and an effect wrapper that
 * accepts only the three product effects in the qualification trace.
 */
export const L3_LIVE_AUTO_COMPACTION_GRAPH_CONTRACT_V1 = Object.freeze({
  schema: 'L3LiveAutoCompactionGraphContractV1' as const,
  version: 1 as const,
  productChainInputs: [
    'src/core/runtime/kernel.ts',
    'src/core/runtime/runner.ts',
    'src/core/runtime/scheduler.ts',
    'src/core/runtime/executor.ts',
    'src/core/controllers/model-controller.ts',
    'src/core/controllers/compaction-controller.ts',
    'src/core/model/compaction-summary.ts',
    'src/core/model/context-projection.ts',
    'src/core/model/invoke.ts',
  ],
  directRunnerProductImports: [
    'src/core/runtime/kernel.ts',
    'src/core/runtime/runner.ts',
    'src/core/runtime/scheduler.ts',
    'src/core/runtime/executor.ts',
    'src/core/model/compaction-summary.ts',
    'src/core/model/context-projection.ts',
    'src/core/model/invoke.ts',
  ],
  forbiddenGraphPrefixes: [
    'src/app/',
    'scripts/evals/qualification/run-l3-live-compatibility.ts',
    'scripts/evals/contracts/qualification/evidence/live-observation-source-registry-v1.ts',
    'scripts/evals/contracts/qualification/evidence/live-observation-verifier-v1.ts',
    'scripts/evals/contracts/qualification/evidence/evidence-schema-v1.ts',
    'scripts/evals/contracts/qualification/evidence/evidence-verifier-v1.ts',
    'scripts/release/evidence-schema.ts',
    'scripts/release/evidence-bundle.ts',
    'scripts/release/gate-',
    'release/oss-first-release/',
  ],
  forbiddenDirectRunnerPrefixes: [
    'src/app/',
    'src/core/mcp/',
    'src/core/tools/',
    'src/core/skills/',
    'src/core/subagent/',
    'src/core/session-logger/',
    'src/core/config/',
  ],
});

export interface L3LiveAutoCompactionGraphSnapshotV1 {
  /** Repo-relative Bun metafile inputs, normalized with forward slashes. */
  readonly inputs: readonly string[];
  /** Resolved direct imports from the AQ-9B runner's own metafile entry. */
  readonly directRunnerImports: readonly string[];
}

function hasExact(inputs: readonly string[], expected: string): boolean {
  return inputs.some((input) => input.endsWith(expected));
}

function hasPrefix(inputs: readonly string[], prefix: string): boolean {
  return inputs.some((input) => input.includes(prefix));
}

/**
 * Fails closed if the runner stops using the literal product chain, directly
 * imports a capability surface, or gains a release/AQ-8 evaluation path.
 */
export function assertL3LiveAutoCompactionProductGraphV1(
  snapshot: L3LiveAutoCompactionGraphSnapshotV1,
): void {
  const contract = L3_LIVE_AUTO_COMPACTION_GRAPH_CONTRACT_V1;
  if (
    !contract.productChainInputs.every((expected) => hasExact(snapshot.inputs, expected)) ||
    !contract.directRunnerProductImports.every((expected) =>
      hasExact(snapshot.directRunnerImports, expected),
    ) ||
    contract.forbiddenGraphPrefixes.some((prefix) => hasPrefix(snapshot.inputs, prefix)) ||
    contract.forbiddenDirectRunnerPrefixes.some((prefix) =>
      hasPrefix(snapshot.directRunnerImports, prefix),
    )
  ) {
    throw new Error('l3_live_auto_compaction_product_graph_drift');
  }
}
