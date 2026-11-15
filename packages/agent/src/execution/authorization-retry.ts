import {
  type ModelAdapter,
  ModelAttemptError,
  type ModelEvent,
  type ModelRequest,
} from '@kite-ai/ai';
import { AgentError, type Json } from '../storage/types';

/** Only positively identified transport failures. SDK reason alone also covers invalid protocols. */
export function retryableReviewFailure(error: unknown): boolean {
  return (
    ModelAttemptError.isInstance(error) &&
    (error.detail === 'request_timeout' ||
      error.detail === 'connection_timeout' ||
      ((error.reason === 'connection_failed' || error.reason === 'stream_incomplete') &&
        (error.detail === 'connection_refused' ||
          error.detail === 'name_resolution_failed' ||
          error.detail === 'connection_interrupted')))
  );
}

/** A single durable check owns these attempts. Cold/recovered checks never call this helper. */
export async function* approvalModelAttempts(options: {
  model: ModelAdapter;
  request: ModelRequest;
  signal: AbortSignal;
  timeoutMs: number;
  checkpoint(): Promise<void>;
  record(attempt: Json): Promise<void>;
  retainCleanup?(pending: Promise<void>): void;
}): AsyncGenerator<ModelEvent> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    options.signal.throwIfAborted();
    await options.checkpoint();
    options.signal.throwIfAborted();
    const startedAt = Date.now();
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal.reason);
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    const expire = () =>
      controller.abort(new ModelAttemptError('provider_unavailable', 'request_timeout'));
    const timer = setTimeout(expire, options.timeoutMs);
    const checkDeadline = () => {
      if (!controller.signal.aborted && Date.now() - startedAt >= options.timeoutMs) expire();
      controller.signal.throwIfAborted();
    };
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    void aborted.catch(() => {});
    const onAbort = () => rejectAbort(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    const events: ModelEvent[] = [];
    let usage: Json = {};
    let size = 0;
    let finished = false;
    let iterator: AsyncIterator<ModelEvent> | undefined;
    let pendingNext: Promise<IteratorResult<ModelEvent>> | undefined;
    let failure: unknown;
    let failed = false;
    try {
      await options.record({ attempt, startedAt, status: 'running' });
      checkDeadline();
      iterator = options.model
        .stream(structuredClone(options.request), { signal: controller.signal })
        [Symbol.asyncIterator]();
      for (;;) {
        pendingNext = iterator.next();
        const next = await Promise.race([pendingNext, aborted]);
        pendingNext = undefined;
        checkDeadline();
        if (next.done) break;
        const event = next.value;
        if (finished) throw new AgentError('model_event_after_finish');
        size += JSON.stringify(event).length;
        if (size > 1024 * 1024) throw new AgentError('authorization_check_output_too_large');
        if (event.type === 'usage' || event.type === 'finish') {
          usage = structuredClone(event.usage) as unknown as Json;
          await options.record({ attempt, startedAt, status: 'running', usage });
        }
        if (event.type === 'tool_call' || (event.type === 'finish' && event.reason !== 'stop'))
          throw new AgentError(
            event.type === 'finish' && event.reason === 'length'
              ? 'authorization_check_output_limit'
              : 'authorization_check_output_invalid',
          );
        if (event.type === 'finish') finished = true;
        events.push(event);
      }
      if (!finished) throw new AgentError('model_response_incomplete');
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
      controller.abort();
      // Cancellation and retry do not wait for an uncooperative provider, but the
      // host must retain its configuration and Store until actual adapter cleanup.
      if (failed && iterator) {
        const closing = Promise.allSettled([
          ...(pendingNext ? [pendingNext] : []),
          ...(iterator.return ? [Promise.resolve().then(() => iterator!.return!())] : []),
        ]).then(() => {});
        options.retainCleanup?.(closing);
        void closing.catch(() => {});
      }
    }
    if (options.signal.aborted) {
      // Update the in-memory final audit immediately, without making cancellation
      // wait for persistence. The owning check's terminal result also retains it.
      void options
        .record({
          attempt,
          startedAt,
          finishedAt: Date.now(),
          usage,
          status:
            options.signal.reason instanceof AgentError &&
            options.signal.reason.code === 'authorization_check_timeout'
              ? 'timed_out'
              : 'cancelled',
        })
        .catch(() => {});
      options.signal.throwIfAborted();
    }
    await options.record({
      attempt,
      startedAt,
      finishedAt: Date.now(),
      status: failed ? 'failed' : 'completed',
      usage,
      ...(failed
        ? {
            code: ModelAttemptError.isInstance(failure)
              ? failure.reason
              : failure instanceof AgentError
                ? failure.code
                : 'model_failed',
            ...(ModelAttemptError.isInstance(failure) && failure.detail
              ? { detail: failure.detail }
              : {}),
          }
        : {}),
    });
    if (failed) {
      if (!finished && attempt < 3 && retryableReviewFailure(failure)) continue;
      throw failure;
    }
    // Never join a failed prefix to a later decision. Only a complete attempt is interpreted.
    await options.checkpoint();
    options.signal.throwIfAborted();
    for (const event of events) yield event;
    return;
  }
}
