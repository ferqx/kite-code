/**
 * Closed, source-owned registry of synthetic qualification executions.
 *
 * This deliberately contains only fixture/runner identifiers. It is shared
 * by diagnostic schemas without importing the product surface, release
 * bundle, or a release-gate evaluator.
 */
export const QUALIFICATION_LOCAL_SYNTHETIC_EXECUTION_REGISTRY_V1 = [
  {
    fixtureId: 'sealed-fixture-v1',
    runner: 'qualification-runner-v1',
  },
  {
    fixtureId: 'l0-contract-fixture-v1',
    runner: 'qualification-l0-contract-runner-v1',
  },
  {
    fixtureId: 'l1-tool-verification-fixture-v1',
    runner: 'qualification-l1-tool-verification-runner-v1',
  },
  {
    fixtureId: 'l1-auto-compaction-failure-fixture-v1',
    runner: 'qualification-l1-auto-compaction-failure-runner-v1',
  },
  {
    fixtureId: 'l1-public-projection-fixture-v1',
    runner: 'qualification-l1-public-projection-runner-v1',
  },
  {
    fixtureId: 'l1-skill-mcp-fixture-v1',
    runner: 'qualification-l1-skill-mcp-runner-v1',
  },
  {
    fixtureId: 'l1-subagent-recovery-fixture-v1',
    runner: 'qualification-l1-subagent-recovery-runner-v1',
  },
  {
    fixtureId: 'l1-tui-rewind-fork-projection-fixture-v1',
    runner: 'qualification-l1-tui-rewind-fork-projection-runner-v1',
  },
  {
    fixtureId: 'qualification-l3-sealed-synthetic-fixture-v1',
    runner: 'qualification-l3-live-compatibility-runner-v1',
  },
  {
    fixtureId: 'qualification-l3-auto-compaction-sealed-synthetic-fixture-v1',
    runner: 'qualification-l3-live-auto-compaction-runner-v1',
  },
] as const;

export function isRegisteredQualificationLocalSyntheticExecutionV1(
  fixtureId: string,
  runner: string,
): boolean {
  return QUALIFICATION_LOCAL_SYNTHETIC_EXECUTION_REGISTRY_V1.some(
    (entry) => entry.fixtureId === fixtureId && entry.runner === runner,
  );
}
