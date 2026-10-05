import { AgentError, type Json } from '../storage/types';

/** Progress is a coalesced observation, with one pending point and one write in flight. */
export function createProgressWriter(write: (content: string) => Promise<unknown>) {
  let pending: string | undefined;
  let writing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let failure: string | undefined;
  const schedule = () => {
    if (closed || failure || timer || writing || pending === undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, 100);
    timer.unref();
  };
  const flush = () => {
    if (writing) return writing;
    if (failure || pending === undefined) return Promise.resolve();
    const content = pending;
    pending = undefined;
    writing = Promise.resolve()
      .then(() => write(content))
      .then(
        () => {},
        (error) => {
          failure =
            error instanceof AgentError && /^[A-Za-z0-9_]+$/.test(error.code)
              ? error.code
              : 'progress_persistence_failed';
          pending = undefined;
        },
      )
      .finally(() => {
        writing = undefined;
        schedule();
      });
    return writing;
  };
  return {
    report(update: Json) {
      if (closed || failure) return;
      let content: string;
      try {
        content = JSON.stringify(update);
      } catch {
        throw new AgentError('invalid_progress');
      }
      if (typeof content !== 'string' || Buffer.byteLength(content) > 32768)
        throw new AgentError('progress_too_large');
      pending = content;
      schedule();
    },
    async finish() {
      closed = true;
      clearTimeout(timer);
      timer = undefined;
      await writing;
      await flush();
      return failure;
    },
  };
}
