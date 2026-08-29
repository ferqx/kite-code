import { spawn } from 'node:child_process';
import { lstatSync, type ReadStream, realpathSync } from 'node:fs';
import { isAbsolute, resolve, win32 } from 'node:path';
import type { KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import {
  COORDINATOR_WORKER_ENDPOINT_SCHEMA,
  COORDINATOR_WORKER_IDENTITY_SCHEMA,
  type CoordinatorWorkerEndpoint,
  type CoordinatorWorkerIdentity,
  readCoordinatorProcessStartIdentity,
} from '@kite-ai/kite-local-runtime/coordinator';
import { z } from 'zod';
import type { WorkerConnectionCapabilityRequest } from './worker';

/** The Store 7 profile a Worker process must report before it can register. */
export const WORKSPACE_WORKER_STORE_PROFILE_ =
  'kite-coordinator-workspace-worker-web-v1-2026-08-28' as const;
export const WORKSPACE_WORKER_READY_SCHEMA_ = 'kite.workspace-worker-ready.v1' as const;
export const WORKSPACE_WORKER_PROCESS_DESCRIPTOR_SCHEMA_ =
  'kite.workspace-worker-process.v1' as const;

const READY_FD = 3;
const MAX_READY_BYTES = 16 * 1024;
const MAX_ENV_ENTRIES = 128;
const MAX_ENV_VALUE_BYTES = 16 * 1024;
const MAX_ARGS = 128;
const MAX_ARGUMENT_BYTES = 16 * 1024;
const boundedText = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => ![...value].some((character) => /\p{Cc}/u.test(character)), {
    message: 'Worker process identity contains a control character',
  });
const processStartIdentity = boundedText.max(256);
const workspacePath = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value),
    'Workspace path must be absolute',
  );
const workspaceDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const layoutGeneration = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u, 'Layout generation is invalid');
const controlOrigin = z
  .string()
  .regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/u, 'Worker control origin is invalid')
  .refine((value) => {
    const port = Number(value.slice(value.lastIndexOf(':') + 1));
    return Number.isSafeInteger(port) && port >= 1 && port <= 65_535;
  }, 'Worker control origin port is invalid');

const workspaceIdentitySchema = z
  .object({
    canonicalPath: workspacePath,
    projectId: boundedText,
    workspaceDigest,
  })
  .strict();

const readySignalSchema = z
  .object({
    schema: z.literal(WORKSPACE_WORKER_READY_SCHEMA_),
    identity: COORDINATOR_WORKER_IDENTITY_SCHEMA,
    workspace: workspaceIdentitySchema,
    pid: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    startedAt: z.iso.datetime({ offset: true }),
    processStartIdentity,
    storeProfile: z.literal(WORKSPACE_WORKER_STORE_PROFILE_),
    layoutGeneration,
    endpoint: COORDINATOR_WORKER_ENDPOINT_SCHEMA,
    controlOrigin,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.identity.workerScopeId.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['identity', 'workerScopeId'],
        message: 'Worker scope identity is empty',
      });
    }
    if (value.identity.workerScopeId !== value.identity.workerScopeId.trim()) {
      context.addIssue({
        code: 'custom',
        path: ['identity', 'workerScopeId'],
        message: 'Worker scope identity is not canonical',
      });
    }
  });

export type WorkspaceWorkerReadySignal = z.infer<typeof readySignalSchema>;
export const WORKSPACE_WORKER_READY_SIGNAL_SCHEMA = readySignalSchema;
export type WorkspaceWorkerEndpoint = CoordinatorWorkerEndpoint;
export type WorkspaceWorkerIdentity = CoordinatorWorkerIdentity;

/** Decode the only readiness record accepted by the Worker process manager. */
export function decodeWorkspaceWorkerReadySignal(value: unknown): WorkspaceWorkerReadySignal {
  return readySignalSchema.parse(value);
}

export interface WorkspaceWorkerProcessExecutable {
  readonly path: string;
  readonly mode: 'source' | 'installed';
  readonly buildId: string;
}

export interface WorkspaceWorkerProcessExecutableResolver {
  resolve(mode: 'source' | 'installed'): Promise<WorkspaceWorkerProcessExecutable>;
}

export interface WorkspaceWorkerProcessEnvironment {
  /** Internal server-owned cwd; it is never part of a Coordinator descriptor or registry entry. */
  readonly cwd: string;
  /** An explicit neutral environment; implementations must not merge process.env implicitly. */
  readonly env: Readonly<Record<string, string>>;
}

export interface WorkspaceWorkerProcessEnvironmentResolver {
  resolve(input: {
    readonly workspace: KiteWorkspaceIdentity;
    readonly workerScopeId: string;
    readonly workerInstanceId: string;
    readonly layoutGeneration: string;
  }): Promise<WorkspaceWorkerProcessEnvironment>;
}

/** Exact authenticated identity used to recover server-owned routing after Coordinator restart. */
export interface WorkspaceWorkerControlIdentity {
  readonly workerScopeId: string;
  readonly workerInstanceId: string;
  readonly buildId: string;
  readonly workspace: KiteWorkspaceIdentity;
}

export interface WorkspaceWorkerProcessSpawnInput {
  readonly executable: WorkspaceWorkerProcessExecutable;
  readonly args: readonly string[];
  /** Internal server-owned canonical Workspace cwd. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly detached: true;
  readonly stdout: 'ignore';
}

export type WorkspaceWorkerProcessStopRequestResult =
  | 'closed'
  | 'busy'
  | 'outcome_unknown'
  | 'unavailable';

export interface WorkspaceWorkerDirectoryOutboxRequest {
  readonly cursor?: number;
  readonly limit?: number;
}

export interface WorkspaceWorkerDirectoryOutboxEntry {
  readonly sessionId: string;
  readonly workerScopeId: string;
  readonly revision: number;
  readonly updatedAt: number;
  readonly tombstone: boolean;
}

export interface WorkspaceWorkerDirectoryOutboxPage {
  readonly entries: readonly WorkspaceWorkerDirectoryOutboxEntry[];
  readonly nextCursor?: number;
  readonly hasMore: boolean;
}

/** Narrow Worker control link. It does not expose generic RPC or a signing key. */
export interface WorkspaceWorkerControlLink {
  describeIdentity(): Promise<WorkspaceWorkerControlIdentity | undefined>;
  mintConnectionCapability(request: WorkerConnectionCapabilityRequest): Promise<
    | {
        readonly outcome: 'applied';
        readonly capability: string;
        readonly expiresAt: string;
      }
    | { readonly outcome: 'outcome_unknown' }
    | { readonly outcome: 'unavailable' }
  >;
  requestIdleStop(): Promise<WorkspaceWorkerProcessStopRequestResult>;
  /** Authenticated, current-Store-only Directory facts; no Runtime/body/path data. */
  readonly readDirectoryOutbox?: (
    request: WorkspaceWorkerDirectoryOutboxRequest,
  ) => Promise<WorkspaceWorkerDirectoryOutboxPage | undefined>;
}

export interface WorkspaceWorkerProcessReadinessPort {
  release(): Promise<void>;
}

export interface WorkspaceWorkerProcessChild {
  readonly pid: number;
  readonly readiness: WorkspaceWorkerProcessReadinessPort;
  /** Legacy child-local seam; the Manager rebuilds an authenticated link after readiness. */
  readonly control?: WorkspaceWorkerControlLink;
  waitForReady(): Promise<WorkspaceWorkerReadySignal>;
  /** Exact owner-held child handle; resolution proves this spawned process exited. */
  readonly waitForExit?: () => Promise<void>;
}

export interface WorkspaceWorkerProcessSpawnPort {
  spawn(input: WorkspaceWorkerProcessSpawnInput): Promise<WorkspaceWorkerProcessChild>;
}

export type WorkspaceWorkerProcessStatus = 'alive' | 'dead' | 'uncertain';

export interface WorkspaceWorkerProcessIdentityProbe {
  readonly pid: number;
  readonly processStartIdentity: string;
}

export interface WorkspaceWorkerProcessProbePort {
  inspect(input: WorkspaceWorkerProcessIdentityProbe): Promise<WorkspaceWorkerProcessStatus>;
}

export interface WorkspaceWorkerWindowsProcessRunner {
  /** Native named-pipe/process-handle seam; it must not fall back to TCP. */
  spawn(input: WorkspaceWorkerProcessSpawnInput): Promise<WorkspaceWorkerProcessChild>;
}

export interface WorkspaceWorkerProcessHostOptions {
  readonly platform?: NodeJS.Platform;
  readonly runtimeExecutable?: string;
  readonly executableVerifier?: WorkspaceWorkerProcessExecutableVerifier;
  readonly windowsRunner?: WorkspaceWorkerWindowsProcessRunner;
  readonly controlLinkFactory?: (input: {
    readonly pid: number;
    readonly executable: WorkspaceWorkerProcessExecutable;
  }) => WorkspaceWorkerControlLink;
}

export type WorkspaceWorkerProcessHostErrorCode =
  | 'unsupported'
  | 'invalid_executable'
  | 'spawn_failed'
  | 'ready_failed';

export class WorkspaceWorkerProcessHostError extends Error {
  readonly code: WorkspaceWorkerProcessHostErrorCode;

  constructor(code: WorkspaceWorkerProcessHostErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceWorkerProcessHostError';
    this.code = code;
  }
}

export interface WorkspaceWorkerProcessExecutableVerificationInput {
  readonly path: string;
  readonly mode: 'source' | 'installed';
}

export type WorkspaceWorkerProcessExecutableVerifier = (
  input: WorkspaceWorkerProcessExecutableVerificationInput,
) => string;

/** Resolve only explicit absolute source/installed files; PATH and cwd are never consulted. */
export function createWorkspaceWorkerProcessExecutableResolver(options: {
  readonly source: string;
  readonly installed: string;
  readonly sourceBuildId: string;
  readonly installedBuildId: string;
  readonly executableVerifier?: WorkspaceWorkerProcessExecutableVerifier;
}): WorkspaceWorkerProcessExecutableResolver {
  const verifier = options.executableVerifier ?? verifyWorkspaceWorkerProcessExecutable;
  const source = validateExecutable(options.source, 'Source');
  const installed = validateExecutable(options.installed, 'Installed');
  assertBuildId(options.sourceBuildId);
  assertBuildId(options.installedBuildId);
  return Object.freeze({
    resolve(mode: 'source' | 'installed') {
      if (mode !== 'source' && mode !== 'installed') {
        return Promise.reject(new TypeError('Worker executable mode is invalid.'));
      }
      const original = mode === 'source' ? source : installed;
      const path = validateExecutable(
        verifier({ path: original, mode }),
        mode === 'source' ? 'Source' : 'Installed',
      );
      return Promise.resolve(
        Object.freeze({
          path,
          mode,
          buildId: mode === 'source' ? options.sourceBuildId : options.installedBuildId,
        }),
      );
    },
  });
}

/** Explicit neutral environment factory; no ambient process environment is copied. */
export function createNeutralWorkspaceWorkerEnvironmentResolver(options: {
  readonly cwd:
    | string
    | ((input: {
        readonly workspace: KiteWorkspaceIdentity;
        readonly workerScopeId: string;
        readonly workerInstanceId: string;
        readonly layoutGeneration: string;
      }) => string);
  readonly env:
    | Readonly<Record<string, string>>
    | ((input: {
        readonly workspace: KiteWorkspaceIdentity;
        readonly workerScopeId: string;
        readonly workerInstanceId: string;
        readonly layoutGeneration: string;
      }) => Readonly<Record<string, string>>);
}): WorkspaceWorkerProcessEnvironmentResolver {
  return Object.freeze({
    async resolve(input: {
      readonly workspace: KiteWorkspaceIdentity;
      readonly workerScopeId: string;
      readonly workerInstanceId: string;
      readonly layoutGeneration: string;
    }) {
      const cwd = typeof options.cwd === 'function' ? options.cwd(input) : options.cwd;
      const env = typeof options.env === 'function' ? options.env(input) : options.env;
      assertAbsolutePath(cwd, 'Worker environment cwd');
      assertNeutralEnvironment(env);
      return Object.freeze({ cwd: resolve(cwd), env: Object.freeze({ ...env }) });
    },
  });
}

/** Native process host. Windows can replace the readiness/handle implementation via a seam. */
export function createWorkspaceWorkerProcessHost(
  options: WorkspaceWorkerProcessHostOptions = {},
): WorkspaceWorkerProcessSpawnPort {
  const platform = options.platform ?? process.platform;
  const runtimeExecutable = options.runtimeExecutable ?? process.execPath;
  const verifier = options.executableVerifier ?? verifyWorkspaceWorkerProcessExecutable;
  const verifiedRuntime = validateExecutable(
    verifier({ path: runtimeExecutable, mode: 'installed' }),
    'Runtime',
  );
  return Object.freeze({
    async spawn(input: WorkspaceWorkerProcessSpawnInput): Promise<WorkspaceWorkerProcessChild> {
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
      if (platform === 'win32' && input.executable.mode === 'source') {
        // Native Windows source mode still uses the explicit Bun/runtime executable; it never
        // attempts to execute a TypeScript file as a native binary.
        return nativeSpawn(verifiedInput, verifiedRuntime, platform, options.controlLinkFactory);
      }
      return nativeSpawn(verifiedInput, verifiedRuntime, platform, options.controlLinkFactory);
    },
  });
}

/** Conservative PID/start-identity probe. It never kills or signals a process. */
export function createWorkspaceWorkerProcessProbe(
  options: {
    readonly platform?: NodeJS.Platform;
    readonly readStartIdentity?: (
      pid: number,
      platform: NodeJS.Platform,
    ) => Promise<string | undefined>;
  } = {},
): WorkspaceWorkerProcessProbePort {
  const platform = options.platform ?? process.platform;
  const readStart =
    options.readStartIdentity ??
    (async (pid: number, targetPlatform: NodeJS.Platform) =>
      readCoordinatorProcessStartIdentity(pid, targetPlatform));
  return Object.freeze({
    async inspect(input: WorkspaceWorkerProcessIdentityProbe) {
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
      const actual = await readStart(input.pid, platform);
      return actual !== undefined && actual === input.processStartIdentity
        ? ('alive' as const)
        : ('uncertain' as const);
    },
  });
}

export function verifyWorkspaceWorkerProcessExecutable(
  input: WorkspaceWorkerProcessExecutableVerificationInput,
): string {
  const path = validateExecutable(input.path, input.mode === 'source' ? 'Source' : 'Installed');
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    throw new WorkspaceWorkerProcessHostError(
      'invalid_executable',
      'Worker executable could not be inspected.',
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new WorkspaceWorkerProcessHostError(
      'invalid_executable',
      'Worker executable is not a private regular file.',
    );
  }
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    throw new WorkspaceWorkerProcessHostError(
      'invalid_executable',
      'Worker executable could not be canonicalized.',
    );
  }
  if (!samePath(canonical, path)) {
    throw new WorkspaceWorkerProcessHostError(
      'invalid_executable',
      'Worker executable is not the exact canonical file.',
    );
  }
  return canonical;
}

export function resolveWorkspaceWorkerProcessSpawnCommand(
  executable: WorkspaceWorkerProcessExecutable,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  runtimeExecutable: string = process.execPath,
): { readonly command: string; readonly args: readonly string[] } {
  // The platform remains part of this seam for hosted Windows runners; source execution is
  // intentionally identical on POSIX and Windows so neither branch can consult PATH.
  void platform;
  if (executable.mode === 'source') {
    // Source entries are scripts on every platform. Invoke the explicit runtime directly so a
    // repo shebang cannot consult `/usr/bin/env`, PATH, or an ambient Bun/Node installation.
    return Object.freeze({
      command: validateExecutable(runtimeExecutable, 'Runtime'),
      args: Object.freeze([executable.path, ...args]),
    });
  }
  return Object.freeze({ command: executable.path, args: Object.freeze([...args]) });
}

function nativeSpawn(
  input: WorkspaceWorkerProcessSpawnInput,
  runtimeExecutable: string,
  platform: NodeJS.Platform,
  controlLinkFactory:
    | ((input: {
        readonly pid: number;
        readonly executable: WorkspaceWorkerProcessExecutable;
      }) => WorkspaceWorkerControlLink)
    | undefined,
): WorkspaceWorkerProcessChild {
  assertSpawnInput(input);
  const invocation = resolveWorkspaceWorkerProcessSpawnCommand(
    input.executable,
    input.args,
    platform,
    runtimeExecutable,
  );
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(invocation.command, [...invocation.args], {
      cwd: input.cwd,
      env: { ...input.env, KITE_WORKER_READY_FD: String(READY_FD) },
      detached: input.detached,
      stdio: ['ignore', input.stdout, 'ignore', 'pipe'],
      windowsHide: true,
    });
  } catch {
    throw new WorkspaceWorkerProcessHostError(
      'spawn_failed',
      'Workspace Worker process could not be spawned.',
    );
  }
  const pid = child.pid;
  const readinessStream = child.stdio[READY_FD] as ReadStream | null;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0 || !readinessStream) {
    readinessStream?.destroy();
    throw new WorkspaceWorkerProcessHostError(
      'spawn_failed',
      'Workspace Worker process did not expose readiness.',
    );
  }
  const childPid = pid;
  const exitPromise =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolvePromise) => {
          child.once('exit', () => resolvePromise());
        });
  child.unref();
  let released = false;
  const readinessPromise = readReady(readinessStream);
  const control =
    controlLinkFactory?.({ pid: childPid, executable: input.executable }) ??
    unsupportedControlLink();
  return Object.freeze({
    pid: childPid,
    readiness: Object.freeze({
      async release() {
        if (released) return;
        released = true;
        readinessStream.destroy();
      },
    }),
    control,
    waitForReady: () => readinessPromise,
    waitForExit: () => exitPromise,
  });
}

async function readReady(
  stream: AsyncIterable<Uint8Array | string>,
): Promise<WorkspaceWorkerReadySignal> {
  let bytes = 0;
  let value = '';
  for await (const chunk of stream) {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_READY_BYTES) {
      throw new WorkspaceWorkerProcessHostError(
        'ready_failed',
        'Workspace Worker readiness signal is oversized.',
      );
    }
    value += text;
    const newline = value.indexOf('\n');
    if (newline < 0) continue;
    if (value.slice(newline + 1).length !== 0) {
      throw new WorkspaceWorkerProcessHostError(
        'ready_failed',
        'Workspace Worker readiness channel has trailing data.',
      );
    }
    try {
      return decodeWorkspaceWorkerReadySignal(JSON.parse(value.slice(0, newline)) as unknown);
    } catch {
      throw new WorkspaceWorkerProcessHostError(
        'ready_failed',
        'Workspace Worker readiness signal is invalid.',
      );
    }
  }
  throw new WorkspaceWorkerProcessHostError(
    'ready_failed',
    'Workspace Worker readiness channel closed before ready.',
  );
}

function unsupportedControlLink(): WorkspaceWorkerControlLink {
  return Object.freeze({
    async describeIdentity() {
      return undefined;
    },
    async mintConnectionCapability() {
      return { outcome: 'unavailable' as const };
    },
    async requestIdleStop() {
      return 'unavailable' as const;
    },
    async readDirectoryOutbox() {
      return undefined;
    },
  });
}

function validateExecutable(path: string, label: string): string {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    !isAbsolutePath(path) ||
    !safeText(path, 4_096)
  ) {
    throw new WorkspaceWorkerProcessHostError(
      'invalid_executable',
      `${label} Worker executable is not an absolute path.`,
    );
  }
  return isWindowsPath(path) ? win32.normalize(path) : resolve(path);
}

function assertSpawnInput(input: WorkspaceWorkerProcessSpawnInput): void {
  assertAbsolutePath(input.cwd, 'Worker spawn cwd');
  if (input.args.length > MAX_ARGS) throw new RangeError('Worker spawn arguments are oversized.');
  for (const argument of input.args) {
    if (!safeText(argument, MAX_ARGUMENT_BYTES)) {
      throw new TypeError('Worker spawn argument is invalid.');
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
  if (entries.length > MAX_ENV_ENTRIES) throw new RangeError('Worker environment is oversized.');
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || !safeText(value, MAX_ENV_VALUE_BYTES)) {
      throw new TypeError('Worker environment is invalid.');
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

function assertBuildId(value: string): void {
  if (!safeText(value, 512)) throw new TypeError('Worker build identity is invalid.');
}

function isNativeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
