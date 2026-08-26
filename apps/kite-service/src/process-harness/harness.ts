import { type ChildProcess, spawn as spawnChild } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import type { KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import {
  createKiteHomeIdentity,
  readLocalRuntimeServiceDescriptor,
  readLocalRuntimeServiceToken,
} from '@kite-ai/kite-local-runtime/service';
import {
  KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME,
  KITE_SERVICE_CONNECT_PATH,
  KITE_SERVICE_CONTROL_AUTHORIZATION_SCHEME,
  KITE_SERVICE_CONTROL_STOP_PATH,
} from '../carrier';
import { createKiteServiceEnvironment, type KiteServiceEnvironment } from '../environment';
import {
  createKiteServiceManager,
  createKiteServiceManagerNativePorts,
  createKiteServiceManagerNativeProcessPort,
  type KiteServiceManagerEnvironment,
  type KiteServiceManagerExecutable,
} from '../manager';
import type {
  KiteServiceManagerChild,
  KiteServiceManagerHandshake,
  KiteServiceManagerReadinessPort,
  KiteServiceManagerSpawnPort,
} from '../manager/ports';
import type {
  KiteServiceProcessHarness,
  KiteServiceProcessHarnessChildConfig,
  KiteServiceProcessHarnessOptions,
  KiteServiceProcessHarnessRequestOptions,
} from './ports';

const READINESS_FD = 3;
const MAX_READINESS_BYTES = 4_096;
const MAX_CAPTURED_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_SERVER_VERSION = 'service-process-harness';
const DEFAULT_BUILD_ID = 'dev:service-process-harness';
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_MANAGER_OPERATION_TIMEOUT_MS = 5_000;

function assertAbsolutePath(value: string, label: string): string {
  if (
    value.length === 0 ||
    !isAbsolute(value) ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    throw new TypeError(`${label} must be an absolute path without control characters.`);
  }
  return resolve(value);
}

function assertBoundedTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new RangeError(`${label} must be between 1 and 300000 milliseconds.`);
  }
  return value;
}

function normalizeFaults(
  value: KiteServiceProcessHarnessOptions['faults'],
): NonNullable<KiteServiceProcessHarnessOptions['faults']> {
  if (value === undefined) return Object.freeze({});
  if (
    value.startupDelayMs !== undefined &&
    (!Number.isSafeInteger(value.startupDelayMs) ||
      value.startupDelayMs < 0 ||
      value.startupDelayMs > 300_000)
  ) {
    throw new RangeError('startupDelayMs must be between 0 and 300000 milliseconds.');
  }
  if (
    (value.failStartup !== undefined && typeof value.failStartup !== 'boolean') ||
    (value.dropCredentialResponse !== undefined &&
      typeof value.dropCredentialResponse !== 'boolean')
  ) {
    throw new TypeError('Process harness fault flags must be boolean.');
  }
  return Object.freeze({ ...value });
}

function defaultWorkspace(homeRoot: string): KiteWorkspaceIdentity {
  const canonicalPath = join(homeRoot, 'harness-workspace');
  const digest = createHash('sha256').update(canonicalPath).digest('hex');
  return Object.freeze({
    canonicalPath,
    projectId: 'process-harness-project',
    workspaceDigest: `sha256:${digest}` as `sha256:${string}`,
  });
}

function assertWorkspace(value: KiteWorkspaceIdentity): KiteWorkspaceIdentity {
  if (
    value.canonicalPath.length === 0 ||
    !isAbsolute(value.canonicalPath) ||
    [...value.canonicalPath].some((character) => /\p{Cc}/u.test(character)) ||
    value.projectId.length === 0 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value.projectId) ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.workspaceDigest)
  ) {
    throw new TypeError('Process harness Workspace identity is invalid.');
  }
  return Object.freeze({ ...value });
}

function capture(stream: Readable | null, sink: { value: string }): void {
  if (!stream) return;
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    if (sink.value.length >= MAX_CAPTURED_OUTPUT_BYTES) return;
    sink.value += chunk.slice(0, MAX_CAPTURED_OUTPUT_BYTES - sink.value.length);
  });
  stream.on('error', () => undefined);
  stream.resume();
}

function decodeReadiness(value: string): { readonly instanceId: string } {
  const parsed = JSON.parse(value) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !('instanceId' in parsed) ||
    typeof parsed.instanceId !== 'string' ||
    parsed.instanceId.length === 0 ||
    parsed.instanceId.length > 512 ||
    /\p{Cc}/u.test(parsed.instanceId)
  ) {
    throw new TypeError('Service harness readiness signal is invalid.');
  }
  return Object.freeze({ instanceId: parsed.instanceId });
}

async function readReadiness(stream: Readable): Promise<{ readonly instanceId: string }> {
  let value = '';
  for await (const chunk of stream) {
    value += Buffer.from(chunk as Uint8Array).toString('utf8');
    if (Buffer.byteLength(value, 'utf8') > MAX_READINESS_BYTES) {
      throw new RangeError('Service harness readiness signal is oversized.');
    }
    const newline = value.indexOf('\n');
    if (newline < 0) continue;
    if (value.slice(newline + 1).length !== 0) {
      throw new TypeError('Service harness readiness signal contains trailing data.');
    }
    return decodeReadiness(value.slice(0, newline));
  }
  throw new Error('Service harness readiness channel closed before ready.');
}

function normalizeChildExit(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null) return 128;
  return 1;
}

function makeChildSpawnPort(
  onChild: (
    child: ChildProcess,
    stdout: { value: string },
    stderr: { value: string },
    exit: Promise<number>,
  ) => void,
): KiteServiceManagerSpawnPort {
  return {
    async spawn(input): Promise<KiteServiceManagerChild> {
      const child = spawnChild(input.executable.path, [...input.args], {
        cwd: input.cwd,
        env: { ...input.env, KITE_SERVICE_READINESS_FD: String(READINESS_FD) },
        detached: true,
        // The manager's production port uses stdout=ignore. The process harness captures this
        // stream only to prove that readiness/protocol never relies on stdout and remains pure.
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const pid = child.pid;
      const readinessStream = child.stdio[READINESS_FD] as Readable | null;
      if (!Number.isSafeInteger(pid) || pid === undefined || pid <= 0 || readinessStream === null) {
        readinessStream?.destroy();
        child.unref();
        throw new Error('Service harness child did not expose PID/readiness.');
      }
      const stdout = { value: '' };
      const stderr = { value: '' };
      capture(child.stdout, stdout);
      capture(child.stderr, stderr);
      const exit = new Promise<number>((resolveExit) => {
        child.once('error', () => resolveExit(1));
        child.once('exit', (code, signal) => resolveExit(normalizeChildExit(code, signal)));
      });
      onChild(child, stdout, stderr, exit);
      child.unref();
      let released = false;
      const readinessPromise = readReadiness(readinessStream);
      const readiness: KiteServiceManagerReadinessPort = {
        async release(): Promise<void> {
          if (released) return;
          released = true;
          readinessStream.destroy();
        },
      };
      return Object.freeze({
        pid,
        readiness,
        waitForReady: () => readinessPromise,
      });
    },
  };
}

function safeHeaderValue(value: string, label: string): string {
  if (value.length === 0 || /[\r\n]/u.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function requestInit(
  options: KiteServiceProcessHarnessRequestOptions | undefined,
  authorization: string | undefined,
  token: string | undefined,
): RequestInit {
  const { body, headers: initialHeaders, ...requestOptions } = options ?? {};
  const headers = new Headers(initialHeaders);
  if (authorization !== undefined && token !== undefined) {
    headers.set('authorization', `${authorization} ${safeHeaderValue(token, 'token')}`);
  }
  let encodedBody: BodyInit | undefined;
  if (body !== undefined) {
    encodedBody = typeof body === 'string' ? body : JSON.stringify(body);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }
  return {
    ...requestOptions,
    headers,
    ...(encodedBody === undefined ? {} : { body: encodedBody }),
  };
}

function relativePath(pathname: string): string {
  if (
    pathname.length === 0 ||
    !pathname.startsWith('/') ||
    pathname.startsWith('//') ||
    pathname.includes('://') ||
    /[\r\n]/u.test(pathname)
  ) {
    throw new TypeError('Process harness request path must be a relative local path.');
  }
  return pathname;
}

function parseControlResult(value: unknown): {
  readonly outcome: 'applied' | 'service_busy' | 'unavailable' | 'outcome_unknown';
  readonly diagnostic?: 'service_busy' | 'service_unavailable' | 'identity_uncertain';
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { outcome: 'unavailable', diagnostic: 'service_unavailable' };
  }
  const candidate = value as { readonly outcome?: unknown; readonly diagnostic?: unknown };
  if (
    candidate.outcome !== 'applied' &&
    candidate.outcome !== 'service_busy' &&
    candidate.outcome !== 'unavailable' &&
    candidate.outcome !== 'outcome_unknown'
  ) {
    return { outcome: 'unavailable', diagnostic: 'service_unavailable' };
  }
  const diagnostic =
    candidate.diagnostic === 'service_busy' ||
    candidate.diagnostic === 'service_unavailable' ||
    candidate.diagnostic === 'identity_uncertain'
      ? candidate.diagnostic
      : undefined;
  return diagnostic === undefined
    ? { outcome: candidate.outcome }
    : { outcome: candidate.outcome, diagnostic };
}

function createWrapper(
  path: string,
  childEntryUrl: string,
  config: KiteServiceProcessHarnessChildConfig,
): void {
  const source = [
    '#!/usr/bin/env bun',
    `import { runKiteServiceProcessHarnessChild } from ${JSON.stringify(childEntryUrl)};`,
    `const result = await runKiteServiceProcessHarnessChild(${JSON.stringify(config)});`,
    'process.exitCode = result;',
    '',
  ].join('\n');
  writeFileSync(path, source, { mode: 0o700 });
  chmodSync(path, 0o700);
}

/**
 * Build an opt-in, parent-side process harness for KLSV1-05 integration tests. The child entry is
 * generated with one explicit fake application configuration; all actual state, descriptor,
 * tokens, listener, ticket and Runtime Server behavior comes from the service infrastructure.
 */
export function createKiteServiceProcessHarness(
  options: KiteServiceProcessHarnessOptions,
): KiteServiceProcessHarness {
  const homeRoot = assertAbsolutePath(options.homeRoot, 'Process harness home');
  const home = createKiteHomeIdentity(homeRoot, 'explicit_argument');
  const workspace = assertWorkspace(options.workspace ?? defaultWorkspace(home.root));
  const serverVersion = options.serverVersion ?? DEFAULT_SERVER_VERSION;
  const buildId = options.buildId ?? DEFAULT_BUILD_ID;
  const startupTimeoutMs = assertBoundedTimeout(
    options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    'startup',
  );
  const shutdownTimeoutMs = assertBoundedTimeout(
    options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    'shutdown',
  );
  const managerOperationTimeoutMs = assertBoundedTimeout(
    options.managerOperationTimeoutMs ?? DEFAULT_MANAGER_OPERATION_TIMEOUT_MS,
    'manager operation',
  );
  const executableMode = options.executableMode ?? 'source';
  const faults = normalizeFaults(options.faults);
  const nativePorts = createKiteServiceManagerNativePorts({
    identity: home,
    process: createKiteServiceManagerNativeProcessPort(),
  });
  const childCwd = join(home.root, 'runtime-service', 'v1', 'process-harness-cwd');
  mkdirSync(childCwd, { recursive: true, mode: 0o700 });
  chmodSync(childCwd, 0o700);

  const childEntryUrl = new URL('./child.ts', import.meta.url).href;
  let launchNumber = 0;
  let lastChild: ChildProcess | undefined;
  let lastChildExit: Promise<number> | undefined;
  let stdout = { value: '' };
  let stderr = { value: '' };
  const wrappers = new Set<string>();

  const spawn = makeChildSpawnPort((child, childStdout, childStderr, exit) => {
    lastChild = child;
    lastChildExit = exit;
    // Keep the public getter live while the detached process writes to its captured streams.
    stdout = childStdout;
    stderr = childStderr;
  });

  const environment = {
    async resolve(): Promise<KiteServiceManagerEnvironment> {
      const value: KiteServiceEnvironment = createKiteServiceEnvironment({
        homeRoot: home.root,
        stateRoot: join(home.root, 'runtime-service', 'v1'),
        source: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        ...(options.systemHome === undefined ? {} : { systemHome: options.systemHome }),
        nodeEnvironment: 'production',
        neutralDirectoryName: 'process-harness-cwd',
      });
      return value;
    },
  };

  const executableResolver = {
    async resolve(mode: 'source' | 'installed'): Promise<KiteServiceManagerExecutable> {
      launchNumber += 1;
      const instanceId = `process-harness-${launchNumber}-${buildId.replace(/[^A-Za-z0-9_-]/gu, '_')}`;
      const config: KiteServiceProcessHarnessChildConfig = {
        homeRoot: home.root,
        workspace,
        instanceId,
        serverVersion,
        buildId,
        startupTimeoutMs,
        shutdownTimeoutMs,
        faults,
      };
      const wrapper = join(childCwd, `child-${launchNumber}.mjs`);
      createWrapper(wrapper, childEntryUrl, config);
      wrappers.add(wrapper);
      return Object.freeze({ path: wrapper, mode, buildId });
    },
  };

  const processPort = createKiteServiceManagerNativeProcessPort();
  const manager = createKiteServiceManager({
    state: nativePorts.state,
    lifecycleLock: nativePorts.lifecycleLock,
    probe: {
      async handshake(input): Promise<KiteServiceManagerHandshake> {
        try {
          const response = await fetch(`${input.descriptor.endpoint.origin}/readyz`);
          const text = await response.text();
          if (response.status !== 200 || text !== 'ready') {
            return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
          }
          return {
            outcome: 'healthy',
            instanceId: input.descriptor.instanceId,
            protocolVersion: input.descriptor.protocolVersion,
            clientContractRevision: input.descriptor.clientContractRevision,
            buildId: input.descriptor.buildId,
          };
        } catch {
          return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
        }
      },
    },
    process: processPort,
    environment,
    executableResolver,
    spawn,
    control: {
      async stop(input) {
        try {
          const response = await fetch(
            `${input.descriptor.endpoint.origin}${KITE_SERVICE_CONTROL_STOP_PATH}`,
            requestInit(
              { method: 'POST', body: {} },
              KITE_SERVICE_CONTROL_AUTHORIZATION_SCHEME,
              input.controlToken,
            ),
          );
          if (!response.ok) return { outcome: 'unavailable', diagnostic: 'service_unavailable' };
          return parseControlResult((await response.json()) as unknown);
        } catch {
          return { outcome: 'outcome_unknown' };
        }
      },
    },
    expectedBuildId: buildId,
    startupTimeoutMs,
    operationTimeoutMs: managerOperationTimeoutMs,
  });

  const request = async (
    pathname: string,
    requestOptions?: KiteServiceProcessHarnessRequestOptions,
  ): Promise<Response> => {
    const descriptor = readLocalRuntimeServiceDescriptor(nativePorts.state.paths);
    if (!descriptor) throw new Error('Service harness descriptor is unavailable.');
    return fetch(
      `${descriptor.endpoint.origin}${relativePath(pathname)}`,
      requestInit(requestOptions, undefined, undefined),
    );
  };

  const requestWithToken = async (
    pathname: string,
    requestOptions: KiteServiceProcessHarnessRequestOptions | undefined,
    kind: 'access' | 'control',
  ): Promise<Response> => {
    const descriptor = readLocalRuntimeServiceDescriptor(nativePorts.state.paths);
    if (!descriptor) throw new Error('Service harness descriptor is unavailable.');
    const token = readLocalRuntimeServiceToken(nativePorts.state.paths, kind);
    if (!token) throw new Error('Service harness token is unavailable.');
    const scheme =
      kind === 'access'
        ? KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME
        : KITE_SERVICE_CONTROL_AUTHORIZATION_SCHEME;
    if (kind === 'control') {
      // The control helper models the authenticated manager path, which has no browser-origin or
      // cookie semantics. Raw `request()` remains available for negative route-matrix tests.
      const headers = new Headers(requestOptions?.headers);
      headers.delete('origin');
      headers.delete('cookie');
      requestOptions = { ...(requestOptions ?? {}), headers };
    }
    return fetch(
      `${descriptor.endpoint.origin}${relativePath(pathname)}`,
      requestInit(requestOptions, scheme, token),
    );
  };

  const waitForLastChildExit = async (
    timeoutMs = managerOperationTimeoutMs,
  ): Promise<number | null> => {
    const exit = lastChildExit;
    if (!exit) return null;
    const timeout = assertBoundedTimeout(timeoutMs, 'child exit');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<{ readonly timedOut: true }>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout({ timedOut: true }), timeout);
    });
    const value = await Promise.race([
      exit.then((code) => ({ timedOut: false as const, code })),
      bounded,
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return value.timedOut ? null : value.code;
  };

  const harness: KiteServiceProcessHarness = {
    home,
    paths: nativePorts.state.paths,
    manager,
    workspace,
    executableMode,
    get stdout() {
      return stdout.value;
    },
    get stderr() {
      return stderr.value;
    },
    get lastChildPid() {
      return lastChild?.pid;
    },
    ensure(requestValue) {
      return manager.ensure({ ...(requestValue ?? {}), executableMode });
    },
    status(requestValue) {
      return manager.status({ ...(requestValue ?? {}), executableMode });
    },
    stop(requestValue) {
      return manager.stop({ ...(requestValue ?? {}), executableMode });
    },
    restart(requestValue) {
      return manager.restart({ ...(requestValue ?? {}), executableMode });
    },
    readDescriptor() {
      return readLocalRuntimeServiceDescriptor(nativePorts.state.paths);
    },
    readToken(kind) {
      const value = readLocalRuntimeServiceToken(nativePorts.state.paths, kind);
      return value;
    },
    request,
    requestAccess(pathname, requestOptions) {
      return requestWithToken(pathname, requestOptions, 'access');
    },
    requestControl(pathname, requestOptions) {
      return requestWithToken(pathname, requestOptions, 'control');
    },
    async issueRuntimeTicket(): Promise<string> {
      const response = await requestWithToken(
        KITE_SERVICE_CONNECT_PATH,
        { method: 'POST', body: { workspace: workspace.canonicalPath } },
        'access',
      );
      if (!response.ok) throw new Error('Service harness Runtime ticket request failed.');
      const value = (await response.json()) as unknown;
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        !('ticket' in value) ||
        typeof value.ticket !== 'string'
      ) {
        throw new Error('Service harness Runtime ticket response is invalid.');
      }
      return value.ticket;
    },
    waitForChildExit(timeoutMs): Promise<number | null> {
      return waitForLastChildExit(timeoutMs);
    },
    async [Symbol.asyncDispose](): Promise<void> {
      const current = await manager.status({ executableMode });
      if (current.state !== 'absent') {
        const stopped = await manager.stop({ executableMode });
        if (stopped.outcome !== 'applied' || stopped.state !== 'absent') {
          throw new Error('Service process harness could not safely stop its detached child.');
        }
      }
      if (lastChildExit && (await waitForLastChildExit()) === null) {
        throw new Error('Service process harness detached child did not exit before cleanup.');
      }
      for (const wrapper of wrappers) {
        rmSync(wrapper, { force: true });
      }
      wrappers.clear();
    },
  };
  return Object.freeze(harness);
}
