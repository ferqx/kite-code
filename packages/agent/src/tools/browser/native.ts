import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  type Stats,
  statSync,
} from 'node:fs';
import { lstat, open, opendir, readFile, unlink } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { JobContext, Json } from '../../extensions';
import {
  type LinuxOwnedProgram,
  type LinuxOwnedProgramEvidence,
  LinuxOwnedProgramStartError,
  startLinuxOwnedProgram,
} from '../../platform/process/linux-owned-program';
import { nodeRuntimeFlags } from '../../platform/runtime-flags';
import {
  type DarwinBrowserEvidence,
  type DarwinBrowserOwner,
  startDarwinBrowserOwner,
} from './darwin-owner';
import type {
  BrowserAnnotation,
  BrowserFrame,
  BrowserReleasedPage,
  BrowserSharedPageIdentity,
} from './types';

/** Pinned internal daemon protocol; never mix this owner with CLI auto-start. */
export const agentBrowserVersion = '0.39.4';
export interface NativeBrowserTransportOptions {
  executable: string;
  browserPath: string;
  linux?: { bubblewrapPath: string; initExecutable: string };
  darwin?: { guardianPath: string; runtimeExecutable: string };
  runtimeDirectory?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  graceMs?: number;
  maximumRequestBytes?: number;
  maximumResponseBytes?: number;
  /** Trusted paired Native host only; never public Tool/configuration input. */
  attachment?: {
    cdpUrl: string;
    /** Paired Main facts only. Never serialized to the daemon, provider or model. */
    readPageState?: (signal: AbortSignal) => Promise<{ url: string; title: string }>;
  };
  /** Trusted unified Native API only; dialogs require a current host-issued identity. */
  manualDialogs?: true;
}
export interface NativeBrowserTransport {
  /** Trusted host diagnostics only; never part of the browser view or Tool result. */
  readProcessEvidence?(): LinuxOwnedProgramEvidence | DarwinBrowserEvidence;
  readonly sharedPage?: true;
  /** Exact identity from the paired Main acquire response; no page/Tool projection. */
  sharedPageIdentity?(): Readonly<BrowserSharedPageIdentity> | null;
  /** Passive exact Main release metadata, available only after confirmed close and dispose. */
  releasedSharedPage?(): Readonly<BrowserReleasedPage> | null;
  handoff?(signal: AbortSignal): Promise<void>;
  resume?(signal: AbortSignal): Promise<void>;
  readonly ready: Promise<void>;
  readonly completion: Promise<{ confirmed: boolean }>;
  /** Full response envelope, including success/code and confirmation-required data. */
  request(command: Record<string, Json>, signal: AbortSignal): Promise<Json>;
  capture(signal: AbortSignal): Promise<{
    frame: Omit<BrowserFrame, 'seq'>;
    annotations: BrowserAnnotation[];
    url?: string;
    title?: string;
  }>;
  /** Formal model observation, independent of annotated UI preview. */
  capturePng?(signal: AbortSignal): Promise<{
    data: string;
    width: number;
    height: number;
    imageRef?: string;
    viewport?: { width: number; height: number };
    navigation?: number;
  }>;
  pointer?(
    input: {
      imageRef: string;
      kind: 'click' | 'drag';
      from: { x: number; y: number };
      to?: { x: number; y: number };
    },
    signal: AbortSignal,
  ): Promise<void>;
  dialogs?(
    signal: AbortSignal,
  ): Promise<{ dialogRef: string; type: 'alert' | 'confirm' | 'prompt' | 'beforeunload' }[]>;
  dialog?(
    input: { dialogRef: string; response: 'accept' | 'dismiss' },
    signal: AbortSignal,
  ): Promise<void>;
  close(): Promise<{ confirmed: boolean }>;
  dispose(): Promise<void>;
}
export class BrowserTransportError extends Error {
  readonly dispatched: boolean;
  constructor(code: string, dispatched: boolean) {
    super(code);
    this.name = 'BrowserTransportError';
    this.dispatched = dispatched;
  }
}
const retained = new Set<object>();
// These are process-local admission/stop budgets, not OS disk or memory quotas.
// Unknown cleanup keeps its slot: creating another owner must not hide accumulation.
const admitted = new Set<string>();
const MAXIMUM_SESSIONS = 2;
const MAXIMUM_LIFETIME_MS = 10 * 60 * 1000;
const STORAGE_BYTES = 256 * 1024 * 1024;
const STORAGE_ENTRIES = 4096;
const STORAGE_DEPTH = 32;
const STORAGE_SCAN_MS = 500;
const STORAGE_INTERVAL_MS = 1000;
const object = (value: unknown): value is Record<string, Json> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code: string, dispatched = false) => new BrowserTransportError(code, dispatched);
/** Match the pinned upstream auto --no-sandbox triggers; PID ownership is not a web sandbox. */
function requireSandboxEligibleHost(): void {
  if (typeof process.geteuid !== 'function' || process.geteuid() === 0 || 'CI' in process.env)
    throw failure('browser_native_sandbox_unavailable');
  for (const marker of ['/.dockerenv', '/run/.containerenv']) {
    try {
      lstatSync(marker);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw failure('browser_native_sandbox_unknown');
    }
    throw failure('browser_native_sandbox_unavailable');
  }
  if (process.platform === 'darwin') return;
  // Inside the owned PID namespace /proc/1 is our init, with our cgroup. Inspect
  // both the current and host init cgroups conservatively, without unbounded reads.
  for (const path of ['/proc/self/cgroup', '/proc/1/cgroup']) {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const bytes = Buffer.alloc(65537);
      let count = 0;
      while (count < bytes.length) {
        const read = readSync(fd, bytes, count, bytes.length - count, null);
        if (!read) break;
        count += read;
      }
      if (!count || count === bytes.length) throw failure('browser_native_sandbox_unknown');
      if (/docker|kubepods|lxc/.test(bytes.subarray(0, count).toString('utf8')))
        throw failure('browser_native_sandbox_unavailable');
    } catch (cause) {
      if (cause instanceof BrowserTransportError) throw cause;
      throw failure('browser_native_sandbox_unknown');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}
/** Passive host preflight only; undefined is not evidence of successful native qualification. */
export function nativeBrowserUnavailableReason(): string | undefined {
  if (!['linux', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch))
    return 'browser_native_platform_unavailable';
  try {
    requireSandboxEligibleHost();
    return undefined;
  } catch (cause) {
    return cause instanceof BrowserTransportError
      ? cause.message
      : 'browser_native_sandbox_unknown';
  }
}
function limit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw failure('browser_native_invalid_limit');
  return result;
}
function executablePath(path: string): string {
  if (!isAbsolute(path) || path.includes('\0')) throw failure('browser_native_invalid_asset');
  const resolved = realpathSync(path);
  const stat = statSync(resolved);
  if (!stat.isFile() || !(stat.mode & 0o111)) throw failure('browser_native_invalid_asset');
  return resolved;
}
function runtimeBase(path: string | undefined): string {
  if (path === undefined) return realpathSync(tmpdir());
  if (!isAbsolute(path) || path.includes('\0')) throw failure('browser_native_invalid_directory');
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
  }
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    realpathSync(path) !== path
  )
    throw failure('browser_native_invalid_directory');
  return path;
}
function ended(e: LinuxOwnedProgramEvidence | DarwinBrowserEvidence, nonce: string): boolean {
  if (!('coverage' in e))
    return (
      e.ownerPid === process.pid &&
      e.nonce === nonce &&
      e.phase === 'terminal' &&
      e.treeStopped &&
      e.fdClosed &&
      e.registration?.removed === true &&
      e.coalition?.taskCount === 1 &&
      e.root?.exit?.reaped === true &&
      e.guardian?.kernelState === 'absent' &&
      e.guardian.exit === null &&
      e.broker?.exit?.code === 0 &&
      e.broker.exit.reaped === true
    );
  return !!(
    e.ownerPid === process.pid &&
    e.admission.nonce === nonce &&
    e.coverage === 'linux-pid-namespace' &&
    e.phase === 'terminal' &&
    e.fdClosed &&
    !e.closeUnknown &&
    e.wrapper.exit?.reaped &&
    e.wrapper.exit.code === 0 &&
    e.wrapper.exit.signal === null &&
    e.wrapper.closed &&
    e.wrapper.stdoutEof &&
    e.wrapper.stderrEof &&
    e.namespace?.treeStopped &&
    e.namespace.init.dead &&
    e.namespace.root?.dead &&
    e.namespace.root.waitReceipt?.waitConfirmed &&
    e.namespace.root.waitReceipt.reaped
  );
}
function jpegSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8)
    throw failure('browser_capture_invalid');
  for (let at = 2; at + 4 <= bytes.length; ) {
    if (bytes[at] !== 0xff) throw failure('browser_capture_invalid');
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(at);
    if (length < 2 || at + length > bytes.length) break;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      if (length < 8) break;
      const height = bytes.readUInt16BE(at + 3),
        width = bytes.readUInt16BE(at + 5);
      if (width < 1 || height < 1 || width > 1920 || height > 1080)
        throw failure('browser_capture_dimensions');
      return { width, height };
    }
    at += length;
  }
  throw failure('browser_capture_invalid');
}
function annotations(value: Json | undefined): BrowserAnnotation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw failure('browser_capture_annotations');
  return value.slice(0, 200).map((item) => {
    if (
      !object(item) ||
      typeof item.ref !== 'string' ||
      !/^e[1-9][0-9]{0,12}$/.test(item.ref) ||
      !Number.isSafeInteger(item.number) ||
      item.number !== Number(item.ref.slice(1)) ||
      typeof item.role !== 'string' ||
      !object(item.box)
    )
      throw failure('browser_capture_annotations');
    const box = item.box;
    for (const key of ['x', 'y', 'width', 'height']) {
      if (
        typeof box[key] !== 'number' ||
        !Number.isFinite(box[key]) ||
        Math.abs(box[key]) > 1000000
      )
        throw failure('browser_capture_annotations');
    }
    if (Number(box.width) <= 0 || Number(box.height) <= 0)
      throw failure('browser_capture_annotations');
    return {
      ref: `@${item.ref}`,
      number: item.number as number,
      role: item.role.slice(0, 64),
      ...(typeof item.name === 'string' ? { name: item.name.slice(0, 256) } : {}),
      box: {
        x: Number(box.x),
        y: Number(box.y),
        width: Number(box.width),
        height: Number(box.height),
      },
    };
  });
}

/** Returns the owner synchronously, including when startup cleanup is unknown. */
export function createNativeBrowserTransport(
  options: NativeBrowserTransportOptions,
  context: JobContext,
): NativeBrowserTransport {
  if (context.signal.aborted) throw failure('browser_native_aborted');
  if (
    options.attachment?.readPageState !== undefined &&
    typeof options.attachment.readPageState !== 'function'
  )
    throw failure('browser_attachment_invalid');
  const unavailable = nativeBrowserUnavailableReason();
  if (unavailable) throw failure(unavailable);
  if (admitted.size >= MAXIMUM_SESSIONS) throw failure('browser_native_session_limit');
  const startupTimeout = limit(options.startupTimeoutMs, 10000, 60000);
  const requestTimeout = limit(options.requestTimeoutMs, 35000, 120000);
  const maximumRequest = limit(options.maximumRequestBytes, 128 * 1024, 256 * 1024);
  const maximumResponse = limit(options.maximumResponseBytes, 512 * 1024, 2 * 1024 * 1024);
  const grace = limit(options.graceMs, 1000, 5000);
  const executable = executablePath(options.executable),
    browser = options.attachment ? '' : executablePath(options.browserPath);
  const linux = process.platform === 'linux' ? options.linux : undefined;
  const darwin = process.platform === 'darwin' ? options.darwin : undefined;
  if ((process.platform === 'linux' && !linux) || (process.platform === 'darwin' && !darwin))
    throw failure('browser_native_asset_unavailable');
  const bubblewrapPath = linux ? executablePath(linux.bubblewrapPath) : '';
  const initExecutable = linux ? executablePath(linux.initExecutable) : '';
  const guardianPath = darwin ? realpathSync(darwin.guardianPath) : '';
  if (
    darwin &&
    (!isAbsolute(guardianPath) || !guardianPath.endsWith('.js') || !statSync(guardianPath).isFile())
  )
    throw failure('browser_native_invalid_asset');
  const runtimeExecutable = darwin ? executablePath(darwin.runtimeExecutable) : '';
  const base = runtimeBase(options.runtimeDirectory);
  const directory = mkdtempSync(join(base, 'kite-ab-'));
  chmodSync(directory, 0o700);
  const identity = lstatSync(directory);
  const session = `s${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const socketPath = join(directory, `${session}.sock`);
  const nonce = randomUUID();
  admitted.add(directory);
  let owner: LinuxOwnedProgram | DarwinBrowserOwner;
  try {
    if (Buffer.byteLength(socketPath) > 103) throw failure('browser_native_socket_path_limit');
    for (const child of ['home', 'tmp', 'downloads', 'profile', 'cache', 'config', 'data'])
      mkdirSync(join(directory, child), { mode: 0o700 });
    const env: Record<string, string> = {
      PATH: '/usr/bin:/bin',
      HOME: join(directory, 'home'),
      TMPDIR: join(directory, 'tmp'),
      XDG_CACHE_HOME: join(directory, 'cache'),
      XDG_CONFIG_HOME: join(directory, 'config'),
      XDG_DATA_HOME: join(directory, 'data'),
      AGENT_BROWSER_DAEMON: '1',
      AGENT_BROWSER_SESSION: session,
      AGENT_BROWSER_SOCKET_DIR: directory,
      AGENT_BROWSER_ENGINE: 'chrome',
      AGENT_BROWSER_EXECUTABLE_PATH: options.attachment
        ? join(directory, 'standalone-browser-disabled')
        : browser,
      AGENT_BROWSER_NO_WEBMCP: '1',
      ...(options.manualDialogs ? { AGENT_BROWSER_NO_AUTO_DIALOG: '1' } : {}),
      AGENT_BROWSER_IDLE_TIMEOUT_MS: '300000',
      AGENT_BROWSER_DEFAULT_TIMEOUT: '25000',
      AGENT_BROWSER_DOWNLOAD_PATH: join(directory, 'downloads'),
    };
    if (options.attachment) {
      const endpoint = new URL(options.attachment.cdpUrl);
      if (
        endpoint.protocol !== 'ws:' ||
        endpoint.hostname !== '127.0.0.1' ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        !/^\/kite-native\/[a-f0-9-]{72}$/.test(endpoint.pathname)
      )
        throw failure('browser_attachment_invalid');
      const providerSource = `const {readFileSync}=await import('node:fs');const input=JSON.parse(readFileSync(0,'utf8'));if(input.protocol!=='agent-browser.plugin.v1'||input.type!=='browser.launch'||input.capability!=='browser.provider'||input.request.provider!=='kite-native-page'||!process.env.KITE_PAGE_CDP_URL)process.exit(2);process.stdout.write(JSON.stringify({protocol:'agent-browser.plugin.v1',success:true,browser:{cdpUrl:process.env.KITE_PAGE_CDP_URL,directPage:true}}));`;
      env.AGENT_BROWSER_PROVIDER = 'kite-native-page';
      env.AGENT_BROWSER_PLUGINS = JSON.stringify([
        {
          name: 'kite-native-page',
          command: darwin ? runtimeExecutable : process.execPath,
          args: [...nodeRuntimeFlags, '--input-type=module', '--eval', providerSource],
          capabilities: ['browser.provider'],
        },
      ]);
      env.KITE_PAGE_CDP_URL = endpoint.href;
    }
    owner = darwin
      ? startDarwinBrowserOwner({
          guardianPath,
          runtimeExecutable,
          executable,
          cwd: directory,
          env,
          nonce,
          graceMs: grace,
          startupTimeoutMs: startupTimeout,
        })
      : startLinuxOwnedProgram({
          executable,
          argv: [],
          cwd: directory,
          bubblewrapPath,
          initExecutable,
          nonce,
          graceMs: grace,
          env,
        });
  } catch (cause) {
    if (cause instanceof LinuxOwnedProgramStartError) owner = cause.cleanup;
    else {
      rmSync(directory, { recursive: true, force: true });
      admitted.delete(directory);
      throw cause;
    }
  }
  let closing = false,
    busy = false,
    disposed = false,
    localCleanupUnknown = false;
  let stopPromise: Promise<{ confirmed: boolean }> | undefined;
  let disposePromise: Promise<void> | undefined;
  const sockets = new Set<Socket>();
  const socketClosures = new Map<Socket, Promise<void>>();
  const captures = new Set<Promise<unknown>>();
  let storageScan: Promise<void> | undefined;
  let storageTimer: ReturnType<typeof setTimeout> | undefined;
  let storageDeadline: ReturnType<typeof setTimeout> | undefined;
  const maximumLifetime = setTimeout(() => void close(), MAXIMUM_LIFETIME_MS);
  function stopMonitors() {
    clearTimeout(maximumLifetime);
    if (storageTimer) clearTimeout(storageTimer);
    if (storageDeadline) clearTimeout(storageDeadline);
  }
  const lifetime = new AbortController();
  let rejectReady!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectReady = reject;
  });
  void interrupted.catch(() => {});
  async function finishLocal(): Promise<boolean> {
    for (const socket of sockets) socket.destroy();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.allSettled([...socketClosures.values(), ...captures, storageScan]).then(
          () => !localCleanupUnknown,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 1000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const completion = owner.completion.then(
    async (result) => {
      closing = true;
      stopMonitors();
      lifetime.abort();
      for (const socket of sockets) socket.destroy();
      context.signal.removeEventListener('abort', aborted);
      rejectReady(failure('browser_native_ended'));
      const localClosed = await finishLocal();
      const proof = {
        confirmed: result.confirmed && localClosed && ended(owner.readProcessEvidence(), nonce),
      };
      if (!proof.confirmed) retained.add({ owner, directory, identity });
      return Object.freeze(proof);
    },
    () => {
      closing = true;
      stopMonitors();
      lifetime.abort();
      for (const socket of sockets) socket.destroy();
      context.signal.removeEventListener('abort', aborted);
      rejectReady(failure('browser_native_ended'));
      retained.add({ owner, directory, identity });
      return Object.freeze({ confirmed: false });
    },
  );
  function close(): Promise<{ confirmed: boolean }> {
    if (stopPromise) return stopPromise;
    // Publish the shared close before abort events can re-enter it.
    stopPromise = (async () => {
      await Promise.resolve();
      try {
        await owner.cancel();
      } catch {
        retained.add({ owner, directory, identity });
      }
      return completion;
    })();
    closing = true;
    stopMonitors();
    lifetime.abort();
    rejectReady(failure('browser_native_closed'));
    for (const socket of sockets) socket.destroy();
    // The native control channel stops the whole original namespace, independently of IPC.
    return stopPromise;
  }
  function aborted() {
    void close();
  }
  context.signal.addEventListener('abort', aborted, { once: true });
  if (context.signal.aborted) aborted();
  // Always drain the owned pipes, even though upstream normally redirects daemon stderr.
  let outputBytes = 0;
  for (const stream of [owner.stdout, owner.stderr]) {
    stream.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024) void close();
    });
    stream.on('error', () => {
      void close();
    });
  }
  // A bounded sampled stopguard, not a hard quota: automatic downloads are NOT
  // denied by the released daemon, and growth can overshoot between samples or
  // while stopping. Never follow Chrome-created symlinks outside the owned root.
  async function inspectStorage(): Promise<void> {
    if (darwin) {
      const { scanDarwinBrowserDirectory } = await import('./darwin-storage');
      await scanDarwinBrowserDirectory({
        directory,
        identity,
        closing: () => closing,
        closeUnknown(resource) {
          localCleanupUnknown = true;
          retained.add({ resource, owner, directory });
          void close();
        },
      });
      return;
    }
    const started = performance.now();
    let entries = 0,
      bytes = 0;
    async function visit(path: string, depth: number): Promise<void> {
      if (closing) return;
      if (depth > STORAGE_DEPTH || performance.now() - started > STORAGE_SCAN_MS)
        throw failure('browser_native_storage_scan_limit');
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        if (depth === 0 && (stat.dev !== identity.dev || stat.ino !== identity.ino))
          throw failure('browser_native_directory_changed');
        const anchored = `/proc/self/fd/${file.fd}`;
        const directoryHandle = await opendir(anchored, { bufferSize: 32 });
        try {
          for (;;) {
            if (closing) return;
            if (performance.now() - started > STORAGE_SCAN_MS)
              throw failure('browser_native_storage_scan_limit');
            const entry = await directoryHandle.read();
            if (!entry) break;
            if (++entries > STORAGE_ENTRIES) throw failure('browser_native_storage_entry_limit');
            const child = join(anchored, entry.name);
            let stat: Stats;
            try {
              stat = await lstat(child);
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue;
              throw cause;
            }
            bytes += Math.max(stat.size, stat.blocks * 512);
            if (!Number.isSafeInteger(bytes) || bytes > STORAGE_BYTES)
              throw failure('browser_native_storage_byte_limit');
            if (stat.isDirectory()) await visit(child, depth + 1);
          }
        } finally {
          try {
            await directoryHandle.close();
          } catch {
            localCleanupUnknown = true;
            retained.add({ directoryHandle, owner, directory });
            void close();
          }
        }
      } finally {
        try {
          await file.close();
        } catch {
          localCleanupUnknown = true;
          retained.add({ file, owner, directory });
          void close();
        }
      }
    }
    await visit(directory, 0);
  }
  function scheduleStorageScan() {
    if (closing) return;
    storageTimer = setTimeout(() => {
      if (closing) return;
      storageDeadline = setTimeout(() => void close(), STORAGE_SCAN_MS);
      storageScan = inspectStorage()
        .catch(() => {
          void close();
        })
        .finally(() => {
          if (storageDeadline) clearTimeout(storageDeadline);
          scheduleStorageScan();
        });
    }, STORAGE_INTERVAL_MS);
  }
  scheduleStorageScan();
  async function wire(
    command: Record<string, Json>,
    signal: AbortSignal,
    timeout = requestTimeout,
  ): Promise<Json> {
    if (closing || signal.aborted || lifetime.signal.aborted)
      throw failure('browser_native_closed');
    if (busy) throw failure('browser_native_busy');
    if (typeof command.action !== 'string' || !/^[a-z_]{1,64}$/.test(command.action))
      throw failure('browser_native_command_invalid');
    const id = randomUUID();
    let bytes: Buffer;
    try {
      bytes = Buffer.from(`${JSON.stringify({ ...command, id })}\n`);
    } catch {
      throw failure('browser_native_command_invalid');
    }
    if (bytes.length > maximumRequest) throw failure('browser_native_request_limit');
    busy = true;
    try {
      return await new Promise<Json>((resolve, reject) => {
        let dispatched = false,
          settled = false,
          buffer = Buffer.alloc(0);
        const socket = createConnection(socketPath);
        sockets.add(socket);
        socketClosures.set(
          socket,
          new Promise<void>((resolve) =>
            socket.once('close', () => {
              sockets.delete(socket);
              socketClosures.delete(socket);
              resolve();
            }),
          ),
        );
        const finish = (value?: Json, error?: BrowserTransportError) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          lifetime.signal.removeEventListener('abort', onAbort);
          socket.destroy();
          if (error) reject(error);
          else resolve(value!);
        };
        const onAbort = () => {
          finish(undefined, failure('browser_native_aborted', dispatched));
          void close();
        };
        const timer = setTimeout(() => {
          finish(undefined, failure('browser_native_request_timeout', dispatched));
          if (dispatched) void close();
        }, timeout);
        signal.addEventListener('abort', onAbort, { once: true });
        lifetime.signal.addEventListener('abort', onAbort, { once: true });
        socket.once('connect', () => {
          if (settled) return;
          if (closing || signal.aborted || lifetime.signal.aborted) {
            onAbort();
            return;
          }
          // Conservatively mark before write: a callback error cannot prove zero bytes sent.
          dispatched = true;
          socket.write(bytes, (error) => {
            if (error) {
              finish(undefined, failure('browser_native_write_failed', true));
              void close();
            }
          });
        });
        socket.on('data', (chunk: Buffer) => {
          if (settled) return;
          if (buffer.length + chunk.length > maximumResponse) {
            finish(undefined, failure('browser_native_response_limit', dispatched));
            void close();
            return;
          }
          buffer = Buffer.concat([buffer, chunk]);
          const newline = buffer.indexOf(10);
          if (newline < 0) return;
          try {
            if (newline !== buffer.length - 1) throw Error('trailing');
            const value: unknown = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, newline)),
            );
            if (!object(value) || value.id !== id || typeof value.success !== 'boolean')
              throw Error('envelope');
            finish(value);
          } catch {
            finish(undefined, failure('browser_native_response_invalid', dispatched));
            void close();
          }
        });
        socket.once('error', () => {
          finish(undefined, failure('browser_native_connection_failed', dispatched));
          if (dispatched) void close();
        });
        socket.once('close', () => {
          if (settled) return;
          finish(undefined, failure('browser_native_response_lost', dispatched));
          if (dispatched) void close();
        });
        if (signal.aborted || lifetime.signal.aborted) onAbort();
      });
    } finally {
      busy = false;
    }
  }
  let startupTimer: ReturnType<typeof setTimeout>;
  const startup = (async () => {
    await owner.ready;
    const evidence = owner.readProcessEvidence();
    const root = 'coverage' in evidence ? evidence.namespace?.root : evidence.root;
    const ownerValid =
      'coverage' in evidence
        ? evidence.ownerPid === process.pid &&
          evidence.admission.nonce === nonce &&
          evidence.phase === 'ready' &&
          root &&
          !evidence.namespace?.root?.dead &&
          !evidence.namespace?.init.dead &&
          !evidence.namespace?.treeStopped &&
          !evidence.closeUnknown &&
          !evidence.fdClosed &&
          !evidence.wrapper.closed &&
          !evidence.wrapper.exit
        : evidence.ownerPid === process.pid &&
          evidence.nonce === nonce &&
          evidence.phase === 'ready' &&
          root &&
          !evidence.treeStopped &&
          !evidence.fdClosed &&
          !evidence.root?.exit;
    if (!ownerValid) throw failure('browser_native_owner_invalid');
    const daemonPid =
      'coverage' in evidence ? evidence.namespace!.root!.localPid : evidence.root!.pid;
    const until = performance.now() + startupTimeout;
    for (;;) {
      if (closing) throw failure('browser_native_closed');
      try {
        const stat = lstatSync(socketPath);
        if (!stat.isSocket() || stat.uid !== process.getuid?.())
          throw failure('browser_native_socket_invalid');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (performance.now() >= until) throw failure('browser_native_start_timeout');
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }
    const version = await readFile(join(directory, `${session}.version`), 'utf8');
    if (version.trim() !== agentBrowserVersion) throw failure('browser_native_version_mismatch');
    const reply = await wire({ action: 'session_info' }, lifetime.signal, startupTimeout);
    if (
      !object(reply) ||
      reply.success !== true ||
      !object(reply.data) ||
      reply.data.session !== session ||
      reply.data.socketDir !== directory ||
      reply.data.backgroundPid !== daemonPid ||
      reply.data.browserLaunched !== false
    )
      throw failure('browser_native_session_mismatch');
  })();
  const ready = Promise.race([
    startup,
    interrupted,
    new Promise<never>((_resolve, reject) => {
      startupTimer = setTimeout(
        () => reject(failure('browser_native_start_timeout')),
        startupTimeout,
      );
    }),
  ]).then(
    () => {
      clearTimeout(startupTimer);
    },
    (cause: unknown) => {
      clearTimeout(startupTimer);
      void close();
      throw cause;
    },
  );
  void ready.catch(() => {});
  async function request(command: Record<string, Json>, signal: AbortSignal): Promise<Json> {
    if (signal.aborted) throw failure('browser_native_aborted');
    const abort = () => {
      void close();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await ready;
    } finally {
      signal.removeEventListener('abort', abort);
    }
    if (command.action === 'launch') {
      if (
        Object.keys(command).some(
          (key) => !['action', 'headless', 'engine', 'webmcp'].includes(key),
        ) ||
        command.headless !== true ||
        command.engine !== 'chrome' ||
        command.webmcp !== false
      )
        throw failure('browser_native_launch_invalid');
      if (options.attachment)
        return wire(
          {
            ...command,
            provider: 'kite-native-page',
            executablePath: join(directory, 'standalone-browser-disabled'),
          },
          signal,
        );
      command = {
        ...command,
        executablePath: browser,
        profile: join(directory, 'profile'),
        downloadPath: join(directory, 'downloads'),
        args: ['--disk-cache-size=33554432', '--media-cache-size=8388608'],
      };
    }
    return wire(command, signal);
  }
  async function capture(
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<NativeBrowserTransport['capture']>>> {
    const readOwned = options.attachment?.readPageState;
    const metadata = async () => {
      const current = AbortSignal.any([
        signal,
        lifetime.signal,
        AbortSignal.timeout(requestTimeout),
      ]);
      current.throwIfAborted();
      if (closing) throw failure('browser_native_closed');
      const state = await readOwned!(current);
      current.throwIfAborted();
      if (
        closing ||
        !state ||
        Object.keys(state).sort().join(',') !== 'title,url' ||
        typeof state.url !== 'string' ||
        state.url.length > 8192 ||
        typeof state.title !== 'string' ||
        state.title.length > 128
      )
        throw failure('browser_native_metadata_invalid', true);
      return { url: state.url, title: state.title };
    };
    const path = join(directory, `capture-${randomUUID()}.jpg`);
    try {
      const before = readOwned
        ? { success: true, data: await metadata() }
        : await request({ action: 'url' }, signal);
      if (
        !object(before) ||
        before.success !== true ||
        !object(before.data) ||
        typeof before.data.url !== 'string'
      )
        throw failure('browser_capture_url');
      const reply = await request(
        {
          action: 'screenshot',
          path,
          format: 'jpeg',
          quality: 35,
          annotate: true,
          fullPage: false,
        },
        signal,
      );
      if (
        !object(reply) ||
        reply.success !== true ||
        !object(reply.data) ||
        reply.data.path !== path
      )
        throw failure('browser_capture_failed');
      const observed = readOwned ? await metadata() : undefined;
      const title = observed
        ? { success: true, data: { title: observed.title } }
        : await request({ action: 'title' }, signal);
      const after = observed
        ? { success: true, data: { url: observed.url } }
        : await request({ action: 'url' }, signal);
      if (
        !object(after) ||
        after.success !== true ||
        !object(after.data) ||
        after.data.url !== before.data.url
      )
        throw failure('browser_capture_navigation_changed');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer | undefined;
      let readFailed = false,
        readCause: unknown;
      try {
        const stat = await file.stat();
        // The base64 preview is at most 128 KiB, independently of page content.
        if (!stat.isFile() || stat.nlink !== 1 || stat.size < 4 || stat.size > 96 * 1024)
          throw failure('browser_capture_limit');
        bytes = Buffer.alloc(stat.size);
        let read = 0;
        while (read < bytes.length) {
          const part = await file.read(bytes, read, bytes.length - read, read);
          if (!part.bytesRead) throw failure('browser_capture_truncated');
          read += part.bytesRead;
        }
        if ((await file.stat()).size !== stat.size) throw failure('browser_capture_changed');
      } catch (cause) {
        readFailed = true;
        readCause = cause;
      }
      try {
        await file.close();
      } catch (cause) {
        localCleanupUnknown = true;
        retained.add({ file, owner, directory });
        throw new AggregateError(
          readFailed ? [readCause, cause] : [cause],
          'browser_capture_close_unknown',
        );
      }
      if (readFailed) throw readCause;
      if (!bytes) throw failure('browser_capture_invalid');
      return {
        frame: { mimeType: 'image/jpeg', data: bytes.toString('base64'), ...jpegSize(bytes) },
        annotations: annotations(reply.data.annotations),
        url: before.data.url.slice(0, 8192),
        ...(object(title) &&
        title.success === true &&
        object(title.data) &&
        typeof title.data.title === 'string'
          ? { title: title.data.title.slice(0, 512) }
          : {}),
      };
    } finally {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
  async function capturePng(
    signal: AbortSignal,
  ): Promise<{ data: string; width: number; height: number }> {
    const path = join(directory, `model-${randomUUID()}.png`);
    try {
      const reply = await request(
        { action: 'screenshot', path, format: 'png', annotate: false, fullPage: false },
        signal,
      );
      if (
        !object(reply) ||
        reply.success !== true ||
        !object(reply.data) ||
        reply.data.path !== path
      )
        throw failure('browser_capture_failed');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let result: { data: string; width: number; height: number } | undefined;
      let readCause: unknown;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size < 24 || stat.size > 4 * 1024 * 1024)
          throw failure('browser_capture_limit');
        const bytes = await file.readFile();
        if (
          bytes.length !== stat.size ||
          (await file.stat()).size !== stat.size ||
          bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
        )
          throw failure('browser_capture_invalid');
        result = {
          data: bytes.toString('base64'),
          width: bytes.readUInt32BE(16),
          height: bytes.readUInt32BE(20),
        };
      } catch (error) {
        readCause = error;
      }
      try {
        await file.close();
      } catch (error) {
        localCleanupUnknown = true;
        retained.add({ file, owner, directory });
        throw new AggregateError(
          readCause ? [readCause, error] : [error],
          'browser_capture_close_unknown',
        );
      }
      if (readCause) throw readCause;
      if (!result) throw failure('browser_capture_invalid');
      if (signal.aborted || lifetime.signal.aborted) throw failure('browser_native_aborted');
      return result;
    } finally {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
  return {
    readProcessEvidence: () => owner.readProcessEvidence(),
    ready,
    completion,
    request,
    close,
    capturePng(signal) {
      if (captures.size) return Promise.reject(failure('browser_native_capture_busy'));
      const pending = capturePng(signal);
      captures.add(pending);
      void pending.finally(() => captures.delete(pending)).catch(() => {});
      return pending;
    },
    capture(signal) {
      if (captures.size) return Promise.reject(failure('browser_native_capture_busy'));
      const pending = capture(signal);
      captures.add(pending);
      void pending.finally(() => captures.delete(pending)).catch(() => {});
      return pending;
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposePromise = (async () => {
        const proof = await close();
        if (!proof.confirmed) throw failure('browser_native_cleanup_unknown');
        if (disposed) return;
        const current = lstatSync(directory);
        if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino)
          throw failure('browser_native_directory_changed');
        rmSync(directory, { recursive: true, force: false });
        disposed = true;
        admitted.delete(directory);
      })();
      return disposePromise;
    },
  };
}
