import { dlopen, type Pointer, ptr } from 'bun:ffi';
import { execFile, spawn } from 'node:child_process';
import {
  closeSync,
  lstatSync,
  type ReadStream,
  readFileSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';
import {
  assertCoordinatorJsonValue,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
  COORDINATOR_WEB_GATEWAY_ENDPOINT_SCHEMA,
  COORDINATOR_WEB_GATEWAY_IDENTITY_SCHEMA,
  type CoordinatorWebGatewayIdentity,
} from '@kite-ai/kite-local-runtime/coordinator';
import { z } from 'zod';
import type { WebGatewayControlLink } from './control';

const execFileAsync = promisify(execFile);
const READY_FD = 3;
const MAX_READY_BYTES = 16 * 1024;
const MAX_ARGS = 128;
const MAX_ARGUMENT_BYTES = 16 * 1024;
const MAX_ENV_ENTRIES = 128;
const MAX_ENV_VALUE_BYTES = 16 * 1024;

export const WEB_GATEWAY_READY_SCHEMA_ = 'kite.web-gateway-ready.v1' as const;

const boundedText = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => ![...value].some((character) => /\p{Cc}/u.test(character)), {
    message: 'Gateway process identity contains a control character',
  });
const readySchema = z
  .object({
    schema: z.literal(WEB_GATEWAY_READY_SCHEMA_),
    identity: COORDINATOR_WEB_GATEWAY_IDENTITY_SCHEMA,
    pid: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    startedAt: z.iso.datetime({ offset: true }),
    processStartIdentity: boundedText.max(256),
    endpoint: COORDINATOR_WEB_GATEWAY_ENDPOINT_SCHEMA,
  })
  .strict();

export type WebGatewayReadySignal = z.infer<typeof readySchema>;
export const WEB_GATEWAY_READY_SIGNAL_SCHEMA = readySchema;

export interface WebGatewayProcessExecutable {
  readonly path: string;
  readonly mode: 'source' | 'installed';
  readonly buildId: string;
}

export interface WebGatewayProcessExecutableResolver {
  resolve(mode: 'source' | 'installed'): Promise<WebGatewayProcessExecutable>;
}

export interface WebGatewayProcessEnvironment {
  /** Internal server-owned cwd; never appears in a Browser or Coordinator DTO. */
  readonly cwd: string;
  /** Explicit neutral environment. Implementations must not spread process.env implicitly. */
  readonly env: Readonly<Record<string, string>>;
}

export interface WebGatewayProcessEnvironmentResolver {
  resolve(input: {
    readonly instanceId: string;
    readonly buildId: string;
  }): Promise<WebGatewayProcessEnvironment>;
}

export interface WebGatewayProcessSpawnInput {
  readonly executable: WebGatewayProcessExecutable;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly detached: true;
  readonly stdout: 'ignore';
}

export type WebGatewayProcessStopResult = 'closed' | 'busy' | 'outcome_unknown' | 'unavailable';

export type { WebGatewayControlLink } from './control';

export interface WebGatewayProcessReadinessPort {
  release(): Promise<void>;
}

export interface WebGatewayProcessChild {
  readonly pid: number;
  readonly readiness: WebGatewayProcessReadinessPort;
  readonly control?: WebGatewayControlLink;
  waitForReady(): Promise<WebGatewayReadySignal>;
}

export interface WebGatewayProcessSpawnPort {
  spawn(input: WebGatewayProcessSpawnInput): Promise<WebGatewayProcessChild>;
}

export type WebGatewayProcessStatus = 'alive' | 'dead' | 'uncertain';

export interface WebGatewayProcessIdentityProbe {
  readonly pid: number;
  readonly processStartIdentity: string;
}

export interface WebGatewayProcessProbePort {
  inspect(input: WebGatewayProcessIdentityProbe): Promise<WebGatewayProcessStatus>;
}

/** Hosted Windows may replace the fd pipe with an authenticated named-pipe runner. */
export interface WebGatewayWindowsProcessRunner {
  spawn(input: WebGatewayProcessSpawnInput): Promise<WebGatewayProcessChild>;
}

export interface WebGatewayProcessHostOptions {
  readonly platform?: NodeJS.Platform;
  readonly runtimeExecutable?: string;
  readonly executableVerifier?: WebGatewayProcessExecutableVerifier;
  readonly windowsRunner?: WebGatewayWindowsProcessRunner;
}

export type WebGatewayProcessHostErrorCode =
  | 'unsupported'
  | 'invalid_executable'
  | 'spawn_failed'
  | 'ready_failed';

export class WebGatewayProcessHostError extends Error {
  readonly code: WebGatewayProcessHostErrorCode;

  constructor(code: WebGatewayProcessHostErrorCode, message: string) {
    super(message);
    this.name = 'WebGatewayProcessHostError';
    this.code = code;
  }
}

export interface WebGatewayProcessExecutableVerificationInput {
  readonly path: string;
  readonly mode: 'source' | 'installed';
}

export type WebGatewayProcessExecutableVerifier = (
  input: WebGatewayProcessExecutableVerificationInput,
) => string;

/** Resolve only explicit absolute source/installed executable paths. */
export function createWebGatewayProcessExecutableResolver(options: {
  readonly source: string;
  readonly installed: string;
  readonly sourceBuildId: string;
  readonly installedBuildId: string;
  readonly executableVerifier?: WebGatewayProcessExecutableVerifier;
}): WebGatewayProcessExecutableResolver {
  const verifier = options.executableVerifier ?? verifyWebGatewayProcessExecutable;
  const source = validateExecutable(options.source, 'Source');
  const installed = validateExecutable(options.installed, 'Installed');
  assertSafeText(options.sourceBuildId, 512);
  assertSafeText(options.installedBuildId, 512);
  return Object.freeze({
    async resolve(mode: 'source' | 'installed') {
      if (mode !== 'source' && mode !== 'installed') {
        return Promise.reject(new TypeError('Web Gateway executable mode is invalid.'));
      }
      const original = mode === 'source' ? source : installed;
      const path = validateExecutable(
        verifier({ path: original, mode }),
        mode === 'source' ? 'Source' : 'Installed',
      );
      return Object.freeze({
        path,
        mode,
        buildId: mode === 'source' ? options.sourceBuildId : options.installedBuildId,
      });
    },
  });
}

/** Explicit neutral environment factory. No cwd, HOME, PATH or process.env inference occurs. */
export function createNeutralWebGatewayEnvironmentResolver(options: {
  readonly cwd:
    | string
    | ((input: { readonly instanceId: string; readonly buildId: string }) => string);
  readonly env:
    | Readonly<Record<string, string>>
    | ((input: {
        readonly instanceId: string;
        readonly buildId: string;
      }) => Readonly<Record<string, string>>);
}): WebGatewayProcessEnvironmentResolver {
  return Object.freeze({
    async resolve(input: { readonly instanceId: string; readonly buildId: string }) {
      const cwd = typeof options.cwd === 'function' ? options.cwd(input) : options.cwd;
      const env = typeof options.env === 'function' ? options.env(input) : options.env;
      assertAbsolutePath(cwd, 'Web Gateway environment cwd');
      assertNeutralEnvironment(env);
      return Object.freeze({ cwd: resolve(cwd), env: Object.freeze({ ...env }) });
    },
  });
}

/** Native detached Gateway process host. Hosted Windows can inject a named-pipe runner. */
export function createWebGatewayProcessHost(
  options: WebGatewayProcessHostOptions = {},
): WebGatewayProcessSpawnPort {
  const platform = options.platform ?? process.platform;
  const verifier = options.executableVerifier ?? verifyWebGatewayProcessExecutable;
  const runtimeExecutable = validateExecutable(
    verifier({ path: options.runtimeExecutable ?? process.execPath, mode: 'installed' }),
    'Runtime',
  );
  return Object.freeze({
    async spawn(input: WebGatewayProcessSpawnInput): Promise<WebGatewayProcessChild> {
      assertSpawnInput(input);
      const executable = {
        ...input.executable,
        path: validateExecutable(
          verifier({ path: input.executable.path, mode: input.executable.mode }),
          input.executable.mode === 'source' ? 'Source' : 'Installed',
        ),
      };
      const verifiedInput = { ...input, executable };
      if (platform === 'win32' && options.windowsRunner) {
        return options.windowsRunner.spawn(verifiedInput);
      }
      // Bun/Node's inherited pipe is a local qualification seam on Windows. Production hosted
      // Windows may supply the named-pipe runner above; neither branch falls back to TCP.
      return nativeSpawn(verifiedInput, runtimeExecutable, platform);
    },
  });
}

/** Exact PID + OS start identity probe. Unknown native identity is always uncertain. */
export function createWebGatewayProcessProbe(
  options: {
    readonly platform?: NodeJS.Platform;
    readonly readStartIdentity?: (
      pid: number,
      platform: NodeJS.Platform,
    ) => Promise<string | undefined>;
  } = {},
): WebGatewayProcessProbePort {
  const platform = options.platform ?? process.platform;
  const readStart =
    options.readStartIdentity ??
    (async (pid: number, targetPlatform: NodeJS.Platform) =>
      readWebGatewayProcessStartIdentity(pid, targetPlatform));
  return Object.freeze({
    async inspect(input: WebGatewayProcessIdentityProbe) {
      if (
        !Number.isSafeInteger(input.pid) ||
        input.pid <= 0 ||
        !safeText(input.processStartIdentity, 256)
      ) {
        return 'uncertain' as const;
      }
      try {
        process.kill(input.pid, 0);
      } catch (error) {
        return isNativeError(error, 'ESRCH') ? ('dead' as const) : ('uncertain' as const);
      }
      try {
        const actual = await readStart(input.pid, platform);
        return actual !== undefined && actual === input.processStartIdentity
          ? ('alive' as const)
          : ('uncertain' as const);
      } catch {
        return 'uncertain' as const;
      }
    },
  });
}

/** Verify the selected file itself; symlinks, hardlinks, relative paths and aliases fail closed. */
export function verifyWebGatewayProcessExecutable(
  input: WebGatewayProcessExecutableVerificationInput,
): string {
  const path = validateExecutable(input.path, input.mode === 'source' ? 'Source' : 'Installed');
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    throw new WebGatewayProcessHostError(
      'invalid_executable',
      'Web Gateway executable could not be inspected.',
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new WebGatewayProcessHostError(
      'invalid_executable',
      'Web Gateway executable is not a private regular file.',
    );
  }
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    throw new WebGatewayProcessHostError(
      'invalid_executable',
      'Web Gateway executable could not be canonicalized.',
    );
  }
  if (!samePath(canonical, path)) {
    throw new WebGatewayProcessHostError(
      'invalid_executable',
      'Web Gateway executable is not the exact canonical file.',
    );
  }
  return canonical;
}

export interface WebGatewayProcessSpawnCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export function resolveWebGatewayProcessSpawnCommand(
  executable: WebGatewayProcessExecutable,
  args: readonly string[],
  _platform: NodeJS.Platform = process.platform,
  runtimeExecutable: string = process.execPath,
): WebGatewayProcessSpawnCommand {
  if (executable.mode === 'source') {
    return Object.freeze({
      command: validateExecutable(runtimeExecutable, 'Runtime'),
      args: Object.freeze([executable.path, ...args]),
    });
  }
  return Object.freeze({ command: executable.path, args: Object.freeze([...args]) });
}

async function readReady(
  stream: AsyncIterable<Uint8Array | string>,
): Promise<WebGatewayReadySignal> {
  let bytes = 0;
  let value = '';
  for await (const chunk of stream) {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_READY_BYTES) {
      throw new WebGatewayProcessHostError(
        'ready_failed',
        'Web Gateway readiness signal is oversized.',
      );
    }
    value += text;
  }
  const newline = value.indexOf('\n');
  if (newline < 0 || newline !== value.length - 1) {
    throw new WebGatewayProcessHostError(
      'ready_failed',
      'Web Gateway readiness channel did not contain exactly one frame.',
    );
  }
  try {
    const parsed = JSON.parse(value.slice(0, newline)) as unknown;
    assertCoordinatorJsonValue(parsed);
    return readySchema.parse(parsed);
  } catch {
    throw new WebGatewayProcessHostError(
      'ready_failed',
      'Web Gateway readiness signal is invalid.',
    );
  }
}

function nativeSpawn(
  input: WebGatewayProcessSpawnInput,
  runtimeExecutable: string,
  platform: NodeJS.Platform,
): WebGatewayProcessChild {
  const invocation = resolveWebGatewayProcessSpawnCommand(
    input.executable,
    input.args,
    platform,
    runtimeExecutable,
  );
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(invocation.command, [...invocation.args], {
      cwd: input.cwd,
      env: { ...input.env, KITE_WEB_GATEWAY_READY_FD: String(READY_FD) },
      detached: input.detached,
      stdio: ['ignore', input.stdout, 'ignore', 'pipe'],
      windowsHide: true,
    });
  } catch {
    throw new WebGatewayProcessHostError(
      'spawn_failed',
      'Web Gateway process could not be spawned.',
    );
  }
  const pid = child.pid;
  const readinessStream = child.stdio[READY_FD] as ReadStream | null;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || !readinessStream) {
    readinessStream?.destroy();
    throw new WebGatewayProcessHostError(
      'spawn_failed',
      'Web Gateway process did not expose readiness.',
    );
  }
  const verifiedPid = pid;
  child.unref();
  let released = false;
  const readinessPromise = readReady(readinessStream);
  return Object.freeze({
    pid: verifiedPid,
    readiness: Object.freeze({
      async release() {
        if (released) return;
        released = true;
        readinessStream.destroy();
      },
    }),
    waitForReady: () => readinessPromise,
  });
}

/** Write one exact server-owned readiness frame and close the inherited descriptor. */
export function writeWebGatewayReadySignal(signal: WebGatewayReadySignal, fd = READY_FD): void {
  const value = readySchema.parse(signal);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (bytes.byteLength > MAX_READY_BYTES) {
    throw new WebGatewayProcessHostError('ready_failed', 'Web Gateway readiness is oversized.');
  }
  try {
    writeSync(fd, bytes);
    closeSync(fd);
  } catch {
    throw new WebGatewayProcessHostError(
      'ready_failed',
      'Web Gateway readiness could not be published.',
    );
  }
}

export async function readWebGatewayProcessStartIdentity(
  pid = process.pid,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (platform === 'linux') return readLinuxStartIdentity(pid);
  if (platform === 'darwin') return readDarwinStartIdentity(pid);
  if (platform === 'win32') return readWindowsStartIdentity(pid);
  return undefined;
}

function readLinuxStartIdentity(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closing = stat.lastIndexOf(')');
    if (closing < 0) return undefined;
    const fields = stat
      .slice(closing + 2)
      .trim()
      .split(/\s+/u);
    const startTicks = fields[19];
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (
      startTicks === undefined ||
      !/^\d+$/u.test(startTicks) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(bootId)
    ) {
      return undefined;
    }
    return `linux:${bootId}:${startTicks}`;
  } catch {
    return undefined;
  }
}

async function readDarwinStartIdentity(pid: number): Promise<string | undefined> {
  try {
    const result = await execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      timeout: 1_000,
      maxBuffer: 4_096,
      windowsHide: true,
    });
    const value = result.stdout.trim();
    return value.length === 0 ? undefined : `darwin:${value}`;
  } catch {
    return undefined;
  }
}

type WindowsProcessIdentityApi = {
  OpenProcess(access: number, inheritHandle: boolean, processId: number): number | bigint;
  GetProcessTimes(
    process: number | bigint,
    creationTime: Pointer,
    exitTime: Pointer,
    kernelTime: Pointer,
    userTime: Pointer,
  ): boolean;
  CloseHandle(handle: number | bigint): boolean;
};

let windowsProcessIdentityApi: WindowsProcessIdentityApi | undefined;

function readWindowsStartIdentity(pid: number): string | undefined {
  try {
    const api = getWindowsProcessIdentityApi();
    const handle = api.OpenProcess(0x1000, false, pid);
    if (!handle) return undefined;
    try {
      const creation = new Uint8Array(8);
      const ignored = new Uint8Array(8);
      if (!api.GetProcessTimes(handle, ptr(creation), ptr(ignored), ptr(ignored), ptr(ignored))) {
        return undefined;
      }
      return `win32:${new DataView(creation.buffer).getBigUint64(0, true)}`;
    } finally {
      api.CloseHandle(handle);
    }
  } catch {
    return undefined;
  }
}

function getWindowsProcessIdentityApi(): WindowsProcessIdentityApi {
  if (!windowsProcessIdentityApi) {
    windowsProcessIdentityApi = dlopen('kernel32.dll', {
      OpenProcess: { args: ['u32', 'bool', 'u32'], returns: 'u64' },
      GetProcessTimes: { args: ['u64', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'bool' },
      CloseHandle: { args: ['u64'], returns: 'bool' },
    }).symbols;
  }
  return windowsProcessIdentityApi;
}

function validateExecutable(path: string, label: string): string {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    !isAbsolutePath(path) ||
    !safeText(path, 4_096)
  ) {
    throw new WebGatewayProcessHostError(
      'invalid_executable',
      `${label} Web Gateway executable is not an absolute path.`,
    );
  }
  return isWindowsPath(path) ? win32.normalize(path) : resolve(path);
}

function assertSpawnInput(input: WebGatewayProcessSpawnInput): void {
  assertAbsolutePath(input.cwd, 'Web Gateway spawn cwd');
  if (input.args.length > MAX_ARGS)
    throw new RangeError('Web Gateway spawn arguments are oversized.');
  for (const argument of input.args) {
    if (!safeText(argument, MAX_ARGUMENT_BYTES)) {
      throw new TypeError('Web Gateway spawn argument is invalid.');
    }
  }
  assertNeutralEnvironment(input.env);
}

function assertAbsolutePath(path: string, label: string): void {
  if (!isAbsolutePath(path) || !safeText(path, 4_096)) {
    throw new TypeError(`${label} must be an absolute path.`);
  }
}

function assertNeutralEnvironment(env: Readonly<Record<string, string>>): void {
  const entries = Object.entries(env);
  if (entries.length > MAX_ENV_ENTRIES)
    throw new RangeError('Web Gateway environment is oversized.');
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || !safeText(value, MAX_ENV_VALUE_BYTES)) {
      throw new TypeError('Web Gateway environment is invalid.');
    }
  }
}

function isAbsolutePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\');
}

function samePath(left: string, right: string): boolean {
  return isWindowsPath(left) || isWindowsPath(right)
    ? win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function safeText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    ![...value].some((character) => /\p{Cc}/u.test(character))
  );
}

function assertSafeText(value: string, maxLength: number): void {
  if (!safeText(value, maxLength)) throw new TypeError('Web Gateway identity is invalid.');
}

function isNativeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

export type { CoordinatorWebGatewayIdentity };
export { COORDINATOR_PROTOCOL_REVISION_, COORDINATOR_PROTOCOL_VERSION };
