import { readFileSync, statSync } from 'node:fs';
import {
  type SourceIdentity,
  type UnifiedSoakReport,
  verifyUnifiedSoakReport,
} from './unified-soak-report';

if (import.meta.main) {
  try {
    const path = process.argv[2];
    if (!path || process.argv.length !== 3)
      throw Error('usage: bun unified-soak-verify.ts <report.json>');
    if (statSync(path).size > 512 * 1024) throw Error('report_size_invalid');
    const value = JSON.parse(readFileSync(path, 'utf8')) as UnifiedSoakReport;
    const expected: SourceIdentity = {
      repository: process.env.GITHUB_REPOSITORY ?? '',
      headSha: process.env.GITHUB_SHA ?? '',
      ref: process.env.GITHUB_REF ?? '',
      workflow: 'runtime-resilience-qualification.yml',
      workflowRef: process.env.GITHUB_WORKFLOW_REF ?? '',
      workflowSha: process.env.GITHUB_WORKFLOW_SHA ?? '',
      runId: process.env.GITHUB_RUN_ID ?? '',
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    };
    const errors = verifyUnifiedSoakReport(value, expected, true);
    if (errors.length) {
      console.error(JSON.stringify({ status: 'rejected', errors }));
      process.exitCode = 1;
    }
  } catch {
    console.error('unified_soak_report_invalid');
    process.exitCode = 1;
  }
}
