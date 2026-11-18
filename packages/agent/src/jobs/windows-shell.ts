import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import type {
  JobContext,
  JobDefinition,
  JobEvent,
  JobHandle,
  Json,
  StopConfirmation,
  ToolResult,
} from '../extensions';
import { JobStartError } from '../extensions';
import {
  startWindowsOwnedChild,
  type WindowsOwnedChild,
  WindowsOwnedChildStartError,
} from '../platform/process/windows-owned-child';
import { privateDirectory } from '../platform/windows-path-security';
import type { DesktopShellPreference } from '../storage/types';
import {
  launchIdentity,
  launchIdentityAsync,
  mapAssetVerification,
  removeRuntimeTempAsync,
  verifyLaunchIdentitiesAsync,
} from './launch-identity';
import { prepareShellOutputCollection, type ShellOutputCollection } from './output-collection';
import { ripgrepAsset } from './ripgrep';
import type { TrustedWorkerLaunch } from './shell';
import type { HostShellExecutionScopeResolver } from './shell-scope';
import { windowsCommandLookup } from './windows-command-lookup';
import {
  captureWindowsGitBashRuntime,
  stageWindowsGitBash,
  WindowsGitBashUnavailable,
} from './windows-git-bash';
import {
  discoverPreferredWindowsPowerShell,
  powerShellLaunchIdentities,
  type WindowsPowerShell,
} from './windows-powershell';

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const protocol = 7;
const maximumFrame = 16 * 1024 * 1024;
const cleanupDiagnosticPrefix = 'kite-windows-runner[cleanup]: ';
const cleanupDiagnosticLimit = 4096;
const lookupOutputLimit = 4096;
const cleanupHresultKeys = [
  'exitCodeQuery',
  'initialJobQuery',
  'terminateJob',
  'lastJobQuery',
  'stdinReadClose',
  'stdinWriteClose',
  'stdoutWriteClose',
  'stderrWriteClose',
  'stdoutRead',
  'stderrRead',
  'stdoutReadClose',
  'stderrReadClose',
  'jobClose',
] as const;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const nullableInteger = (value: unknown, min: number, max: number) =>
  value === null ||
  (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max);

function validPipeDiagnostic(value: unknown): boolean {
  const pipe = record(value);
  return (
    !!pipe &&
    Object.keys(pipe).length === 2 &&
    ['eof', 'read_failed', 'forward_failed', 'timed_out', 'panicked'].includes(
      pipe.state as string,
    ) &&
    (pipe.state === 'timed_out'
      ? pipe.handleClosed === null
      : typeof pipe.handleClosed === 'boolean')
  );
}

/** Retain only a bounded observation on the original runner's private stderr. */
async function readNativeCleanup(stream: AsyncIterable<Uint8Array>): Promise<Json | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size <= cleanupDiagnosticLimit) chunks.push(Buffer.from(chunk));
  }
  if (size > cleanupDiagnosticLimit) return;
  const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/u);
  const matches = lines.filter((line) => line.startsWith(cleanupDiagnosticPrefix));
  if (matches.length !== 1) return;
  try {
    const value = record(JSON.parse(matches[0]!.slice(cleanupDiagnosticPrefix.length)));
    const hresults = record(value?.hresults);
    if (
      !value ||
      Object.keys(value).length !== 9 ||
      !['process_exited', 'timed_out', 'cancelled'].includes(value.waitReason as string) ||
      ![value.rootExitCode, value.activeBefore, value.activeAfter].every((number) =>
        nullableInteger(number, 0, 0xffffffff),
      ) ||
      !validPipeDiagnostic(value.stdout) ||
      !validPipeDiagnostic(value.stderr) ||
      typeof value.jobHandleClosed !== 'boolean' ||
      typeof value.aclCleanupConfirmed !== 'boolean' ||
      !hresults ||
      Object.keys(hresults).length !== cleanupHresultKeys.length ||
      !cleanupHresultKeys.every((key) => nullableInteger(hresults[key], -0x80000000, 0x7fffffff))
    )
      return;
    return value as Json;
  } catch {
    return;
  }
}

const capabilitySid = () =>
  `S-1-5-21-${Array.from({ length: 4 }, () => randomBytes(4).readUInt32LE()).join('-')}`;
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
          .join(',')}}`
      : JSON.stringify(value);

export type WindowsShellBackend =
  | { kind?: 'bash'; fullShellExecutable: string; bashVersion?: string }
  | {
      kind: 'powershell';
      powerShell: WindowsPowerShell;
      gitExecutable?: string;
      fullShellExecutable?: never;
    };

/** Installed assets only. Source callers must explicitly select their built fixture. */
export async function windowsShellAssets(
  stateRoot: string,
  preference: DesktopShellPreference = 'git-bash',
): Promise<{
  runner: string;
  shell: string;
  windows: WindowsShellBackend & { stateRoot: string };
}> {
  if (process.platform !== 'win32' || !import.meta.url.endsWith('.js'))
    throw Error('windows_shell_asset_unavailable');
  const module = dirname(fileURLToPath(import.meta.url));
  const root = join(
    basename(module) === 'jobs' ? dirname(module) : module,
    'platform/process/windows-shell',
  );
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  if (
    manifest.protocol !== protocol ||
    manifest.runtime !== 'windows-restricted-token' ||
    Object.keys(manifest.files).sort().join(',') !== 'kite-windows-runner.exe,ktipc.dll'
  )
    throw Error('windows_shell_asset_invalid');
  for (const [file, hash] of Object.entries(manifest.files))
    if (digest(join(root, file)) !== hash) throw Error('windows_shell_asset_changed');
  const runner = join(root, 'kite-windows-runner.exe');
  const powerShellAssets = async (gitExecutable?: string) => {
    const powerShell = await discoverPreferredWindowsPowerShell();
    privateDirectory(stateRoot);
    return {
      runner,
      shell: powerShell.executable.canonical,
      windows: { kind: 'powershell' as const, stateRoot, powerShell, gitExecutable },
    };
  };
  if (preference === 'powershell' || preference === 'powershell-7') {
    const git = Bun.which('git');
    return powerShellAssets(
      git && isAbsolute(git) && /^git\.exe$/i.test(basename(git)) ? git : undefined,
    );
  }
  try {
    const bash = await stageWindowsGitBash(stateRoot, join(root, 'ktipc.dll'));
    return {
      runner,
      shell: bash.shell,
      windows: {
        kind: 'bash',
        stateRoot,
        fullShellExecutable: bash.fullShell,
        bashVersion: await inspectGitBashVersion(runner, stateRoot, bash),
      },
    };
  } catch (error) {
    if (preference !== 'auto' || !(error instanceof WindowsGitBashUnavailable)) throw error;
    return powerShellAssets(error.gitExecutable);
  }
}

/** Read the staged interpreter through the same restricted Job used for commands. */
async function inspectGitBashVersion(
  supervisorPath: string,
  stateRoot: string,
  bash: { shell: string; fullShell: string },
): Promise<string | undefined> {
  const signal = AbortSignal.timeout(5000);
  const job = await createWindowsShellJob(
    {
      cwd: dirname(bash.shell),
      controlBase: stateRoot,
      stateRoot,
      shellExecutable: bash.shell,
      fullShellExecutable: bash.fullShell,
      supervisorPath,
      env: { LANG: 'C.UTF-8' },
      executionScope: () => ({ filesystem: 'read_only', network: 'none' }),
    },
    signal,
  ).catch((error: unknown) => {
    if (error !== signal.reason) throw error;
  });
  if (!job) return;
  let handle: JobHandle | undefined;
  try {
    handle = await job.start(
      { command: `builtin printf '%s\\n' "$BASH_VERSION"` },
      { sessionId: 'windows-shell-runtime', executionId: randomBytes(16).toString('hex'), signal },
    );
    let stdout = '';
    for await (const event of job.observe(handle)) {
      if (event.type === 'output_dropped' && event.stream === 'stdout') return;
      if (event.type === 'output' && event.stream === 'stdout') {
        stdout += event.content;
        if (stdout.length > 128) return;
      }
      if (event.type === 'terminal' && event.result.outcome === 'succeeded' && !signal.aborted) {
        const version = stdout.trim();
        if (version.length <= 64 && /^\d+\.\d+\.\d+\(\d+\)-[a-z0-9-]+$/iu.test(version))
          return version;
      }
    }
  } catch (error) {
    if (!(error instanceof JobStartError)) throw error;
    handle = error.handle;
  } finally {
    if (handle) await job.dispose(handle);
  }
  return undefined;
}

export function windowsUserLocale(): string | undefined {
  try {
    const { dlopen, ptr } = require('bun:ffi') as typeof import('bun:ffi');
    const kernel = dlopen('kernel32.dll', {
      GetUserDefaultLocaleName: { args: ['ptr', 'i32'], returns: 'i32' },
    });
    try {
      const buffer = new Uint16Array(85); // LOCALE_NAME_MAX_LENGTH
      const length = kernel.symbols.GetUserDefaultLocaleName(ptr(buffer), buffer.length);
      if (length <= 1 || length > buffer.length) return;
      const locale = Buffer.from(buffer.buffer, 0, (length - 1) * 2).toString('utf16le');
      return /^[a-z0-9][a-z0-9_-]*$/iu.test(locale) ? locale : undefined;
    } finally {
      kernel.close();
    }
  } catch {
    return undefined;
  }
}
interface State {
  queue: { event: JobEvent; bytes: number }[];
  bytes: number;
  gaps: Map<'stdout' | 'stderr', JobEvent & { type: 'output_dropped' }>;
  wake?: () => void;
  observed: boolean;
  ended: boolean;
  cancel: () => Promise<StopConfirmation>;
}
export type WindowsShellOptions = WindowsShellBackend & {
  cwd: string;
  workspaceRoot?: string;
  env: Readonly<Record<string, string>>;
  supervisorPath: string;
  shellExecutable: string;
  stateRoot: string;
  controlBase: string;
  executionScope: (context: JobContext) =>
    | ReturnType<HostShellExecutionScopeResolver>
    | {
        filesystem: 'read_only';
        network: 'none';
      };
  maxQueuedBytes?: number;
  /** Host-verified read execution details, never taken from Job input. */
  readOnlyLaunch?: (context: JobContext) =>
    | {
        pinRipgrep?: 'command' | 'script';
        git?: { path: string; digest: string; argv?: readonly string[] };
      }
    | undefined;
  trustedWorkerLaunch?: (
    command: string,
    context: JobContext,
  ) => (TrustedWorkerLaunch & { readonly powerShellCommand?: string }) | undefined;
  outputCollection?: ShellOutputCollection;
};
/** Live native Job/HANDLE owner; durable references never reconstruct a process from a PID. */
export async function createWindowsShellJob(
  input: WindowsShellOptions,
  signal?: AbortSignal,
): Promise<JobDefinition> {
  const options = { ...input, env: { ...input.env } };
  const workspaceRoot = options.workspaceRoot ?? options.cwd;
  const powerShell = options.kind === 'powershell' ? options.powerShell : undefined;
  const search = ripgrepAsset();
  if (
    process.platform !== 'win32' ||
    process.arch !== 'x64' ||
    !process.versions.bun ||
    ![
      options.cwd,
      workspaceRoot,
      options.supervisorPath,
      options.shellExecutable,
      ...(options.kind === 'powershell'
        ? [options.powerShell.executable.canonical, options.powerShell.engine.canonical]
        : [options.fullShellExecutable]),
      options.stateRoot,
      options.controlBase,
    ].every(isAbsolute)
  )
    throw Error('windows_shell_unqualified');
  const assets = await mapAssetVerification(
    [
      options.supervisorPath,
      options.shellExecutable,
      options.kind === 'powershell' ? search : options.fullShellExecutable,
    ],
    (path, signal) => launchIdentityAsync(path, true, signal),
    signal,
  );
  const roots = await mapAssetVerification(
    [...new Set([options.cwd, workspaceRoot, options.controlBase])],
    (path, signal) => launchIdentityAsync(path, false, signal),
    signal,
  );
  const bashRuntime =
    options.kind === 'powershell'
      ? undefined
      : await captureWindowsGitBashRuntime(
          options.shellExecutable,
          options.fullShellExecutable,
          signal,
        );
  if (powerShell && assets[1]!.canonical !== powerShell.executable.canonical)
    throw Error('windows_powershell_asset_invalid');
  const states = new WeakMap<JobHandle, State>();
  const get = (handle: JobHandle) => {
    const state = states.get(handle);
    if (!state) throw Error('unknown_shell_handle');
    return state;
  };
  return {
    id: 'shell.command',
    version: '1',
    description: `${powerShell ? `PowerShell ${powerShell.version}` : 'Git Bash'} with unelevated write-restricted filesystem access and owned Job supervision`,
    resources: { slot: 'process' },
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', minLength: 1, maxLength: 262144 } },
      required: ['command'],
      additionalProperties: false,
    },
    async start(value, context: JobContext) {
      const { scope, shell, command, trusted, readOnly } = await (async () => {
        try {
          context.signal.throwIfAborted();
          if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            Object.keys(value).join(',') !== 'command' ||
            typeof value.command !== 'string' ||
            !value.command ||
            value.command.length > 262144
          )
            throw Error('invalid_shell_input');
          await verifyLaunchIdentitiesAsync(
            [...assets, ...roots, ...(powerShell ? powerShellLaunchIdentities(powerShell) : [])],
            context.signal,
          );
          const scope = options.executionScope(context);
          const readOnly =
            scope.filesystem === 'read_only' ? options.readOnlyLaunch?.(context) : undefined;
          await bashRuntime?.verify(scope.filesystem === 'full_access', context.signal);
          if (readOnly?.git) {
            const git = readOnly.git;
            const current = await launchIdentityAsync(git.path, true, context.signal);
            if (current.canonical !== git.path || current.digest !== git.digest)
              throw Error('shell_asset_changed');
          }
          context.signal.throwIfAborted();
          const fullBash = !powerShell && scope.filesystem === 'full_access';
          const shell = fullBash ? assets[2]! : assets[1]!;
          if (!powerShell && basename(shell.canonical).toLowerCase() !== 'bash.exe')
            throw Error('windows_git_bash_required');
          const trusted = options.trustedWorkerLaunch?.(value.command, context);
          return { scope, shell, command: value.command, trusted, readOnly };
        } catch (error) {
          throw new JobStartError(
            undefined,
            error instanceof Error ? error.message : 'windows_shell_preparation_failed',
          );
        }
      })();
      const invocation = `kitecode.${randomBytes(16).toString('hex')}`;
      const temp = realpathSync.native(mkdtempSync(join(options.controlBase, 'shell-')));
      const tempIdentity = launchIdentity(temp);
      const collection = options.outputCollection
        ? await prepareShellOutputCollection(options.outputCollection, context, {
            runtimeTemp: tempIdentity,
            cleanup: () => removeRuntimeTempAsync(tempIdentity),
          })
        : undefined;
      const cleanup = collection ? async () => {} : () => removeRuntimeTempAsync(tempIdentity);
      const env = { ...(trusted?.env ?? options.env), ...collection?.env };
      const inheritedPath = Object.hasOwn(env, 'PATH')
        ? env.PATH
        : Object.entries(env).find(([name]) => name.toUpperCase() === 'PATH')?.[1];
      const replaced = new Set(['PATH', 'TEMP', 'TMP', 'TMPDIR', 'BASH_ENV', 'ENV']);
      if (powerShell)
        for (const key of [
          'SYSTEMROOT',
          'WINDIR',
          'COMSPEC',
          'PATHEXT',
          'PSMODULEPATH',
          'POWERSHELL_TELEMETRY_OPTOUT',
          'POWERSHELL_UPDATECHECK',
          'RIPGREP_CONFIG_PATH',
        ])
          replaced.add(key);
      for (const name of Object.keys(env)) if (replaced.has(name.toUpperCase())) delete env[name];
      Object.assign(env, {
        TEMP: temp,
        TMP: temp,
        HOME: env.HOME ?? env.USERPROFILE ?? temp,
        PATH: [
          dirname(search),
          ...(bashRuntime
            ? [
                dirname(shell.canonical),
                dirname(scope.filesystem === 'full_access' ? bashRuntime.fullGit : bashRuntime.git),
              ]
            : [
                ...(powerShell!.installation ? [powerShell!.installation.root] : []),
                powerShell!.systemDirectory,
              ]),
          inheritedPath ?? '',
        ].join(';'),
      });
      if (powerShell)
        Object.assign(env, {
          SystemRoot: dirname(powerShell.systemDirectory),
          windir: dirname(powerShell.systemDirectory),
          ComSpec: join(powerShell.systemDirectory, 'cmd.exe'),
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
          PSModulePath: join(dirname(shell.canonical), 'Modules'),
          POWERSHELL_TELEMETRY_OPTOUT: '1',
          POWERSHELL_UPDATECHECK: 'Off',
          TMPDIR: temp,
        });
      else env.TMPDIR = temp.replaceAll('\\', '/');
      const git = readOnly?.git;
      if (git) {
        for (const key of Object.keys(env)) {
          if (/^(?:GIT_|GNUPGHOME$|MSYS2_ARG_CONV_EXCL$)/iu.test(key)) delete env[key];
        }
        Object.assign(env, {
          GIT_TERMINAL_PROMPT: '0',
          GIT_ALLOW_PROTOCOL: '',
          MSYS2_ARG_CONV_EXCL: '*',
        });
      }
      if (scope.network === 'none') {
        // The approved offline scope supplies conventional application hints.
        // Commands are never replaced by failing stubs or a second policy.
        const defaults = {
          HTTP_PROXY: 'http://127.0.0.1:9',
          HTTPS_PROXY: 'http://127.0.0.1:9',
          ALL_PROXY: 'http://127.0.0.1:9',
          NO_PROXY: 'localhost,127.0.0.1,::1',
          PIP_NO_INDEX: '1',
          PIP_DISABLE_PIP_VERSION_CHECK: '1',
          NPM_CONFIG_OFFLINE: 'true',
          CARGO_NET_OFFLINE: 'true',
        };
        for (const [key, value] of Object.entries(defaults)) {
          const inherited = Object.keys(env).find((name) => name.toUpperCase() === key);
          if (powerShell && inherited) delete env[inherited];
          if (powerShell || !inherited) env[key] = value;
        }
      }
      const shellLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
      const gitCommand =
        git?.argv && powerShell
          ? [
              `& ${shellLiteral(git.path)} ${git.argv.map(shellLiteral).join(' ')}`,
              'exit $LASTEXITCODE',
            ].join('\n')
          : undefined;
      const powerShellCommand = readOnly?.pinRipgrep
        ? [
            ...['rg', 'rg.exe'].map(
              (name) => `Set-Alias -Name ${name} -Value ${shellLiteral(search)}`,
            ),
            command,
            ...(readOnly.pinRipgrep === 'command' ? ['exit $LASTEXITCODE'] : []),
          ].join('\n')
        : command;
      const request = {
        version: protocol,
        directWorkspace: {
          runtimeCapabilitySid: capabilitySid(),
          ...(scope.filesystem === 'full_access'
            ? { approvedFilesystemGuardSid: capabilitySid() }
            : {}),
        },
        invocationName: invocation,
        commandLine: powerShell
          ? (gitCommand ?? trusted?.powerShellCommand ?? powerShellCommand)
          : command,
        cwd: options.cwd,
        env,
        filesystemScope: scope.filesystem,
        workspaceRoot,
        runtimeRoot: temp,
        shellRuntime: powerShell ? 'powershell' : 'bash',
        shellRuntimeDigest: `sha256:${shell.digest}`,
        ...(!powerShell || powerShell.installation
          ? { shellRuntimeRoot: dirname(shell.canonical) }
          : {}),
        // PowerShell and Windows MSYS exec both retain the interpreter while
        // the pinned Git runs. Its configured helpers have no third slot.
        maxProcesses: git ? 2 : 64,
        timeoutMs: null,
        networkMode: scope.network === 'none' ? 'off' : 'allow_all',
      };
      let owner: WindowsOwnedChild;
      try {
        owner = startWindowsOwnedChild({
          executable: options.supervisorPath,
          argv: [],
          cwd: options.cwd,
          env: Object.fromEntries(
            Object.entries({
              ...process.env,
              KITE_WINDOWS_RESTRICTED_TOKEN_STATE_DIR: options.stateRoot,
            }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
          ),
          stdin: 'pipe',
        });
      } catch (error) {
        if (error instanceof WindowsOwnedChildStartError) {
          await error.cleanup;
        }
        await cleanup();
        throw error;
      }
      let sequence = 0,
        expected = 0,
        ready = false,
        released = false,
        cancelRequested = false,
        terminal: Record<string, unknown> | undefined,
        protocolFailed = false,
        stopping: Promise<StopConfirmation> | undefined;
      let confirmAdmission!: (admitted: boolean) => void;
      const admission = new Promise<boolean>((resolve) => {
        confirmAdmission = resolve;
      });
      const encode = (type: string, payload: unknown) => {
        const body = Buffer.from(
          canonical({
            type,
            version: protocol,
            invocationId: invocation,
            peerId: 'host',
            sequence: sequence++,
            payloadBase64: Buffer.from(canonical(payload)).toString('base64'),
          }),
        );
        const frame = Buffer.alloc(4 + body.length);
        frame.writeUInt32LE(body.length);
        body.copy(frame, 4);
        return frame;
      };
      const maximum = options.maxQueuedBytes ?? 256 * 1024;
      const state: State = {
        queue: [],
        bytes: 0,
        gaps: new Map(),
        observed: false,
        ended: false,
        cancel,
      };
      const abort = () => {
        void cancel();
      };
      const enqueue = (event: JobEvent) => {
        const bytes = event.type === 'output' ? Buffer.byteLength(event.content) : 0;
        if (bytes && state.bytes + bytes > maximum) {
          const stream = (event as JobEvent & { type: 'output' }).stream;
          const previous = state.gaps.get(stream);
          if (previous) previous.bytes = String(BigInt(previous.bytes) + BigInt(bytes));
          else {
            const gap: JobEvent & { type: 'output_dropped' } = {
              type: 'output_dropped',
              stream,
              bytes: String(bytes),
            };
            state.gaps.set(stream, gap);
            state.queue.push({ event: gap, bytes: 0 });
          }
        } else {
          if (event.type === 'output') state.gaps.delete(event.stream);
          state.queue.push({ event, bytes });
          state.bytes += bytes;
        }
        state.wake?.();
        state.wake = undefined;
      };
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
      const strictDecoders = trusted
        ? {
            stdout: new TextDecoder('utf-8', { fatal: true }),
            stderr: new TextDecoder('utf-8', { fatal: true }),
          }
        : undefined;
      let outputInvalid = false;
      // Admission has the same finite startup window as the other host backends.
      // A late READY must never release a request after that window has closed.
      const startupTimer = setTimeout(() => {
        protocolFailed = true;
        void owner.stop({ graceMs: 0 }).catch(() => {});
      }, 5000);
      let lookupOutput = '';
      const protocolReader = (async () => {
        let pending = Buffer.alloc(0);
        for await (const chunk of owner.stdout) {
          pending = Buffer.concat([pending, chunk]);
          while (pending.length >= 4) {
            const length = pending.readUInt32LE();
            if (length < 1 || length > maximumFrame) throw Error('windows_shell_frame_invalid');
            if (pending.length < 4 + length) break;
            const frameBytes = pending.subarray(4, 4 + length);
            const frame = JSON.parse(
              trusted
                ? new TextDecoder('utf-8', { fatal: true }).decode(frameBytes)
                : frameBytes.toString('utf8'),
            );
            pending = pending.subarray(4 + length);
            if (
              frame.version !== protocol ||
              frame.invocationId !== invocation ||
              frame.peerId !== 'runner' ||
              frame.sequence !== expected++ ||
              typeof frame.payloadBase64 !== 'string' ||
              terminal
            )
              throw Error('windows_shell_frame_invalid');
            const payloadBytes = Buffer.from(frame.payloadBase64, 'base64');
            const payload = JSON.parse(
              trusted
                ? new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes)
                : payloadBytes.toString('utf8'),
            );
            if (!ready) {
              if (
                frame.type !== 'ready' ||
                payload.invocationName !== invocation ||
                payload.runtimeValidated !== true
              )
                throw Error('windows_shell_ready_invalid');
              ready = true;
              clearTimeout(startupTimer);
              // Only the original live owner can release this request; a cancelled start never executes.
              if (!protocolFailed && !context.signal.aborted && !cancelRequested) {
                released = true;
                await owner.writeStdin(
                  encode('go', { invocationName: invocation, supervisorAcknowledged: true }),
                );
                confirmAdmission(true);
              }
            } else if (frame.type === 'stdout' || frame.type === 'stderr') {
              if (typeof payload.data !== 'string') throw Error('windows_shell_output_invalid');
              const stream = frame.type as 'stdout' | 'stderr';
              const bytes = Buffer.from(payload.data, 'base64');
              let content = '';
              try {
                if (!outputInvalid)
                  content = strictDecoders
                    ? strictDecoders[stream].decode(bytes, { stream: true })
                    : decoders[stream].write(bytes);
              } catch {
                outputInvalid = true;
                void cancel().catch(() => {});
              }
              if (content) {
                if (stream === 'stderr' && !trusted)
                  lookupOutput = (lookupOutput + content.slice(-lookupOutputLimit)).slice(
                    -lookupOutputLimit,
                  );
                enqueue({ type: 'output', stream: frame.type, content });
              }
            } else if (frame.type === 'exit') {
              if (
                payload.version !== protocol ||
                payload.invocationName !== invocation ||
                !Number.isInteger(payload.exitCode) ||
                typeof payload.cleanupConfirmed !== 'boolean' ||
                typeof payload.cancelled !== 'boolean'
              )
                throw Error('windows_shell_exit_invalid');
              terminal = payload;
            } else throw Error('windows_shell_frame_invalid');
          }
        }
        if (pending.length) throw Error('windows_shell_frame_incomplete');
      })().catch(() => {
        protocolFailed = true;
        void owner.stop({ graceMs: 0 }).catch(() => {});
      });
      // Never interpret diagnostics as command output or as a completion proof.
      const diagnostics = readNativeCleanup(owner.stderr).catch(() => undefined);
      void owner.exited.finally(() => clearTimeout(startupTimer)).catch(() => {});
      const done = (async () => {
        const code = await owner.exited;
        const [, nativeCleanup] = await Promise.all([protocolReader, diagnostics]);
        let evidence = await owner.stop({ graceMs: 0 });
        let confirmed =
          evidence.job.treeStopped &&
          !protocolFailed &&
          // Before GO, the pinned runner only validates assets. The original
          // process wait and empty owned Job prove cancellation without user
          // dispatch, even when its GO read exits on our stdin EOF.
          ((!released && cancelRequested) ||
            (code === 0 && terminal?.cleanupConfirmed === true && terminal.version === protocol));
        if (confirmed) {
          try {
            await owner.close();
            evidence = owner.readEvidence();
            if (!evidence.closed || evidence.closeUnknown)
              throw Error('windows_shell_close_unconfirmed');
            await cleanup();
          } catch {
            confirmed = false;
          }
        }
        state.ended = confirmed;
        for (const stream of ['stdout', 'stderr'] as const) {
          try {
            const content = strictDecoders
              ? strictDecoders[stream].decode()
              : decoders[stream].end();
            if (content) enqueue({ type: 'output', stream, content });
          } catch {
            outputInvalid = true;
          }
        }
        const commandLookup =
          released &&
          confirmed &&
          !trusted &&
          !outputInvalid &&
          !context.signal.aborted &&
          terminal &&
          terminal.error !== 'process_exit_status_unconfirmed' &&
          !terminal.cancelled
            ? windowsCommandLookup(
                {
                  stderr: lookupOutput,
                  powerShell: !!powerShell,
                  command,
                  exitCode: terminal.exitCode as number,
                  emptyStdout: terminal.stdoutBytes === 0,
                },
                env,
              )
            : undefined;
        const result: ToolResult = {
          outcome: !confirmed
            ? 'outcome_unknown'
            : outputInvalid
              ? 'failed'
              : terminal?.cancelled || (!released && cancelRequested)
                ? 'cancelled'
                : terminal?.exitCode === 0
                  ? 'succeeded'
                  : 'failed',
          content: !confirmed
            ? 'windows_shell_cleanup_unconfirmed'
            : outputInvalid
              ? 'shell_output_invalid_utf8'
              : released
                ? 'Shell completed'
                : 'windows_shell_not_dispatched',
          details: {
            exitCode:
              terminal?.error === 'process_exit_status_unconfirmed'
                ? null
                : ((terminal?.exitCode ?? code) as Json),
            cleanupConfirmed: confirmed,
            processTreeStopped: evidence.job.treeStopped,
            ownedProcesses: evidence as unknown as Json,
            ...(released && nativeCleanup ? { nativeCleanup } : {}),
            ...(commandLookup ? { commandLookup } : {}),
          },
        };
        enqueue({ type: 'terminal', result, supervision: confirmed ? 'ended' : 'unknown' });
        if (confirmed) context.signal.removeEventListener('abort', abort);
      })()
        .catch(() => {
          enqueue({
            type: 'terminal',
            result: { outcome: 'outcome_unknown', content: 'windows_shell_cleanup_unconfirmed' },
            supervision: 'unknown',
          });
        })
        .finally(() => confirmAdmission(false));
      function cancel(): Promise<StopConfirmation> {
        if (stopping) return stopping;
        stopping = (async () => {
          if (state.ended) return { status: 'already_finished' };
          cancelRequested = true;
          try {
            if (released) await owner.writeStdin(encode('cancel', {}));
            else await owner.endStdin();
          } catch {}
          const timer = setTimeout(() => {
            void owner.stop({ graceMs: 0 });
          }, 3000);
          try {
            await done;
          } finally {
            clearTimeout(timer);
          }
          return { status: state.ended ? 'stopped' : 'unknown' };
        })();
        return stopping;
      }
      context.signal.addEventListener('abort', abort, { once: true });
      if (context.signal.aborted) abort();
      try {
        await owner.writeStdin(encode('request', request));
      } catch {
        await owner.stop({ graceMs: 0 });
      }
      const handle: JobHandle = {
        reference: {
          nonce: invocation,
          executionId: context.executionId,
          supervisorPid: owner.pid,
          confinement: {
            backend:
              scope.filesystem === 'full_access'
                ? 'windows-full-job'
                : 'windows-restricted-token-job',
            filesystem: scope.filesystem,
            network: scope.network,
          },
        },
      };
      states.set(handle, state);
      if (!(await admission)) throw new JobStartError(handle);
      return handle;
    },
    async *observe(handle) {
      const state = get(handle);
      if (state.observed) throw Error('shell_observer_already_attached');
      state.observed = true;
      for (;;) {
        if (!state.queue.length)
          await new Promise<void>((resolve) => {
            state.wake = resolve;
          });
        const item = state.queue.shift();
        if (!item) continue;
        state.bytes -= item.bytes;
        if (
          item.event.type === 'output_dropped' &&
          state.gaps.get(item.event.stream) === item.event
        )
          state.gaps.delete(item.event.stream);
        yield item.event;
        if (item.event.type === 'terminal') return;
      }
    },
    cancel: (handle) => get(handle).cancel(),
    async dispose(handle) {
      const state = get(handle);
      await state.cancel();
      if (!state.ended) throw Error('windows_shell_cleanup_unconfirmed');
    },
  };
}
