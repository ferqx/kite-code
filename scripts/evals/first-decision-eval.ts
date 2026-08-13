import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runFirstDecisionEval } from './prompt-contract-ab';

export * from './prompt-contract-ab';

if (import.meta.main) {
  try {
    const runsArg = process.argv.find((value) => value.startsWith('--runs='));
    const comparisonArg = process.argv.find((value) => value.startsWith('--comparison='));
    const suiteArg = process.argv.find((value) => value.startsWith('--suite='));
    const outputArg = process.argv.find((value) => value.startsWith('--output='));
    const report = await runFirstDecisionEval({
      live:
        process.env.KITE_RUN_FIRST_DECISION_EVAL === '1' || process.env.KITE_RUN_PROMPT_AB === '1',
      runs: runsArg ? Number(runsArg.slice('--runs='.length)) : undefined,
      comparison: comparisonArg?.slice('--comparison='.length) as 'legacy_vs_published' | undefined,
      suite: suiteArg?.slice('--suite='.length) as
        | 'first_decision'
        | 'tool_description'
        | 'project_instruction_effect'
        | 'task_delegation_diagnostic'
        | undefined,
    });
    if (outputArg) {
      const outputPath = resolve(outputArg.slice('--output='.length));
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'completed' && report.status !== 'live_eval_skipped') {
      process.exitCode = 1;
    }
  } catch {
    console.error(
      JSON.stringify({
        schema: 'FirstDecisionEvalV1',
        evaluationScope: 'first_decision_only',
        status: 'provider_request_failed',
        reason: 'live_provider_request_failed',
        contentLogged: false,
      }),
    );
    process.exitCode = 1;
  }
}
