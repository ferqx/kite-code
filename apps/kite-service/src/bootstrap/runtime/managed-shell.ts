import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  readonly moreOutput: boolean;
  readonly returnReason?: 'output' | 'terminal' | 'timeout' | 'new_input' | 'cancelled';
  readonly result?: Readonly<BuiltinShellTerminalExecutionResult>;
}

interface ManagedShellEntry {
  readonly shellId: string;
  readonly ownerKey: string;
  readonly mode: 'finite' | 'service';
  readonly controller: AbortController;
  readonly spoolPath: string;
  readonly previewPath: string;
  spoolFd?: number;
  cursor: number;
  readonly progressWaiters: Set<() => void>;
  readonly terminalWaiters: Set<() => void>;
  readonly inputWaiters: Set<() => void>;
  result?: Readonly<BuiltinShellTerminalExecutionResult>;
  previewStored: boolean;
  progressStdoutSeen: boolean;
  progressStderrSeen: boolean;
  terminalRead: boolean;
  ownerDisposed: boolean;
  stopRequested: boolean;
  revision: number;
  completion: Promise<Readonly<BuiltinShellTerminalExecutionResult>>;
}

// One page fits the Runtime Protocol text/frame envelope even when the Tool
// receipt carries both JSON output and structured metadata.
const OUTPUT_PAGE_BYTES = 32 * 1024;
const OUTPUT_FRAME_BYTES = 8 * 1024;
// Leave room for the closed shell_read JSON metadata inside the Protocol
// tool-result text field after control characters are escaped.
const OUTPUT_PAGE_JSON_CHARS = 60_000;

/** Process-local owner for finite Shell executions which outlive their starting Tool call. */
export class ManagedShellRuntime {
  readonly #entries = new Map<string, ManagedShellEntry>();
  #spoolDirectory: string | undefined;
  readonly #ownerRevisions = new Map<string, number>();
  readonly #ownerGeneration = `shell_${randomUUID()}`;
  #watermark = 0;
  readonly #ownerWaiters = new Map<string, Set<() => void>>();

  async start(input: {
    readonly ownerKey: string;
    readonly mode?: 'finite' | 'service';
    readonly yieldMs: number;
    /** Required launch boundary: sandbox supervisor acknowledgement or explicit Host selection. */
    readonly started?: Promise<void>;
    readonly execute: (
      signal: AbortSignal,
      onProgress: (chunk: string, stream: 'stdout' | 'stderr') => void,
    ) => Promise<Readonly<BuiltinShellTerminalExecutionResult>>;
  }): Promise<ManagedShellSnapshot> {
    const shellId = `sh_${randomUUID()}`;
    const controller = new AbortController();
    this.#spoolDirectory ??= mkdtempSync(join(tmpdir(), 'kite-managed-shell-'));
    const directory = this.#spoolDirectory;
    const spoolPath = join(directory, `${shellId}.out`);
    const spoolFd = openSync(spoolPath, 'wx', 0o600);
    const entry: ManagedShellEntry = {
      shellId,
      ownerKey: input.ownerKey,
      mode: input.mode ?? 'finite',
      controller,
      spoolPath,
      previewPath: join(directory, `${shellId}.preview`),
      spoolFd,
      cursor: 0,
      progressWaiters: new Set(),
      terminalWaiters: new Set(),
      inputWaiters: new Set(),
      terminalRead: false,
      ownerDisposed: false,
      previewStored: false,
      progressStdoutSeen: false,
      progressStderrSeen: false,
      revision: ++this.#watermark,
      stopRequested: false,
      completion: Promise.resolve(undefined as never),
    };
    const yieldDeadlineMs = performance.now() + input.yieldMs;
    try {
      entry.completion = input.execute(controller.signal, (chunk, stream) => {
        try {
          appendSpool(entry, chunk, stream);
          if (chunk.length > 0) {
            if (stream === 'stdout') entry.progressStdoutSeen = true;
            else entry.progressStderrSeen = true;
          }
        } catch (error) {
          controller.abort(error);
          throw error;
        }
        this.#touch(entry);
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
        try {
          // A host executor may provide only its terminal output. Streamed
          // output already has its exact bytes in the spool and must not be
          // appended a second time from a bounded terminal preview.
          if (!entry.progressStdoutSeen && result.stdout)
            appendSpool(entry, result.stdout, 'stdout');
          if (!entry.progressStderrSeen && result.stderr)
            appendSpool(entry, result.stderr, 'stderr');
          writeFileSync(
            entry.previewPath,
            JSON.stringify({
              stdout: terminalPreview(result.stdout),
              stderr: terminalPreview(result.stderr),
            }),
            { flag: 'wx', mode: 0o600 },
          );
          entry.result = Object.freeze({ ...result, stdout: '', stderr: '' });
          entry.previewStored = true;
        } catch (error) {
          entry.result = Object.freeze({
            ...result,
            stdout: '',
            stderr: 'Shell terminal preview could not be persisted.',
            executionPhase: 'unknown_after_go',
          });
          controller.abort(error);
        } finally {
          if (entry.spoolFd !== undefined) {
            closeSync(entry.spoolFd);
            entry.spoolFd = undefined;
          }
        }
        this.#touch(entry);
        for (const wake of entry.progressWaiters) wake();
        entry.progressWaiters.clear();
        for (const wake of entry.terminalWaiters) wake();
        entry.terminalWaiters.clear();
        this.#wakeOwner(entry.ownerKey);
        if (entry.ownerDisposed && shellCleanupConfirmed(entry.result)) this.#deleteEntry(entry);
        return entry.result;
      });
    this.#entries.set(shellId, entry);
    this.#ownerRevisions.set(input.ownerKey, entry.revision);
    if (input.started) await Promise.race([input.started, entry.completion.then(() => undefined)]);
    const remainingYieldMs = Math.max(0, yieldDeadlineMs - performance.now());
    if (remainingYieldMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          entry.completion.then(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, remainingYieldMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    return this.read(shellId, input.ownerKey, 0);
  }

  read(shellId: string, ownerKey: string, cursor = 0): ManagedShellSnapshot {
    const entry = this.#entries.get(shellId);
    if (!entry || entry.ownerKey !== ownerKey)
      throw new Error('Managed Shell handle is unavailable.');
    const page = readSpoolPage(entry, cursor);
    const snapshot = Object.freeze({
      shellId,
      mode: entry.mode,
      status: entry.result ? 'exited' : 'running',
      cursor: page.cursor,
      stdout: page.stdout,
      stderr: page.stderr,
      gap: false,
      moreOutput: page.cursor < entry.cursor,
      ...(entry.result ? { result: terminalResult(entry) } : {}),
    });
    if (entry.result && page.cursor === entry.cursor) entry.terminalRead = true;
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
    if (!entry.result && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          entry.terminalWaiters.delete(finish);
          signal?.removeEventListener('abort', finish);
          resolve();
        };
        entry.terminalWaiters.add(finish);
        signal?.addEventListener('abort', finish, { once: true });
        if (entry.result || signal?.aborted) finish();
      });
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
    if (input.signal?.aborted) returnReason = 'cancelled';
    else if (
      (input.waitUntil === 'terminal' || (input.waitMs && input.waitMs > 0)) &&
      !entry.result &&
      (input.waitUntil === 'terminal' || (input.cursor ?? 0) >= entry.cursor)
    ) {
      returnReason = await new Promise<NonNullable<ManagedShellSnapshot['returnReason']>>(
        (resolve) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const terminal = () => finish('terminal');
          const progress = () => finish('output');
          const newInput = () => finish('new_input');
          const aborted = () => finish('cancelled');
          const finish = (reason: NonNullable<ManagedShellSnapshot['returnReason']>) => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            entry.terminalWaiters.delete(terminal);
            entry.progressWaiters.delete(progress);
            entry.inputWaiters.delete(newInput);
            input.signal?.removeEventListener('abort', aborted);
            resolve(reason);
          };
          entry.terminalWaiters.add(terminal);
          entry.inputWaiters.add(newInput);
          if (input.waitUntil !== 'terminal') {
            entry.progressWaiters.add(progress);
            timer = setTimeout(() => finish('timeout'), input.waitMs);
          }
          input.signal?.addEventListener('abort', aborted, { once: true });
          // No completion, progress or cancellation between the initial read and
          // registration may leave a waiter parked until a later event.
          if (input.signal?.aborted) aborted();
          else if (entry.result) terminal();
          else if (input.waitUntil !== 'terminal' && (input.cursor ?? 0) < entry.cursor) progress();
        },
      );
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
    return this.#ownerRevisions.get(ownerKey) ?? 0;
  }

  /** Find a process-local Shell owner without reading historical Session State. */
  liveWorkspaceForSession(sessionId: string): string | null {
    const prefix = `${sessionId}\0`;
    for (const entry of this.#entries.values()) {
      if (entry.ownerKey.startsWith(prefix) && !shellCleanupConfirmed(entry.result))
        return entry.ownerKey.slice(prefix.length);
    }
    return null;
  }

  waitForOwnerChange(ownerKey: string, watermark: number, signal?: AbortSignal): Promise<void> {
    if (this.ownerWatermark(ownerKey) !== watermark || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = () => {
        const waiters = this.#ownerWaiters.get(ownerKey);
        waiters?.delete(finish);
        if (waiters?.size === 0) this.#ownerWaiters.delete(ownerKey);
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
      this.#touch(entry);
      entry.controller.abort('stop_background_execution');
    }
    void entry.completion.then(onTerminal, onTerminal);
    return true;
  }

  listSnapshot(sessionId: string, ownerKey: string): ManagedShellDirectorySnapshot {
    const executions = [...this.#entries.values()]
      .filter((entry) => entry.ownerKey === ownerKey)
      .map((entry) => projectManagedShellExecution(entry, sessionId, this.#ownerGeneration));
    return Object.freeze({
      sessionId,
      aggregateGeneration: this.#ownerGeneration,
      watermark: this.ownerWatermark(ownerKey),
      executions: Object.freeze(executions),
    });
  }

  getProjection(
    sessionId: string,
    ownerKey: string,
    shellId: string,
  ): Omit<RuntimeBackgroundExecutionProjection, 'sessionRevision'> | undefined {
    const entry = this.#entries.get(shellId);
    return entry?.ownerKey === ownerKey
      ? projectManagedShellExecution(entry, sessionId, this.#ownerGeneration)
      : undefined;
  }

  /** Host shutdown boundary: stop every retained execution and await real Provider cleanup. */
  async dispose(reason = 'runtime_disposed'): Promise<void> {
    const entries = [...this.#entries.values()];
    for (const entry of entries) entry.controller.abort(reason);
    await Promise.allSettled(entries.map((entry) => entry.completion));
    for (const entry of entries) this.#deleteEntry(entry);
    this.#removeEmptyDirectory();
    this.#ownerRevisions.clear();
  }

  /** Session/Workspace shutdown boundary; other owners remain untouched. */
  async disposeOwner(
    ownerKey: string,
    reason = 'runtime_owner_disposed',
    timeoutMs = 10_000,
  ): Promise<void> {
    const entries = [...this.#entries.values()].filter((entry) => entry.ownerKey === ownerKey);
    for (const entry of entries) {
      entry.ownerDisposed = true;
      entry.stopRequested = true;
      this.#touch(entry);
      entry.controller.abort(reason);
    }
    await waitBounded(Promise.allSettled(entries.map((entry) => entry.completion)), timeoutMs);
    for (const entry of entries) {
      // Keep an unresolved entry as a visible recovery-required ownership fact.
      // Its eventual Provider terminal still completes the ordinary watcher.
      if (shellCleanupConfirmed(entry.result)) this.#deleteEntry(entry);
    }
    this.#wakeOwner(ownerKey);
    if (![...this.#entries.values()].some((entry) => entry.ownerKey === ownerKey))
      this.#ownerRevisions.delete(ownerKey);
  }

  #touch(entry: ManagedShellEntry): void {
    entry.revision = ++this.#watermark;
    this.#ownerRevisions.set(entry.ownerKey, entry.revision);
  }

  #wakeOwner(ownerKey: string): void {
    const waiters = this.#ownerWaiters.get(ownerKey);
    if (!waiters) return;
    this.#ownerWaiters.delete(ownerKey);
    for (const wake of waiters) wake();
  }

  #deleteEntry(entry: ManagedShellEntry): void {
    if (!this.#entries.delete(entry.shellId)) return;
    if (entry.spoolFd !== undefined) closeSync(entry.spoolFd);
    rmSync(entry.spoolPath, { force: true });
    rmSync(entry.previewPath, { force: true });
    this.#removeEmptyDirectory();
  }

  #removeEmptyDirectory(): void {
    if (this.#entries.size > 0 || !this.#spoolDirectory) return;
    rmSync(this.#spoolDirectory, { recursive: true, force: true });
    this.#spoolDirectory = undefined;
  }
}

function appendSpool(entry: ManagedShellEntry, chunk: string, stream: 'stdout' | 'stderr'): void {
  // Each frame has its own cursor boundary so a large producer chunk can be
  // delivered in successive pages without retaining it in process memory.
  const data = Buffer.from(chunk, 'utf8');
  const fd = entry.spoolFd;
  if (fd === undefined) throw new Error('Managed Shell output spool is closed.');
  for (let offset = 0; offset < data.byteLength; offset += OUTPUT_FRAME_BYTES) {
    let end = Math.min(data.byteLength, offset + OUTPUT_FRAME_BYTES);
    if (end < data.byteLength) {
      while (end > offset && (data[end]! & 0xc0) === 0x80) end -= 1;
    }
    const part = data.subarray(offset, end);
    const header = Buffer.allocUnsafe(5);
    header[0] = stream === 'stdout' ? 0 : 1;
    header.writeUInt32BE(part.byteLength, 1);
    writeAll(fd, header, entry.cursor);
    writeAll(fd, part, entry.cursor + header.byteLength);
    entry.cursor += header.byteLength + part.byteLength;
    offset = end - OUTPUT_FRAME_BYTES;
  }
}

function readSpoolPage(
  entry: ManagedShellEntry,
  cursor: number,
): { cursor: number; stdout: string; stderr: string } {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > entry.cursor)
    throw new Error('Managed Shell output cursor is invalid.');
  let offset = cursor;
  let bytes = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fd = openSync(entry.spoolPath, 'r');
  try {
    while (offset < entry.cursor && bytes < OUTPUT_PAGE_BYTES) {
      const header = Buffer.allocUnsafe(5);
      readAll(fd, header, offset);
      const length = header.readUInt32BE(1);
      if (
        header[0] === undefined ||
        header[0] > 1 ||
        length > OUTPUT_FRAME_BYTES ||
        offset + 5 + length > entry.cursor
      )
        throw new Error('Managed Shell output spool frame is invalid.');
      const data = Buffer.allocUnsafe(length);
      readAll(fd, data, offset + 5);
      const chunk = data.toString('utf8');
      const nextStdout = header[0] === 0 ? `${stdout.join('')}${chunk}` : stdout.join('');
      const nextStderr = header[0] === 1 ? `${stderr.join('')}${chunk}` : stderr.join('');
      if (
        JSON.stringify({ stdout: nextStdout, stderr: nextStderr }).length > OUTPUT_PAGE_JSON_CHARS
      ) {
        if (offset === cursor) throw new Error('Managed Shell output frame cannot fit one page.');
        break;
      }
      (header[0] === 0 ? stdout : stderr).push(chunk);
      offset += 5 + length;
      bytes += length;
    }
  } finally {
    closeSync(fd);
  }
  return { cursor: offset, stdout: stdout.join(''), stderr: stderr.join('') };
}

function terminalPreview(value: string): string {
  if (value.length <= OUTPUT_PAGE_BYTES) return value;
  const half = Math.floor(OUTPUT_PAGE_BYTES / 2);
  return `${value.slice(0, half)}\n[Terminal preview shortened; use shell_read for output.]\n${value.slice(-half)}`;
}

function terminalResult(entry: ManagedShellEntry): Readonly<BuiltinShellTerminalExecutionResult> {
  const terminal = entry.result;
  if (!terminal) throw new Error('Managed Shell terminal is unavailable.');
  if (!entry.previewStored) return terminal;
  let preview: unknown;
  try {
    preview = JSON.parse(readFileSync(entry.previewPath, 'utf8'));
  } catch {
    throw new Error('Managed Shell terminal preview is unavailable.');
  }
  if (
    !preview ||
    typeof preview !== 'object' ||
    typeof (preview as { stdout?: unknown }).stdout !== 'string' ||
    typeof (preview as { stderr?: unknown }).stderr !== 'string'
  )
    throw new Error('Managed Shell terminal preview is invalid.');
  return {
    ...terminal,
    stdout: (preview as { stdout: string }).stdout,
    stderr: (preview as { stderr: string }).stderr,
  };
}

function writeAll(fd: number, bytes: Buffer, position: number): void {
  let written = 0;
  while (written < bytes.byteLength) {
    const count = writeSync(fd, bytes, written, bytes.byteLength - written, position + written);
    if (count <= 0) throw new Error('Managed Shell output spool write failed.');
    written += count;
  }
}

function readAll(fd: number, bytes: Buffer, position: number): void {
  let read = 0;
  while (read < bytes.byteLength) {
    const count = readSync(fd, bytes, read, bytes.byteLength - read, position + read);
    if (count <= 0) throw new Error('Managed Shell output spool is incomplete.');
    read += count;
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
    stderr: message,
    intent: 'other',
    executionPhase: 'unknown_after_go',
  });
}

function projectManagedShellExecution(
  entry: ManagedShellEntry,
  sessionId: string,
  ownerGeneration: string,
): Omit<RuntimeBackgroundExecutionProjection, 'sessionRevision'> {
  return Object.freeze({
    executionId: entry.shellId,
    sessionId,
    kind: entry.mode === 'service' ? ('service' as const) : ('shell' as const),
    status:
      entry.stopRequested && !entry.result
        ? ('stopping' as const)
        : shellBackgroundStatus(entry.result),
    ownerGeneration,
    revision: entry.revision,
    cleanupConfirmed: shellCleanupConfirmed(entry.result),
    cursor: entry.cursor,
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
