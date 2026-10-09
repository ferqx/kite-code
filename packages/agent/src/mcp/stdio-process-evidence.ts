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
export type McpStdioProcessEvidence = McpStdioProcessEvidenceV1 | McpStdioProcessEvidenceV2;
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
    const data = value as McpStdioProcessEvidence;
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
