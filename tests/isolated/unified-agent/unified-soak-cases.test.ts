import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFunctionalCase } from '../../fixtures/unified-agent/soak/cases';

for (const caseId of [
  'long_runtime_replay',
  'subagent_cancel_recovery',
  'model_transient_stream',
  'mcp_churn',
  'storage_and_logger_faults',
] as const)
  test(`bounded migrated soak actual ${caseId}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-soak-cases-'));
    try {
      const evidence = await runFunctionalCase(root, caseId);
      if (evidence.status !== 'passed') console.error(JSON.stringify(evidence));
      expect(evidence.unavailable).toEqual([]);
      expect(evidence.status).toBe('passed');
      expect(evidence.cleanupConfirmed).toBe(true);
      expect(evidence.assertions.every((value) => value.passed)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180000);
