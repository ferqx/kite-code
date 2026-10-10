import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyMcpStdioJobHandoff } from '../../../scripts/runtime/unified-soak-mcp-handoff';
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
      const evidence = await runFunctionalCase(root, caseId, {
        guardianPath: join(
          import.meta.dir,
          '../../../packages/agent/dist/mcp',
          process.platform === 'win32' ? 'windows-stdio-guardian.js' : 'stdio-guardian.js',
        ),
        bunExecutable: process.execPath,
        ...(caseId === 'mcp_churn' && process.platform === 'linux'
          ? {
              linux: (
                await import(join(import.meta.dir, '../../../packages/agent/dist/mcp/index.js'))
              ).mcpStdioLinuxAssets(),
            }
          : {}),
      });
      if (evidence.status !== 'passed') console.error(JSON.stringify(evidence));
      expect(evidence.unavailable).toEqual([]);
      expect(evidence.status).toBe('passed');
      expect(evidence.cleanupConfirmed).toBe(true);
      expect(evidence.assertions.every((value) => value.passed)).toBe(true);
      if (caseId === 'mcp_churn') {
        const handoff = evidence.mcpStdioHandoff!;
        expect(
          verifyMcpStdioJobHandoff(handoff, {
            ownerPid: process.pid,
            platform: process.platform,
            identities: evidence.identities!,
          }),
        ).toEqual([]);
        const unreaped = structuredClone(handoff);
        if (unreaped.terminal.version === 2 && unreaped.terminal.broker)
          unreaped.terminal.broker.exit = null;
        else if (unreaped.terminal.version === 3 && unreaped.terminal.guardian)
          unreaped.terminal.guardian.exit = null;
        else if (unreaped.terminal.version === 4) unreaped.terminal.process.wrapper.exit = null;
        else throw Error('original_mcp_handoff_missing');
        expect(
          verifyMcpStdioJobHandoff(unreaped, {
            ownerPid: process.pid,
            platform: process.platform,
            identities: evidence.identities!,
          }),
        ).toContain('mcp_stdio_handoff_invalid');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180000);
