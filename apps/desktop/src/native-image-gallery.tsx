import {
  ImageGalleryHostContext,
  type ImageGalleryPresentationProps,
  useErrorFeedback,
} from '@kite-ai/ui/desktop';
import { type ReactNode, useLayoutEffect, useRef } from 'react';
import type { NativeImageGalleryPresentation as GalleryState } from './native-image-gallery-bridge';

const imageMediaTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Root retains source authority. The isolated viewer receives only the active verified bytes. */
export function NativeImageGalleryPresentation(props: ImageGalleryPresentationProps) {
  const port = window.kiteNativeImageGallery;
  const sessionId = useRef(crypto.randomUUID()).current;
  const revisions = useRef(new WeakMap<Blob, string>()).current;
  const feedback = useErrorFeedback();
  const retired = useRef(false);
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
      if (action.type === 'unavailable') {
        retired.current = true;
        port.close(sessionId);
        current.current.feedback?.('图片预览暂时不可用，请重新打开。');
        current.current.onSelectedIdChange(null);
      } else if (action.type === 'close') {
        retired.current = true;
        current.current.onSelectedIdChange(null);
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
      port.close(sessionId);
      current.current.onSelectedIdChange(null);
    };
    owner.addEventListener('visibilitychange', hide);
    return () => {
      owner.removeEventListener('visibilitychange', hide);
      unsubscribe();
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
  }, [sessionId]);
  const { selectedId, status, blob } = props;
  const itemsKey = JSON.stringify(props.images);
  // Names and IDs define the presentation, not each render's temporary array identity.
  // biome-ignore lint/correctness/useExhaustiveDependencies: itemsKey contains the complete metadata; callback identity cannot restart a byte transfer.
  useLayoutEffect(() => {
    if (!port) return;
    let active = true;
    const state = {
      sessionId,
      items: props.images.map(({ id, name }) => ({ id, name: name.slice(0, 512) })),
      selectedId,
      language: 'zh' as const,
    };
    const present = (image: GalleryState['image']) => {
      if (!active || retired.current || document.hidden) return;
      port.present({ ...state, image });
    };
    if (status !== 'ready') present({ status });
    else if (!blob?.size || blob.size > 16 * 1024 * 1024 || !imageMediaTypes.has(blob.type))
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
        .then((buffer) => {
          if (!active || retired.current || !buffer) return;
          if (buffer.byteLength !== blob.size) throw Error('image_preview_bytes_invalid');
          present({
            status: 'ready',
            revision: admittedRevision,
            mimeType: blob.type as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
            bytes: new Uint8Array(buffer),
          });
        })
        .catch(() => present({ status: 'error' }));
    }
    return () => {
      active = false;
    };
  }, [port, sessionId, selectedId, status, blob, itemsKey]);
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
