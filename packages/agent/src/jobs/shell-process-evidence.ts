import type { DarwinOwnedChildEvidence } from '../platform/process/darwin-owned-child';
import {
  isOwnedProcessIdentity,
  type OwnedProcessRecord,
} from '../platform/process/owned-process-observation';
import {
  decodeLinuxShellProcessEvidence,
  type LinuxShellProcessEvidence,
  linuxShellProcessEvidenceEnded,
} from './linux-shell-process-evidence';

export interface MacosShellProcessEvidence {
  version: 1;
  coverage: 'shell-owned-coalition';
  binding: { sessionId: string; executionId: string; nonce: string };
  ownerPid: number;
  broker: OwnedProcessRecord;
  guardian: OwnedProcessRecord;
  root: DarwinOwnedChildEvidence;
  coalition: {
    id: string;
    guardianUniqueId: string;
    guardianPidVersion: number;
    claimTaskCount: 1;
    terminalTaskCount: 1 | null;
    processTreeStopped: boolean;
    label: string;
    domain: string;
    registrationRemoved: boolean;
  };
}
export type ShellProcessEvidence = MacosShellProcessEvidence | LinuxShellProcessEvidence;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function copyShellProcessEvidence<T extends ShellProcessEvidence>(value: T): T {
  return freeze(structuredClone(value));
}
/** Cold evidence is an observation of the original Job, never a live stop authority. */
export function decodeShellProcessEvidence(
  value: unknown,
  binding: ShellProcessEvidence['binding'],
  ownerPid?: number,
): ShellProcessEvidence | undefined {
  return value && typeof value === 'object' && 'version' in value && value.version === 2
    ? decodeLinuxShellProcessEvidence(value, binding, ownerPid)
    : decodeMacosShellProcessEvidence(value, binding, ownerPid);
}
export function decodeMacosShellProcessEvidence(
  value: unknown,
  binding: MacosShellProcessEvidence['binding'],
  ownerPid?: number,
): MacosShellProcessEvidence | undefined {
  try {
    const exact = (row: object, keys: string) => Object.keys(row).sort().join(',') === keys;
    const data = value as MacosShellProcessEvidence;
    if (
      !data ||
      !exact(data, 'binding,broker,coalition,coverage,guardian,ownerPid,root,version') ||
      data.version !== 1 ||
      data.coverage !== 'shell-owned-coalition' ||
      !Number.isSafeInteger(data.ownerPid) ||
      data.ownerPid < 2 ||
      (ownerPid !== undefined && data.ownerPid !== ownerPid) ||
      !exact(data.binding, 'executionId,nonce,sessionId') ||
      Object.entries(data.binding).some(
        ([key, entry]) =>
          typeof entry !== 'string' ||
          !entry ||
          entry.length > 8192 ||
          entry !== binding[key as keyof typeof binding],
      )
    )
      return undefined;
    const record = (row: OwnedProcessRecord, parent: number) => {
      if (
        !row ||
        !exact(row, 'birth,exit,kernelState,parentPid,pid,unavailable') ||
        !isOwnedProcessIdentity(
          {
            pid: row.pid,
            parentPid: row.parentPid,
            birth: row.birth,
            unavailable: row.unavailable,
          },
          row.pid,
          parent,
        ) ||
        !row.birth ||
        !['alive', 'absent', 'reused', 'unavailable'].includes(row.kernelState)
      )
        return false;
      if (row.exit === null) return true;
      return (
        row.kernelState !== 'alive' &&
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
    const root = data.root;
    if (
      !record(data.broker, data.ownerPid) ||
      !record(data.guardian, 1) ||
      data.guardian.exit !== null ||
      !root ||
      !exact(root, 'identity,observation,observationFailed,reaped,waitpid') ||
      !isOwnedProcessIdentity(root.identity, root.identity.pid, data.guardian.pid) ||
      !root.identity.birth ||
      new Set([data.ownerPid, data.broker.pid, data.guardian.pid, root.identity.pid]).size !== 4 ||
      typeof root.observationFailed !== 'boolean' ||
      typeof root.reaped !== 'boolean'
    )
      return undefined;
    if (
      root.observation !== null &&
      (!exact(root.observation, 'kind,status') ||
        ![1, 2, 3].includes(root.observation.kind) ||
        !Number.isSafeInteger(root.observation.status) ||
        root.observation.status < 0 ||
        root.observation.status > (root.observation.kind === 1 ? 255 : 127))
    )
      return undefined;
    if (root.waitpid === null) {
      if (root.reaped) return undefined;
    } else {
      const receipt = root.waitpid,
        observed = root.observation;
      if (
        !exact(receipt, 'pid,status,statusMatched') ||
        receipt.pid !== root.identity.pid ||
        !Number.isSafeInteger(receipt.status) ||
        receipt.status < 0 ||
        receipt.status > 65535 ||
        typeof receipt.statusMatched !== 'boolean' ||
        !root.reaped ||
        !observed
      )
        return undefined;
      const matches =
        observed.kind === 1
          ? (receipt.status & 0x7f) === 0 && ((receipt.status >> 8) & 0xff) === observed.status
          : (receipt.status & 0x7f) === observed.status;
      if (receipt.statusMatched !== matches) return undefined;
    }
    const c = data.coalition;
    if (
      !c ||
      !exact(
        c,
        'claimTaskCount,domain,guardianPidVersion,guardianUniqueId,id,label,processTreeStopped,registrationRemoved,terminalTaskCount',
      ) ||
      !/^[1-9][0-9]{0,19}$/.test(c.id) ||
      !/^[1-9][0-9]{0,19}$/.test(c.guardianUniqueId) ||
      BigInt(c.id) > 18446744073709551615n ||
      BigInt(c.guardianUniqueId) > 18446744073709551615n ||
      !Number.isSafeInteger(c.guardianPidVersion) ||
      c.guardianPidVersion < 1 ||
      c.guardianPidVersion > 0xffffffff ||
      c.claimTaskCount !== 1 ||
      typeof c.processTreeStopped !== 'boolean' ||
      c.terminalTaskCount !== (c.processTreeStopped ? 1 : null) ||
      !/^com\.kitecode\.shell\.[a-f0-9-]{36}$/.test(c.label) ||
      !/^user\/[0-9]{1,10}$/.test(c.domain) ||
      typeof c.registrationRemoved !== 'boolean' ||
      (c.processTreeStopped &&
        (!root.reaped || !root.waitpid?.statusMatched || root.observationFailed))
    )
      return undefined;
    if (JSON.stringify(data).length > 64 * 1024) return undefined;
    return copyShellProcessEvidence(data);
  } catch {
    return undefined;
  }
}
export function shellProcessEvidenceEnded(value: ShellProcessEvidence): boolean {
  if (value.version === 2) return linuxShellProcessEvidenceEnded(value);
  return !!(
    value.broker.exit &&
    ['absent', 'reused'].includes(value.broker.kernelState) &&
    ['absent', 'reused'].includes(value.guardian.kernelState) &&
    value.coalition.registrationRemoved &&
    value.coalition.processTreeStopped &&
    value.root.reaped &&
    value.root.waitpid?.statusMatched &&
    !value.root.observationFailed
  );
}
