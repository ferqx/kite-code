import { basename, relative, resolve } from 'node:path';
import { planTestSuites, runTestPlan } from './test-plan';
import { collectTestFiles, testParallelism } from './test-suite';

export const UNIFIED_TUI_SHARD_ENV = 'KITE_TUI_SYSTEM_SHARD';
const formal = 'tests/isolated/unified-agent/formal-terminal-entrypoints.test.ts';

export function parseUnifiedTuiShard(value: string | undefined) {
  if (value === undefined) return undefined;
  if (value.length !== 3 || !/^[0-3]\/4$/.test(value))
    throw Error(`${UNIFIED_TUI_SHARD_ENV} must be exactly 0/4, 1/4, 2/4 or 3/4`);
  return Object.freeze({ index: Number(value[0]), count: 4 });
}

/** Current CLI owner tests plus the formal candidate wrapper; no legacy scenario harness. */
export function unifiedTuiInventory(root: string): string[] {
  const cli = collectTestFiles(resolve(root, 'apps/cli/test'))
    .filter((file) => /^tui.*\.test\.ts$/.test(basename(file)))
    .map((file) => relative(root, file).replaceAll('\\', '/'));
  if (cli.length === 0 || collectTestFiles(resolve(root, formal)).length !== 1)
    throw Error('unified_tui_test_inventory_unavailable');
  return [...cli, formal].sort();
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
  const plan = planTestSuites(root, selection.files, concurrency);
  console.log(`[unified-tui] parallelism=${concurrency} shard=${shardValue ?? 'all'}`);
  return await runTestPlan(root, plan, concurrency);
}

if (import.meta.main)
  process.exitCode = await runUnifiedTuiSystemTests(
    resolve(import.meta.dir, '..'),
    process.argv.slice(2),
    process.env[UNIFIED_TUI_SHARD_ENV],
  );
