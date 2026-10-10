import type { LinuxOwnedProgramEvidence } from '../platform/process/linux-owned-program';
import type { McpStdioProcessEvidenceV1 } from './stdio-process-evidence';

export interface McpStdioLinuxEvidence {
  version: 4;
  coverage: 'mcp-owned-pid-namespace';
  binding: McpStdioProcessEvidenceV1['binding'];
  ownerPid: number;
  process: LinuxOwnedProgramEvidence;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, keys: string): value is Record<string, unknown> =>
  object(value) && Object.keys(value).sort().join(',') === keys;
const pid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 1 && value <= 0x7fffffff;
const uint = (value: unknown, nonzero = true): value is string =>
  typeof value === 'string' &&
  (nonzero ? /^[1-9][0-9]{0,19}$/ : /^(?:0|[1-9][0-9]{0,19})$/).test(value) &&
  BigInt(value) <= 18446744073709551615n;
const bools = (value: Record<string, unknown>, keys: string[]) =>
  keys.every((key) => typeof value[key] === 'boolean');
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Original receipts only: cold decoding never opens /proc, libc, a socket or a pidfd. */
export function decodeMcpStdioLinuxEvidence(
  value: unknown,
  binding: McpStdioLinuxEvidence['binding'],
  ownerPid?: number,
): McpStdioLinuxEvidence | undefined {
  try {
    if (
      !exact(value, 'binding,coverage,ownerPid,process,version') ||
      value.version !== 4 ||
      value.coverage !== 'mcp-owned-pid-namespace' ||
      !pid(value.ownerPid) ||
      (ownerPid !== undefined && value.ownerPid !== ownerPid) ||
      !exact(
        value.binding,
        'configDigest,executionId,originalStoreId,scopeId,serverId,sessionId',
      ) ||
      Object.entries(value.binding).some(
        ([key, entry]) =>
          typeof entry !== 'string' ||
          !entry ||
          entry.length > 8192 ||
          entry !== binding[key as keyof typeof binding],
      )
    )
      return undefined;
    const owner = value.process;
    if (
      !exact(
        owner,
        'admission,closeUnknown,coverage,fdClosed,namespace,ownerPid,phase,version,wrapper',
      ) ||
      owner.version !== 1 ||
      owner.coverage !== 'linux-pid-namespace' ||
      owner.ownerPid !== value.ownerPid ||
      !exact(owner.admission, 'nonce,purpose') ||
      typeof owner.admission.nonce !== 'string' ||
      !/^[a-zA-Z0-9_-]{16,128}$/.test(owner.admission.nonce) ||
      owner.admission.purpose !== 'stdio' ||
      !['starting', 'ready', 'terminal', 'unknown'].includes(String(owner.phase)) ||
      !bools(owner, ['fdClosed', 'closeUnknown']) ||
      (owner.fdClosed && owner.closeUnknown)
    )
      return undefined;
    const wrapper = owner.wrapper;
    if (
      !exact(wrapper, 'birth,closed,exit,parentPid,pid,stderrEof,stdoutEof') ||
      !pid(wrapper.pid) ||
      wrapper.parentPid !== value.ownerPid ||
      !uint(wrapper.birth) ||
      !bools(wrapper, ['closed', 'stdoutEof', 'stderrEof']) ||
      wrapper.pid === value.ownerPid
    )
      return undefined;
    if (
      wrapper.exit !== null &&
      (!exact(wrapper.exit, 'code,reaped,signal') ||
        wrapper.exit.reaped !== true ||
        !(
          (typeof wrapper.exit.code === 'number' &&
            Number.isSafeInteger(wrapper.exit.code) &&
            wrapper.exit.code >= 0 &&
            wrapper.exit.code <= 255 &&
            wrapper.exit.signal === null) ||
          (wrapper.exit.code === null &&
            typeof wrapper.exit.signal === 'string' &&
            /^SIG[A-Z0-9]{1,12}$/.test(wrapper.exit.signal))
        ))
    )
      return undefined;
    if (wrapper.closed && (!wrapper.exit || !wrapper.stdoutEof || !wrapper.stderrEof))
      return undefined;
    const ns = owner.namespace;
    if (ns === null) {
      if (owner.phase === 'ready' || owner.phase === 'terminal') return undefined;
    } else {
      if (
        !exact(ns, 'dev,init,ino,root,treeStopped') ||
        !uint(ns.dev, false) ||
        !uint(ns.ino) ||
        typeof ns.treeStopped !== 'boolean' ||
        !exact(ns.init, 'birth,dead,localPid,parentPid,pid') ||
        !pid(ns.init.pid) ||
        !uint(ns.init.birth) ||
        ns.init.parentPid !== wrapper.pid ||
        ns.init.localPid !== 1 ||
        typeof ns.init.dead !== 'boolean' ||
        new Set([value.ownerPid, wrapper.pid, ns.init.pid]).size !== 3
      )
        return undefined;
      const root = ns.root;
      if (root === null) {
        if (ns.treeStopped || owner.phase === 'ready' || owner.phase === 'terminal')
          return undefined;
      } else {
        if (
          !exact(root, 'birth,dead,localPid,parentPid,pid,waitReceipt') ||
          !pid(root.pid) ||
          !pid(root.localPid) ||
          !uint(root.birth) ||
          root.parentPid !== ns.init.pid ||
          typeof root.dead !== 'boolean' ||
          new Set([value.ownerPid, wrapper.pid, ns.init.pid, root.pid]).size !== 4
        )
          return undefined;
        const receipt = root.waitReceipt;
        if (receipt !== null) {
          if (
            !exact(receipt, 'code,localPid,rawStatus,reaped,signal,waitConfirmed') ||
            receipt.localPid !== root.localPid ||
            receipt.reaped !== true ||
            receipt.waitConfirmed !== true ||
            typeof receipt.rawStatus !== 'number' ||
            !Number.isSafeInteger(receipt.rawStatus) ||
            receipt.rawStatus < 0 ||
            receipt.rawStatus > 65535
          )
            return undefined;
          const raw = receipt.rawStatus;
          if (
            !(
              (typeof receipt.code === 'number' &&
                Number.isSafeInteger(receipt.code) &&
                receipt.code >= 0 &&
                receipt.code <= 255 &&
                receipt.signal === null &&
                raw === receipt.code * 256) ||
              (receipt.code === null &&
                typeof receipt.signal === 'number' &&
                Number.isSafeInteger(receipt.signal) &&
                receipt.signal >= 1 &&
                receipt.signal <= 64 &&
                (raw & 0x7f) === receipt.signal &&
                (raw & ~0xff) === 0)
            )
          )
            return undefined;
        }
        if (ns.treeStopped && !receipt) return undefined;
      }
    }
    const result = value as unknown as McpStdioLinuxEvidence;
    if (
      Buffer.byteLength(JSON.stringify(value)) > 64 * 1024 ||
      (owner.phase === 'terminal' && !mcpStdioLinuxEvidenceEnded(result))
    )
      return undefined;
    return freeze(structuredClone(result));
  } catch {
    return undefined;
  }
}
export function mcpStdioLinuxEvidenceEnded(value: McpStdioLinuxEvidence): boolean {
  const owner = value.process;
  const ns = owner.namespace;
  return !!(
    owner.phase === 'terminal' &&
    owner.fdClosed &&
    !owner.closeUnknown &&
    owner.wrapper.exit?.reaped &&
    owner.wrapper.exit.code === 0 &&
    owner.wrapper.exit.signal === null &&
    owner.wrapper.closed &&
    owner.wrapper.stdoutEof &&
    owner.wrapper.stderrEof &&
    ns?.treeStopped &&
    ns.init.dead &&
    ns.root?.dead &&
    ns.root.waitReceipt?.reaped &&
    ns.root.waitReceipt.waitConfirmed
  );
}
