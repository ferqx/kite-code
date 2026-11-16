import { ImageGallerySurface } from '@kite-ai/ui/desktop/image-gallery';
import { useLayoutEffect, useRef, useState } from 'react';
import type {
  NativeImageGalleryState,
  NativeImageGalleryViewerBridge,
} from './native-image-gallery-bridge';
import { createNativeImageGalleryUrlCache } from './native-image-gallery-url-cache';

function CurrentGallery({
  state,
  delivery,
  bridge,
}: {
  state: NonNullable<NativeImageGalleryState>;
  delivery: number;
  bridge: NativeImageGalleryViewerBridge;
}) {
  const [cache] = useState(() =>
    createNativeImageGalleryUrlCache({
      create: (image) =>
        URL.createObjectURL(
          new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.mimeType }),
        ),
      revoke: (src) => URL.revokeObjectURL(src),
    }),
  );
  const [saved, setSaved] = useState<{ id: string; revision: string; src?: string }>();
  const retired = useRef(false);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.style.colorScheme = state.theme;
    document.documentElement.lang = state.language;
  }, [state.theme, state.language]);
  useLayoutEffect(() => {
    const hide = () => {
      if (!document.hidden || retired.current) return;
      retired.current = true;
      cache.dispose();
      bridge.act({ sessionId: state.sessionId, type: 'close' });
    };
    document.addEventListener('visibilitychange', hide);
    return () => {
      retired.current = true;
      document.removeEventListener('visibilitychange', hide);
      cache.dispose();
    };
  }, [bridge, cache, state.sessionId]);
  const { selectedId, image } = state;
  const revision = image.status === 'ready' ? image.revision : undefined;
  // Each new Main delivery re-admits its ready source, even if React coalesces
  // retry loading -> ready into one render with an unchanged Blob revision. The
  // cache still preserves URLs for duplicate ready/theme deliveries. Local retry
  // alone does not change delivery and cannot re-admit the previous ready DTO.
  // biome-ignore lint/correctness/useExhaustiveDependencies: delivery identifies the complete admitted DTO; cloned bytes must not reset decoding.
  useLayoutEffect(() => {
    if (retired.current) return;
    if (image.status !== 'ready') {
      cache.selecting();
      return;
    }
    try {
      setSaved({ id: selectedId, revision: image.revision, src: cache.admit(selectedId, image) });
    } catch {
      setSaved({ id: selectedId, revision: image.revision });
    }
  }, [cache, selectedId, image.status, revision, delivery]);
  const matching =
    image.status === 'ready' && saved?.id === selectedId && saved.revision === image.revision;
  const src = matching ? saved.src : undefined;
  const status =
    image.status === 'ready' ? (matching ? (src ? 'ready' : 'error') : 'loading') : image.status;
  return (
    <ImageGallerySurface
      images={state.items}
      selectedId={selectedId}
      status={status}
      src={src}
      allowDownload={false}
      canRestoreFocus={() => false}
      onImageCommit={(source) => cache.commit(source)}
      onSelectedIdChange={(id) =>
        bridge.act(
          id === null
            ? { sessionId: state.sessionId, type: 'close' }
            : { sessionId: state.sessionId, type: 'select', id },
        )
      }
      onRetry={() => {
        cache.retry(selectedId);
        setSaved(undefined);
        bridge.act({ sessionId: state.sessionId, type: 'retry' });
      }}
    />
  );
}

/** Isolated presentation only. Root/Main remain the sole source-admission owners. */
export function NativeImageGalleryViewer({ bridge }: { bridge?: NativeImageGalleryViewerBridge }) {
  const [{ state, delivery }, setState] = useState<{
    state: NativeImageGalleryState;
    delivery: number;
  }>({ state: null, delivery: 0 });
  useLayoutEffect(() => {
    if (!bridge) return;
    let active = true;
    const unwatch = bridge.watch((next) => {
      if (active) setState((previous) => ({ state: next, delivery: previous.delivery + 1 }));
    });
    bridge.ready();
    return () => {
      active = false;
      unwatch();
    };
  }, [bridge]);
  return state && bridge ? (
    <CurrentGallery key={state.sessionId} state={state} delivery={delivery} bridge={bridge} />
  ) : null;
}
