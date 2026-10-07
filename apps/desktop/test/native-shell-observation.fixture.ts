import { dlopen, ptr } from 'bun:ffi';
import { spawnSync } from 'node:child_process';

export interface NativeShellProcessIncarnation {
  pid: number;
  unique: string;
  version: number;
}

export interface NativeShellProcessIdentity extends NativeShellProcessIncarnation {
  coalition: string;
  parent: number;
  processGroup: number;
  executable: string;
}

/** A scoped scan cannot establish absence from a failed identity/path read. */
export function scanNativeShellOwned(
  pids: readonly number[],
  executables: readonly string[],
  roots: readonly string[],
  reader: {
    uid: number;
    executable(pid: number): string | undefined;
    uidOf(pid: number): number | undefined;
    incarnation(pid: number): NativeShellProcessIncarnation | undefined;
    preExisting: ReadonlyMap<number, NativeShellProcessIncarnation>;
    observe(pid: number): NativeShellProcessIdentity | undefined;
    mayBeAlive(pid: number): boolean;
  },
) {
  const identities: NativeShellProcessIdentity[] = [],
    unconfirmed: number[] = [];
  const scoped = (path: string) =>
    executables.includes(path) || roots.some((root) => path.startsWith(`${root}/`));
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    const path = reader.executable(pid);
    if (path && !scoped(path)) continue;
    // All fixture children retain this user's UID. A readable foreign UID is
    // outside this scope; an unreadable UID must not be treated as foreign.
    if (!path) {
      const uid = reader.uidOf(pid);
      if (uid !== undefined && uid !== reader.uid) continue;
      const prior = reader.preExisting.get(pid);
      const current = prior && reader.incarnation(pid);
      if (
        prior &&
        current &&
        prior.unique === current.unique &&
        prior.version === current.version &&
        prior.pid === current.pid
      )
        continue;
    }
    const identity = reader.observe(pid);
    if (identity && scoped(identity.executable)) identities.push(identity);
    else if (reader.mayBeAlive(pid)) unconfirmed.push(pid);
  }
  return { identities, unconfirmed };
}

/** Read-only kernel identities; fixture cleanup uses atomic PID-version signals. */
export function openNativeShellObservation() {
  const library = dlopen('/usr/lib/libproc.dylib', {
    proc_pidinfo: { args: ['i32', 'i32', 'u64', 'ptr', 'i32'], returns: 'i32' },
    proc_pidpath: { args: ['i32', 'ptr', 'u32'], returns: 'i32' },
    proc_listallpids: { args: ['ptr', 'i32'], returns: 'i32' },
    proc_listcoalitions: { args: ['i32', 'i32', 'ptr', 'i32'], returns: 'i32' },
    proc_signal_with_audittoken: { args: ['ptr', 'i32'], returns: 'i32' },
  });
  const api = library.symbols;
  let incompleteObservations = 0,
    incompleteScopedObservations = 0,
    uidFallbackReads = 0;
  const uid = process.getuid?.();
  if (uid === undefined) {
    library.close();
    throw Error('native_shell_user_identity_unavailable');
  }
  const listPids = () => {
    const slots = new Int32Array(65536);
    const count = api.proc_listallpids(ptr(slots), slots.byteLength);
    if (count <= 0 || count >= slots.length) throw Error('native_shell_process_list_unavailable');
    return Array.from(slots.subarray(0, count));
  };
  const incarnation = (pid: number): NativeShellProcessIncarnation | undefined => {
    const info = Buffer.alloc(56);
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 1 ||
      api.proc_pidinfo(pid, 17, 0, ptr(info), info.length) !== info.length
    )
      return;
    return {
      pid,
      unique: info.readBigUInt64LE(16).toString(),
      version: info.readInt32LE(32),
    };
  };
  // This observer opens before any fixture process is launched. Only an exact
  // kernel incarnation match can exclude a pre-existing unreadable path.
  const preExisting = new Map<number, NativeShellProcessIncarnation>();
  try {
    for (const pid of listPids()) {
      const original = incarnation(pid);
      if (original) preExisting.set(pid, original);
    }
  } catch (cause) {
    library.close();
    throw cause;
  }
  const executable = (pid: number) => {
    const path = Buffer.alloc(4096);
    if (api.proc_pidpath(pid, ptr(path), path.length) <= 0) return;
    const end = path.indexOf(0);
    if (end <= 0) return;
    return path.subarray(0, end).toString('utf8');
  };
  const mayBeAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return false;
      return true;
    }
  };
  const observe = (pid: number): NativeShellProcessIdentity | undefined => {
    const before = Buffer.alloc(56),
      after = Buffer.alloc(56),
      coalition = Buffer.alloc(40),
      info = Buffer.alloc(136),
      path = Buffer.alloc(4096);
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 1 ||
      api.proc_pidinfo(pid, 17, 0, ptr(before), before.length) !== before.length ||
      api.proc_pidinfo(pid, 20, 0, ptr(coalition), coalition.length) !== coalition.length ||
      api.proc_pidinfo(pid, 3, 0, ptr(info), info.length) !== info.length ||
      api.proc_pidpath(pid, ptr(path), path.length) <= 0 ||
      api.proc_pidinfo(pid, 17, 0, ptr(after), after.length) !== after.length ||
      before.readBigUInt64LE(16) !== after.readBigUInt64LE(16) ||
      before.readInt32LE(32) !== after.readInt32LE(32)
    )
      return;
    return {
      pid,
      unique: before.readBigUInt64LE(16).toString(),
      version: before.readInt32LE(32),
      coalition: coalition.readBigUInt64LE(0).toString(),
      parent: info.readUInt32LE(16),
      processGroup: info.readUInt32LE(100),
      executable: path.subarray(0, path.indexOf(0)).toString('utf8'),
    };
  };
  const same = (a: NativeShellProcessIdentity, b: NativeShellProcessIdentity | undefined) =>
    !!b && a.pid === b.pid && a.unique === b.unique && a.version === b.version;
  const present = (original: NativeShellProcessIdentity) => {
    const current = observe(original.pid);
    if (current) return same(original, current);
    // Failed native observation is not absence unless the OS also says ESRCH.
    try {
      process.kill(original.pid, 0);
      // SIGKILL can leave a short exit/reap interval with no readable path.
      // Keep the original unconfirmed and let the bounded observer retry.
      incompleteObservations++;
      return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw cause;
    }
  };
  const coalitionCount = (id: string): number | 'absent' => {
    const rows = Buffer.alloc(4096 * 16);
    const bytes = api.proc_listcoalitions(2, 0, ptr(rows), rows.length);
    if (bytes <= 0 || bytes >= rows.length || bytes % 16)
      throw Error('native_shell_coalition_observation_unavailable');
    let count: number | undefined;
    for (let offset = 0; offset < bytes; offset += 16) {
      if (rows.readBigUInt64LE(offset).toString() !== id || rows.readUInt32LE(offset + 8) !== 0)
        continue;
      if (count !== undefined) throw Error('native_shell_coalition_ambiguous');
      count = rows.readUInt32LE(offset + 12);
    }
    return count ?? 'absent';
  };
  return {
    observe,
    same,
    present,
    coalitionCount,
    diagnostics() {
      return {
        incompleteObservations,
        incompleteScopedObservations,
        preExistingIdentities: preExisting.size,
        uidFallbackReads,
      };
    },
    owned(executables: readonly string[], roots: readonly string[]) {
      let fallbackUids: Map<number, number> | undefined;
      const fallbackUid = (pid: number) => {
        if (!fallbackUids) {
          fallbackUids = new Map();
          uidFallbackReads++;
          // libproc cannot read some zombies. ps supplies only current UID
          // classification, never signal authority or an absence claim.
          const result = spawnSync('/bin/ps', ['-axo', 'pid=,uid='], {
            encoding: 'utf8',
            timeout: 1000,
            maxBuffer: 1024 * 1024,
          });
          if (!result.error && result.status === 0)
            for (const row of result.stdout.trim().split('\n')) {
              const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(row);
              if (!match) continue;
              const id = Number(match[1]),
                owner = Number(match[2]);
              if (Number.isSafeInteger(id) && Number.isSafeInteger(owner))
                fallbackUids.set(id, owner);
            }
        }
        return fallbackUids.get(pid);
      };
      const result = scanNativeShellOwned(listPids(), executables, roots, {
        uid,
        executable,
        uidOf(pid) {
          const info = Buffer.alloc(136);
          if (api.proc_pidinfo(pid, 3, 0, ptr(info), info.length) !== info.length)
            return fallbackUid(pid);
          return info.readUInt32LE(20);
        },
        incarnation,
        preExisting,
        observe,
        mayBeAlive,
      });
      incompleteScopedObservations += result.unconfirmed.length;
      return result;
    },
    signal(original: NativeShellProcessIdentity, signal: 9 | 15) {
      if (!present(original)) return;
      const token = new Uint32Array(8);
      token[5] = original.pid;
      token[7] = original.version;
      const result = api.proc_signal_with_audittoken(ptr(token), signal);
      if (token[5] !== original.pid || token[7] !== original.version >>> 0)
        throw Error('native_shell_signal_identity_changed');
      if (result !== 0 && present(original)) throw Error('native_shell_original_signal_failed');
    },
    close() {
      library.close();
    },
  };
}
