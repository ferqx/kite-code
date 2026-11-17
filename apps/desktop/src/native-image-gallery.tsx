import {
  ImageGalleryHostContext,
  type ImageGalleryPresentationProps,
  useErrorFeedback,
} from '@kite-ai/ui/desktop';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import {
  nativeImageDisplaySourceByteLimit,
  renderNativeImageDisplay,
} from './native-image-display-bridge';
import {
  type NativeImageGalleryPresentation as GalleryState,
  nativeImageGalleryEdge,
} from './native-image-gallery-bridge';

const imageMediaTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Root retains source authority. The isolated viewer receives only the active verified bytes. */
export function NativeImageGalleryPresentation(props: ImageGalleryPresentationProps) {
  const port = window.kiteNativeImageGallery;
  const sessionId = useRef(crypto.randomUUID()).current;
  const revisions = useRef(new WeakMap<Blob, string>()).current;
  const feedback = useErrorFeedback();
  const retired = useRef(false);
  const base = useRef<GalleryState | undefined>(undefined);
  const detailTask = useRef<AbortController | undefined>(undefined);
  const [quality, setQuality] = useState<{ id: string; edge: 1024 | 2048 | 4096 }>();
  const current = useRef({ ...props, feedback });
  useLayoutEffect(() => {
    current.current = { ...props, feedback };
  });
  useLayoutEffect(() => {
    if (!port) return;
    const owner = document;
    const focused = owner.activeElement;
    const unsubscribe = port.watchActions((action) => {
      if (action.sessionId !== sessionId || retired.current) return;
      if (action.type === 'detail') {
        const admitted = base.current;
        const source = current.current.blob;
        if (
          !source ||
          current.current.status !== 'ready' ||
          current.current.selectedId !== action.id ||
          revisions.get(source) !== action.sourceKey ||
          admitted?.selectedId !== action.id ||
          admitted.image.status !== 'ready' ||
          admitted.image.display?.key !== action.sourceKey
        )
          return;
        detailTask.current?.abort();
        detailTask.current = undefined;
        if (!action.region) {
          port.present(admitted);
          return;
        }
        const abort = new AbortController();
        detailTask.current = abort;
        const region = action.region;
        const publish = (detail: Extract<GalleryState['image'], { status: 'ready' }>['detail']) => {
          if (
            abort.signal.aborted ||
            detailTask.current !== abort ||
            retired.current ||
            document.hidden ||
            base.current !== admitted ||
            current.current.blob !== source ||
            current.current.selectedId !== action.id
          )
            return;
          port.present({
            ...admitted,
            image: {
              ...(admitted.image as Extract<GalleryState['image'], { status: 'ready' }>),
              detail,
            },
          });
        };
        const identity = { requestId: action.requestId, sourceKey: action.sourceKey, region };
        publish({ ...identity, status: 'loading' });
        void source
          .arrayBuffer()
          .then((buffer) => {
            abort.signal.throwIfAborted();
            return renderNativeImageDisplay({
              bytes: new Uint8Array(buffer),
              mediaType: source.type as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
              edge: 2048,
              region,
              signal: abort.signal,
            });
          })
          .then((result) =>
            publish({
              ...identity,
              status: 'ready',
              bytes: result.bytes,
              mimeType: result.mimeType,
              width: result.width,
              height: result.height,
            }),
          )
          .catch(() => publish({ ...identity, status: 'error' }));
        return;
      }
      if (['close', 'unavailable', 'select', 'retry'].includes(action.type)) {
        detailTask.current?.abort();
        detailTask.current = undefined;
      }
      if (action.type === 'unavailable') {
        retired.current = true;
        port.close(sessionId);
        current.current.feedback?.('图片预览暂时不可用，请重新打开。');
        current.current.onSelectedIdChange(null);
      } else if (action.type === 'close') {
        retired.current = true;
        current.current.onSelectedIdChange(null);
      } else if (action.type === 'quality') {
        if (action.id === current.current.selectedId)
          setQuality((previous) => ({
            id: action.id,
            edge: Math.max(previous?.id === action.id ? previous.edge : 1024, action.edge) as
              | 1024
              | 2048
              | 4096,
          }));
      } else if (action.type === 'retry') current.current.onRetry();
      else if (action.type === 'select') {
        const id = action.id;
        if (current.current.images.some((image) => image.id === id))
          current.current.onSelectedIdChange(id);
      }
    });
    const hide = () => {
      if (!owner.hidden) return;
      retired.current = true;
      detailTask.current?.abort();
      port.close(sessionId);
      current.current.onSelectedIdChange(null);
    };
    owner.addEventListener('visibilitychange', hide);
    return () => {
      owner.removeEventListener('visibilitychange', hide);
      unsubscribe();
      detailTask.current?.abort();
      port.close(sessionId);
      if (
        !owner.hidden &&
        current.current.canRestoreFocus?.() &&
        focused instanceof HTMLElement &&
        focused.isConnected &&
        !focused.closest('[hidden], [inert]')
      )
        focused.focus({ preventScroll: true });
    };
  }, [sessionId, revisions]);
  const { selectedId, status, blob } = props;
  const edge = Math.max(
    nativeImageGalleryEdge(
      Math.max(window.innerWidth, window.innerHeight) * (window.devicePixelRatio || 1),
    ),
    quality?.id === selectedId ? quality.edge : 1024,
  ) as 1024 | 2048 | 4096;
  const itemsKey = JSON.stringify(props.images);
  // Names and IDs define the presentation, not each render's temporary array identity.
  // biome-ignore lint/correctness/useExhaustiveDependencies: itemsKey contains the complete metadata; callback identity cannot restart a byte transfer.
  useLayoutEffect(() => {
    if (!port) return;
    let active = true;
    detailTask.current?.abort();
    detailTask.current = undefined;
    base.current = undefined;
    const abort = new AbortController();
    const state = {
      sessionId,
      items: props.images.map(({ id, name }) => ({ id, name: name.slice(0, 512) })),
      selectedId,
      language: 'zh' as const,
    };
    const present = (image: GalleryState['image']) => {
      if (!active || retired.current || document.hidden) return;
      base.current = { ...state, image };
      port.present(base.current);
    };
    if (status !== 'ready') present({ status });
    else if (
      !blob?.size ||
      blob.size > nativeImageDisplaySourceByteLimit ||
      !imageMediaTypes.has(blob.type)
    )
      present({ status: 'error' });
    else {
      // Loading already came from source admission/selection. Do not insert another
      // loading transition when an admitted stable Blob is ready to transfer.
      let revision = revisions.get(blob);
      if (!revision) {
        revision = crypto.randomUUID();
        revisions.set(blob, revision);
      }
      const admittedRevision = revision;
      void Promise.resolve()
        .then(() => {
          if (!active || retired.current || document.hidden) return undefined;
          return blob.arrayBuffer();
        })
        .then(async (buffer) => {
          if (!active || retired.current || !buffer) return;
          if (buffer.byteLength !== blob.size) throw Error('image_preview_bytes_invalid');
          const result = await renderNativeImageDisplay({
            bytes: new Uint8Array(buffer),
            mediaType: blob.type as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
            edge,
            signal: abort.signal,
          });
          present({
            status: 'ready',
            revision: `${admittedRevision}-${edge}`,
            mimeType: result.mimeType,
            bytes: result.bytes,
            display: {
              key: admittedRevision,
              sourceWidth: result.sourceWidth,
              sourceHeight: result.sourceHeight,
              edge,
              frame: result.frame,
            },
          });
        })
        .catch(() => present({ status: 'error' }));
    }
    return () => {
      active = false;
      detailTask.current?.abort();
      abort.abort();
    };
  }, [port, sessionId, selectedId, status, blob, itemsKey, edge]);
  return null;
}

/** An old Native preload cannot substitute a lower Root DOM dialog. */
function UnavailableNativeImageGallery(props: ImageGalleryPresentationProps) {
  const feedback = useErrorFeedback();
  const reported = useRef(false);
  useLayoutEffect(() => {
    if (reported.current) return;
    reported.current = true;
    feedback?.('图片预览功能尚未加载，请完全退出后重新启动。');
    props.onSelectedIdChange(null);
  });
  return null;
}

export function NativeImageGalleryProvider({
  children,
  nativeWindow = false,
}: {
  children: ReactNode;
  nativeWindow?: boolean;
}) {
  return (
    <ImageGalleryHostContext.Provider
      value={
        window.kiteNativeImageGallery
          ? NativeImageGalleryPresentation
          : nativeWindow
            ? UnavailableNativeImageGallery
            : null
      }
    >
      {children}
    </ImageGalleryHostContext.Provider>
  );
}
