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
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  assertCoordinatorJsonValue,
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorIdentity,
} from './codecs';
import type { CoordinatorProcessDescriptor, CoordinatorProcessStatus } from './process-state';

const execFileAsync = promisify(execFile);
const READY_FD = 3;
const MAX_READY_BYTES = 4_096;

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

export const COORDINATOR_READY_SCHEMA_ = 'kite.local-coordinator-ready.v1' as const;

const boundedText = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => ![...value].some((character) => /\p{Cc}/u.test(character)), {
    message: 'Coordinator readiness identity contains a control character',
  });
const readySignalSchema = z
  .object({
    schema: z.literal(COORDINATOR_READY_SCHEMA_),
    instanceId: boundedText,
    pid: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    startedAt: z.iso.datetime({ offset: true }),
    processStartIdentity: boundedText.max(256),
    buildId: boundedText,
    protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
    protocolRevision: boundedText,
    clientContractRevision: boundedText,
  })
  .strict();

export type CoordinatorProcessReadySignal = z.infer<typeof readySignalSchema>;
export const COORDINATOR_PROCESS_READY_SIGNAL_SCHEMA = readySignalSchema;

export interface CoordinatorProcessReadinessPort {
  release(): Promise<void>;
}

export interface CoordinatorProcessChild {
  readonly pid: number;
  readonly readiness: CoordinatorProcessReadinessPort;
  waitForReady(): Promise<CoordinatorProcessReadySignal>;
}

export interface CoordinatorProcessExecutable {
  readonly path: string;
  readonly mode: 'source' | 'installed';
  readonly buildId?: string;
}

export interface CoordinatorProcessEnvironment {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface CoordinatorProcessSpawnInput {
  readonly executable: CoordinatorProcessExecutable;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly detached: true;
  readonly stdout: 'ignore';
}

export interface CoordinatorProcessSpawnPort {
  spawn(input: CoordinatorProcessSpawnInput): Promise<CoordinatorProcessChild>;
}

export interface CoordinatorProcessExecutableResolver {
  resolve(mode: 'source' | 'installed'): Promise<CoordinatorProcessExecutable>;
}

export interface CoordinatorProcessExecutableVerificationInput {
  readonly path: string;
  readonly mode: 'source' | 'installed';
}

/** Return the exact canonical executable path or throw a typed invalid-executable error. */
export type CoordinatorProcessExecutableVerifier = (
  input: CoordinatorProcessExecutableVerificationInput,
) => string;

export interface CoordinatorProcessPort {
  inspect(input: CoordinatorProcessIdentityProbe): Promise<CoordinatorProcessStatus>;
}

export interface CoordinatorProcessIdentityProbe {
  readonly pid: number;
  readonly processStartIdentity: string;
}

export interface CoordinatorWindowsRunnerPort {
  /** A typed runner seam for named-pipe readiness. It never falls back to TCP. */
  spawn(input: CoordinatorProcessSpawnInput): Promise<CoordinatorProcessChild>;
}

export interface CoordinatorProcessHostOptions {
  readonly platform?: NodeJS.Platform;
  readonly runtimeExecutable?: string;
  readonly executableVerifier?: CoordinatorProcessExecutableVerifier;
  readonly windowsRunner?: CoordinatorWindowsRunnerPort;
}

export type CoordinatorProcessHostErrorCode =
  | 'unsupported'
  | 'invalid_executable'
  | 'spawn_failed'
  | 'ready_failed';

export class CoordinatorProcessHostError extends Error {
  readonly code: CoordinatorProcessHostErrorCode;

  constructor(code: CoordinatorProcessHostErrorCode, message: string) {
    super(message);
    this.name = 'CoordinatorProcessHostError';
    this.code = code;
  }
}

function validateExecutable(path: string, label: string): string {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    !isAbsolute(path) ||
    [...path].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || point === 127;
    })
  ) {
    throw new CoordinatorProcessHostError(
      'invalid_executable',
      `${label} Coordinator executable is not an absolute path.`,
    );
  }
  return resolve(path);
}

export interface CoordinatorProcessExecutableResolverOptions {
  readonly source: string;
  readonly installed: string;
  readonly sourceBuildId?: string;
  readonly installedBuildId?: string;
  readonly executableVerifier?: CoordinatorProcessExecutableVerifier;
}

/** Explicit source/installed resolution. PATH and cwd are intentionally not consulted. */
export function createCoordinatorProcessExecutableResolver(
  options: CoordinatorProcessExecutableResolverOptions,
): CoordinatorProcessExecutableResolver {
  const verifier = options.executableVerifier ?? verifyCoordinatorProcessExecutable;
  const source = validateExecutable(options.source, 'Source');
  const installed = validateExecutable(options.installed, 'Installed');
  return Object.freeze({
    resolve(mode: 'source' | 'installed') {
      if (mode !== 'source' && mode !== 'installed') {
        return Promise.reject(
          new TypeError('Coordinator executable mode must be source or installed.'),
        );
      }
      const path = verifyExecutableWith(verifier, mode === 'source' ? source : installed, mode);
      const buildId = mode === 'source' ? options.sourceBuildId : options.installedBuildId;
      return Promise.resolve(
        Object.freeze({
          path,
          mode,
          ...(buildId === undefined ? {} : { buildId }),
        }),
      );
    },
  });
}

function verifyExecutableWith(
  verifier: CoordinatorProcessExecutableVerifier,
  path: string,
  mode: 'source' | 'installed',
): string {
  const validated = validateExecutable(path, mode === 'source' ? 'Source' : 'Installed');
  return validateExecutable(
    verifier({ path: validated, mode }),
    mode === 'source' ? 'Source' : 'Installed',
  );
}

export function verifyCoordinatorProcessExecutable(
  input: CoordinatorProcessExecutableVerificationInput,
): string {
  const path = validateExecutable(input.path, input.mode === 'source' ? 'Source' : 'Installed');
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    throw new CoordinatorProcessHostError(
      'invalid_executable',
      'Coordinator executable could not be inspected.',
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new CoordinatorProcessHostError(
      'invalid_executable',
      'Coordinator executable is not a private regular file.',
    );
  }
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    throw new CoordinatorProcessHostError(
      'invalid_executable',
      'Coordinator executable could not be canonicalized.',
    );
  }
  if (canonical !== path) {
    throw new CoordinatorProcessHostError(
      'invalid_executable',
      'Coordinator executable is not the exact canonical file.',
    );
  }
  return canonical;
}

/** Compatibility alias for callers that prefer the shorter resolver name. */
export const createCoordinatorExecutableResolver = createCoordinatorProcessExecutableResolver;

export interface CoordinatorProcessSpawnCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** Source always runs through the exact Bun/runtime executable; installed artifacts run direct. */
export function resolveCoordinatorProcessSpawnCommand(
  executable: CoordinatorProcessExecutable,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  runtimeExecutable: string = process.execPath,
): CoordinatorProcessSpawnCommand {
  if (executable.mode === 'source') {
    return Object.freeze({
      command: validateExecutable(runtimeExecutable, 'Runtime'),
      args: Object.freeze([executable.path, ...args]),
    });
  }
  void platform;
  return Object.freeze({ command: executable.path, args: Object.freeze([...args]) });
}

export const resolveCoordinatorSpawnCommand = resolveCoordinatorProcessSpawnCommand;

function decodeReady(value: string): CoordinatorProcessReadySignal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
    assertCoordinatorJsonValue(parsed);
    return readySignalSchema.parse(parsed);
  } catch {
    throw new CoordinatorProcessHostError(
      'ready_failed',
      'Coordinator readiness signal is invalid.',
    );
  }
}

async function readReady(
  stream: AsyncIterable<Uint8Array | string>,
): Promise<CoordinatorProcessReadySignal> {
  let bytes = 0;
  let value = '';
  for await (const chunk of stream) {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_READY_BYTES) {
      throw new CoordinatorProcessHostError(
        'ready_failed',
        'Coordinator readiness signal is oversized.',
      );
    }
    value += text;
  }
  const newline = value.indexOf('\n');
  if (newline < 0) {
    throw new CoordinatorProcessHostError(
      'ready_failed',
      'Coordinator readiness channel closed before ready.',
    );
  }
  if (newline !== value.length - 1) {
    throw new CoordinatorProcessHostError(
      'ready_failed',
      'Coordinator readiness channel has trailing data.',
    );
  }
  return decodeReady(value.slice(0, newline));
}

function nativeSpawn(
  input: CoordinatorProcessSpawnInput,
  runtimeExecutable: string,
  platform: NodeJS.Platform,
): CoordinatorProcessChild {
  validateExecutable(input.executable.path, 'Coordinator');
  const invocation = resolveCoordinatorProcessSpawnCommand(
    input.executable,
    input.args,
    platform,
    runtimeExecutable,
  );
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(invocation.command, [...invocation.args], {
      cwd: input.cwd,
      env: { ...input.env, KITE_COORDINATOR_READY_FD: String(READY_FD) },
      detached: input.detached,
      stdio: ['ignore', input.stdout, 'ignore', 'pipe'],
      windowsHide: true,
    });
  } catch {
    throw new CoordinatorProcessHostError(
      'spawn_failed',
      'Coordinator process could not be spawned.',
    );
  }
  const pid = child.pid;
  const readinessStream = child.stdio[READY_FD] as ReadStream | null;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || !readinessStream) {
    readinessStream?.destroy();
    throw new CoordinatorProcessHostError(
      'spawn_failed',
      'Coordinator process did not expose readiness.',
    );
  }
  child.unref();
  let released = false;
  const readinessPromise = readReady(readinessStream);
  return Object.freeze({
    pid,
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

/** Native process host for POSIX/macOS and Windows. A named-pipe runner may override readiness. */
export function createCoordinatorProcessHost(
  options: CoordinatorProcessHostOptions = {},
): CoordinatorProcessSpawnPort {
  const platform = options.platform ?? process.platform;
  const verifier = options.executableVerifier ?? verifyCoordinatorProcessExecutable;
  const runtimeExecutable = verifyExecutableWith(
    verifier,
    options.runtimeExecutable ?? process.execPath,
    'installed',
  );
  return Object.freeze({
    async spawn(input: CoordinatorProcessSpawnInput): Promise<CoordinatorProcessChild> {
      const verifiedInput: CoordinatorProcessSpawnInput = {
        ...input,
        executable: {
          ...input.executable,
          path: verifyExecutableWith(verifier, input.executable.path, input.executable.mode),
        },
      };
      if (platform === 'win32') {
        if (options.windowsRunner) return options.windowsRunner.spawn(verifiedInput);
        // Windows process creation and inherited stdio pipes are supported by Node/Bun. The
        // hosted Windows runner can replace this readiness pipe with an authenticated named pipe
        // without changing the manager contract; this local implementation remains unverified on
        // Windows and intentionally has no TCP fallback.
        return nativeSpawn(verifiedInput, runtimeExecutable, platform);
      }
      return nativeSpawn(verifiedInput, runtimeExecutable, platform);
    },
  });
}

function readLinuxProcessStartIdentity(pid: number): string | undefined {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closing = value.lastIndexOf(')');
    if (closing < 0) return undefined;
    const fields = value
      .slice(closing + 2)
      .trim()
      .split(/\s+/u);
    const startTime = fields[19];
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return startTime === undefined ||
      !/^\d+$/u.test(startTime) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(bootId)
      ? undefined
      : `linux:${bootId}:${startTime}`;
  } catch {
    return undefined;
  }
}

async function readDarwinProcessStartIdentity(pid: number): Promise<string | undefined> {
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

function readWindowsProcessStartIdentity(pid: number): string | undefined {
  try {
    const api = getWindowsProcessIdentityApi();
    const processHandle = api.OpenProcess(0x1000, false, pid);
    if (!processHandle) return undefined;
    try {
      const creationTime = new Uint8Array(8);
      const ignored = new Uint8Array(8);
      if (
        !api.GetProcessTimes(
          processHandle,
          ptr(creationTime),
          ptr(ignored),
          ptr(ignored),
          ptr(ignored),
        )
      ) {
        return undefined;
      }
      const value = new DataView(creationTime.buffer).getBigUint64(0, true);
      return `win32:${value}`;
    } finally {
      api.CloseHandle(processHandle);
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

/** Read the OS process-start token used by readiness and stale-owner checks. */
export async function readCoordinatorProcessStartIdentity(
  pid: number = process.pid,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (platform === 'linux') return readLinuxProcessStartIdentity(pid);
  if (platform === 'darwin') return readDarwinProcessStartIdentity(pid);
  if (platform === 'win32') return readWindowsProcessStartIdentity(pid);
  return undefined;
}

/** Write one server-owned, bounded readiness record to the inherited fd/handle. */
export function writeCoordinatorProcessReadySignal(
  signal: CoordinatorProcessReadySignal,
  fd: number = READY_FD,
): void {
  const value = readySignalSchema.parse(signal);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (bytes.byteLength > MAX_READY_BYTES) {
    throw new CoordinatorProcessHostError(
      'ready_failed',
      'Coordinator readiness signal is oversized.',
    );
  }
  try {
    writeSync(fd, bytes);
    closeSync(fd);
  } catch {
    throw new CoordinatorProcessHostError(
      'ready_failed',
      'Coordinator readiness signal could not be published.',
    );
  }
}

/** A conservative exact-start probe. It never kills or signals a process. */
export function createCoordinatorProcessPort(
  options: { readonly platform?: NodeJS.Platform } = {},
): CoordinatorProcessPort {
  const platform = options.platform ?? process.platform;
  return Object.freeze({
    async inspect(input: CoordinatorProcessIdentityProbe): Promise<CoordinatorProcessStatus> {
      if (!Number.isSafeInteger(input.pid) || input.pid <= 0) return 'uncertain';
      try {
        process.kill(input.pid, 0);
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { readonly code?: unknown }).code === 'ESRCH'
        ) {
          return 'dead';
        }
        return 'uncertain';
      }
      const actual = await readCoordinatorProcessStartIdentity(input.pid, platform);
      if (actual === undefined || actual !== input.processStartIdentity) return 'uncertain';
      return 'alive';
    },
  });
}

export const createCoordinatorNativeProcessPort = createCoordinatorProcessPort;

/** Convert a ready record into a process descriptor identity for manager comparisons. */
export function coordinatorReadyMatchesDescriptor(
  ready: CoordinatorProcessReadySignal,
  descriptor: CoordinatorProcessDescriptor,
): boolean {
  return (
    ready.instanceId === descriptor.instanceId &&
    ready.pid === descriptor.pid &&
    ready.startedAt === descriptor.startedAt &&
    ready.processStartIdentity === descriptor.processStartIdentity &&
    ready.buildId === descriptor.buildId &&
    ready.protocolVersion === descriptor.protocolVersion &&
    ready.protocolRevision === descriptor.protocolRevision &&
    ready.clientContractRevision === descriptor.clientContractRevision
  );
}

/** Compare an endpoint's server identity with the ready process identity. */
export function coordinatorReadyMatchesIdentity(
  ready: CoordinatorProcessReadySignal,
  identity: CoordinatorIdentity,
): boolean {
  return (
    ready.instanceId === identity.instanceId &&
    ready.buildId === identity.buildId &&
    ready.protocolVersion === identity.protocolVersion &&
    ready.protocolRevision === identity.protocolRevision &&
    ready.clientContractRevision === identity.clientContractRevision
  );
}
