import { renderNativeImageDisplay } from './native-image-display-bridge';
import type { ImagePreviewWorker } from './native-image-previews';

/** Worker-shaped cancellable task, not a renderer codec. Only Main decodes original bytes. */
export function createNativeImagePreviewTask(): ImagePreviewWorker {
  let controller: AbortController | undefined;
  const task: ImagePreviewWorker = {
    onmessage: null,
    onerror: null,
    terminate() {
      controller?.abort();
      controller = undefined;
    },
    postMessage(message: { id: number; source: Blob }) {
      const abort = new AbortController();
      controller = abort;
      void message.source
        .arrayBuffer()
        .then((buffer) => {
          abort.signal.throwIfAborted();
          return renderNativeImageDisplay({
            bytes: new Uint8Array(buffer),
            mediaType: message.source.type as
              | 'image/png'
              | 'image/jpeg'
              | 'image/webp'
              | 'image/gif',
            edge: 512,
            signal: abort.signal,
          });
        })
        .then((result) => {
          if (controller !== abort || abort.signal.aborted) return;
          task.onmessage?.call(
            task as Worker,
            {
              data: {
                id: message.id,
                ...result,
                blob: new Blob([result.bytes as Uint8Array<ArrayBuffer>], {
                  type: result.mimeType,
                }),
              },
            } as MessageEvent,
          );
        })
        .catch(() => {
          if (controller === abort && !abort.signal.aborted)
            task.onmessage?.call(
              task as Worker,
              { data: { id: message.id, error: 'image_preview_unavailable' } } as MessageEvent,
            );
        });
    },
  };
  return task;
}
