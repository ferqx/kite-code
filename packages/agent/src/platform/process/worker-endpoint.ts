import { parentPort } from 'node:worker_threads';

/** Dedicated worker endpoint backed by the original worker's private parent port. */
export function workerEndpoint<Input = unknown, Output = unknown>() {
  const port = parentPort;
  if (!port) throw Error('worker_parent_unavailable');
  let listener: ((data: Input) => void) | undefined;
  return {
    set onmessage(handler: ((event: MessageEvent<Input>) => void) | null) {
      if (listener) port.off('message', listener);
      listener = handler ? (data) => handler(new MessageEvent('message', { data })) : undefined;
      if (listener) port.on('message', listener);
    },
    postMessage(value: Output) {
      port.postMessage(value);
    },
  };
}
