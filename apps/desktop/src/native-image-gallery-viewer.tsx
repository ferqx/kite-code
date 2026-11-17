import {
  type ImageGalleryPresentationProps,
  ImageGallerySurface,
} from '@kite-ai/ui/desktop/image-gallery';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { NativeImageDisplayRegion } from './native-image-display-bridge';
import type {
  NativeImageGalleryState,
  NativeImageGalleryViewerBridge,
} from './native-image-gallery-bridge';
import { nativeImageGalleryEdge } from './native-image-gallery-bridge';
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
  const [detail, setDetail] = useState<ImageGalleryPresentationProps['detail']>();
  const desiredDetail = useRef<
    { requestId: string; sourceKey: string; region: NativeImageDisplayRegion } | undefined
  >(undefined);
  const detailUrls = useRef(new Map<string, string>()).current;
  const pinnedDetail = useRef<string | undefined>(undefined);
  const clearDetails = useCallback(() => {
    for (const src of detailUrls.values()) URL.revokeObjectURL(src);
    detailUrls.clear();
    pinnedDetail.current = undefined;
    desiredDetail.current = undefined;
  }, [detailUrls]);
  const requestedQuality = useRef<{ id: string; revision: string; edge: number } | undefined>(
    undefined,
  );
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
      clearDetails();
      bridge.act({ sessionId: state.sessionId, type: 'close' });
    };
    document.addEventListener('visibilitychange', hide);
    return () => {
      retired.current = true;
      document.removeEventListener('visibilitychange', hide);
      cache.dispose();
      clearDetails();
    };
  }, [bridge, cache, state.sessionId, clearDetails]);
  const { selectedId, image } = state;
  const sourceKey = image.status === 'ready' ? image.display?.key : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: exact selected source retires every crop even when IDs repeat.
  useLayoutEffect(() => {
    setDetail(undefined);
    return clearDetails;
  }, [selectedId, sourceKey, clearDetails]);
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
  const requestDetail = (region: NativeImageDisplayRegion | null) => {
    if (image.status !== 'ready' || !image.display || retired.current) return;
    const previous = desiredDetail.current;
    if (!region && !previous) return;
    const requestId = crypto.randomUUID();
    desiredDetail.current = region
      ? { requestId, sourceKey: image.display.key, region }
      : undefined;
    for (const [id, src] of detailUrls)
      if (id !== pinnedDetail.current) {
        URL.revokeObjectURL(src);
        detailUrls.delete(id);
      }
    setDetail(undefined);
    bridge.act({
      sessionId: state.sessionId,
      type: 'detail',
      id: selectedId,
      sourceKey: image.display.key,
      requestId,
      region,
    });
  };
  const incomingDetail = image.status === 'ready' ? image.detail : undefined;
  // Every delivery is checked against the latest local viewport request, including after cancellation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: delivery identifies complete admitted bytes, not transient cloned-array identity.
  useLayoutEffect(() => {
    const expected = desiredDetail.current;
    if (
      !incomingDetail ||
      !expected ||
      incomingDetail.requestId !== expected.requestId ||
      incomingDetail.sourceKey !== sourceKey ||
      JSON.stringify(incomingDetail.region) !== JSON.stringify(expected.region)
    )
      return;
    if (incomingDetail.status !== 'ready') {
      setDetail(incomingDetail);
      return;
    }
    try {
      let src = detailUrls.get(incomingDetail.requestId);
      if (!src) {
        for (const [id, url] of detailUrls)
          if (id !== pinnedDetail.current) {
            URL.revokeObjectURL(url);
            detailUrls.delete(id);
          }
        src = URL.createObjectURL(
          new Blob([incomingDetail.bytes as Uint8Array<ArrayBuffer>], {
            type: incomingDetail.mimeType,
          }),
        );
        detailUrls.set(incomingDetail.requestId, src);
      }
      setDetail({ ...incomingDetail, src });
    } catch {
      setDetail({ ...incomingDetail, status: 'error' });
    }
  }, [delivery, sourceKey]);
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
      detail={detail}
      onDetailDemand={requestDetail}
      onDetailCommit={(requestId) => {
        pinnedDetail.current = requestId;
        for (const [id, src] of detailUrls)
          if (id !== requestId) {
            URL.revokeObjectURL(src);
            detailUrls.delete(id);
          }
      }}
      onDetailError={(requestId) => {
        if (desiredDetail.current?.requestId === requestId)
          setDetail((value) =>
            value?.requestId === requestId ? { ...value, status: 'error' } : value,
          );
      }}
      onDetailRetry={() => {
        const region = desiredDetail.current?.region;
        if (region) requestDetail(region);
      }}
      display={image.status === 'ready' ? image.display : undefined}
      onDisplayDemand={(id, pixels) => {
        if (image.status !== 'ready' || !image.display || id !== selectedId) return;
        const edge = nativeImageGalleryEdge(pixels);
        const previous = requestedQuality.current;
        if (
          edge <= image.display.edge ||
          (previous?.id === id && previous.revision === image.display.key && previous.edge >= edge)
        )
          return;
        requestedQuality.current = { id, revision: image.display.key, edge };
        bridge.act({ sessionId: state.sessionId, type: 'quality', id, edge });
      }}
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
