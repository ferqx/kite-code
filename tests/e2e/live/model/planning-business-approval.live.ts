import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { liveCodeEvidence } from './live-code-evidence';
import {
  runPlanningBusinessCase,
  selectPlanningBusinessCases,
} from './planning-business-approval-fixture';

if (process.env.KITE_RUN_LIVE_PLANNING_BUSINESS !== '1')
  throw Error('live_planning_business_opt_in_required');
if (process.platform !== 'darwin')
  throw Error('live_planning_business_requires_qualified_native_shell');
const args = new Map<string, string>();
for (const argument of process.argv.slice(2)) {
  const match = /^--(output|case|model|reasoning-effort)=(.+)$/.exec(argument);
  assert(match && !args.has(match[1]!), 'invalid_or_duplicate_argument');
  args.set(match[1]!, match[2]!);
}
assert.equal(args.get('model'), 'gpt-6-luna', 'explicit_luna_required');
assert.equal(args.get('reasoning-effort'), 'medium', 'explicit_medium_required');
const output = args.get('output');
assert(output && isAbsolute(output) && !existsSync(output), 'new_absolute_output_required');
const repo = resolve(import.meta.dirname, '../../../..');
const owned = relative(join(repo, 'dist/acceptance'), output);
assert(owned && !owned.startsWith('..') && !isAbsolute(owned), 'output_must_be_in_acceptance');
const root = `${output}.workspace`;
assert(!existsSync(root), 'output_workspace_exists');
mkdirSync(dirname(output), { recursive: true });
mkdirSync(root, { mode: 0o700 });
const sourceBefore = liveCodeEvidence();
const controller = new AbortController();
const interrupt = () => controller.abort(new Error('operator_interrupted'));
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
const cases: Awaited<ReturnType<typeof runPlanningBusinessCase>>[] = [];
let failure: unknown;
try {
  for (const entry of selectPlanningBusinessCases(args.get('case'))) {
    controller.signal.throwIfAborted();
    console.log(
      JSON.stringify({ phase: 'starting', case: entry.id, provider: 'actual-luna-medium' }),
    );
    const result = await runPlanningBusinessCase({
      entry,
      root: join(root, entry.id),
      provider: 'luna',
      signal: controller.signal,
    });
    cases.push(result);
    console.log(
      JSON.stringify({
        phase: 'completed',
        case: entry.id,
        status: result.status,
        cleanupConfirmed: result.cleanupConfirmed,
      }),
    );
    if (!result.cleanupConfirmed) throw Error('previous_runtime_cleanup_unconfirmed');
  }
} catch (error) {
  failure = error;
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
const sourceAfter = liveCodeEvidence();
const sourceStable = JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter);
const report = {
  qualification:
    'Actual gpt-6-luna/medium business requests through original Service adapters; original low/default reviewer, real Service/HTTP/SQLite/native Shell. Test operator answers exact original cards; not human UI acceptance.',
  sourceBefore,
  sourceAfter,
  sourceStable,
  model: 'gpt-6-luna',
  reasoningEffort: 'medium',
  originalFailuresPreserved: true,
  outerRetries: 0,
  grandchild: { status: 'not_run', reason: 'current_default_root_only_spawn_not_widened' },
  failure:
    failure instanceof Error
      ? { name: failure.name, message: failure.message }
      : failure
        ? String(failure)
        : null,
  status:
    !failure &&
    sourceStable &&
    cases.length > 0 &&
    cases.every((entry) => entry.status === 'passed' && entry.cleanupConfirmed)
      ? 'passed'
      : 'failed',
  cases,
};
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ output, status: report.status, cases: cases.length, sourceStable }));
process.exitCode = report.status === 'passed' ? 0 : 1;
