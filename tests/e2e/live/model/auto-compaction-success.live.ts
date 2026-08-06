import { runL3LiveAutoCompactionV1 } from '../../../../scripts/evals/qualification/run-l3-live-auto-compaction';

/**
 * AQ-9B's independent success observation. This wrapper is deliberately not
 * `test:model:live`: it has its own opt-in and owner-supplied ledger root, so
 * it cannot alter AQ-8 compatibility or the existing G1 smoke meaning.
 */
const parentEnvironment = { ...process.env };
const report = await runL3LiveAutoCompactionV1({
  explicitOptIn: parentEnvironment.KITE_RUN_QUALIFICATION_AUTO_COMPACTION_LIVE_V1 === '1',
  parentEnvironment,
  ledgerRoot: parentEnvironment.KITE_QUALIFICATION_AUTO_COMPACTION_LEDGER_DIR,
});

// The schema-closed diagnostic report excludes credentials, endpoints,
// prompts, responses, reasoning, filesystem paths, and workspace content.
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== 'observed' || report.outcome !== 'success') process.exitCode = 1;
