import { randomUUID } from 'node:crypto';
import type { BuiltinShellTerminalExecutionResult } from '@kite-ai/builtin-runtime';
import type { RuntimeBackgroundExecutionProjection } from '@kite-ai/runtime-contract';

export interface ManagedShellDirectorySnapshot {
  readonly sessionId: string;
  readonly aggregateGeneration: string;
  readonly watermark: number;
  readonly executions: readonly Omit<RuntimeBackgroundExecutionProjection, 'sessionRevision'>[];
}

export interface ManagedShellSnapshot {
  readonly shellId: string;
  readonly mode: 'finite' | 'service';
  readonly status: 'running' | 'exited';
  readonly cursor: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly gap: boolean;
  readonly returnReason?: 'output' | 'terminal' | 'timeout' | 'new_input' | 'cancelled';
  readonly result?: Readonly<BuiltinShellTerminalExecutionResult>;
}

interface ManagedShellEntry {
  readonly shellId: string;
  readonly ownerKey: string;
  readonly mode: 'finite' | 'service';
  readonly controller: AbortController;
  readonly chunks: Array<Readonly<{ cursor: number; stream: 'stdout' | 'stderr'; chunk: string }>>;
  cursor: number;
  retainedChars: number;
  droppedThroughCursor: number;
  readonly progressWaiters: Set<() => void>;
  readonly inputWaiters: Set<() => void>;
  result?: Readonly<BuiltinShellTerminalExecutionResult>;
  terminalRead: boolean;
  stopRequested: boolean;
  revision: number;
  completion: Promise<Readonly<BuiltinShellTerminalExecutionResult>>;
}

const MAX_RETAINED_OUTPUT_CHARS = 256 * 1024;
const MAX_MANAGED_SHELL_ENTRIES = 256;
const MAX_RETAINED_READ_TERMINALS = 64;

/** Process-local owner for finite Shell executions which outlive their starting Tool call. */
export class ManagedShellRuntime {
  readonly #entries = new Map<string, ManagedShellEntry>();
  readonly #ownerGeneration = `shell_${randomUUID()}`;
  #watermark = 0;
  readonly #ownerWaiters = new Map<string, Set<() => void>>();

  async start(input: {
    readonly ownerKey: string;
    readonly mode?: 'finite' | 'service';
    readonly yieldMs: number;
    readonly execute: (
      signal: AbortSignal,
      onProgress: (chunk: string, stream: 'stdout' | 'stderr') => void,
    ) => Promise<Readonly<BuiltinShellTerminalExecutionResult>>;
  }): Promise<ManagedShellSnapshot> {
    this.#pruneReadTerminals();
    if (this.#entries.size >= MAX_MANAGED_SHELL_ENTRIES) {
      throw new Error('Managed Shell owner capacity is exhausted.');
    }
    const shellId = `sh_${randomUUID()}`;
    const controller = new AbortController();
    const entry: ManagedShellEntry = {
      shellId,
      ownerKey: input.ownerKey,
      mode: input.mode ?? 'finite',
      controller,
      chunks: [],
      cursor: 0,
      retainedChars: 0,
      droppedThroughCursor: 0,
      progressWaiters: new Set(),
      inputWaiters: new Set(),
      terminalRead: false,
      revision: ++this.#watermark,
      stopRequested: false,
      completion: Promise.resolve(undefined as never),
    };
    try {
      entry.completion = input.execute(controller.signal, (chunk, stream) => {
        entry.cursor += 1;
        entry.revision = ++this.#watermark;
        entry.chunks.push(Object.freeze({ cursor: entry.cursor, stream, chunk }));
        entry.retainedChars += chunk.length;
        while (entry.retainedChars > MAX_RETAINED_OUTPUT_CHARS && entry.chunks.length > 1) {
          const dropped = entry.chunks.shift()!;
          entry.retainedChars -= dropped.chunk.length;
          entry.droppedThroughCursor = dropped.cursor;
        }
        for (const wake of entry.progressWaiters) wake();
        entry.progressWaiters.clear();
      });
    } catch (error) {
      entry.completion = Promise.resolve(failedExecution(error));
    }
    entry.completion = entry.completion
      .then(
        (result) => result,
        (error) => failedExecution(error),
      )
      .then((result) => {
        entry.result = result;
        entry.revision = ++this.#watermark;
        for (const wake of entry.progressWaiters) wake();
        entry.progressWaiters.clear();
        this.#wakeOwner(entry.ownerKey);
        return result;
      });
    this.#entries.set(shellId, entry);
    if (input.yieldMs > 0) {
      await Promise.race([
        entry.completion.then(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, input.yieldMs)),
      ]);
    }
    return this.read(shellId, input.ownerKey, 0);
  }

  read(shellId: string, ownerKey: string, cursor = 0): ManagedShellSnapshot {
    const entry = this.#entries.get(shellId);
    if (!entry || entry.ownerKey !== ownerKey)
      throw new Error('Managed Shell handle is unavailable.');
    const chunks = entry.chunks.filter((item) => item.cursor > cursor);
    const snapshot = Object.freeze({
      shellId,
      mode: entry.mode,
      status: entry.result ? 'exited' : 'running',
      cursor: entry.cursor,
      stdout: chunks
        .filter((item) => item.stream === 'stdout')
        .map((item) => item.chunk)
        .join('\n'),
      stderr: chunks
        .filter((item) => item.stream === 'stderr')
        .map((item) => item.chunk)
        .join('\n'),
      gap: cursor < entry.droppedThroughCursor,
      ...(entry.result ? { result: entry.result } : {}),
    });
    if (entry.result) {
      entry.terminalRead = true;
      this.#pruneReadTerminals();
    }
    return snapshot;
  }

  async wait(
    shellId: string,
    ownerKey: string,
    signal?: AbortSignal,
  ): Promise<ManagedShellSnapshot> {
    const entry = this.#entries.get(shellId);
    if (!entry || entry.ownerKey !== ownerKey)
      throw new Error('Managed Shell handle is unavailable.');
    if (!signal) {
      await entry.completion;
    } else if (!signal.aborted) {
      await Promise.race([
        entry.completion,
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
      ]);
    }
    return this.read(shellId, ownerKey, 0);
  }

  async readWaiting(input: {
    readonly shellId: string;
    readonly ownerKey: string;
    readonly cursor?: number;
    readonly waitMs?: number;
    readonly waitUntil?: 'terminal';
    readonly signal?: AbortSignal;
  }): Promise<ManagedShellSnapshot> {
    const entry = this.#entries.get(input.shellId);
    if (!entry || entry.ownerKey !== input.ownerKey)
      throw new Error('Managed Shell handle is unavailable.');
    let returnReason: ManagedShellSnapshot['returnReason'];
    if ((input.waitUntil === 'terminal' || (input.waitMs && input.waitMs > 0)) && !entry.result) {
      let progressWake!: () => void;
      const progress = new Promise<void>((resolve) => {
        progressWake = resolve;
        entry.progressWaiters.add(progressWake);
      });
      let inputWake!: () => void;
      const newInput = new Promise<void>((resolve) => {
        inputWake = resolve;
        entry.inputWaiters.add(inputWake);
      });
      returnReason = await Promise.race([
        entry.completion.then(() => 'terminal' as const),
        ...(input.waitUntil === 'terminal'
          ? []
          : [
              progress.then(() => 'output' as const),
              new Promise<'timeout'>((resolve) =>
                setTimeout(() => resolve('timeout'), input.waitMs),
              ),
            ]),
        newInput.then(() => 'new_input' as const),
        ...(input.signal
          ? [
              new Promise<'cancelled'>((resolve) =>
                input.signal!.addEventListener('abort', () => resolve('cancelled'), { once: true }),
              ),
            ]
          : []),
      ]);
      entry.progressWaiters.delete(progressWake);
      entry.inputWaiters.delete(inputWake);
    }
    const snapshot = this.read(input.shellId, input.ownerKey, input.cursor ?? 0);
    return Object.freeze({
      ...snapshot,
      ...(returnReason === undefined
        ? { returnReason: snapshot.status === 'exited' ? ('terminal' as const) : undefined }
        : { returnReason }),
    });
  }

  notifyInput(ownerKey: string): void {
    for (const entry of this.#entries.values()) {
      if (entry.ownerKey !== ownerKey) continue;
      for (const wake of entry.inputWaiters) wake();
      entry.inputWaiters.clear();
    }
    this.#wakeOwner(ownerKey);
  }

  ownerWatermark(ownerKey: string): number {
    return [...this.#entries.values()]
      .filter((entry) => entry.ownerKey === ownerKey)
      .reduce((watermark, entry) => Math.max(watermark, entry.revision), 0);
  }

  waitForOwnerChange(ownerKey: string, watermark: number, signal?: AbortSignal): Promise<void> {
    if (this.ownerWatermark(ownerKey) !== watermark || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = () => {
        this.#ownerWaiters.get(ownerKey)?.delete(finish);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const waiters = this.#ownerWaiters.get(ownerKey) ?? new Set<() => void>();
      waiters.add(finish);
      this.#ownerWaiters.set(ownerKey, waiters);
      signal?.addEventListener('abort', finish, { once: true });
      if (this.ownerWatermark(ownerKey) !== watermark || signal?.aborted) finish();
    });
  }

  async stop(shellId: string, ownerKey: string): Promise<ManagedShellSnapshot> {
    const entry = this.#entries.get(shellId);
    if (!entry || entry.ownerKey !== ownerKey)
      throw new Error('Managed Shell handle is unavailable.');
    entry.controller.abort('shell_stop');
    await entry.completion;
    return this.read(shellId, ownerKey, 0);
  }
  requestStop(shellId: string, ownerKey: string, onTerminal: () => void): boolean {
    const entry = this.#entries.get(shellId);
    if (!entry || entry.ownerKey !== ownerKey || entry.result) return false;
    if (!entry.stopRequested) {
      entry.stopRequested = true;
      entry.revision = ++this.#watermark;
      entry.controller.abort('stop_background_execution');
    }
    void entry.completion.then(onTerminal, onTerminal);
    return true;
  }

  listSnapshot(sessionId: string, ownerKey: string): ManagedShellDirectorySnapshot {
    const executions = [...this.#entries.values()]
      .filter((entry) => entry.ownerKey === ownerKey)
      .map((entry) => ({
        executionId: entry.shellId,
        sessionId,
        kind: entry.mode === 'service' ? ('service' as const) : ('shell' as const),
        status:
          entry.stopRequested && !entry.result
            ? ('stopping' as const)
            : shellBackgroundStatus(entry.result),
        ownerGeneration: this.#ownerGeneration,
        revision: entry.revision,
        cleanupConfirmed: shellCleanupConfirmed(entry.result),
        cursor: entry.cursor,
      }));
    return Object.freeze({
      sessionId,
      aggregateGeneration: this.#ownerGeneration,
      watermark: this.#watermark,
      executions: Object.freeze(executions),
    });
  }

  /** Host shutdown boundary: stop every retained execution and await real Provider cleanup. */
  async dispose(reason = 'runtime_disposed'): Promise<void> {
    const entries = [...this.#entries.values()];
    for (const entry of entries) entry.controller.abort(reason);
    await Promise.allSettled(entries.map((entry) => entry.completion));
    for (const entry of entries) this.#entries.delete(entry.shellId);
  }

  /** Session/Workspace shutdown boundary; other owners remain untouched. */
  async disposeOwner(
    ownerKey: string,
    reason = 'runtime_owner_disposed',
    timeoutMs = 10_000,
  ): Promise<void> {
    const entries = [...this.#entries.values()].filter((entry) => entry.ownerKey === ownerKey);
    for (const entry of entries) {
      entry.stopRequested = true;
      entry.revision = ++this.#watermark;
      entry.controller.abort(reason);
    }
    await waitBounded(Promise.allSettled(entries.map((entry) => entry.completion)), timeoutMs);
    for (const entry of entries) {
      // Keep an unresolved entry as a visible recovery-required ownership fact.
      // Its eventual Provider terminal still completes the ordinary watcher.
      if (shellCleanupConfirmed(entry.result)) this.#entries.delete(entry.shellId);
    }
    this.#ownerWaiters.delete(ownerKey);
  }

  #wakeOwner(ownerKey: string): void {
    const waiters = this.#ownerWaiters.get(ownerKey);
    if (!waiters) return;
    this.#ownerWaiters.delete(ownerKey);
    for (const wake of waiters) wake();
  }

  #pruneReadTerminals(): void {
    const retained = [...this.#entries.values()]
      .filter((entry) => shellCleanupConfirmed(entry.result) && entry.terminalRead)
      .sort((left, right) => left.revision - right.revision);
    while (retained.length > MAX_RETAINED_READ_TERMINALS) {
      const entry = retained.shift()!;
      this.#entries.delete(entry.shellId);
    }
  }
}

function failedExecution(error: unknown): Readonly<BuiltinShellTerminalExecutionResult> {
  const message = error instanceof Error ? error.message : 'Managed Shell execution failed.';
  return Object.freeze({
    status: 'exited',
    ok: false,
    command: '',
    exitCode: 1,
    stdout: '',
    stderr: message.slice(0, 1_024),
    intent: 'other',
    executionPhase: 'unknown_after_go',
  });
}

function shellBackgroundStatus(
  result: Readonly<BuiltinShellTerminalExecutionResult> | undefined,
): 'running' | 'completed' | 'failed' | 'cancelled' | 'unavailable' {
  if (!result) return 'running';
  if (!shellCleanupConfirmed(result)) return 'unavailable';
  if (result.terminationReason === 'cancelled') return 'cancelled';
  return result.ok ? 'completed' : 'failed';
}

function shellCleanupConfirmed(
  result: Readonly<BuiltinShellTerminalExecutionResult> | undefined,
): boolean {
  if (!result || result.executionPhase === 'unknown_after_go') return false;
  return result.processCleanup?.confirmedExited !== false;
}

async function waitBounded(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const managedShellRuntime = new ManagedShellRuntime();

export function managedShellOwnerKey(sessionId: string, workspace: string): string {
  return `${sessionId}\0${workspace}`;
}
