import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalModelJsonV1 } from '@/core/model/surface-canonicalizer';
import type { SubagentTaskArtifactAccessV1 } from '@/core/persistence/subagent-task-artifacts';
import type {
  SubagentDelegationGrantV1,
  SubagentHandleV1,
  SubagentObservationV1,
  SubagentProviderResultV1,
  SubagentProviderV1,
  SubagentResumeGrantV1,
} from '@/protocol/subagent-provider';
import { SUBAGENT_PROVIDER_SCHEMA_V1 } from '@/protocol/subagent-provider';
import { SubagentGrantErrorV1, type SubagentGrantVerifierV1 } from './grant-authority';

export interface LocalSubagentLifecycleDriverV1 {
  start(
    grant: Readonly<SubagentDelegationGrantV1>,
    task: string,
    signal: AbortSignal,
  ): Promise<LocalSubagentDriverResultV1>;
  resume(
    grant: Readonly<SubagentResumeGrantV1>,
    task: string,
    signal: AbortSignal,
  ): Promise<LocalSubagentDriverResultV1>;
  /** Drops an exact pre-activation registration without executing child I/O. */
  abandon(grant: Readonly<SubagentDelegationGrantV1 | SubagentResumeGrantV1>): boolean;
}

export interface LocalSubagentDriverResultV1 {
  readonly childInvocationId: string;
  readonly status: SubagentObservationV1['status'];
  readonly summary: string;
  readonly toolCallCount: number;
  readonly durationMs: number;
  readonly privatePayload: import('@/protocol/subagent').JsonObject;
}

interface RunningChild {
  readonly handle: SubagentHandleV1;
  readonly controller: AbortController;
  readonly grant: Readonly<SubagentDelegationGrantV1 | SubagentResumeGrantV1>;
  readonly task: string;
  readonly purpose: 'start' | 'resume';
  completion?: Promise<LocalSubagentDriverResultV1>;
  observed: boolean;
}

/** Sole production Provider. It owns lifecycle/cancel/observation transport only. */
export class LocalSubagentProviderV1 implements SubagentProviderV1 {
  readonly #runs = new Map<string, RunningChild>();
  readonly #verifier: SubagentGrantVerifierV1;
  readonly #driver: LocalSubagentLifecycleDriverV1;
  readonly #idSource: () => string;
  readonly #cleanupGraceMs: number;
  readonly #taskArtifacts: SubagentTaskArtifactAccessV1;
  readonly #providerInstanceId: string;
  readonly #ownerProcessStartIdentity: string;
  readonly #unconfirmed = new Set<string>();
  readonly #stopped = new Set<string>();

  constructor(
    verifier: SubagentGrantVerifierV1,
    driver: LocalSubagentLifecycleDriverV1,
    taskArtifacts: SubagentTaskArtifactAccessV1,
    idSource: () => string = randomUUID,
    cleanupGraceMs = 3_000,
  ) {
    this.#verifier = verifier;
    this.#driver = driver;
    this.#taskArtifacts = taskArtifacts;
    this.#idSource = idSource;
    this.#providerInstanceId = `local-${this.#idSource()}`;
    this.#ownerProcessStartIdentity = currentProcessStartIdentity();
    if (!Number.isSafeInteger(cleanupGraceMs) || cleanupGraceMs < 1 || cleanupGraceMs > 3_000) {
      throw new Error('Subagent cleanup grace is invalid.');
    }
    this.#cleanupGraceMs = cleanupGraceMs;
  }

  async start(input: { grant: SubagentDelegationGrantV1; signal?: AbortSignal }) {
    return this.#launch(input.grant, input.signal, 'start');
  }

  async resume(input: { grant: SubagentResumeGrantV1; signal?: AbortSignal }) {
    return this.#launch(input.grant, input.signal, 'resume');
  }

  async observe(input: { handle: SubagentHandleV1; signal?: AbortSignal }) {
    const running = this.#runs.get(input.handle.handleId);
    if (!running?.completion || !sameHandle(running.handle, input.handle) || running.observed) {
      return failure('stale_handle', 'Subagent handle is stale or was already observed.');
    }
    running.observed = true;
    const abort = () => running.controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    try {
      const driverResult = await boundedCompletion(
        running.completion,
        running.controller,
        this.#cleanupGraceMs,
      );
      const observation = boundedObservation(running.handle, driverResult);
      this.#runs.delete(input.handle.handleId);
      this.#stopped.add(input.handle.handleId);
      return { ok: true, value: observation } as const;
    } catch (error) {
      if (error instanceof DriverCleanupPendingErrorV1) {
        // The single absolute cleanup grace is exhausted. Forget the in-memory
        // transport handle and force parent reconciliation; never open a
        // second grace window or retain an unobservable active handle.
        this.#runs.delete(input.handle.handleId);
        this.#unconfirmed.add(input.handle.handleId);
        return failure('recovery_required', error.message);
      }
      this.#runs.delete(input.handle.handleId);
      this.#stopped.add(input.handle.handleId);
      if (error instanceof ObservationTooLargeErrorV1) {
        return failure('observation_too_large', error.message);
      }
      return failure(
        running.controller.signal.aborted || input.signal?.aborted ? 'cancelled' : 'driver_crashed',
        running.controller.signal.aborted || input.signal?.aborted
          ? 'Subagent lifecycle was cancelled.'
          : error instanceof Error
            ? error.message
            : 'Child Runtime driver crashed.',
      );
    } finally {
      input.signal?.removeEventListener('abort', abort);
    }
  }

  async activate(input: { handle: SubagentHandleV1; signal?: AbortSignal }) {
    const running = this.#runs.get(input.handle.handleId);
    if (!running || running.completion || !sameHandle(running.handle, input.handle)) {
      return failure('stale_handle', 'Subagent prepared handle is stale or already activated.');
    }
    if (input.signal?.aborted) {
      this.#driver.abandon(running.grant);
      this.#runs.delete(input.handle.handleId);
      this.#stopped.add(input.handle.handleId);
      return failure('cancelled', 'Subagent lifecycle was cancelled.');
    }
    const abort = () => running.controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', abort, { once: true });
    running.completion = (
      running.purpose === 'start'
        ? this.#driver.start(
            running.grant as SubagentDelegationGrantV1,
            running.task,
            running.controller.signal,
          )
        : this.#driver.resume(
            running.grant as SubagentResumeGrantV1,
            running.task,
            running.controller.signal,
          )
    ).finally(() => input.signal?.removeEventListener('abort', abort));
    return { ok: true as const, value: { activated: true as const } };
  }

  async cancel(input: { handle: SubagentHandleV1; reason: string }) {
    const running = this.#runs.get(input.handle.handleId);
    if (!running || !sameHandle(running.handle, input.handle)) {
      return failure('stale_handle', 'Subagent handle is stale.');
    }
    if (!running.completion) {
      this.#driver.abandon(running.grant);
      this.#runs.delete(input.handle.handleId);
      this.#stopped.add(input.handle.handleId);
      return { ok: true, value: { cancelled: true as const } } as const;
    }
    running.controller.abort(input.reason || 'cancelled');
    return { ok: true, value: { cancelled: true as const } } as const;
  }

  async reconcile(input: { handle: SubagentHandleV1 }) {
    let verified: Readonly<SubagentHandleV1>;
    try {
      verified = this.#verifier.verifyHandle(input.handle);
    } catch {
      return failure('stale_handle', 'Subagent recovery handle is malformed.');
    }
    const running = this.#runs.get(verified.handleId);
    if (running) {
      if (!sameHandle(running.handle, verified)) {
        return failure('stale_handle', 'Subagent recovery handle is stale.');
      }
      return {
        ok: true as const,
        value: { status: 'running' as const, cleanupConfirmed: false },
      };
    }
    if (
      verified.providerInstanceId === this.#providerInstanceId &&
      this.#stopped.has(verified.handleId)
    ) {
      return {
        ok: true as const,
        value: { status: 'stopped' as const, cleanupConfirmed: true },
      };
    }
    if (
      verified.providerInstanceId === this.#providerInstanceId &&
      this.#unconfirmed.has(verified.handleId)
    ) {
      return failure('recovery_required', 'Subagent cleanup remains unconfirmed.');
    }
    if (
      verified.ownerProcessId === process.pid &&
      verified.ownerProcessStartIdentity === this.#ownerProcessStartIdentity
    ) {
      return failure(
        'recovery_required',
        'Subagent handle owner may still be live in this process.',
      );
    }
    const liveIdentity = processStartIdentity(verified.ownerProcessId);
    if (
      liveIdentity === null ||
      liveIdentity === verified.ownerProcessStartIdentity ||
      (liveIdentity === undefined && processExists(verified.ownerProcessId))
    ) {
      return failure('recovery_required', 'Subagent handle owner is still running.');
    }
    return {
      ok: true as const,
      value: { status: 'stopped' as const, cleanupConfirmed: true },
    };
  }

  async #launch(
    grant: SubagentDelegationGrantV1 | SubagentResumeGrantV1,
    signal: AbortSignal | undefined,
    purpose: 'start' | 'resume',
  ): Promise<SubagentProviderResultV1<SubagentHandleV1>> {
    try {
      const verified =
        purpose === 'start'
          ? this.#verifier.verifyAndConsumeStart(grant as SubagentDelegationGrantV1)
          : this.#verifier.verifyAndConsumeResume(grant as SubagentResumeGrantV1);
      if (signal?.aborted) {
        this.#driver.abandon(verified);
        return failure('cancelled', 'Subagent lifecycle was cancelled.');
      }
      const taskArtifact = this.#taskArtifacts.read(verified.taskArtifact, {
        parentInvocationId: verified.parentInvocationId,
        parentAttempt: verified.parentAttempt,
        parentToolCallId: verified.parentToolCallId,
        childInvocationId: verified.childInvocationId,
        taskDigest: verified.taskDigest,
      });
      const controller = new AbortController();
      const handle = this.#verifier.issueHandle(verified, {
        handleId: this.#idSource(),
        ownerProcessId: process.pid,
        ownerProcessStartIdentity: this.#ownerProcessStartIdentity,
        providerInstanceId: this.#providerInstanceId,
      });
      this.#runs.set(handle.handleId, {
        handle,
        controller,
        grant: verified,
        task: taskArtifact.task,
        purpose,
        observed: false,
      });
      return { ok: true, value: handle };
    } catch (error) {
      this.#driver.abandon(grant);
      if (error instanceof SubagentGrantErrorV1) return failure(error.code, error.message);
      return failure('invalid_grant', 'Subagent grant verification failed.');
    }
  }
}

function sameHandle(left: SubagentHandleV1, right: SubagentHandleV1): boolean {
  return canonicalModelJsonV1(left) === canonicalModelJsonV1(right);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ESRCH'
    );
  }
}

const CURRENT_PROCESS_FALLBACK_START = `node-epoch:${Math.max(
  0,
  Math.floor(Date.now() - process.uptime() * 1_000),
)}`;

function currentProcessStartIdentity(): string {
  return processStartIdentity(process.pid) ?? CURRENT_PROCESS_FALLBACK_START;
}

/** null means the process exists but its exact start identity is unavailable. */
function processStartIdentity(pid: number): string | null | undefined {
  if (process.platform !== 'linux') {
    if (pid === process.pid) return CURRENT_PROCESS_FALLBACK_START;
    return processExists(pid) ? null : undefined;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const fields = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/u);
    const startTicks = fields[19];
    return startTicks ? `linux-proc-start:${startTicks}` : null;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return undefined;
    }
    return null;
  }
}

function failure(
  code: Parameters<typeof typedFailure>[0],
  message: string,
): ReturnType<typeof typedFailure> {
  return typedFailure(code, message);
}

function typedFailure(
  code: import('@/protocol/subagent-provider').SubagentProviderFailureCodeV1,
  message: string,
) {
  return { ok: false, failure: { code, message } } as const;
}

class DriverCleanupPendingErrorV1 extends Error {}
class ObservationTooLargeErrorV1 extends Error {}

async function boundedCompletion<T>(
  promise: Promise<T>,
  controller: AbortController,
  cleanupGraceMs: number,
): Promise<T> {
  if (controller.signal.aborted) return cleanupRace(promise, cleanupGraceMs);
  return new Promise<T>((resolve, reject) => {
    const abort = () => cleanupRace(promise, cleanupGraceMs).then(resolve, reject);
    controller.signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => controller.signal.removeEventListener('abort', abort));
  });
}

function cleanupRace<T>(promise: Promise<T>, cleanupGraceMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DriverCleanupPendingErrorV1('Child cancellation cleanup is incomplete.')),
      cleanupGraceMs,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function boundedObservation(
  handle: SubagentHandleV1,
  result: LocalSubagentDriverResultV1,
): Readonly<SubagentObservationV1> {
  if (
    result.childInvocationId !== handle.childInvocationId ||
    !['completed', 'failed', 'cancelled', 'exhausted', 'blocked'].includes(result.status) ||
    typeof result.summary !== 'string' ||
    result.summary.length > 1_000_000 ||
    !Number.isSafeInteger(result.toolCallCount) ||
    result.toolCallCount < 0 ||
    !Number.isSafeInteger(result.durationMs) ||
    result.durationMs < 0
  ) {
    throw new Error('Child Runtime driver returned an invalid bounded result.');
  }
  let payload: string;
  try {
    payload = JSON.stringify(result.privatePayload);
  } catch {
    throw new Error('Child Runtime driver returned a non-JSON private payload.');
  }
  if (Buffer.byteLength(payload) > 4 * 1024 * 1024) {
    throw new ObservationTooLargeErrorV1(
      'Child Runtime driver observation exceeds the transport bound.',
    );
  }
  const body = {
    schema: SUBAGENT_PROVIDER_SCHEMA_V1,
    handleId: handle.handleId,
    childInvocationId: handle.childInvocationId,
    status: result.status,
    summary: result.summary,
    toolCallCount: result.toolCallCount,
    durationMs: result.durationMs,
    privatePayload: structuredClone(result.privatePayload),
  };
  return Object.freeze({
    ...body,
    observationDigest: `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`,
  });
}
