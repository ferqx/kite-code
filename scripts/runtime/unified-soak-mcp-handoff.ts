import { decodeMcpStdioProcessEvidence, type McpStdioProcessEvidence } from '@kite-ai/agent/mcp';
import type { CaseEvidence } from './unified-soak-cases';

/** Original connection Job only; not a Runtime process or resource census. */
export interface McpStdioJobHandoff {
  version: 1;
  coverage: 'original-mcp-stdio-job';
  binding: McpStdioProcessEvidence['binding'];
  ownerPid: number;
  connectionCommandId: string;
  runCommandId: string;
  runId: string;
  connectExecutionId: string;
  callExecutionId: string;
  ready: McpStdioProcessEvidence;
  terminal: McpStdioProcessEvidence;
  cold: {
    storeId: string;
    cursor: string;
    unchanged: true;
    providerCallsBefore: number;
    providerCallsAfter: number;
    originalResultUnchanged: true;
    originalOutputUnchanged: true;
    originalCommandUnchanged: true;
    originalRunUnchanged: true;
  };
}
const keys = (value: unknown, expected: string[]) =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === expected.sort().join(',');
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const counter = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

/** Pure cold decoder. Original native/reap observations remain the owning port's facts. */
export function verifyMcpStdioJobHandoff(
  value: McpStdioJobHandoff,
  expected: { ownerPid: number; identities: NonNullable<CaseEvidence['identities']> },
): string[] {
  try {
    if (
      !keys(value, [
        'version',
        'coverage',
        'binding',
        'ownerPid',
        'connectionCommandId',
        'runCommandId',
        'runId',
        'connectExecutionId',
        'callExecutionId',
        'ready',
        'terminal',
        'cold',
      ]) ||
      value.version !== 1 ||
      value.coverage !== 'original-mcp-stdio-job' ||
      value.ownerPid !== expected.ownerPid ||
      !counter(value.ownerPid) ||
      value.ownerPid < 2 ||
      !keys(value.binding, [
        'originalStoreId',
        'sessionId',
        'executionId',
        'serverId',
        'scopeId',
        'configDigest',
      ]) ||
      ![
        value.binding.originalStoreId,
        value.binding.sessionId,
        value.binding.executionId,
        value.binding.serverId,
        value.connectionCommandId,
        value.runCommandId,
        value.runId,
        value.connectExecutionId,
        value.callExecutionId,
      ].every(id) ||
      value.binding.scopeId !==
        JSON.stringify([
          value.binding.originalStoreId,
          value.binding.sessionId,
          value.binding.serverId,
        ]) ||
      !/^[a-f0-9]{64}$/.test(value.binding.configDigest) ||
      value.connectionCommandId === value.runCommandId ||
      new Set([value.binding.executionId, value.connectExecutionId, value.callExecutionId]).size !==
        3
    )
      return ['mcp_stdio_handoff_invalid'];
    const ready = decodeMcpStdioProcessEvidence(value.ready, value.binding, value.ownerPid);
    const terminal = decodeMcpStdioProcessEvidence(value.terminal, value.binding, value.ownerPid);
    if (!ready || !terminal || ready.version !== 2 || terminal.version !== 2)
      return ['mcp_stdio_handoff_invalid'];
    for (const role of ['broker', 'guardian', 'server'] as const) {
      const before = ready[role],
        after = terminal[role];
      if (
        !before?.birth ||
        !after?.birth ||
        before.exit !== null ||
        before.kernelState !== 'alive' ||
        !['absent', 'reused'].includes(after.kernelState) ||
        before.unavailable.length ||
        after.unavailable.length ||
        before.pid !== after.pid ||
        before.parentPid !== after.parentPid ||
        before.birth.seconds !== after.birth.seconds ||
        before.birth.microseconds !== after.birth.microseconds ||
        BigInt(before.birth.seconds) > 18446744073709551615n
      )
        return ['mcp_stdio_handoff_invalid'];
    }
    const first = ready.coalition,
      last = terminal.coalition;
    if (
      !first ||
      !last ||
      first.processTreeStopped ||
      first.registrationRemoved ||
      first.terminalTaskCount !== null ||
      !last.processTreeStopped ||
      !last.registrationRemoved ||
      last.terminalTaskCount !== 1 ||
      !terminal.broker?.exit ||
      terminal.broker.exit.code !== 0 ||
      !terminal.server?.exit ||
      terminal.server.exit.code !== 7 ||
      terminal.guardian?.exit !== null ||
      BigInt(first.id) > 18446744073709551615n ||
      BigInt(first.guardianUniqueId) > 18446744073709551615n ||
      (
        [
          'id',
          'guardianUniqueId',
          'guardianPidVersion',
          'claimTaskCount',
          'label',
          'domain',
        ] as const
      ).some((key) => first[key] !== last[key])
    )
      return ['mcp_stdio_handoff_invalid'];
    for (const [executionId, commandId, runId] of [
      [value.binding.executionId, value.connectionCommandId, null],
      [value.connectExecutionId, value.runCommandId, value.runId],
      [value.callExecutionId, value.runCommandId, value.runId],
    ] as const) {
      const rows = expected.identities.filter((row) => row.executionId === executionId);
      if (
        rows.length !== 1 ||
        rows[0]!.storeId !== value.binding.originalStoreId ||
        rows[0]!.sessionId !== value.binding.sessionId ||
        rows[0]!.commandId !== commandId ||
        rows[0]!.runId !== runId
      )
        return ['mcp_stdio_handoff_identity_invalid'];
    }
    const cold = value.cold;
    if (
      !keys(cold, [
        'storeId',
        'cursor',
        'unchanged',
        'providerCallsBefore',
        'providerCallsAfter',
        'originalResultUnchanged',
        'originalOutputUnchanged',
        'originalCommandUnchanged',
        'originalRunUnchanged',
      ]) ||
      cold.storeId !== value.binding.originalStoreId ||
      !/^(0|[1-9][0-9]*)$/.test(cold.cursor) ||
      BigInt(cold.cursor) > 9223372036854775807n ||
      cold.unchanged !== true ||
      !counter(cold.providerCallsBefore) ||
      cold.providerCallsBefore < 3 ||
      cold.providerCallsAfter !== cold.providerCallsBefore ||
      cold.originalResultUnchanged !== true ||
      cold.originalOutputUnchanged !== true ||
      cold.originalCommandUnchanged !== true ||
      cold.originalRunUnchanged !== true ||
      JSON.stringify(value).length > 256 * 1024
    )
      return ['mcp_stdio_handoff_cold_invalid'];
    return [];
  } catch {
    return ['mcp_stdio_handoff_invalid'];
  }
}
