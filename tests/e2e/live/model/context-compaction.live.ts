import { runL3LiveCompatibilityV1 } from '../../../../scripts/evals/qualification/run-l3-live-compatibility';

/**
 * AQ-8 replaces the former direct/incremental compaction script with this
 * sealed diagnostic wrapper. AQ-9B owns separate auto-compaction success and
 * cancel wrappers; this entrypoint never falls back to product config, a
 * workspace overlay, or the G1 smoke path.
 */
const parentEnvironment = { ...process.env };
const report = await runL3LiveCompatibilityV1({
  explicitOptIn: parentEnvironment.KITE_RUN_QUALIFICATION_LIVE_V1 === '1',
  parentEnvironment,
  ledgerRoot: parentEnvironment.KITE_QUALIFICATION_LEDGER_DIR,
});

// The report is schema-closed diagnostic metadata. It has no position for a
// key, endpoint, prompt, response, reasoning, workspace path, or raw error.
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== 'observed') process.exitCode = 1;
