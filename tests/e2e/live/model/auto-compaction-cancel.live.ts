import { runL3LiveAutoCompactionV1 } from '../../../../scripts/evals/qualification/run-l3-live-auto-compaction';

/**
 * AQ-9B's independent cancellation observation. The operator sends one real
 * SIGINT only after the live summary request is in flight; an early signal or
 * any other terminal branch remains a nonzero blocked result, never success.
 */
const parentEnvironment = { ...process.env };
const cancellation = new AbortController();
const cancelFromOperator = () => cancellation.abort();
process.once('SIGINT', cancelFromOperator);

try {
  const report = await runL3LiveAutoCompactionV1({
    explicitOptIn: parentEnvironment.KITE_RUN_QUALIFICATION_AUTO_COMPACTION_LIVE_V1 === '1',
    parentEnvironment,
    ledgerRoot: parentEnvironment.KITE_QUALIFICATION_AUTO_COMPACTION_LEDGER_DIR,
    signal: cancellation.signal,
  });
  // The schema-closed diagnostic report excludes credentials, endpoints,
  // prompts, responses, reasoning, filesystem paths, and workspace content.
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status !== 'observed' || report.outcome !== 'cancelled') process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', cancelFromOperator);
}
