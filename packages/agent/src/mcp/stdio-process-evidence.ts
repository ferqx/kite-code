/** Read-only owned-process evidence; never a descendant census or execution authority. */
export interface McpStdioProcessIdentity {
  pid: number;
  parentPid: number | null;
  birth: { seconds: string; microseconds: number } | null;
  unavailable: string[];
}
export interface McpStdioProcessRecord extends McpStdioProcessIdentity {
  exit: { code: number | null; signal: string | null; reaped: true } | null;
  kernelState: 'absent' | 'reused' | 'alive' | 'unavailable';
}
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
let native: ((pid: number) => McpStdioProcessIdentity) | undefined;
export function observeMcpStdioIdentity(pid: number): McpStdioProcessIdentity {
  try {
    if (!Number.isSafeInteger(pid) || pid < 2 || process.platform !== 'darwin')
      throw Error('unsupported');
    if (!native) {
      const { dlopen, ptr } = require('bun:ffi') as typeof import('bun:ffi');
      const api = dlopen('/usr/lib/libproc.dylib', {
        proc_pidinfo: { args: ['i32', 'i32', 'u64', 'ptr', 'i32'], returns: 'i32' },
      });
      native = (current) => {
        // Darwin SDK proc_bsdinfo: size 136, pid@12, ppid@16, sec@120, usec@128.
        const bytes = new Uint8Array(136);
        if (api.symbols.proc_pidinfo(current, 3, 0, ptr(bytes), bytes.length) !== bytes.length)
          throw Error('unavailable');
        const view = new DataView(bytes.buffer),
          seconds = view.getBigUint64(120, true),
          microseconds = view.getBigUint64(128, true);
        if (view.getUint32(12, true) !== current || seconds === 0n || microseconds >= 1000000n)
          throw Error('invalid');
        return {
          pid: current,
          parentPid: view.getUint32(16, true),
          birth: { seconds: String(seconds), microseconds: Number(microseconds) },
          unavailable: [],
        };
      };
    }
    return native(pid);
  } catch {
    return { pid, parentPid: null, birth: null, unavailable: ['native_birth_unavailable'] };
  }
}
export function mcpStdioKernelState(
  original: McpStdioProcessIdentity,
): McpStdioProcessRecord['kernelState'] {
  if (!Number.isSafeInteger(original.pid) || original.pid < 2) return 'unavailable';
  const current = observeMcpStdioIdentity(original.pid);
  if (original.birth && current.birth)
    return original.birth.seconds === current.birth.seconds &&
      original.birth.microseconds === current.birth.microseconds
      ? 'alive'
      : 'reused';
  try {
    process.kill(original.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'absent';
  }
  return 'unavailable';
}
/** Exact finite metadata accepted only inside the nonce/sequence-authenticated control stream. */
export function isMcpStdioIdentity(
  value: unknown,
  pid: number,
  parentPid: number,
): value is McpStdioProcessIdentity {
  if (!value || typeof value !== 'object') return false;
  const row = value as McpStdioProcessIdentity;
  return (
    Object.keys(row).sort().join(',') === 'birth,parentPid,pid,unavailable' &&
    row.pid === pid &&
    Number.isSafeInteger(pid) &&
    pid > 1 &&
    Array.isArray(row.unavailable) &&
    ((row.birth === null &&
      row.parentPid === null &&
      row.unavailable.length === 1 &&
      row.unavailable[0] === 'native_birth_unavailable') ||
      (row.parentPid === parentPid &&
        row.unavailable.length === 0 &&
        !!row.birth &&
        Object.keys(row.birth).sort().join(',') === 'microseconds,seconds' &&
        typeof row.birth.seconds === 'string' &&
        /^[1-9][0-9]{0,19}$/.test(row.birth.seconds) &&
        Number.isSafeInteger(row.birth.microseconds) &&
        row.birth.microseconds >= 0 &&
        row.birth.microseconds < 1000000))
  );
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
