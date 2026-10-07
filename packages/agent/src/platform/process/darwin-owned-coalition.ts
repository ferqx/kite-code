import { dlopen, ptr } from 'bun:ffi';
import type { DarwinOwnedChild } from './darwin-owned-child';

// Apple proc_info_private.h / mach/coalition.h ABI, arm64 and x86_64.
// Loading is explicit: a cold import neither observes nor signals a process.
function loadProc() {
  return dlopen('/usr/lib/libproc.dylib', {
    proc_pidinfo: { args: ['i32', 'i32', 'u64', 'ptr', 'i32'], returns: 'i32' },
    proc_listallpids: { args: ['ptr', 'i32'], returns: 'i32' },
    proc_listcoalitions: { args: ['i32', 'i32', 'ptr', 'i32'], returns: 'i32' },
    proc_signal_with_audittoken: { args: ['ptr', 'i32'], returns: 'i32' },
  });
}

interface Identity {
  pid: number;
  unique: bigint;
  version: number;
  coalition: bigint;
}
export interface DarwinOwnedCoalition {
  readonly id: string;
  stop(child: DarwinOwnedChild, graceMs: number): Promise<{ confirmed: boolean; forced: boolean }>;
  close(): void;
}

/** Only a fresh, otherwise empty launchd guardian may claim its resource coalition. */
export function claimDarwinOwnedCoalition(): DarwinOwnedCoalition {
  if (process.platform !== 'darwin') throw Error('darwin_coalition_unsupported');
  const library = loadProc();
  const api = library.symbols;
  let closed = false;
  const identify = (pid: number): Identity | undefined => {
    if (closed || !Number.isSafeInteger(pid) || pid <= 1) return;
    const before = Buffer.alloc(56);
    const coalition = Buffer.alloc(40);
    const after = Buffer.alloc(56);
    if (
      api.proc_pidinfo(pid, 17, 0, ptr(before), before.length) !== before.length ||
      api.proc_pidinfo(pid, 20, 0, ptr(coalition), coalition.length) !== coalition.length ||
      api.proc_pidinfo(pid, 17, 0, ptr(after), after.length) !== after.length ||
      before.readBigUInt64LE(16) !== after.readBigUInt64LE(16) ||
      before.readInt32LE(32) !== after.readInt32LE(32)
    )
      return;
    return {
      pid,
      unique: before.readBigUInt64LE(16),
      version: before.readInt32LE(32),
      coalition: coalition.readBigUInt64LE(0),
    };
  };
  const rows = Buffer.alloc(4096 * 16);
  const count = (id: bigint): number | undefined => {
    if (closed) return;
    const bytes = api.proc_listcoalitions(2, 0, ptr(rows), rows.length);
    // A saturated or malformed list cannot establish the original task count.
    if (bytes <= 0 || bytes >= rows.length || bytes % 16) return;
    let found: number | undefined;
    for (let offset = 0; offset < bytes; offset += 16) {
      if (rows.readBigUInt64LE(offset) !== id || rows.readUInt32LE(offset + 8) !== 0) continue;
      if (found !== undefined) return;
      found = rows.readUInt32LE(offset + 12);
    }
    return found;
  };
  const original = identify(process.pid);
  const isOriginal = () => {
    const current = identify(process.pid);
    return (
      original &&
      current &&
      current.unique === original.unique &&
      current.version === original.version &&
      current.coalition === original.coalition
    );
  };
  if (!original || original.coalition === 0n || count(original.coalition) !== 1 || !isOriginal()) {
    library.close();
    throw Error('darwin_coalition_not_exclusive');
  }
  const pids = new Int32Array(65536);
  const signalMembers = (signal: 15 | 9): void => {
    if (!isOriginal()) return;
    const length = api.proc_listallpids(ptr(pids), pids.byteLength);
    if (length <= 0 || length >= pids.length) return;
    for (let index = 0; index < length; index++) {
      const pid = pids[index]!;
      if (pid === original.pid) continue;
      const member = identify(pid);
      if (!member || member.coalition !== original.coalition) continue;
      const token = new Uint32Array(8);
      token[5] = pid;
      token[7] = member.version;
      // The kernel matches PID version atomically; an exec/reuse race returns
      // ESRCH. Never fall back to kill(pid), a process name, or a foreign group.
      api.proc_signal_with_audittoken(ptr(token), signal);
      // Keep the pointer's backing storage alive through the synchronous call.
      if (token[5] !== pid || token[7] !== member.version >>> 0)
        throw Error('darwin_coalition_signal_memory_changed');
    }
  };
  let stopping: Promise<{ confirmed: boolean; forced: boolean }> | undefined;
  return {
    id: original.coalition.toString(),
    stop(child, graceMs) {
      if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 5000)
        return Promise.reject(Error('darwin_coalition_invalid_grace'));
      stopping ??= (async () => {
        let rootExited = false;
        void child.exited.then(() => {
          rootExited = true;
        });
        const empty = () =>
          rootExited && isOriginal() && count(original.coalition) === 1 && isOriginal();
        const waitEmpty = async (signal: 15 | 9, milliseconds: number) => {
          const deadline = Date.now() + milliseconds;
          do {
            if (empty()) return true;
            signalMembers(signal);
            await new Promise((resolve) => setTimeout(resolve, 20));
          } while (Date.now() < deadline);
          return Boolean(empty());
        };
        let forced = false;
        let confirmed = await waitEmpty(15, graceMs);
        if (!confirmed) {
          forced = true;
          confirmed = await waitEmpty(9, 2000);
        }
        // Retain the separate original-root/group proof and exact reap. Kernel
        // task count establishes descendant emptiness; neither PID enumeration
        // nor the unreaped root's numerical PGID establishes that fact.
        if (confirmed) confirmed = (await child.terminateGroup(0)).confirmed;
        return { confirmed, forced };
      })();
      return stopping;
    },
    close() {
      if (!closed) {
        closed = true;
        library.close();
      }
    },
  };
}
