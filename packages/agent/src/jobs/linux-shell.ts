import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type {
  JobContext,
  JobDefinition,
  JobEvent,
  JobHandle,
  Json,
  StopConfirmation,
  ToolResult,
} from '../extensions';
import {
  type LinuxOwnedShell,
  type LinuxOwnedShellCompletion,
  LinuxOwnedShellStartError,
  startLinuxOwnedShell,
} from '../platform/process/linux-owned-shell';
import {
  captureLinuxLaunch,
  type LinuxLaunch,
  type LinuxPaths,
  LinuxPreparationCleanupError,
} from './linux-preparation';
import {
  copyLinuxShellProcessEvidence,
  decodeLinuxShellProcessEvidence,
  type LinuxShellProcessEvidence,
  linuxShellProcessEvidenceEnded,
} from './linux-shell-process-evidence';
import type { ShellJobOptions } from './shell';

interface State {
  owner: LinuxOwnedShell;
  binding: LinuxShellProcessEvidence['binding'];
  queue: { event: JobEvent; bytes: number }[];
  queuedBytes: number;
  gaps: Map<'stdout' | 'stderr', JobEvent & { type: 'output_dropped' }>;
  wake?: () => void;
  observed: boolean;
  result?: ToolResult;
  ended: boolean;
  cleanupUnknown: boolean;
  cleanup(): void;
  signal: AbortSignal;
  aborted(): void;
  disposed?: Promise<void>;
}
/** Host assembly only. The ordinary Job owns actual native objects, never a cold PID. */
export function createLinuxShellJob(
  options: ShellJobOptions & LinuxPaths & { readonly initExecutable: string },
): JobDefinition {
  const configuration = { ...options, env: { ...options.env } };
  const maximum = configuration.maxQueuedBytes ?? 256 * 1024;
  const grace = configuration.graceMs ?? 200;
  const shell = configuration.shellExecutable ?? '/bin/sh';
  const binaries = [
    configuration.initExecutable,
    configuration.bunExecutable ?? process.execPath,
    shell,
  ];
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1024 ||
    !Number.isSafeInteger(grace) ||
    grace < 0 ||
    grace > 5000 ||
    ![configuration.cwd, configuration.bubblewrapPath, ...binaries].every(isAbsolute) ||
    Object.values(configuration.env).some((value) => typeof value !== 'string')
  )
    throw Error('invalid_shell_configuration');
  const prepare = captureLinuxLaunch(configuration, binaries);
  const states = new WeakMap<JobHandle, State>();
  const get = (handle: JobHandle) => {
    const state = states.get(handle);
    if (!state) throw Error('unknown_shell_handle');
    return state;
  };
  const evidence = (state: State) =>
    decodeLinuxShellProcessEvidence(
      {
        version: 2,
        coverage: 'shell-owned-pid-namespace',
        binding: state.binding,
        owner: state.owner.readProcessEvidence(),
      },
      state.binding,
      process.pid,
    );
  const enqueue = (state: State, event: JobEvent) => {
    if (state.result && event.type !== 'terminal') return;
    if (event.type === 'output') {
      const bytes = Buffer.byteLength(event.content);
      if (!bytes) return;
      if (state.queuedBytes + bytes > maximum) {
        const gap = state.gaps.get(event.stream);
        if (gap) gap.bytes = String(BigInt(gap.bytes) + BigInt(bytes));
        else {
          const dropped: JobEvent & { type: 'output_dropped' } = {
            type: 'output_dropped',
            stream: event.stream,
            bytes: String(bytes),
          };
          state.queue.push({ event: dropped, bytes: 0 });
          state.gaps.set(event.stream, dropped);
        }
      } else {
        state.gaps.delete(event.stream);
        state.queue.push({ event, bytes });
        state.queuedBytes += bytes;
      }
    } else state.queue.push({ event, bytes: 0 });
    state.wake?.();
    state.wake = undefined;
  };
  const complete = (state: State, receipt: LinuxOwnedShellCompletion, cleanup: () => void) => {
    if (state.result) return;
    const facts = evidence(state);
    let ended = receipt.confirmed && !!facts && linuxShellProcessEvidenceEnded(facts);
    if (ended) {
      try {
        cleanup();
      } catch {
        state.cleanupUnknown = true;
        ended = false;
      }
    }
    state.ended = ended;
    state.result = {
      outcome: !ended
        ? 'outcome_unknown'
        : receipt.reason === 'cancel'
          ? 'cancelled'
          : receipt.code === 0
            ? 'succeeded'
            : 'failed',
      content: !ended ? 'shell_owned_cleanup_unconfirmed' : 'Shell completed',
      details: {
        exitCode: receipt.code,
        signal: receipt.signal,
        processTreeStopped: receipt.confirmed,
        cleanupConfirmed: ended,
        ...(facts
          ? { ownedProcesses: copyLinuxShellProcessEvidence(facts) as unknown as Json }
          : { ownedProcessesUnavailable: 'shell_owned_process_evidence_unavailable' }),
      },
    };
    enqueue(state, {
      type: 'terminal',
      result: state.result,
      supervision: ended ? 'ended' : 'unknown',
    });
    if (ended) state.signal.removeEventListener('abort', state.aborted);
  };
  const cancel = async (state: State): Promise<StopConfirmation> => {
    if (state.ended) return { status: 'already_finished' };
    await state.owner.cancel();
    // completion's callback runs before this continuation and includes temp cleanup.
    return { status: state.ended ? 'stopped' : 'unknown' };
  };
  return {
    id: 'shell.command',
    version: '1',
    description: 'Shell with an owned Linux PID namespace and fixed host confinement',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: { command: { type: 'string', minLength: 1, maxLength: 262144 } },
    },
    resources: { slot: 'process' },
    async start(input, context: JobContext) {
      context.signal.throwIfAborted();
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).join(',') !== 'command' ||
        typeof input.command !== 'string' ||
        !input.command ||
        input.command.length > 262144
      )
        throw Error('invalid_shell_input');
      let launch: LinuxLaunch;
      let preparationFailure: LinuxPreparationCleanupError | undefined;
      try {
        launch = prepare(input.command, shell, context);
      } catch (error) {
        if (!(error instanceof LinuxPreparationCleanupError)) throw error;
        launch = error.launch;
        preparationFailure = error;
      }
      const env = Object.fromEntries(
        Object.entries(configuration.env).filter(
          ([key]) => !/^(?:DYLD_|LD_|BASH_ENV$|ENV$|ZDOTDIR$|NODE_OPTIONS$|BUN_OPTIONS$)/.test(key),
        ),
      );
      const nonce = crypto.randomUUID();
      const owner = (() => {
        if (preparationFailure)
          return new LinuxOwnedShellStartError(
            preparationFailure.cause,
            preparationFailure.cleanupError,
            { nonce, mode: launch.mode },
          ).cleanup;
        try {
          return startLinuxOwnedShell({
            bubblewrapPath: launch.bubblewrapPath,
            bubblewrapArgs: launch.bubblewrapArgs,
            initExecutable: launch.executablePaths[0]!,
            shellExecutable: launch.executablePaths[2]!,
            command: input.command,
            cwd: launch.cwd,
            env: {
              ...env,
              ...(launch.preserveHostHome ? {} : { HOME: launch.temp }),
              TMPDIR: launch.temp,
              TMP: launch.temp,
              TEMP: launch.temp,
            },
            nonce,
            graceMs: grace,
            temp: launch.temp,
            mode: launch.mode,
            noExecPaths: launch.noExecPaths,
            trustedExecutableFiles: launch.trustedExecutableFiles,
            maskedRoots: launch.maskedRoots,
          });
        } catch (error) {
          if (error instanceof LinuxOwnedShellStartError) return error.cleanup;
          // Known pre-spawn failure has no live owner. Delete only our
          // original private directory; native close uncertainty has the
          // explicit retained facade above and never enters this path.
          try {
            launch.cleanup();
          } catch (cleanupError) {
            return new LinuxOwnedShellStartError(error, cleanupError, {
              nonce,
              mode: launch.mode,
            }).cleanup;
          }
          throw error;
        }
      })();
      const state: State = {
        owner,
        binding: { sessionId: context.sessionId, executionId: context.executionId, nonce },
        queue: [],
        queuedBytes: 0,
        gaps: new Map(),
        observed: false,
        ended: false,
        cleanupUnknown: false,
        cleanup: launch.cleanup,
        signal: context.signal,
        aborted: () => {
          void owner.cancel();
        },
      };
      context.signal.addEventListener('abort', state.aborted, { once: true });
      if (context.signal.aborted) state.aborted();
      for (const [stream, source] of [
        ['stdout', owner.stdout],
        ['stderr', owner.stderr],
      ] as const) {
        const decoder = new StringDecoder('utf8');
        const output = (text: string) => {
          while (text) {
            let end = Math.min(8192, text.length);
            if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
            enqueue(state, { type: 'output', stream, content: text.slice(0, end) });
            text = text.slice(end);
          }
        };
        source.on('data', (chunk: Buffer) => output(decoder.write(chunk)));
        source.once('end', () => output(decoder.end()));
      }
      void owner.completion.then(
        (receipt) => complete(state, receipt, launch.cleanup),
        () =>
          complete(
            state,
            { confirmed: false, code: null, signal: null, reason: null },
            launch.cleanup,
          ),
      );
      // A created owner with failed admission still returns its original Job
      // handle and unknown terminal, so Runtime can retain and fence cleanup.
      await owner.ready.catch(() => {});
      const facts = evidence(state);
      const handle: JobHandle = {
        reference: {
          nonce,
          executionId: context.executionId,
          supervisorPid: owner.pid,
          ...(facts ? { ownedProcesses: facts as unknown as Json } : {}),
          confinement: {
            backend: 'linux-bubblewrap-pid-namespace',
            profileDigest: launch.profileDigest,
            scope: launch.mode,
          },
        },
      };
      states.set(handle, state);
      return handle;
    },
    async *observe(handle) {
      const state = get(handle);
      if (state.observed) throw Error('shell_observer_already_attached');
      state.observed = true;
      while (true) {
        if (!state.queue.length)
          await new Promise<void>((resolve) => {
            state.wake = resolve;
          });
        const item = state.queue.shift();
        if (!item) continue;
        state.queuedBytes -= item.bytes;
        if (
          item.event.type === 'output_dropped' &&
          state.gaps.get(item.event.stream) === item.event
        )
          state.gaps.delete(item.event.stream);
        yield item.event;
        if (item.event.type === 'terminal') return;
      }
    },
    cancel: (handle) => cancel(get(handle)),
    async dispose(handle) {
      const state = get(handle);
      state.disposed ??= (async () => {
        await cancel(state);
        if (!state.ended || state.cleanupUnknown) throw Error('shell_owned_cleanup_unconfirmed');
        state.signal.removeEventListener('abort', state.aborted);
        state.queue = state.queue.filter((item) => item.event.type === 'terminal');
        state.queuedBytes = 0;
        state.gaps.clear();
      })();
      return state.disposed;
    },
  };
}
