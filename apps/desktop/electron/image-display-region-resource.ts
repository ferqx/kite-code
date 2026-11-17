import type { NativeImageDisplayMediaType } from '../src/native-image-display-bridge';
import { renderImageDisplay } from './image-display-service';
import { imageDisplayRegionRequest } from './image-display-viewport';

/** One authorized preview's coordinate-only resource. It cannot name or acquire another file. */
export function createImageDisplayRegionResource(input: {
  origin: string;
  source: string;
  mediaType: NativeImageDisplayMediaType;
  width: number;
  height: number;
  signal: AbortSignal;
  check(): void;
  verifyAccess?: () => Promise<void>;
  render?: typeof renderImageDisplay;
}) {
  const origin = new URL(input.origin);
  let latest = 0;
  let active: AbortController | undefined;
  const parse = (value: string) => {
    try {
      const url = new URL(value);
      if (
        url.protocol !== origin.protocol ||
        url.host !== origin.host ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return undefined;
      return imageDisplayRegionRequest(url.pathname, input);
    } catch {
      return undefined;
    }
  };
  return {
    accepts: (url: string) => !!parse(url),
    async load(url: string, requestSignal: AbortSignal) {
      const request = parse(url);
      if (!request || request.serial <= latest) throw Error('image_region_stale');
      input.check();
      input.signal.throwIfAborted();
      requestSignal.throwIfAborted();
      latest = request.serial;
      active?.abort();
      const controller = new AbortController();
      active = controller;
      const abort = () => controller.abort();
      input.signal.addEventListener('abort', abort, { once: true });
      requestSignal.addEventListener('abort', abort, { once: true });
      const current = () => {
        controller.signal.throwIfAborted();
        input.signal.throwIfAborted();
        requestSignal.throwIfAborted();
        input.check();
        if (active !== controller || request.serial !== latest) throw Error('image_region_stale');
      };
      try {
        current();
        await input.verifyAccess?.();
        current();
        const display = await (input.render ?? renderImageDisplay)({
          source: { path: input.source },
          mediaType: input.mediaType,
          edge: 2048,
          region: request.region,
          signal: controller.signal,
        });
        current();
        await input.verifyAccess?.();
        current();
        return display;
      } finally {
        input.signal.removeEventListener('abort', abort);
        requestSignal.removeEventListener('abort', abort);
        if (active === controller) active = undefined;
      }
    },
  };
}
