/** Compositor readiness only. Owners must arrange safe underlay drawing and verify
 * document, geometry, window and permission identity through current(). */
export function waitForNativeFrame(input: {
  contents: {
    isDestroyed(): boolean;
    beginFrameSubscription(
      onlyDirty: boolean,
      callback: (image: {
        isEmpty(): boolean;
        getSize(): { width: number; height: number };
      }) => void,
    ): void;
    endFrameSubscription(): void;
    invalidate(): void;
  };
  bounds: { width: number; height: number };
  signal: AbortSignal;
  cancelled: Error;
  current(): boolean;
  cancel(): void;
  setStop(stop: (() => void) | undefined): void;
  ownsStop(stop: () => void): boolean;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    let subscribed = false,
      settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener('abort', abort);
      if (input.ownsStop(abort)) {
        input.setStop(undefined);
        if (subscribed && !input.contents.isDestroyed()) {
          try {
            input.contents.endFrameSubscription();
          } catch (cause) {
            error = cause;
          }
        }
      }
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(input.cancelled);
    input.setStop(abort);
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted || !input.current()) {
      input.cancel();
      abort();
      return;
    }
    try {
      subscribed = true;
      input.contents.beginFrameSubscription(false, (image) => {
        if (settled) return;
        if (!input.current()) {
          input.cancel();
          abort();
          return;
        }
        const size = image.getSize(),
          bounds = input.bounds;
        if (
          !image.isEmpty() &&
          [size.width, size.height].every(Number.isFinite) &&
          size.width >= bounds.width &&
          size.height >= bounds.height &&
          Math.abs(size.height - (size.width / bounds.width) * bounds.height) <= 2
        )
          finish();
      });
      if (!settled) input.contents.invalidate();
    } catch (cause) {
      finish(cause);
    }
  });
}
