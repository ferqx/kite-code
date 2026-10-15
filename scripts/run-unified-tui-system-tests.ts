import { basename, relative, resolve } from 'node:path';
import { planTestSuites, runTestPlan } from './test-plan';
import { collectTestFiles, testParallelism } from './test-suite';

export const UNIFIED_TUI_SHARD_ENV = 'KITE_TUI_SYSTEM_SHARD';
const formal = [
  'tests/isolated/unified-agent/formal-terminal-entrypoints.test.ts',
  'tests/isolated/unified-agent/tui-startup-wait.test.ts',
] as const;
const originalScenarios = 'tests/tui-system/scenarios/';

export function parseUnifiedTuiShard(value: string | undefined) {
  if (value === undefined) return undefined;
  if (value.length !== 3 || !/^[0-3]\/4$/.test(value))
    throw Error(`${UNIFIED_TUI_SHARD_ENV} must be exactly 0/4, 1/4, 2/4 or 3/4`);
  return Object.freeze({ index: Number(value[0]), count: 4 });
}

/** Original terminal journeys now use the current UI/Service, alongside owner and formal checks. */
export function unifiedTuiInventory(root: string): string[] {
  const cli = collectTestFiles(resolve(root, 'apps/cli/test'))
    .filter((file) => /^tui.*\.test\.ts$/.test(basename(file)))
    .map((file) => relative(root, file).replaceAll('\\', '/'));
  const original = collectTestFiles(resolve(root, originalScenarios)).map((file) =>
    relative(root, file).replaceAll('\\', '/'),
  );
  if (
    cli.length === 0 ||
    original.length === 0 ||
    formal.some((file) => collectTestFiles(resolve(root, file)).length !== 1)
  )
    throw Error('unified_tui_test_inventory_unavailable');
  return [...cli, ...original, ...formal].sort();
}

export function selectUnifiedTuiTests(
  root: string,
  args: readonly string[],
  shardValue: string | undefined,
) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--list'))
    throw Error('usage: bun run scripts/run-unified-tui-system-tests.ts [--list]');
  const shard = parseUnifiedTuiShard(shardValue);
  const files = unifiedTuiInventory(root).filter(
    (_, index) => !shard || index % shard.count === shard.index,
  );
  return Object.freeze({ list: args[0] === '--list', shard, files: Object.freeze(files) });
}

export function unifiedTuiTestPlan(root: string, files: readonly string[], concurrency: number) {
  const plan = planTestSuites(
    root,
    files.filter((file) => !file.startsWith(originalScenarios)),
    concurrency,
  );
  for (const file of files.filter((candidate) => candidate.startsWith(originalScenarios))) {
    plan.concurrent.push({
      label: `original-tui:${basename(file)}`,
      files: [resolve(root, file)],
      // Retain the original per-file, test, journey and owned-process teardown budgets.
      command: [process.execPath, resolve(root, 'scripts/run-tui-system-tests.ts'), basename(file)],
      maxConcurrency: 1,
      drainOnFailure: true,
    });
    plan.counts.isolated++;
  }
  return plan;
}

export async function runUnifiedTuiSystemTests(
  root: string,
  args: readonly string[],
  shardValue?: string,
): Promise<number> {
  let selection: ReturnType<typeof selectUnifiedTuiTests>;
  try {
    selection = selectUnifiedTuiTests(root, args, shardValue);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'unified_tui_test_selection_invalid');
    return 2;
  }
  if (selection.list) {
    console.log(JSON.stringify({ shard: shardValue ?? null, files: selection.files }));
    return 0;
  }
  const concurrency = testParallelism();
  const plan = unifiedTuiTestPlan(root, selection.files, concurrency);
  console.log(`[unified-tui] parallelism=${concurrency} shard=${shardValue ?? 'all'}`);
  return await runTestPlan(root, plan, concurrency);
}

if (import.meta.main)
  process.exitCode = await runUnifiedTuiSystemTests(
    resolve(import.meta.dir, '..'),
    process.argv.slice(2),
    process.env[UNIFIED_TUI_SHARD_ENV],
  );
