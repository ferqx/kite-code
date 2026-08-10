import { runFirstDecisionEval } from './prompt-contract-ab';

export * from './prompt-contract-ab';

if (import.meta.main) {
  try {
    const runsArg = process.argv.find((value) => value.startsWith('--runs='));
    const report = await runFirstDecisionEval({
      live:
        process.env.KITE_RUN_FIRST_DECISION_EVAL === '1' || process.env.KITE_RUN_PROMPT_AB === '1',
      runs: runsArg ? Number(runsArg.slice('--runs='.length)) : undefined,
    });
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
