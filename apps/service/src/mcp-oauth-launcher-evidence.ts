import {
  isOwnedProcessIdentity,
  type OwnedProcessRecord,
} from '@kite-ai/agent/process-observation';

export interface McpAuthBinding {
  version: 1;
  executionId: string;
  originCommandId: string;
  originalStoreId: string;
  sessionId: string;
  workspaceId: string;
  actionId: 'mcp.auth.login' | 'mcp.auth.refresh' | 'mcp.auth.clear' | 'mcp.auth.revoke';
  serverId: string;
  inputDigest: string;
}
export interface McpOAuthLauncherObservation {
  version: 1;
  coverage: 'oauth-launcher-only';
  browserOwnership: 'external';
  ownerPid: number;
  launcher: OwnedProcessRecord;
}
export interface McpOAuthLauncherEvidence extends McpOAuthLauncherObservation {
  binding: McpAuthBinding;
}
const exact = (value: object, keys: string) => Object.keys(value).sort().join(',') === keys;
function copy<T extends object>(value: T): T {
  const result = structuredClone(value);
  const freeze = (row: object) => {
    for (const child of Object.values(row)) if (child && typeof child === 'object') freeze(child);
    Object.freeze(row);
  };
  freeze(result);
  return result;
}
/** A trusted spawn observer's finite metadata, never an ownership/stop qualification. */
export function decodeMcpOAuthLauncherObservation(
  value: unknown,
  ownerPid?: number,
): McpOAuthLauncherObservation | undefined {
  try {
    const data = value as McpOAuthLauncherObservation;
    if (
      !data ||
      !exact(data, 'browserOwnership,coverage,launcher,ownerPid,version') ||
      data.version !== 1 ||
      data.coverage !== 'oauth-launcher-only' ||
      data.browserOwnership !== 'external' ||
      !Number.isSafeInteger(data.ownerPid) ||
      data.ownerPid < 2 ||
      (ownerPid !== undefined && data.ownerPid !== ownerPid)
    )
      return undefined;
    const row = data.launcher;
    if (
      !row ||
      !exact(row, 'birth,exit,kernelState,parentPid,pid,unavailable') ||
      row.pid === data.ownerPid ||
      !isOwnedProcessIdentity(
        { pid: row.pid, parentPid: row.parentPid, birth: row.birth, unavailable: row.unavailable },
        row.pid,
        data.ownerPid,
      ) ||
      !['absent', 'reused', 'alive', 'unavailable'].includes(row.kernelState) ||
      ((row.kernelState === 'alive' || row.kernelState === 'reused') && !row.birth)
    )
      return undefined;
    if (row.exit !== null) {
      // Bun reports an actual numeric exit status even when signalCode is present.
      if (
        !exact(row.exit, 'code,reaped,signal') ||
        row.exit.reaped !== true ||
        !Number.isSafeInteger(row.exit.code) ||
        row.exit.code! < 0 ||
        row.exit.code! > 255 ||
        !(
          row.exit.signal === null ||
          (typeof row.exit.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(row.exit.signal))
        ) ||
        row.kernelState === 'alive'
      )
        return undefined;
    }
    if (JSON.stringify(data).length > 4096) return undefined;
    return copy(data);
  } catch {
    return undefined;
  }
}
export function decodeMcpOAuthLauncherEvidence(
  value: unknown,
  binding: McpAuthBinding,
  ownerPid?: number,
): McpOAuthLauncherEvidence | undefined {
  try {
    const data = value as McpOAuthLauncherEvidence;
    if (
      !data ||
      !exact(data, 'binding,browserOwnership,coverage,launcher,ownerPid,version') ||
      !data.binding ||
      !exact(
        data.binding,
        'actionId,executionId,inputDigest,originCommandId,originalStoreId,serverId,sessionId,version,workspaceId',
      ) ||
      data.binding.version !== 1 ||
      data.binding.actionId !== 'mcp.auth.login' ||
      Object.entries(data.binding).some(
        ([key, entry]) =>
          entry !== binding[key as keyof McpAuthBinding] ||
          (key !== 'version' && (typeof entry !== 'string' || !entry || entry.length > 8192)),
      )
    )
      return undefined;
    const { binding: _binding, ...observation } = data;
    const decoded = decodeMcpOAuthLauncherObservation(observation, ownerPid);
    if (!decoded || JSON.stringify(data).length > 16384) return undefined;
    return copy({ ...decoded, binding: data.binding });
  } catch {
    return undefined;
  }
}
