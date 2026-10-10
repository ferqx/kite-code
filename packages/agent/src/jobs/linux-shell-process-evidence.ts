import type { LinuxOwnedShellEvidence } from '../platform/process/linux-owned-shell';

export interface LinuxShellProcessEvidence {
  version: 2;
  coverage: 'shell-owned-pid-namespace';
  binding: { sessionId: string; executionId: string; nonce: string };
  owner: LinuxOwnedShellEvidence;
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
export function copyLinuxShellProcessEvidence(
  value: LinuxShellProcessEvidence,
): LinuxShellProcessEvidence {
  return freeze(structuredClone(value));
}
/** A finite cold observation. It never opens libc, /proc, sockets or pidfds. */
export function decodeLinuxShellProcessEvidence(
  value: unknown,
  binding: LinuxShellProcessEvidence['binding'],
  ownerPid?: number,
): LinuxShellProcessEvidence | undefined {
  try {
    if (
      !exact(value, 'binding,coverage,owner,version') ||
      value.version !== 2 ||
      value.coverage !== 'shell-owned-pid-namespace' ||
      !exact(value.binding, 'executionId,nonce,sessionId') ||
      Object.entries(value.binding).some(
        ([key, entry]) =>
          typeof entry !== 'string' ||
          !entry ||
          entry.length > 8192 ||
          entry !== binding[key as keyof typeof binding],
      )
    )
      return undefined;
    const owner = value.owner;
    if (
      !exact(
        owner,
        'admission,closeUnknown,coverage,fdClosed,namespace,ownerPid,phase,version,wrapper',
      ) ||
      owner.version !== 1 ||
      owner.coverage !== 'linux-pid-namespace' ||
      !pid(owner.ownerPid) ||
      (ownerPid !== undefined && owner.ownerPid !== ownerPid) ||
      !exact(owner.admission, 'mode,nonce') ||
      owner.admission.nonce !== binding.nonce ||
      !['workspace', 'full', 'confined'].includes(String(owner.admission.mode)) ||
      !['starting', 'ready', 'terminal', 'unknown'].includes(String(owner.phase)) ||
      !bools(owner, ['fdClosed', 'closeUnknown']) ||
      (owner.fdClosed && owner.closeUnknown)
    )
      return undefined;
    const wrapper = owner.wrapper;
    if (
      !exact(wrapper, 'birth,closed,exit,parentPid,pid,stderrEof,stdoutEof') ||
      !pid(wrapper.pid) ||
      wrapper.parentPid !== owner.ownerPid ||
      !uint(wrapper.birth) ||
      !bools(wrapper, ['closed', 'stdoutEof', 'stderrEof']) ||
      wrapper.pid === owner.ownerPid
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
        new Set([owner.ownerPid, wrapper.pid, ns.init.pid]).size !== 3
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
          new Set([owner.ownerPid, wrapper.pid, ns.init.pid, root.pid]).size !== 4
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
        // The init can have reaped every business descendant while its own
        // original pidfd is still live. Complete disposal separately needs
        // both pidfds dead and all original descriptors closed.
        if (ns.treeStopped && !receipt) return undefined;
      }
    }
    const result = value as unknown as LinuxShellProcessEvidence;
    if (
      JSON.stringify(value).length > 64 * 1024 ||
      (owner.phase === 'terminal' && !linuxShellProcessEvidenceEnded(result))
    )
      return undefined;
    return copyLinuxShellProcessEvidence(result);
  } catch {
    return undefined;
  }
}
export function linuxShellProcessEvidenceEnded(value: LinuxShellProcessEvidence): boolean {
  const owner = value.owner;
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
