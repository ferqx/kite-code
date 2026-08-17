import { createHash, randomUUID } from 'node:crypto';
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
    signal: AbortSignal,
  ): Promise<LocalSubagentDriverResultV1>;
  resume(
    grant: Readonly<SubagentResumeGrantV1>,
    signal: AbortSignal,
  ): Promise<LocalSubagentDriverResultV1>;
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
  readonly completion: Promise<LocalSubagentDriverResultV1>;
  observed: boolean;
}

/** Sole production Provider. It owns lifecycle/cancel/observation transport only. */
export class LocalSubagentProviderV1 implements SubagentProviderV1 {
  readonly #runs = new Map<string, RunningChild>();
  readonly #verifier: SubagentGrantVerifierV1;
  readonly #driver: LocalSubagentLifecycleDriverV1;
  readonly #idSource: () => string;
  readonly #cleanupGraceMs: number;

  constructor(
    verifier: SubagentGrantVerifierV1,
    driver: LocalSubagentLifecycleDriverV1,
    idSource: () => string = randomUUID,
    cleanupGraceMs = 3_000,
  ) {
    this.#verifier = verifier;
    this.#driver = driver;
    this.#idSource = idSource;
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
    if (!running || !sameHandle(running.handle, input.handle) || running.observed) {
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
      return { ok: true, value: observation } as const;
    } catch (error) {
      if (error instanceof DriverCleanupPendingErrorV1) {
        // The single absolute cleanup grace is exhausted. Forget the in-memory
        // transport handle and force parent reconciliation; never open a
        // second grace window or retain an unobservable active handle.
        this.#runs.delete(input.handle.handleId);
        return failure('recovery_required', error.message);
      }
      this.#runs.delete(input.handle.handleId);
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

  async cancel(input: { handle: SubagentHandleV1; reason: string }) {
    const running = this.#runs.get(input.handle.handleId);
    if (!running || !sameHandle(running.handle, input.handle)) {
      return failure('stale_handle', 'Subagent handle is stale.');
    }
    running.controller.abort(input.reason || 'cancelled');
    return { ok: true, value: { cancelled: true as const } } as const;
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
      if (signal?.aborted) return failure('cancelled', 'Subagent lifecycle was cancelled.');
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const handle = Object.freeze({
        schema: SUBAGENT_PROVIDER_SCHEMA_V1,
        handleId: this.#idSource(),
        grantId: verified.grantId,
        childInvocationId: verified.childInvocationId,
        parentInvocationId: verified.parentInvocationId,
        parentToolCallId: verified.parentToolCallId,
        role: verified.role,
        lifecycle: 'running' as const,
      });
      const completion = (
        purpose === 'start'
          ? this.#driver.start(verified as SubagentDelegationGrantV1, controller.signal)
          : this.#driver.resume(verified as SubagentResumeGrantV1, controller.signal)
      ).finally(() => signal?.removeEventListener('abort', abort));
      this.#runs.set(handle.handleId, { handle, controller, completion, observed: false });
      return { ok: true, value: handle };
    } catch (error) {
      if (error instanceof SubagentGrantErrorV1) return failure(error.code, error.message);
      return failure('invalid_grant', 'Subagent grant verification failed.');
    }
  }
}

function sameHandle(left: SubagentHandleV1, right: SubagentHandleV1): boolean {
  return (
    left.schema === right.schema &&
    left.handleId === right.handleId &&
    left.grantId === right.grantId &&
    left.childInvocationId === right.childInvocationId &&
    left.parentInvocationId === right.parentInvocationId &&
    left.parentToolCallId === right.parentToolCallId &&
    left.role === right.role &&
    left.lifecycle === right.lifecycle
  );
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
