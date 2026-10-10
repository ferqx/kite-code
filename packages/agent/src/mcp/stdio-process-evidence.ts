/** Read-only owned-process evidence; never a descendant census or execution authority. */
import {
  isOwnedProcessIdentity as isMcpStdioIdentity,
  type OwnedProcessIdentity,
  type OwnedProcessRecord,
} from '../platform/process/owned-process-observation';

export {
  isOwnedProcessIdentity as isMcpStdioIdentity,
  observeOwnedProcessIdentity as observeMcpStdioIdentity,
  ownedProcessKernelState as mcpStdioKernelState,
} from '../platform/process/owned-process-observation';
export type McpStdioProcessIdentity = OwnedProcessIdentity;
export type McpStdioProcessRecord = OwnedProcessRecord;
export interface McpStdioProcessEvidenceV1 {
  version: 1;
  coverage: 'guardian-and-server-only';
  binding: {
    originalStoreId: string;
    sessionId: string;
    executionId: string;
    serverId: string;
    scopeId: string;
    configDigest: string;
  };
  ownerPid: number;
  guardian: McpStdioProcessRecord | null;
  server: McpStdioProcessRecord | null;
}
export interface McpStdioCoalitionEvidence {
  id: string;
  guardianUniqueId: string;
  guardianPidVersion: number;
  claimTaskCount: 1;
  terminalTaskCount: 1 | null;
  processTreeStopped: boolean;
  label: string;
  domain: string;
  registrationRemoved: boolean;
}
export interface McpStdioProcessEvidenceV2 {
  version: 2;
  coverage: 'mcp-owned-coalition';
  binding: McpStdioProcessEvidenceV1['binding'];
  ownerPid: number;
  broker: McpStdioProcessRecord | null;
  /** launchd owns this process; its disappearance is not a parent-observed reap. */
  guardian: McpStdioProcessRecord | null;
  server: McpStdioProcessRecord | null;
  coalition: McpStdioCoalitionEvidence | null;
}
export interface McpStdioWindowsEvidence {
  version: 3;
  coverage: 'windows-job-members';
  binding: McpStdioProcessEvidenceV1['binding'];
  ownerPid: number;
  guardian: {
    pid: number;
    parentPid: number;
    creationTime: string;
    exit: { code: number | null; signal: string | null; reaped: true } | null;
    kernelState: 'alive' | 'dead' | 'uncertain';
    observationClosed: boolean;
  } | null;
  server: {
    pid: number;
    creationTime: string;
    exitCode: number | null;
    waitConfirmed: boolean;
  } | null;
  job: { activeProcesses: number | null; treeStopped: boolean } | null;
  closed: boolean;
  closeUnknown: boolean;
}
export type McpStdioProcessEvidence =
  | McpStdioProcessEvidenceV1
  | McpStdioProcessEvidenceV2
  | McpStdioWindowsEvidence;

/** Closed Windows receipt; never reconstructs a process or Job HANDLE on cold read. */
function decodeWindowsEvidence(
  value: McpStdioWindowsEvidence,
  binding: McpStdioProcessEvidenceV1['binding'],
  ownerPid?: number,
): McpStdioWindowsEvidence | undefined {
  const exact = (row: object, fields: string) => Object.keys(row).sort().join(',') === fields;
  const pid = (n: number) => Number.isSafeInteger(n) && n > 1 && n <= 0xffffffff;
  const birth = (s: string) =>
    typeof s === 'string' && /^[1-9][0-9]{0,19}$/.test(s) && BigInt(s) <= 0xffffffffffffffffn;
  const recordOrNull = (row: unknown) =>
    row === null || (typeof row === 'object' && !Array.isArray(row));
  if (
    !exact(value, 'binding,closeUnknown,closed,coverage,guardian,job,ownerPid,server,version') ||
    value.coverage !== 'windows-job-members' ||
    !pid(value.ownerPid) ||
    (ownerPid !== undefined && ownerPid !== value.ownerPid) ||
    !value.binding ||
    !exact(value.binding, 'configDigest,executionId,originalStoreId,scopeId,serverId,sessionId') ||
    Object.entries(value.binding).some(
      ([key, entry]) =>
        typeof entry !== 'string' ||
        !entry ||
        entry.length > 8192 ||
        binding[key as keyof typeof binding] !== entry,
    ) ||
    typeof value.closed !== 'boolean' ||
    typeof value.closeUnknown !== 'boolean' ||
    (value.closed && value.closeUnknown) ||
    !recordOrNull(value.guardian) ||
    !recordOrNull(value.server) ||
    !recordOrNull(value.job) ||
    JSON.stringify(value).length > 64 * 1024
  )
    return undefined;
  const g = value.guardian;
  if (
    g &&
    (!exact(g, 'creationTime,exit,kernelState,observationClosed,parentPid,pid') ||
      !pid(g.pid) ||
      g.pid === value.ownerPid ||
      g.parentPid !== value.ownerPid ||
      !birth(g.creationTime) ||
      !['alive', 'dead', 'uncertain'].includes(g.kernelState) ||
      typeof g.observationClosed !== 'boolean' ||
      (g.observationClosed && (g.kernelState !== 'dead' || g.exit === null)) ||
      (g.exit !== null &&
        (!exact(g.exit, 'code,reaped,signal') ||
          g.exit.reaped !== true ||
          g.kernelState === 'alive' ||
          !(
            (Number.isInteger(g.exit.code) &&
              g.exit.code! >= 0 &&
              g.exit.code! <= 0xffffffff &&
              g.exit.signal === null) ||
            (g.exit.code === null &&
              typeof g.exit.signal === 'string' &&
              /^SIG[A-Z0-9]{1,12}$/.test(g.exit.signal))
          ))))
  )
    return undefined;
  const r = value.server,
    j = value.job;
  if (
    (r === null) !== (j === null) ||
    (r &&
      (!g ||
        !exact(r, 'creationTime,exitCode,pid,waitConfirmed') ||
        !pid(r.pid) ||
        r.pid === g.pid ||
        r.pid === value.ownerPid ||
        !birth(r.creationTime) ||
        typeof r.waitConfirmed !== 'boolean' ||
        !(
          r.exitCode === null ||
          (Number.isInteger(r.exitCode) && r.exitCode >= 0 && r.exitCode <= 0xffffffff)
        ) ||
        r.waitConfirmed !== (r.exitCode !== null)))
  )
    return undefined;
  if (
    j &&
    (!exact(j, 'activeProcesses,treeStopped') ||
      typeof j.treeStopped !== 'boolean' ||
      !(
        j.activeProcesses === null ||
        (Number.isSafeInteger(j.activeProcesses) &&
          j.activeProcesses >= 0 &&
          j.activeProcesses <= 0xffffffff)
      ) ||
      (j.treeStopped && (j.activeProcesses !== 0 || !r?.waitConfirmed)))
  )
    return undefined;
  if (value.closed && (!j?.treeStopped || !r?.waitConfirmed)) return undefined;
  return copyMcpStdioEvidence(value) as McpStdioWindowsEvidence;
}
export function copyMcpStdioEvidence(value: McpStdioProcessEvidence): McpStdioProcessEvidence {
  const copy = structuredClone(value);
  const freeze = (row: object) => {
    for (const child of Object.values(row)) if (child && typeof child === 'object') freeze(child);
    Object.freeze(row);
  };
  freeze(copy);
  return copy;
}
export function decodeMcpStdioProcessEvidence(
  value: unknown,
  binding: McpStdioProcessEvidence['binding'],
  ownerPid?: number,
): McpStdioProcessEvidence | undefined {
  try {
    const exact = (row: object, fields: string) => Object.keys(row).sort().join(',') === fields;
    if ((value as { version?: unknown } | null)?.version === 3)
      return decodeWindowsEvidence(value as McpStdioWindowsEvidence, binding, ownerPid);
    const data = value as McpStdioProcessEvidenceV1 | McpStdioProcessEvidenceV2;
    if (
      !data ||
      !(
        (data.version === 1 &&
          exact(data, 'binding,coverage,guardian,ownerPid,server,version') &&
          data.coverage === 'guardian-and-server-only') ||
        (data.version === 2 &&
          exact(data, 'binding,broker,coalition,coverage,guardian,ownerPid,server,version') &&
          data.coverage === 'mcp-owned-coalition')
      ) ||
      !Number.isSafeInteger(data.ownerPid) ||
      data.ownerPid < 1 ||
      (ownerPid !== undefined && data.ownerPid !== ownerPid) ||
      !data.binding ||
      !exact(data.binding, 'configDigest,executionId,originalStoreId,scopeId,serverId,sessionId') ||
      Object.entries(data.binding).some(
        ([key, entry]) =>
          typeof entry !== 'string' ||
          !entry ||
          entry.length > 8192 ||
          binding[key as keyof typeof binding] !== entry,
      )
    )
      return undefined;
    const record = (row: McpStdioProcessRecord | null, parent: number) => {
      if (row === null) return true;
      if (row.pid === data.ownerPid) return false;
      if (!exact(row, 'birth,exit,kernelState,parentPid,pid,unavailable')) return false;
      const identity = {
        pid: row.pid,
        parentPid: row.parentPid,
        birth: row.birth,
        unavailable: row.unavailable,
      };
      if (
        !isMcpStdioIdentity(identity, row.pid, parent) ||
        !['absent', 'reused', 'alive', 'unavailable'].includes(row.kernelState)
      )
        return false;
      if (row.kernelState === 'alive' || row.kernelState === 'reused') if (!row.birth) return false;
      if (row.exit === null) return true;
      if (row.kernelState === 'alive') return false;
      return (
        exact(row.exit, 'code,reaped,signal') &&
        row.exit.reaped === true &&
        ((Number.isSafeInteger(row.exit.code) &&
          row.exit.code! >= 0 &&
          row.exit.code! <= 255 &&
          row.exit.signal === null) ||
          (row.exit.code === null &&
            typeof row.exit.signal === 'string' &&
            /^SIG[A-Z0-9]{1,12}$/.test(row.exit.signal)))
      );
    };
    if (
      !record(data.guardian, data.version === 1 ? data.ownerPid : 1) ||
      (data.server !== null && (!data.guardian || data.server.pid === data.guardian.pid)) ||
      !record(data.server, data.guardian?.pid ?? 0) ||
      JSON.stringify(data).length > 64 * 1024
    )
      return undefined;
    if (data.version === 2) {
      if (
        !record(data.broker, data.ownerPid) ||
        (data.guardian && data.guardian.exit !== null) ||
        (data.broker && [data.guardian?.pid, data.server?.pid].includes(data.broker.pid))
      )
        return undefined;
      const coalition = data.coalition;
      if (coalition === null) {
        if (data.guardian || data.server) return undefined;
      } else if (
        !data.guardian?.birth ||
        !exact(
          coalition,
          'claimTaskCount,domain,guardianPidVersion,guardianUniqueId,id,label,processTreeStopped,registrationRemoved,terminalTaskCount',
        ) ||
        !/^[1-9][0-9]{0,19}$/.test(coalition.id) ||
        !/^[1-9][0-9]{0,19}$/.test(coalition.guardianUniqueId) ||
        !Number.isSafeInteger(coalition.guardianPidVersion) ||
        coalition.guardianPidVersion < 1 ||
        coalition.guardianPidVersion > 0xffffffff ||
        coalition.claimTaskCount !== 1 ||
        typeof coalition.processTreeStopped !== 'boolean' ||
        coalition.terminalTaskCount !== (coalition.processTreeStopped ? 1 : null) ||
        !/^com\.kitecode\.mcp\.[a-f0-9-]{36}$/.test(coalition.label) ||
        !/^user\/[0-9]{1,10}$/.test(coalition.domain) ||
        typeof coalition.registrationRemoved !== 'boolean' ||
        (coalition.processTreeStopped &&
          (!data.server?.exit || data.server.kernelState === 'alive'))
      )
        return undefined;
    }
    return copyMcpStdioEvidence(data);
  } catch {
    return undefined;
  }
}
