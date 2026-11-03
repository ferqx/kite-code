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
import { launchIdentity, removeRuntimeTemp, verifyLaunchIdentities } from './launch-identity';
import { ripgrepAsset } from './ripgrep';
import type { HostShellExecutionScopeResolver } from './shell-scope';
import { captureWindowsGitBashRuntime, stageWindowsGitBash } from './windows-git-bash';

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const protocol = 6;
const maximumFrame = 16 * 1024 * 1024;
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

/** Installed assets only. Source callers must explicitly select their built fixture. */
export function windowsShellAssets(stateRoot: string) {
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
    manifest.runtime !== 'git-bash-restricted-token' ||
    Object.keys(manifest.files).sort().join(',') !==
      'coreutils.exe,kite-windows-runner.exe,ktipc.dll'
  )
    throw Error('windows_shell_asset_unavailable');
  for (const [file, hash] of Object.entries(manifest.files))
    if (digest(join(root, file)) !== hash) throw Error('windows_shell_asset_changed');
  return {
    runner: join(root, 'kite-windows-runner.exe'),
    ...stageWindowsGitBash(stateRoot, join(root, 'coreutils.exe'), join(root, 'ktipc.dll')),
  };
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
export interface WindowsShellOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  supervisorPath: string;
  shellExecutable: string;
  fullShellExecutable: string;
  coreutilsPath: string;
  stateRoot: string;
  controlBase: string;
  executionScope: HostShellExecutionScopeResolver;
  maxQueuedBytes?: number;
}
/** Live native Job/HANDLE owner; durable references never reconstruct a process from a PID. */
export function createWindowsShellJob(input: WindowsShellOptions): JobDefinition {
  const options = { ...input, env: { ...input.env } };
  if (
    process.platform !== 'win32' ||
    process.arch !== 'x64' ||
    !process.versions.bun ||
    ![
      options.cwd,
      options.supervisorPath,
      options.shellExecutable,
      options.fullShellExecutable,
      options.coreutilsPath,
      options.stateRoot,
      options.controlBase,
    ].every(isAbsolute)
  )
    throw Error('windows_shell_unqualified');
  const assets = [
    options.supervisorPath,
    options.shellExecutable,
    options.coreutilsPath,
    options.fullShellExecutable,
    join(dirname(options.fullShellExecutable), 'coreutils.exe'),
  ].map((path) => launchIdentity(path, true));
  const roots = [options.cwd, options.controlBase].map((path) => launchIdentity(path));
  const verifyRuntime = captureWindowsGitBashRuntime(
    options.shellExecutable,
    options.fullShellExecutable,
  );
  const states = new WeakMap<JobHandle, State>();
  const get = (handle: JobHandle) => {
    const state = states.get(handle);
    if (!state) throw Error('unknown_shell_handle');
    return state;
  };
  return {
    id: 'shell.command',
    version: '1',
    description:
      'Git Bash with unelevated write-restricted filesystem access and owned Job supervision',
    resources: { slot: 'process' },
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', minLength: 1, maxLength: 262144 } },
      required: ['command'],
      additionalProperties: false,
    },
    async start(value, context: JobContext) {
      const { scope, shell, coreutils, searchDirectory, command } = (() => {
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
          verifyLaunchIdentities([...assets, ...roots]);
          const scope = options.executionScope(context);
          verifyRuntime(scope.filesystem === 'full_access');
          const shell = scope.filesystem === 'full_access' ? assets[3]! : assets[1]!;
          const coreutils = scope.filesystem === 'full_access' ? assets[4]! : assets[2]!;
          if (basename(shell.canonical).toLowerCase() !== 'bash.exe')
            throw Error('windows_git_bash_required');
          const searchDirectory = dirname(ripgrepAsset());
          return { scope, shell, coreutils, searchDirectory, command: value.command };
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
      const cleanup = () => removeRuntimeTemp(tempIdentity);
      const env = { ...options.env };
      Object.assign(env, {
        TEMP: temp,
        TMP: temp,
        HOME: env.HOME ?? env.USERPROFILE ?? temp,
        PATH: [
          searchDirectory,
          join(temp, 'kite-coreutils'),
          dirname(shell.canonical),
          join(dirname(shell.canonical), '../../mingw64/bin'),
          env.PATH ?? '',
        ].join(';'),
      });
      delete env.BASH_ENV;
      delete env.ENV;
      env.TMPDIR = temp.replaceAll('\\', '/');
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
        for (const [key, value] of Object.entries(defaults))
          if (!Object.keys(env).some((name) => name.toUpperCase() === key)) env[key] = value;
      }
      const request = {
        version: protocol,
        directWorkspace: {
          runtimeCapabilitySid: capabilitySid(),
          ...(scope.filesystem === 'full_access'
            ? { approvedFilesystemGuardSid: capabilitySid() }
            : {}),
        },
        invocationName: invocation,
        commandLine: command,
        cwd: options.cwd,
        env,
        filesystemScope: scope.filesystem,
        workspaceRoot: options.cwd,
        runtimeRoot: temp,
        shellRuntimeRoot: dirname(shell.canonical),
        shellRuntime: 'bash',
        shellRuntimeDigest: `sha256:${shell.digest}`,
        coreutilsDigest: `sha256:${coreutils.digest}`,
        maxProcesses: 64,
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
        cleanup();
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
      // Admission has the same finite startup window as the other host backends.
      // A late READY must never release a request after that window has closed.
      const startupTimer = setTimeout(() => {
        protocolFailed = true;
        void owner.stop({ graceMs: 0 }).catch(() => {});
      }, 5000);
      const protocolReader = (async () => {
        let pending = Buffer.alloc(0);
        for await (const chunk of owner.stdout) {
          pending = Buffer.concat([pending, chunk]);
          while (pending.length >= 4) {
            const length = pending.readUInt32LE();
            if (length < 1 || length > maximumFrame) throw Error('windows_shell_frame_invalid');
            if (pending.length < 4 + length) break;
            const frame = JSON.parse(pending.subarray(4, 4 + length).toString('utf8'));
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
            const payload = JSON.parse(Buffer.from(frame.payloadBase64, 'base64').toString('utf8'));
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
              const content = decoders[frame.type as 'stdout' | 'stderr'].write(
                Buffer.from(payload.data, 'base64'),
              );
              if (content) enqueue({ type: 'output', stream: frame.type, content });
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
      // Native diagnostics are not command output; drain without exposing private paths.
      const diagnostics = (async () => {
        for await (const _ of owner.stderr) {
        }
      })();
      void owner.exited.finally(() => clearTimeout(startupTimer)).catch(() => {});
      const done = (async () => {
        const code = await owner.exited;
        await Promise.all([protocolReader, diagnostics]);
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
            cleanup();
          } catch {
            confirmed = false;
          }
        }
        state.ended = confirmed;
        for (const stream of ['stdout', 'stderr'] as const) {
          const content = decoders[stream].end();
          if (content) enqueue({ type: 'output', stream, content });
        }
        const result: ToolResult = {
          outcome: !confirmed
            ? 'outcome_unknown'
            : terminal?.cancelled || (!released && cancelRequested)
              ? 'cancelled'
              : terminal?.exitCode === 0
                ? 'succeeded'
                : 'failed',
          content: !confirmed
            ? 'windows_shell_cleanup_unconfirmed'
            : released
              ? 'Shell completed'
              : 'windows_shell_not_dispatched',
          details: {
            exitCode: (terminal?.exitCode ?? code) as Json,
            cleanupConfirmed: confirmed,
            processTreeStopped: evidence.job.treeStopped,
            ownedProcesses: evidence as unknown as Json,
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
