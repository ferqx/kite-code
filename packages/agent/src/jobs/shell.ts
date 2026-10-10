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
import { ownedProcessKernelState } from '../platform/process/owned-process-observation';
import {
  type ConfinedLaunch,
  type ConfinedPaths,
  captureConfinedLaunch,
} from './confined-preparation';
import { captureMacosHostLaunch, type MacosHostPaths } from './host-preparation';
import type { LinuxPaths } from './linux-preparation';
import { createLinuxShellJob } from './linux-shell';

import {
  copyShellProcessEvidence,
  decodeMacosShellProcessEvidence as decodeShellProcessEvidence,
  type MacosShellProcessEvidence as ShellProcessEvidence,
  shellProcessEvidenceEnded,
} from './shell-process-evidence';

export type { MacosHostPaths } from './host-preparation';

export {
  decodeLinuxShellProcessEvidence,
  type LinuxShellProcessEvidence,
} from './linux-shell-process-evidence';
export {
  decodeMacosShellProcessEvidence,
  decodeShellProcessEvidence,
  type MacosShellProcessEvidence,
  type ShellProcessEvidence,
  shellProcessEvidenceEnded,
} from './shell-process-evidence';

export interface ShellJobOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly supervisorPath?: string;
  readonly bunExecutable?: string;
  readonly shellExecutable?: string;
  readonly maxQueuedBytes?: number;
  readonly graceMs?: number;
  /** Trusted Linux namespace assets, never command input or a source fallback. */
  readonly linux?: { readonly bubblewrapPath: string; readonly initExecutable: string };
  /** Trusted macOS host only; never supplied by the command input. */
  readonly supervision?: { readonly kind: 'macos-launchd-coalition'; readonly controlBase: string };
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
  coalitionId?: string;
  evidence?: ShellProcessEvidence;
  readyEvidence?: ShellProcessEvidence;
  pendingTerminal?: ToolResult;
  terminalTimer?: ReturnType<typeof setTimeout>;
  brokerExit?: { code: number | null; signal: string | null; reaped: true };
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
export function linuxShellInitAsset(): string {
  if (!import.meta.url.endsWith('.js')) throw Error('linux_shell_init_asset_unavailable');
  const path = fileURLToPath(new URL('../platform/process/linux-shell-init', import.meta.url));
  if (!existsSync(path)) throw Error('linux_shell_init_asset_unavailable');
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

/** macOS host tools, inherited Seatbelt scope and a fresh launchd-owned descendant coalition. */
export function createMacosHostShellJob(options: ShellJobOptions & MacosHostPaths): JobDefinition {
  const supervisor = options.supervisorPath ?? shellSupervisorAsset();
  const prepare = captureMacosHostLaunch(options, [
    supervisor,
    options.bunExecutable ?? process.execPath,
    options.shellExecutable ?? '/bin/sh',
  ]);
  return shellJob(
    {
      ...options,
      supervision: { kind: 'macos-launchd-coalition', controlBase: options.controlBase },
    },
    prepare,
  );
}

export function createLinuxHostShellJob(
  options: ShellJobOptions & Omit<LinuxPaths, 'mode'>,
): JobDefinition {
  return createLinuxShellJob({
    ...options,
    initExecutable: options.linux?.initExecutable ?? linuxShellInitAsset(),
    mode: 'host',
  });
}

/** Fixed compensation confinement; unavailable namespace/sealing never falls back. */
export function createLinuxConfinedShellJob(
  options: ShellJobOptions & ConfinedPaths & { readonly bubblewrapPath: string },
): JobDefinition {
  return createLinuxShellJob({
    ...options,
    initExecutable: options.linux?.initExecutable ?? linuxShellInitAsset(),
    mode: 'confined',
    filesystemScope: 'workspace_write',
  });
}

function shellJob(
  options: ShellJobOptions,
  prepare?: (command: string, shell: string, context: JobContext) => ConfinedLaunch,
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
    (configuration.supervision &&
      (process.platform !== 'darwin' ||
        configuration.supervision.kind !== 'macos-launchd-coalition' ||
        !isAbsolute(configuration.supervision.controlBase))) ||
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
    if (state.terminalTimer) clearTimeout(state.terminalTimer);
    state.terminalTimer = undefined;
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
    const brokerExited = state.process.exitCode !== null || state.process.signalCode !== null;
    if (brokerExited && !(configuration.supervision && state.readyEvidence))
      return { status: 'unknown', details: { processGroupId: state.groupId ?? null } };
    if (state.stopping) return state.stopping;
    state.stopping = (async () => {
      if (!brokerExited && !state.pendingTerminal && state.process.stdin?.writable)
        state.process.stdin.write(`${JSON.stringify({ type: 'cancel', nonce: state.nonce })}\n`);
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
      const confined = prepare?.(value.command, shell, context);
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
            ...(confined.preserveHostHome ? {} : { HOME: confined.temp }),
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
              if (configuration.supervision) {
                if (
                  typeof frame.coalitionId !== 'string' ||
                  !/^[1-9][0-9]{0,19}$/.test(frame.coalitionId) ||
                  BigInt(frame.coalitionId) > 18446744073709551615n
                )
                  throw Error('invalid_private_coalition');
                const evidence = decodeShellProcessEvidence(
                  {
                    version: 1,
                    coverage: 'shell-owned-coalition',
                    binding: frame.binding,
                    ownerPid: process.pid,
                    broker: { ...(frame.broker as object), exit: null, kernelState: 'unavailable' },
                    guardian: frame.guardian,
                    root: frame.nativeRoot,
                    coalition: {
                      id: frame.coalitionId,
                      guardianUniqueId: (frame.coalition as { uniqueId?: string })?.uniqueId,
                      guardianPidVersion: (frame.coalition as { pidVersion?: number })?.pidVersion,
                      claimTaskCount: 1,
                      terminalTaskCount: null,
                      processTreeStopped: false,
                      label: (frame.registration as { label?: string })?.label,
                      domain: (frame.registration as { domain?: string })?.domain,
                      registrationRemoved: false,
                    },
                  },
                  { sessionId: context.sessionId, executionId: context.executionId, nonce },
                  process.pid,
                );
                if (
                  !evidence ||
                  evidence.broker.pid !== proc.pid ||
                  evidence.guardian.pid !== frame.supervisorPid ||
                  evidence.root.identity.pid !== frame.processGroupId ||
                  (frame.coalition as { pid?: number })?.pid !== evidence.guardian.pid ||
                  (frame.coalition as { coalitionId?: string })?.coalitionId !==
                    frame.coalitionId ||
                  (frame.registration as { removed?: boolean })?.removed !== false
                )
                  throw Error('invalid_private_process_evidence');
                state.evidence = evidence;
                state.readyEvidence = evidence;
                state.coalitionId = frame.coalitionId;
              }
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
              if (configuration.supervision && state.pendingTerminal) continue;
              if (
                configuration.supervision &&
                frame.groupStopped &&
                frame.coalitionId !== state.coalitionId
              )
                throw Error('invalid_private_coalition');
              const result: ToolResult = {
                outcome: frame.outcome as ToolResult['outcome'],
                content: `Shell ${frame.outcome}`,
                details: {
                  exitCode: typeof frame.exitCode === 'number' ? frame.exitCode : null,
                  processGroupId: state.groupId ?? null,
                  groupStopped: frame.groupStopped,
                  forced: frame.forced === true,
                  ...(state.coalitionId
                    ? { coalitionId: state.coalitionId, processTreeStopped: frame.groupStopped }
                    : {}),
                },
              };
              if (configuration.supervision) {
                const original = state.evidence;
                const evidence =
                  original &&
                  decodeShellProcessEvidence(
                    {
                      ...original,
                      guardian: frame.guardian,
                      root: frame.nativeRoot,
                      coalition: {
                        ...original.coalition,
                        processTreeStopped: frame.processTreeStopped === true,
                        terminalTaskCount: frame.terminalTaskCount ?? null,
                        registrationRemoved: frame.registrationRemoved === true,
                      },
                    },
                    original.binding,
                    process.pid,
                  );
                if (
                  !evidence ||
                  frame.groupStopped !== evidence.coalition.processTreeStopped ||
                  JSON.stringify(evidence.root.identity) !==
                    JSON.stringify(original!.root.identity) ||
                  JSON.stringify(evidence.guardian.birth) !==
                    JSON.stringify(original!.guardian.birth) ||
                  evidence.guardian.pid !== original!.guardian.pid ||
                  JSON.stringify(frame.binding) !== JSON.stringify(original!.binding) ||
                  (frame.coalition as { uniqueId?: string })?.uniqueId !==
                    original!.coalition.guardianUniqueId ||
                  (frame.coalition as { pidVersion?: number })?.pidVersion !==
                    original!.coalition.guardianPidVersion ||
                  (frame.coalition as { coalitionId?: string })?.coalitionId !==
                    original!.coalition.id ||
                  (frame.registration as { label?: string })?.label !== original!.coalition.label ||
                  (frame.registration as { domain?: string })?.domain !==
                    original!.coalition.domain ||
                  (frame.registration as { removed?: boolean })?.removed !== true
                )
                  throw Error('invalid_private_process_evidence');
                state.evidence = evidence;
                state.pendingTerminal = result;
                state.terminalTimer ??= setTimeout(() => {
                  proc.stdin!.end();
                  finish(
                    state,
                    {
                      ...result,
                      details: {
                        ...(result.details as Record<string, Json>),
                        ownedProcesses: copyShellProcessEvidence(evidence) as unknown as Json,
                      },
                    },
                    false,
                  );
                }, grace + 4000);
              } else finish(state, result, frame.groupStopped);
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
      proc.once('exit', (code, signal) => {
        state.brokerExit = { code, signal, reaped: true };
      });
      proc.on('close', () => {
        if (configuration.supervision && state.pendingTerminal && state.evidence) {
          const snapshot = copyShellProcessEvidence({
            ...state.evidence,
            broker: {
              ...state.evidence.broker,
              exit: state.brokerExit ?? null,
              kernelState: ownedProcessKernelState(state.evidence.broker),
            },
          });
          const evidence = decodeShellProcessEvidence(
            snapshot,
            state.evidence.binding,
            process.pid,
          );
          finish(
            state,
            {
              ...state.pendingTerminal,
              details: {
                ...(state.pendingTerminal.details as Record<string, Json>),
                ...(evidence
                  ? { ownedProcesses: evidence as unknown as Json }
                  : { ownedProcessesUnavailable: 'shell_owned_process_evidence_unavailable' }),
              },
            },
            !!evidence && shellProcessEvidenceEnded(evidence),
          );
          return;
        }
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
          ...(configuration.supervision
            ? { sessionId: context.sessionId, executionId: context.executionId }
            : {}),
          executable: launch.executable,
          argv: launch.argv,
          identities: confined?.identities,
          runtimeTemp: confined?.runtimeTemp,
          profileDigest: confined?.profileDigest,
          cwd: launch.cwd,
          env: childEnv,
          graceMs: grace,
          ...(configuration.supervision
            ? {
                supervision: configuration.supervision.kind,
                controlBase: configuration.supervision.controlBase,
              }
            : {}),
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
          ...(state.readyEvidence
            ? {
                launchdGuardianPid: state.readyEvidence.guardian.pid,
                ownedProcesses: copyShellProcessEvidence(state.readyEvidence) as unknown as Json,
              }
            : {}),
          ...(state.coalitionId ? { coalitionId: state.coalitionId } : {}),
          executionId: context.executionId,
          ...(confined
            ? {
                confinement: {
                  backend: 'macos-seatbelt',
                  profileDigest: confined.profileDigest,
                  subprocesses: configuration.supervision ? 'coalition_owned' : 'denied',
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
