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
    const suite = suiteArg?.slice('--suite='.length);
    if (
      suite !== undefined &&
      suite !== 'first_decision' &&
      suite !== 'project_instruction_effect'
    ) {
      throw new Error('first_decision_suite_invalid');
    }
    const report = await runFirstDecisionEval({
      live: process.env.KITE_RUN_FIRST_DECISION_EVAL === '1',
      runs: runsArg ? Number(runsArg.slice('--runs='.length)) : undefined,
      comparison: comparisonArg?.slice('--comparison='.length) as 'legacy_vs_published' | undefined,
      suite: suite as 'first_decision' | 'project_instruction_effect' | undefined,
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
  } catch (error) {
    console.error(
      JSON.stringify({
        schema: 'FirstDecisionEvalV1',
        evaluationScope: 'first_decision_only',
        status: 'provider_request_failed',
        reason:
          error instanceof Error && error.message === 'first_decision_suite_invalid'
            ? error.message
            : 'live_provider_request_failed',
        contentLogged: false,
      }),
    );
    process.exitCode = 1;
  }
}
