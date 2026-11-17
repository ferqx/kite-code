import {
  Add01Icon,
  ArrowLeft02Icon,
  ArrowRight02Icon,
  Cancel01Icon,
  Download04Icon,
  Remove01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type ComponentType,
  type CSSProperties,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useConversationReadActive } from '../conversation-activity';
import { Dialog, DialogClose, DialogContent, DialogTitle } from './components/ui/dialog';
import { Spinner } from './components/ui/spinner';
import {
  ImageGalleryDetail,
  type ImageGalleryDetailValue,
  type ImageGalleryRegion,
} from './ImageGalleryDetail';
import { useReadGate } from './ReadGate';

/** The host admits the image. The gallery never fetches paths or remote URLs. */
export type ImagePreviewSource =
  | { src: string; load?: never }
  | { load: (signal: AbortSignal) => Promise<Blob>; src?: never };

export interface ImageGalleryItem {
  id: string;
  name: string;
  /** Missing originals retain their place in the group and show an unavailable state. */
  source?: ImagePreviewSource;
}

export interface ImageGalleryProps {
  images: readonly ImageGalleryItem[];
  selectedId: string | null;
  onSelectedIdChange: (id: string | null) => void;
  /** Changes revoke this presentation, even if the next group reuses image IDs. */
  scopeKey?: string;
  disabled?: boolean;
}

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const imageMime = /^image\/(?:png|jpeg|webp|gif)$/i;

function localImageSource(src: string) {
  if (/^blob:/i.test(src)) return true;
  if (src.length > 64 + Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return false;
  const data = /^data:image\/(?:png|jpeg|webp|gif);base64,([a-z\d+/]*={0,2})$/i.exec(src);
  if (!data?.[1] || data[1].length % 4 !== 0) return false;
  const padding = data[1].endsWith('==') ? 2 : data[1].endsWith('=') ? 1 : 0;
  return (data[1].length * 3) / 4 - padding <= MAX_IMAGE_BYTES;
}

type LoadedImage = {
  id: string;
  load: ImagePreviewSource['load'];
  src: string | undefined;
  url?: string;
  blob?: Blob;
  failed?: boolean;
};

export interface ImageGalleryPresentationProps {
  images: readonly Pick<ImageGalleryItem, 'id' | 'name'>[];
  selectedId: string;
  onSelectedIdChange: (id: string | null) => void;
  status: 'loading' | 'error' | 'ready';
  /** Explicit retry may re-decode the same admitted local URL. */
  sourceKey?: number;
  /** Renderer-local admitted URL, never a filesystem or remote URL. */
  src?: string;
  /** Hosts receive admitted source bytes and must derive display pixels before rendering. */
  blob?: Blob;
  onRetry: () => void;
  canRestoreFocus?: () => boolean;
  /** Restricted Native renderers cannot initiate browser downloads. */
  allowDownload?: boolean;
  /** Runs after the decoded image and its caption commit together. */
  onImageCommit?: (src: string) => void;
  /** Native derivative metadata; stable key preserves zoom/pan across quality upgrades. */
  display?: {
    key: string;
    sourceWidth: number;
    sourceHeight: number;
    frame: 'first' | 'static';
    edge?: number;
  };
  detail?: ImageGalleryDetailValue;
  onDetailDemand?: (region: ImageGalleryRegion | null) => void;
  onDetailCommit?: (requestId: string) => void;
  onDetailError?: (requestId: string) => void;
  onDetailRetry?: () => void;
  onDisplayDemand?: (id: string, pixels: number) => void;
}

/** Native may supply its existing full-window transparent presentation host. */
export const ImageGalleryHostContext =
  createContext<ComponentType<ImageGalleryPresentationProps> | null>(null);

type GroupImageIdentity = {
  id: string;
  name: string;
  load: ImagePreviewSource['load'];
  src: string | undefined;
};
function groupIdentity(images: readonly ImageGalleryItem[]): GroupImageIdentity[] {
  return images.map(({ id, name, source }) => ({ id, name, load: source?.load, src: source?.src }));
}
function sameGroup(before: readonly GroupImageIdentity[], images: readonly ImageGalleryItem[]) {
  return (
    before.length === images.length &&
    before.every((prior, index) => {
      const image = images[index]!;
      return (
        prior.id === image.id &&
        prior.name === image.name &&
        prior.load === image.source?.load &&
        prior.src === image.source?.src
      );
    })
  );
}

/** One controlled gallery belongs to one draft, user message or tool-result group. */
export function ImageGallery(props: ImageGalleryProps) {
  const readActive = useConversationReadActive();
  const gated = useReadGate();
  const previousScope = useRef(props.scopeKey);
  const previousGroup = useRef(groupIdentity(props.images));
  const groupChanged = !sameGroup(previousGroup.current, props.images);
  const scopeChanged = previousScope.current !== props.scopeKey;
  const index = props.images.findIndex((image) => image.id === props.selectedId);
  const permitted = !props.disabled && readActive && !gated;
  const visible = permitted && !scopeChanged && !groupChanged && index >= 0;
  const current = useRef({ scope: props.scopeKey, permitted });
  current.current = { scope: props.scopeKey, permitted };
  useLayoutEffect(() => {
    previousScope.current = props.scopeKey;
    previousGroup.current = groupIdentity(props.images);
    if (props.selectedId !== null && (!permitted || scopeChanged || groupChanged || index < 0))
      props.onSelectedIdChange(null);
  }, [
    props.scopeKey,
    props.selectedId,
    props.onSelectedIdChange,
    permitted,
    scopeChanged,
    groupChanged,
    index,
    props.images,
  ]);
  if (!visible) return null;
  return (
    <GalleryPresentation
      key={props.scopeKey}
      {...props}
      index={index}
      canRestoreFocus={() => current.current.permitted && current.current.scope === props.scopeKey}
    />
  );
}

function GalleryPresentation({
  images,
  index,
  onSelectedIdChange,
  canRestoreFocus,
}: ImageGalleryProps & { index: number; canRestoreFocus: () => boolean }) {
  const image = images[index]!;
  const load = image.source?.load;
  const src = image.source?.src;
  const [loaded, setLoaded] = useState<LoadedImage>();
  const [retry, setRetry] = useState(0);
  const Host = useContext(ImageGalleryHostContext);
  const matching = loaded?.id === image.id && loaded?.load === load && loaded?.src === src;
  const url = matching ? loaded?.url : undefined;
  const nativePresentation = Host !== null;
  const status =
    matching && loaded?.failed ? 'error' : matching && (loaded?.blob || url) ? 'ready' : 'loading';

  // biome-ignore lint/correctness/useExhaustiveDependencies: Selection and retry must reset even for shared source primitives.
  useLayoutEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setLoaded({ id: image.id, load, src });
    if (load) {
      void Promise.resolve()
        .then(() => (controller.signal.aborted ? undefined : load(controller.signal)))
        .then((blob) => {
          if (controller.signal.aborted || !blob) return;
          if (
            !blob.size ||
            (!nativePresentation && blob.size > MAX_IMAGE_BYTES) ||
            !imageMime.test(blob.type)
          )
            throw Error('image_preview_unavailable');
          if (!nativePresentation) objectUrl = URL.createObjectURL(blob);
          setLoaded({ id: image.id, load, src, url: objectUrl, blob });
        })
        .catch(() => {
          if (!controller.signal.aborted) setLoaded({ id: image.id, load, src, failed: true });
        });
    } else if (src && localImageSource(src)) {
      setLoaded({ id: image.id, load, src, url: src });
    } else {
      setLoaded({ id: image.id, load, src, failed: true });
    }
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [image.id, load, src, retry, nativePresentation]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onSelectedIdChange(null);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [onSelectedIdChange]);

  const Surface = Host ?? ImageGallerySurface;
  return (
    <Surface
      images={images}
      selectedId={image.id}
      onSelectedIdChange={onSelectedIdChange}
      status={status}
      sourceKey={retry}
      src={url}
      blob={matching ? loaded?.blob : undefined}
      onRetry={() => setRetry((value) => value + 1)}
      canRestoreFocus={canRestoreFocus}
    />
  );
}

type GalleryBuffer = {
  token: number;
  id: string;
  name: string;
  index: number;
  total: number;
  src: string;
  sourceKey: number | undefined;
  width?: number;
  height?: number;
  display?: ImageGalleryPresentationProps['display'];
};

/** Presentation-only surface reused by the isolated Native viewer renderer. */
export function ImageGallerySurface({
  images,
  selectedId,
  onSelectedIdChange,
  status,
  sourceKey,
  src,
  onRetry,
  canRestoreFocus = () => true,
  allowDownload = true,
  onImageCommit,
  display,
  onDisplayDemand,
  detail,
  onDetailDemand,
  onDetailCommit,
  onDetailError,
  onDetailRetry,
}: ImageGalleryPresentationProps) {
  const index = images.findIndex((image) => image.id === selectedId);
  const image = images[index];
  const url = src && localImageSource(src) ? src : undefined;
  const [committed, setCommitted] = useState<GalleryBuffer>();
  const committedRef = useRef<GalleryBuffer | undefined>(undefined);
  const [failedToken, setFailedToken] = useState<number>();
  const [zoom, setZoom] = useState(1);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const content = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const restoreTarget = useRef<HTMLElement | null>(null);
  const focusAllowed = useRef(canRestoreFocus);
  focusAllowed.current = canRestoreFocus;
  const commitCallback = useRef(onImageCommit);
  commitCallback.current = onImageCommit;
  const mounted = useRef(true);
  const request = useRef({ selectedId, sourceKey, url, status, token: 0 });
  if (
    request.current.selectedId !== selectedId ||
    request.current.sourceKey !== sourceKey ||
    request.current.url !== url ||
    request.current.status !== status
  ) {
    request.current = { selectedId, sourceKey, url, status, token: request.current.token + 1 };
  }
  const token = request.current.token;
  const failed = status === 'error' || (status === 'ready' && (!url || failedToken === token));
  const ready =
    status === 'ready' &&
    !failed &&
    !!committed &&
    committed.id === selectedId &&
    committed.src === url &&
    committed.sourceKey === sourceKey;
  const candidate: GalleryBuffer | undefined =
    !ready && !failed && status === 'ready' && url && image
      ? {
          token,
          id: selectedId,
          name: image.name,
          index,
          total: images.length,
          src: url,
          sourceKey,
          display,
        }
      : undefined;
  const candidateRef = useRef<GalleryBuffer | undefined>(undefined);
  const activeRequest = useRef(request.current);
  const requested = request.current;
  useLayoutEffect(() => {
    candidateRef.current = candidate;
    activeRequest.current = requested;
  });

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      candidateRef.current = undefined;
      committedRef.current = undefined;
    };
  }, []);

  const previousDisplay = useRef<GalleryBuffer | undefined>(undefined);
  useLayoutEffect(() => {
    if (!committed) return;
    const previous = previousDisplay.current;
    previousDisplay.current = committed;
    const qualityUpgrade =
      previous?.id === committed.id &&
      previous.display?.key &&
      previous.display.key === committed.display?.key;
    if (viewport.current && !qualityUpgrade) {
      viewport.current.scrollTop = 0;
      viewport.current.scrollLeft = 0;
    }
    commitCallback.current?.(committed.src);
  }, [committed]);

  const viewportRef = useCallback((element: HTMLDivElement | null) => {
    viewport.current = element;
    if (!element) return;
    const measure = () =>
      setViewportSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    const owner = element.ownerDocument.defaultView;
    owner?.addEventListener('resize', measure);
    return () => {
      viewport.current = null;
      observer?.disconnect();
      owner?.removeEventListener('resize', measure);
    };
  }, []);

  const demandCallback = useRef(onDisplayDemand);
  demandCallback.current = onDisplayDemand;
  useEffect(() => {
    if (!committed?.width || !committed.height || committed.id !== selectedId) return;
    const fit = Math.min(
      viewportSize.width / committed.width,
      viewportSize.height / committed.height,
      1,
    );
    if (fit > 0)
      demandCallback.current?.(
        committed.id,
        Math.max(committed.width, committed.height) * fit * zoom * (window.devicePixelRatio || 1),
      );
  }, [committed, selectedId, viewportSize, zoom]);

  if (!image) return null;

  const select = (next: number) => {
    if (next >= 0 && next < images.length) onSelectedIdChange(images[next]!.id);
  };
  const currentCandidate = (buffer: GalleryBuffer) =>
    mounted.current &&
    candidateRef.current?.token === buffer.token &&
    activeRequest.current.token === buffer.token;
  const commit = (buffer: GalleryBuffer, element: HTMLImageElement) => {
    const publish = () => {
      if (!currentCandidate(buffer)) return;
      if (!element.naturalWidth || !element.naturalHeight) {
        setFailedToken(buffer.token);
        return;
      }
      const next = {
        ...buffer,
        width: buffer.display?.sourceWidth ?? element.naturalWidth,
        height: buffer.display?.sourceHeight ?? element.naturalHeight,
      };
      const previous = committedRef.current;
      const qualityUpgrade =
        previous?.id === next.id &&
        previous.display?.key &&
        previous.display.key === next.display?.key;
      committedRef.current = next;
      setCommitted(next);
      if (!qualityUpgrade) setZoom(1);
    };
    if (typeof element.decode === 'function') {
      void element
        .decode()
        .then(publish)
        .catch(() => {
          if (currentCandidate(buffer)) setFailedToken(buffer.token);
        });
    } else publish();
  };
  const fail = (buffer: GalleryBuffer) => {
    const current = activeRequest.current;
    if (
      !mounted.current ||
      current.status !== 'ready' ||
      current.selectedId !== buffer.id ||
      current.url !== buffer.src ||
      current.sourceKey !== buffer.sourceKey
    )
      return;
    if (currentCandidate(buffer) || committedRef.current?.token === buffer.token)
      setFailedToken(current.token);
  };
  const fitScale =
    committed?.width && committed.height
      ? Math.min(viewportSize.width / committed.width, viewportSize.height / committed.height, 1)
      : 1;
  const zoomLimit = display && fitScale > 0 ? Math.max(4, 2 / fitScale) : 4;
  const caption = committed ?? {
    name: image.name,
    index,
    total: images.length,
    display: undefined,
  };
  const qualityPending =
    !!candidate?.display?.key &&
    candidate.id === committed?.id &&
    candidate.display.key === committed.display?.key;
  const buffers = [...(committed ? [committed] : []), ...(candidate ? [candidate] : [])];

  return (
    <Dialog open onOpenChange={(open) => !open && onSelectedIdChange(null)}>
      <DialogContent
        ref={content}
        className="image-gallery-dialog translate-x-0 translate-y-0"
        showCloseButton={false}
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const active = content.current?.ownerDocument.activeElement;
          restoreTarget.current = active instanceof HTMLElement ? active : null;
          close.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = restoreTarget.current;
          if (focusAllowed.current() && target?.isConnected && !target.closest('[hidden], [inert]'))
            target.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            event.stopPropagation();
            select(index + (event.key === 'ArrowLeft' ? -1 : 1));
          }
        }}
      >
        <DialogTitle className="sr-only">图片预览：{caption.name}</DialogTitle>
        <div className="image-gallery-toolbar">
          <span className="image-gallery-caption" aria-live="polite">
            <span title={caption.name}>{caption.name}</span>
            {caption.display?.frame === 'first' && <span>动画首帧</span>}
            <span>
              {caption.index + 1} / {caption.total}
            </span>
          </span>
          {allowDownload &&
            (ready ? (
              <a
                className="image-gallery-control"
                href={committed?.src}
                download={caption.name}
                aria-label="下载图片"
                title="下载图片"
              >
                <HugeiconsIcon icon={Download04Icon} aria-hidden="true" />
              </a>
            ) : (
              <button
                className="image-gallery-control"
                type="button"
                disabled
                aria-label="下载图片"
                title="下载图片"
              >
                <HugeiconsIcon icon={Download04Icon} aria-hidden="true" />
              </button>
            ))}
          <DialogClose asChild>
            <button
              ref={close}
              className="image-gallery-control"
              type="button"
              aria-label="关闭图片预览"
              title="关闭"
            >
              <HugeiconsIcon icon={Cancel01Icon} aria-hidden="true" />
            </button>
          </DialogClose>
        </div>
        {images.length > 1 && (
          <button
            className="image-gallery-control image-gallery-previous"
            type="button"
            disabled={index === 0}
            onClick={() => select(index - 1)}
            aria-label="上一张图片"
            title="上一张图片"
          >
            <HugeiconsIcon icon={ArrowLeft02Icon} aria-hidden="true" />
          </button>
        )}
        <div className="image-gallery-viewport" ref={viewportRef} aria-busy={!ready && !failed}>
          {buffers.map((buffer) => {
            const displayed = buffer === committed;
            let size: CSSProperties | undefined;
            if (
              displayed &&
              buffer.width &&
              buffer.height &&
              viewportSize.width > 0 &&
              viewportSize.height > 0
            ) {
              const fit = Math.min(
                viewportSize.width / buffer.width,
                viewportSize.height / buffer.height,
                1,
              );
              size = { width: buffer.width * fit * zoom, height: buffer.height * fit * zoom };
            }
            return (
              <div
                key={buffer.token}
                className={`image-gallery-stage${displayed ? '' : ' image-gallery-candidate'}`}
                style={{ ...size, position: 'relative' }}
                aria-hidden={!displayed || undefined}
              >
                <img
                  className="image-gallery-image"
                  src={buffer.src}
                  alt={buffer.name}
                  draggable={false}
                  decoding="async"
                  onLoad={(event) => commit(buffer, event.currentTarget)}
                  onError={() => fail(buffer)}
                />
                {displayed &&
                  status === 'ready' &&
                  buffer.id === selectedId &&
                  buffer.display?.key === display?.key &&
                  display &&
                  onDetailDemand && (
                    <ImageGalleryDetail
                      key={`${buffer.id}/${display.key}`}
                      sourceKey={display.key}
                      sourceWidth={display.sourceWidth}
                      sourceHeight={display.sourceHeight}
                      overviewEdge={display.edge ?? 4096}
                      viewport={viewport.current}
                      geometryKey={`${zoom}/${viewportSize.width}/${viewportSize.height}`}
                      value={detail}
                      demand={onDetailDemand}
                      commit={onDetailCommit ?? (() => {})}
                      fail={onDetailError ?? (() => {})}
                    />
                  )}
              </div>
            );
          })}
          {!ready && !qualityPending && (
            <div
              className={`image-gallery-status${committed ? ' image-gallery-transition-status' : ''}`}
              role={failed ? 'alert' : 'status'}
            >
              {failed ? (
                <>
                  <span>图片预览不可用</span>
                  <span>
                    {image.name} · {index + 1} / {images.length}
                  </span>
                  <button className="image-gallery-retry" type="button" onClick={onRetry}>
                    重试
                  </button>
                </>
              ) : (
                <>
                  <Spinner aria-label="加载图片" />
                  {committed && (
                    <span>
                      {image.name} · {index + 1} / {images.length}
                    </span>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        {images.length > 1 && (
          <button
            className="image-gallery-control image-gallery-next"
            type="button"
            disabled={index === images.length - 1}
            onClick={() => select(index + 1)}
            aria-label="下一张图片"
            title="下一张图片"
          >
            <HugeiconsIcon icon={ArrowRight02Icon} aria-hidden="true" />
          </button>
        )}
        {detail?.status === 'error' && (
          <div role="alert" className="image-gallery-detail-error">
            高清预览不可用{' '}
            <button type="button" onClick={onDetailRetry}>
              重试高清预览
            </button>
          </div>
        )}
        <fieldset className="image-gallery-zoom" aria-label="图片缩放">
          <button
            className="image-gallery-control"
            type="button"
            disabled={(!ready && !qualityPending) || zoom <= 0.25}
            onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))}
            aria-label="缩小图片"
            title="缩小"
          >
            <HugeiconsIcon icon={Remove01Icon} aria-hidden="true" />
          </button>
          <button
            className="image-gallery-zoom-reset"
            type="button"
            disabled={!ready && !qualityPending}
            onClick={() => setZoom(1)}
            aria-label="重置图片缩放"
            title={display ? '还原适应窗口' : '重置缩放'}
          >
            {display
              ? zoom === 1
                ? '适应'
                : `${Math.round(fitScale * zoom * 100)}%`
              : `${Math.round(zoom * 100)}%`}
          </button>
          <button
            className="image-gallery-control"
            type="button"
            disabled={(!ready && !qualityPending) || zoom >= zoomLimit}
            onClick={() =>
              setZoom((value) =>
                Math.min(zoomLimit, value + (display ? Math.max(0.25, value / 4) : 0.25)),
              )
            }
            aria-label="放大图片"
            title="放大"
          >
            <HugeiconsIcon icon={Add01Icon} aria-hidden="true" />
          </button>
          {display && (
            <button
              type="button"
              className="image-gallery-zoom-reset"
              aria-label="原始大小"
              disabled={!ready || fitScale <= 0}
              onClick={() => setZoom(1 / fitScale)}
            >
              原始大小
            </button>
          )}
        </fieldset>
      </DialogContent>
    </Dialog>
  );
}
