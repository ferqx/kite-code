import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  JobContext,
  JobDefinition,
  JobEvent,
  JobHandle,
  Json,
  StopConfirmation,
  ToolResult,
} from '@kite-ai/agent/extensions';
import { type ConfinedPaths, captureConfinedLaunch } from './confined-preparation';

export interface ShellJobOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly supervisorPath?: string;
  readonly bunExecutable?: string;
  readonly shellExecutable?: string;
  readonly maxQueuedBytes?: number;
  readonly graceMs?: number;
}
interface QueueItem {
  event: JobEvent;
  bytes: number;
}
interface State {
  nonce: string;
  process: ChildProcess;
  queue: QueueItem[];
  queuedBytes: number;
  gaps: Map<'stdout' | 'stderr', QueueItem>;
  wake?: () => void;
  observed: boolean;
  result?: ToolResult;
  groupStopped: boolean;
  groupId?: number;
  terminal: Promise<void>;
  stopped: Promise<void>;
  proveStop: () => void;
  settle: () => void;
  ready: Promise<void>;
  acknowledge: () => void;
  rejectReady: (error: Error) => void;
  stopping?: Promise<StopConfirmation>;
  disposed?: Promise<void>;
  signal: AbortSignal;
  aborted: () => void;
  cleanup?: () => void;
}

/** Built leaf resolves only the packaged guardian asset; source tests explicitly select a built asset. */
export function shellSupervisorAsset(): string {
  if (!import.meta.url.endsWith('.js')) throw new Error('shell_supervisor_asset_unavailable');
  const path = fileURLToPath(new URL('../platform/process/shell-supervisor.js', import.meta.url));
  if (!existsSync(path)) throw new Error('shell_supervisor_asset_unavailable');
  return path;
}
function object(value: Json): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_shell_input');
  return value;
}

/** Explicit assembly only. Factory/import never starts an external process. */
export function createShellJob(options: ShellJobOptions): JobDefinition {
  return shellJob(options);
}

/** Fixed macOS OS confinement; subprocess creation is denied, never silently unconfined. */
export function createMacosConfinedShellJob(
  options: ShellJobOptions & ConfinedPaths,
): JobDefinition {
  const supervisor = options.supervisorPath ?? shellSupervisorAsset();
  const bun = options.bunExecutable ?? process.execPath;
  const shell = options.shellExecutable ?? '/bin/sh';
  const prepare = captureConfinedLaunch(options, [supervisor, bun, shell]);
  return shellJob(options, prepare);
}

function shellJob(
  options: ShellJobOptions,
  prepare?: ReturnType<typeof captureConfinedLaunch>,
): JobDefinition {
  const configuration = { ...options, env: { ...options.env } };
  const maximum = configuration.maxQueuedBytes ?? 256 * 1024;
  const grace = configuration.graceMs ?? 200;
  if (
    !isAbsolute(configuration.cwd) ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1024 ||
    !Number.isSafeInteger(grace) ||
    grace < 0 ||
    grace > 5000 ||
    Object.values(configuration.env).some((value) => typeof value !== 'string')
  )
    throw new Error('invalid_shell_configuration');
  const states = new WeakMap<JobHandle, State>();
  function get(handle: JobHandle): State {
    const state = states.get(handle);
    if (!state) throw new Error('unknown_shell_handle');
    return state;
  }
  function enqueue(state: State, event: JobEvent): void {
    if (state.result && event.type !== 'terminal') return;
    if (event.type === 'output') {
      const bytes = Buffer.byteLength(event.content);
      if (!bytes) return;
      if (state.queuedBytes + bytes > maximum) {
        const existing = state.gaps.get(event.stream);
        if (existing && existing.event.type === 'output_dropped')
          existing.event.bytes = String(BigInt(existing.event.bytes) + BigInt(bytes));
        else {
          const item: QueueItem = {
            event: { type: 'output_dropped', stream: event.stream, bytes: String(bytes) },
            bytes: 0,
          };
          state.queue.push(item);
          state.gaps.set(event.stream, item);
        }
      } else {
        state.gaps.delete(event.stream);
        state.queue.push({ event, bytes });
        state.queuedBytes += bytes;
      }
    } else state.queue.push({ event, bytes: 0 });
    state.wake?.();
    state.wake = undefined;
  }
  function finish(state: State, result: ToolResult, groupStopped: boolean): void {
    if (groupStopped) {
      state.groupStopped = true;
      state.cleanup?.();
      state.cleanup = undefined;
      state.proveStop();
      state.signal.removeEventListener('abort', state.aborted);
    }
    if (state.result) return;
    if (!groupStopped) result = { ...result, outcome: 'outcome_unknown' };
    state.result = result;
    state.groupStopped = groupStopped;
    enqueue(state, { type: 'terminal', result, supervision: groupStopped ? 'ended' : 'unknown' });
    state.settle();
  }
  async function cancelState(state: State): Promise<StopConfirmation> {
    if (state.result && state.groupStopped)
      return {
        status: state.groupStopped ? 'already_finished' : 'unknown',
        details: { processGroupId: state.groupId ?? null },
      };
    if (state.process.exitCode !== null || state.process.signalCode !== null)
      return { status: 'unknown', details: { processGroupId: state.groupId ?? null } };
    if (state.stopping) return state.stopping;
    state.stopping = (async () => {
      state.process.stdin?.write(`${JSON.stringify({ type: 'cancel', nonce: state.nonce })}\n`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        state.stopped,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, grace + 4000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      return {
        status: state.result && state.groupStopped ? 'stopped' : 'unknown',
        details: {
          processGroupId: state.groupId ?? null,
          confirmedBySupervisor: state.groupStopped,
        },
      };
    })();
    return state.stopping;
  }
  return {
    id: 'shell.command',
    version: '1',
    description: 'POSIX shell process-group job with a private guardian',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', minLength: 1, maxLength: 262144 } },
      required: ['command'],
      additionalProperties: false,
    },
    resources: { slot: 'process' },
    async start(input: Json, context: JobContext): Promise<JobHandle> {
      if (process.platform !== 'darwin' && process.platform !== 'linux')
        throw new Error('shell_platform_unsupported');
      context.signal.throwIfAborted();
      const value = object(input);
      if (
        typeof value.command !== 'string' ||
        !value.command ||
        value.command.length > 262144 ||
        Object.keys(value).some((key) => key !== 'command')
      )
        throw new Error('invalid_shell_input');
      const supervisor = configuration.supervisorPath ?? shellSupervisorAsset();
      const bun = configuration.bunExecutable ?? process.execPath;
      const shell = configuration.shellExecutable ?? '/bin/sh';
      if (![supervisor, bun, shell].every((path) => isAbsolute(path) && existsSync(path)))
        throw new Error('shell_supervisor_asset_unavailable');
      const confined = prepare?.(value.command, shell);
      const launch = confined ?? {
        executable: shell,
        argv: ['-c', value.command],
        cwd: configuration.cwd,
      };
      const env = confined
        ? Object.fromEntries(
            Object.entries(configuration.env).filter(
              ([key]) =>
                !/^(?:DYLD_|LD_|BASH_ENV$|ENV$|ZDOTDIR$|NODE_OPTIONS$|BUN_OPTIONS$)/.test(key),
            ),
          )
        : configuration.env;
      const childEnv = confined
        ? {
            ...env,
            HOME: confined.temp,
            TMPDIR: confined.temp,
            TMP: confined.temp,
            TEMP: confined.temp,
          }
        : env;
      const proc = spawn(bun, [supervisor], {
        cwd: configuration.cwd,
        env: configuration.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let settle!: () => void;
      let proveStop!: () => void;
      let acknowledge!: () => void;
      let rejectReady!: (error: Error) => void;
      const nonce = crypto.randomUUID();
      const state: State = {
        nonce,
        process: proc,
        cleanup: confined?.cleanup,
        queue: [],
        queuedBytes: 0,
        gaps: new Map(),
        observed: false,
        groupStopped: false,
        terminal: new Promise((resolve) => {
          settle = resolve;
        }),
        settle: () => settle(),
        stopped: new Promise((resolve) => {
          proveStop = resolve;
        }),
        proveStop: () => proveStop(),
        ready: new Promise((resolve, reject) => {
          acknowledge = resolve;
          rejectReady = reject;
        }),
        acknowledge: () => acknowledge(),
        rejectReady: (error) => rejectReady(error),
        signal: context.signal,
        aborted: () => {
          void cancelState(state);
        },
      };
      context.signal.addEventListener('abort', state.aborted, { once: true });
      let buffer = '';
      proc.stdin!.on('error', () => {
        finish(
          state,
          { outcome: 'outcome_unknown', content: 'Shell supervisor control disconnected' },
          false,
        );
        state.rejectReady(new Error('shell_supervisor_disconnected'));
      });
      proc.stdout!.setEncoding('utf8');
      proc.stdout!.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 512 * 1024) {
          buffer = '';
          proc.stdin!.end();
          finish(
            state,
            { outcome: 'outcome_unknown', content: 'Shell supervisor output exceeded frame limit' },
            false,
          );
          return;
        }
        while (buffer.includes('\n')) {
          const boundary = buffer.indexOf('\n');
          const line = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 1);
          try {
            const frame = JSON.parse(line) as Record<string, unknown>;
            if (frame.nonce !== nonce) throw new Error('invalid_private_identity');
            if (
              frame.type === 'ready' &&
              Number.isSafeInteger(frame.processGroupId) &&
              Number(frame.processGroupId) > 1
            ) {
              state.groupId = Number(frame.processGroupId);
              state.acknowledge();
            } else if (
              frame.type === 'output' &&
              ['stdout', 'stderr'].includes(String(frame.stream)) &&
              typeof frame.content === 'string' &&
              Buffer.byteLength(frame.content) <= 32 * 1024
            )
              enqueue(state, {
                type: 'output',
                stream: frame.stream as 'stdout' | 'stderr',
                content: frame.content,
              });
            else if (
              frame.type === 'terminal' &&
              ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(
                String(frame.outcome),
              ) &&
              typeof frame.groupStopped === 'boolean'
            ) {
              finish(
                state,
                {
                  outcome: frame.outcome as ToolResult['outcome'],
                  content: `Shell ${frame.outcome}`,
                  details: {
                    exitCode: typeof frame.exitCode === 'number' ? frame.exitCode : null,
                    processGroupId: state.groupId ?? null,
                    groupStopped: frame.groupStopped,
                    forced: frame.forced === true,
                  },
                },
                frame.groupStopped,
              );
              state.acknowledge();
            } else throw new Error('invalid_private_frame');
          } catch {
            proc.stdin!.end();
            finish(
              state,
              { outcome: 'outcome_unknown', content: 'Shell supervisor protocol invalid' },
              false,
            );
            state.rejectReady(new Error('shell_supervisor_protocol_invalid'));
          }
        }
      });
      // Internal diagnostics are bounded by immediate draining; they are not business output.
      proc.stderr!.resume();
      proc.on('error', () => {
        finish(state, { outcome: 'outcome_unknown', content: 'Shell supervisor failed' }, false);
        state.rejectReady(new Error('shell_supervisor_failed'));
      });
      proc.on('close', () => {
        finish(
          state,
          { outcome: 'outcome_unknown', content: 'Shell supervisor ended without confirmation' },
          false,
        );
        state.rejectReady(new Error('shell_supervisor_disconnected'));
      });
      proc.stdin!.write(
        `${JSON.stringify({
          type: 'start',
          nonce,
          executable: launch.executable,
          argv: launch.argv,
          identities: confined?.identities,
          runtimeTemp: confined?.runtimeTemp,
          profileDigest: confined?.profileDigest,
          cwd: launch.cwd,
          env: childEnv,
          graceMs: grace,
        })}\n`,
      );
      const timer = setTimeout(() => {
        proc.stdin!.end();
        state.rejectReady(new Error('shell_supervisor_start_timeout'));
      }, 5000);
      try {
        await state.ready;
      } catch (error) {
        proc.stdin!.end();
        throw error;
      } finally {
        clearTimeout(timer);
      }
      const handle: JobHandle = {
        reference: {
          nonce,
          processGroupId: state.groupId ?? null,
          supervisorPid: proc.pid ?? null,
          executionId: context.executionId,
          ...(confined
            ? {
                confinement: {
                  backend: 'macos-seatbelt',
                  profileDigest: confined.profileDigest,
                  subprocesses: 'denied',
                },
              }
            : {}),
        },
      };
      states.set(handle, state);
      return handle;
    },
    async *observe(handle: JobHandle): AsyncIterable<JobEvent> {
      const state = get(handle);
      if (state.observed) throw new Error('shell_observer_already_attached');
      state.observed = true;
      while (true) {
        if (!state.queue.length)
          await new Promise<void>((resolve) => {
            state.wake = resolve;
          });
        const item = state.queue.shift();
        if (!item) continue;
        state.queuedBytes -= item.bytes;
        if (item.event.type === 'output_dropped' && state.gaps.get(item.event.stream) === item)
          state.gaps.delete(item.event.stream);
        yield item.event;
        if (item.event.type === 'terminal') return;
      }
    },
    async cancel(handle) {
      return cancelState(get(handle));
    },
    async dispose(handle) {
      const state = get(handle);
      if (state.disposed) return state.disposed;
      state.disposed = (async () => {
        await cancelState(state);
        state.process.stdin?.end();
        state.signal.removeEventListener('abort', state.aborted);
        state.queue = state.queue.filter((item) => item.event.type === 'terminal');
        state.queuedBytes = 0;
        state.gaps.clear();
      })();
      return state.disposed;
    },
  };
}
