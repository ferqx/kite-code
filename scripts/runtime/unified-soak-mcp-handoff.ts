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

/** The original port supplies native observations; this checks their ready-to-exit continuity. */
function ownedExitValid(
  ready: McpStdioProcessEvidence,
  terminal: McpStdioProcessEvidence,
): boolean {
  if (ready.version === 3 && terminal.version === 3) {
    const firstGuardian = ready.guardian,
      lastGuardian = terminal.guardian,
      firstServer = ready.server,
      lastServer = terminal.server;
    return !!(
      firstGuardian &&
      lastGuardian &&
      firstServer &&
      lastServer &&
      !ready.closed &&
      !ready.closeUnknown &&
      firstGuardian.kernelState === 'alive' &&
      firstGuardian.exit === null &&
      !firstGuardian.observationClosed &&
      firstServer.exitCode === null &&
      !firstServer.waitConfirmed &&
      ready.job &&
      !ready.job.treeStopped &&
      ready.job.activeProcesses !== 0 &&
      firstGuardian.pid === lastGuardian.pid &&
      firstGuardian.parentPid === lastGuardian.parentPid &&
      firstGuardian.creationTime === lastGuardian.creationTime &&
      firstServer.pid === lastServer.pid &&
      firstServer.creationTime === lastServer.creationTime &&
      terminal.closed &&
      !terminal.closeUnknown &&
      lastGuardian.kernelState === 'dead' &&
      lastGuardian.observationClosed &&
      lastGuardian.exit?.reaped &&
      lastGuardian.exit.code === 0 &&
      lastGuardian.exit.signal === null &&
      lastServer.waitConfirmed &&
      lastServer.exitCode === 7 &&
      terminal.job?.treeStopped &&
      terminal.job.activeProcesses === 0
    );
  }
  if (ready.version === 4 && terminal.version === 4) {
    const first = ready.process,
      last = terminal.process,
      firstNamespace = first.namespace,
      lastNamespace = last.namespace,
      firstRoot = firstNamespace?.root,
      lastRoot = lastNamespace?.root;
    return !!(
      firstNamespace &&
      lastNamespace &&
      firstRoot &&
      lastRoot &&
      first.phase === 'ready' &&
      !first.fdClosed &&
      !first.closeUnknown &&
      first.wrapper.exit === null &&
      !first.wrapper.closed &&
      !first.wrapper.stdoutEof &&
      !first.wrapper.stderrEof &&
      !firstNamespace.treeStopped &&
      !firstNamespace.init.dead &&
      !firstRoot.dead &&
      firstRoot.waitReceipt === null &&
      first.admission.nonce === last.admission.nonce &&
      (['pid', 'parentPid', 'birth'] as const).every(
        (key) => first.wrapper[key] === last.wrapper[key],
      ) &&
      firstNamespace.dev === lastNamespace.dev &&
      firstNamespace.ino === lastNamespace.ino &&
      (['pid', 'parentPid', 'birth', 'localPid'] as const).every(
        (key) =>
          firstNamespace.init[key] === lastNamespace.init[key] && firstRoot[key] === lastRoot[key],
      ) &&
      last.phase === 'terminal' &&
      last.fdClosed &&
      !last.closeUnknown &&
      last.wrapper.exit?.reaped &&
      last.wrapper.exit.code === 0 &&
      last.wrapper.exit.signal === null &&
      last.wrapper.closed &&
      last.wrapper.stdoutEof &&
      last.wrapper.stderrEof &&
      lastNamespace.treeStopped &&
      lastNamespace.init.dead &&
      lastRoot.dead &&
      lastRoot.waitReceipt?.waitConfirmed &&
      lastRoot.waitReceipt.reaped &&
      lastRoot.waitReceipt.code === 7 &&
      lastRoot.waitReceipt.signal === null &&
      lastRoot.waitReceipt.rawStatus === 7 * 256
    );
  }
  if (ready.version !== 2 || terminal.version !== 2) return false;
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
      return false;
  }
  const first = ready.coalition,
    last = terminal.coalition;
  return !(
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
      ['id', 'guardianUniqueId', 'guardianPidVersion', 'claimTaskCount', 'label', 'domain'] as const
    ).some((key) => first[key] !== last[key])
  );
}

/** Pure cold decoder. Original native/reap observations remain the owning port's facts. */
export function verifyMcpStdioJobHandoff(
  value: McpStdioJobHandoff,
  expected: {
    ownerPid: number;
    identities: NonNullable<CaseEvidence['identities']>;
    platform?: string;
  },
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
    const platformVersion = { darwin: 2, win32: 3, linux: 4 };
    if (
      !ready ||
      !terminal ||
      (expected.platform !== undefined &&
        ready.version !== platformVersion[expected.platform as keyof typeof platformVersion]) ||
      !ownedExitValid(ready, terminal)
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
      Buffer.byteLength(JSON.stringify(value)) > 256 * 1024
    )
      return ['mcp_stdio_handoff_cold_invalid'];
    return [];
  } catch {
    return ['mcp_stdio_handoff_invalid'];
  }
}
