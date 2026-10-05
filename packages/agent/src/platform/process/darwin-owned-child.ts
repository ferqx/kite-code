import { dlopen, ptr, toArrayBuffer } from 'bun:ffi';
import { Readable } from 'node:stream';

// Darwin SDK ABI (arm64/x86_64): opaque spawn handles are pointer slots,
// siginfo_t is 104 bytes. No process is started on import.
function loadSystem() {
  return dlopen('/usr/lib/libSystem.B.dylib', {
    posix_spawn: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
    posix_spawnattr_init: { args: ['ptr'], returns: 'i32' },
    posix_spawnattr_destroy: { args: ['ptr'], returns: 'i32' },
    posix_spawnattr_setflags: { args: ['ptr', 'i16'], returns: 'i32' },
    posix_spawn_file_actions_init: { args: ['ptr'], returns: 'i32' },
    posix_spawn_file_actions_destroy: { args: ['ptr'], returns: 'i32' },
    posix_spawn_file_actions_addchdir_np: { args: ['ptr', 'ptr'], returns: 'i32' },
    posix_spawn_file_actions_addopen: { args: ['ptr', 'i32', 'ptr', 'i32', 'u16'], returns: 'i32' },
    posix_spawn_file_actions_adddup2: { args: ['ptr', 'i32', 'i32'], returns: 'i32' },
    posix_spawn_file_actions_addclose: { args: ['ptr', 'i32'], returns: 'i32' },
    pipe: { args: ['ptr'], returns: 'i32' },
    // Fixed-arity kernel entry: libc fcntl is variadic (Darwin arm64 stack ABI).
    __fcntl: { args: ['i32', 'i32', 'i32'], returns: 'i32' },
    read: { args: ['i32', 'ptr', 'u64'], returns: 'i64' },
    close: { args: ['i32'], returns: 'i32' },
    waitid: { args: ['i32', 'u32', 'ptr', 'i32'], returns: 'i32' },
    waitpid: { args: ['i32', 'ptr', 'i32'], returns: 'i32' },
    kill: { args: ['i32', 'i32'], returns: 'i32' },
    __error: { args: [], returns: 'ptr' },
  });
}
function loadProc() {
  return dlopen('/usr/lib/libproc.dylib', {
    proc_listpgrppids: { args: ['u32', 'ptr', 'i32'], returns: 'i32' },
  });
}

export interface DarwinOwnedChild {
  readonly pid: number;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Actual original-root exit; WNOWAIT deliberately keeps its PID reserved. */
  readonly exited: Promise<number | null>;
  terminateGroup(graceMs: number): Promise<{ confirmed: boolean; forced: boolean }>;
  /** Requires confirmed group stop. Exact root reap once; no later group signals. */
  reapAfterConfirmedStop(): void;
}

export function startDarwinOwnedChild(input: {
  executable: string;
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
}): DarwinOwnedChild {
  if (process.platform !== 'darwin') throw Error('darwin_owned_child_unsupported');
  if (
    !input.executable.startsWith('/') ||
    !input.cwd.startsWith('/') ||
    input.argv.length > 256 ||
    [input.executable, input.cwd, ...input.argv].some((value) => value.includes('\0')) ||
    Object.entries(input.env).some(
      ([key, value]) => !key || key.includes('=') || key.includes('\0') || value.includes('\0'),
    )
  )
    throw Error('darwin_owned_child_invalid_start');
  const system = loadSystem();
  let proc: ReturnType<typeof loadProc>;
  try {
    proc = loadProc();
  } catch (error) {
    system.close();
    throw error;
  }
  const api = system.symbols;
  const errno = () => new DataView(toArrayBuffer(api.__error()!, 0, 4)).getInt32(0, true);
  const failure = (operation: string, code: number): Error =>
    Object.assign(Error(`darwin_owned_child_${operation}`), { errno: code });
  const check = (operation: string, result: number) => {
    if (result !== 0) throw failure(operation, result);
  };
  const fds = new Set<number>();
  const closeFd = (fd: number) => {
    if (fds.delete(fd)) api.close(fd);
  };
  let spawned = false;
  let reaped = false;
  let released = false;
  const release = () => {
    if (!released && (!spawned || reaped) && fds.size === 0) {
      released = true;
      proc.close();
      system.close();
    }
  };
  const attr = new BigUint64Array(1);
  const actions = new BigUint64Array(1);
  let attrReady = false;
  let actionsReady = false;
  const cstring = (value: string) => Buffer.from(`${value}\0`);
  const executable = cstring(input.executable);
  const cwd = cstring(input.cwd);
  const nullDevice = cstring('/dev/null');
  const args = [executable, ...input.argv.map(cstring)];
  const environment = Object.entries(input.env).map(([key, value]) => cstring(`${key}=${value}`));
  const vector = (values: Buffer[]) =>
    BigUint64Array.from([...values.map((value) => BigInt(ptr(value))), 0n]);
  const argv = vector(args);
  const env = vector(environment);
  // ptr() provides addresses, not a pinning contract. This strong local set is
  // actually read after spawn returns, keeping every pointee alive across all
  // intervening native calls and JS allocations (including a forced GC).
  const launchStrings = [executable, cwd, nullDevice, ...args, ...environment];
  const launchVectors = [argv, env];
  let launchMemoryValid = true;
  const pidSlot = new Int32Array(1);
  let stdout: Readable | undefined;
  let stderr: Readable | undefined;
  const output = (fd: number): Readable => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let demand = false;
    const data = Buffer.alloc(32 * 1024);
    const pump = () => {
      timer = undefined;
      if (!demand || stream.destroyed) return;
      // One bounded native nonblocking read per turn; push owns a copied chunk.
      const count = Number(api.read(fd, ptr(data), data.length));
      if (count > 0) {
        demand = stream.push(Buffer.from(data.subarray(0, count)));
      } else if (count === 0) {
        demand = false;
        closeFd(fd);
        release();
        stream.push(null);
        return;
      } else {
        const code = errno();
        if (code !== 35 && code !== 4) {
          stream.destroy(failure('read', code));
          return;
        }
      }
      if (demand) timer = setTimeout(pump, count > 0 ? 0 : 10);
    };
    const stream = new Readable({
      highWaterMark: 32 * 1024,
      read() {
        demand = true;
        if (!timer) timer = setTimeout(pump, 0);
      },
      destroy(error, callback) {
        demand = false;
        if (timer) clearTimeout(timer);
        timer = undefined;
        closeFd(fd);
        release();
        callback(error);
      },
    });
    return stream;
  };
  try {
    check('attr_init', api.posix_spawnattr_init(ptr(attr)));
    attrReady = true;
    check('actions_init', api.posix_spawn_file_actions_init(ptr(actions)));
    actionsReady = true;
    // SETSID makes the original PID both PGID and SID. CLOEXEC_DEFAULT prevents
    // unrelated parent FDs from leaking; only explicit file actions survive.
    check('attr_flags', api.posix_spawnattr_setflags(ptr(attr), 0x4400));
    check('chdir', api.posix_spawn_file_actions_addchdir_np(ptr(actions), ptr(cwd)));
    check('stdin', api.posix_spawn_file_actions_addopen(ptr(actions), 0, ptr(nullDevice), 0, 0));
    const pipe = (target: number) => {
      const slots = new Int32Array(2);
      if (api.pipe(ptr(slots)) !== 0) throw failure('pipe', errno());
      const reader = slots[0]!;
      const writer = slots[1]!;
      fds.add(reader);
      fds.add(writer);
      if (reader < 3 || writer < 3) throw Error('darwin_owned_child_standard_fds_missing');
      for (const fd of [reader, writer]) {
        if (api.__fcntl(fd, 2, 1) < 0 || (api.__fcntl(fd, 1, 0) & 1) !== 1)
          throw failure('cloexec', errno());
      }
      const flags = api.__fcntl(reader, 3, 0);
      if (
        flags < 0 ||
        api.__fcntl(reader, 4, flags | 4) < 0 ||
        (api.__fcntl(reader, 3, 0) & 4) !== 4
      )
        throw failure('nonblocking', errno());
      check('dup', api.posix_spawn_file_actions_adddup2(ptr(actions), writer, target));
      check('close_reader', api.posix_spawn_file_actions_addclose(ptr(actions), reader));
      check('close_writer', api.posix_spawn_file_actions_addclose(ptr(actions), writer));
      return { reader, writer };
    };
    const out = pipe(1);
    const err = pipe(2);
    stdout = output(out.reader);
    stderr = output(err.reader);
    check(
      'spawn',
      api.posix_spawn(ptr(pidSlot), ptr(executable), ptr(actions), ptr(attr), ptr(argv), ptr(env)),
    );
    spawned = true;
    closeFd(out.writer);
    closeFd(err.writer);
  } catch (error) {
    // POSIX spawn reports failure without a child; never invent a pid/exit.
    stdout?.destroy();
    stderr?.destroy();
    for (const fd of fds) closeFd(fd);
    throw error;
  } finally {
    // Do not throw after successful spawn and lose the already-created root.
    // An invalid terminator preserves its owner but prevents a stop proof/reap.
    launchMemoryValid =
      launchStrings.every((value) => value.length > 0 && value[value.length - 1] === 0) &&
      launchVectors.every((value) => value.length > 0 && value[value.length - 1] === 0n);
    if (actionsReady) api.posix_spawn_file_actions_destroy(ptr(actions));
    if (attrReady) api.posix_spawnattr_destroy(ptr(attr));
    release();
  }
  const pid = pidSlot[0]!;
  const info = Buffer.alloc(104);
  let observed = false;
  let observationFailed = false;
  let observedCode: number | null = null;
  let observedStatus = 0;
  let observedKind = 0;
  let resolveExit!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });
  let observeTimer: ReturnType<typeof setTimeout> | undefined;
  const observe = (): boolean => {
    if (reaped || observationFailed) return false;
    info.fill(0);
    if (api.waitid(1, pid, ptr(info), 0x25) !== 0) {
      if (errno() === 4) return false;
      observationFailed = true;
      resolveExit(null);
      return false;
    }
    const waited = info.readInt32LE(12);
    if (waited === 0) return false;
    const code = info.readInt32LE(8);
    const status = info.readInt32LE(20);
    if (waited !== pid || ![1, 2, 3].includes(code)) {
      observationFailed = true;
      resolveExit(null);
      return false;
    }
    if (
      observed &&
      (observedCode !== (code === 1 ? status : null) ||
        observedStatus !== status ||
        observedKind !== code)
    ) {
      observationFailed = true;
      return false;
    }
    observed = true;
    observedStatus = status;
    observedKind = code;
    observedCode = code === 1 ? status : null;
    resolveExit(observedCode);
    return true;
  };
  const pollExit = () => {
    observeTimer = undefined;
    observe();
    if (!observed && !observationFailed) observeTimer = setTimeout(pollExit, 10);
  };
  observeTimer = setTimeout(pollExit, 0);
  const pids = new Int32Array(4096);
  const stopped = (): boolean => {
    // A waitable original root is the ownership anchor. EPERM/ESRCH from kill
    // cannot prove a held-zombie group stopped. Bound libproc enumeration.
    if (!launchMemoryValid || !observe()) return false;
    pids.fill(0);
    const count = proc.symbols.proc_listpgrppids(pid, ptr(pids), pids.byteLength);
    if (count <= 0 || count >= pids.length) return false;
    // Accept only the complete root-only group. A second WNOWAIT observation
    // matches its sole member to the owned, unreaped root, which cannot fork.
    // Any other member, even a zombie, requires another snapshot or unknown.
    return count === 1 && pids[0] === pid && observe();
  };
  const waitStopped = async (milliseconds: number) => {
    const deadline = Date.now() + milliseconds;
    do {
      if (stopped()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() <= deadline);
    return stopped();
  };
  let stopPromise: Promise<{ confirmed: boolean; forced: boolean }> | undefined;
  let confirmed = false;
  const signal = (value: number): boolean => {
    if (reaped || observationFailed) return false;
    // The original direct child remains unreaped even when it is a zombie.
    if (api.kill(-pid, value) === 0) return true;
    return errno() === 3; // ESRCH still requires independent libproc proof.
  };
  return {
    pid,
    stdout: stdout!,
    stderr: stderr!,
    exited,
    terminateGroup(graceMs) {
      if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 5000)
        return Promise.reject(Error('darwin_owned_child_invalid_grace'));
      stopPromise ??= (async () => {
        if (stopped()) {
          confirmed = true;
          return { confirmed: true, forced: false };
        }
        const termSent = signal(15);
        if (await waitStopped(graceMs)) {
          confirmed = true;
          return { confirmed: true, forced: false };
        }
        if (!termSent) return { confirmed: false, forced: false };
        signal(9);
        confirmed = await waitStopped(2000);
        return { confirmed, forced: true };
      })();
      return stopPromise;
    },
    reapAfterConfirmedStop() {
      if (reaped) return;
      if (!confirmed || !observe()) throw Error('darwin_owned_child_stop_unconfirmed');
      const status = new Int32Array(1);
      const result = api.waitpid(pid, ptr(status), 1);
      if (result !== pid) {
        observationFailed = true;
        throw failure('reap', result < 0 ? errno() : 0);
      }
      reaped = true;
      if (observeTimer) clearTimeout(observeTimer);
      observeTimer = undefined;
      release();
      const rawStatus = status[0]!;
      if (
        (observedKind === 1 && (rawStatus & 0x7f) !== 0) ||
        (observedKind === 1 && ((rawStatus >> 8) & 0xff) !== observedStatus) ||
        (observedKind !== 1 && (rawStatus & 0x7f) !== observedStatus)
      )
        throw Error('darwin_owned_child_reap_status_mismatch');
    },
  };
}
