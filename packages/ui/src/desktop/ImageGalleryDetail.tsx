import { useLayoutEffect, useRef, useState } from 'react';
export type ImageGalleryRegion = { left: number; top: number; width: number; height: number };
export type ImageGalleryDetailValue = {
  requestId: string;
  sourceKey: string;
  region: ImageGalleryRegion;
  status: 'loading' | 'ready' | 'error';
  src?: string;
};
/** The viewport is measured against the oriented source stage, never encoded-file EXIF axes. */
export function imageGalleryRegion(
  stage: { left: number; top: number; width: number; height: number },
  viewport: { left: number; top: number; width: number; height: number },
  sourceWidth: number,
  sourceHeight: number,
): ImageGalleryRegion | null {
  if (stage.width <= 0 || stage.height <= 0) return null;
  const left = Math.max(0, Math.floor(((viewport.left - stage.left) / stage.width) * sourceWidth));
  const top = Math.max(0, Math.floor(((viewport.top - stage.top) / stage.height) * sourceHeight));
  const right = Math.min(
    sourceWidth,
    Math.ceil(((viewport.left + viewport.width - stage.left) / stage.width) * sourceWidth),
  );
  const bottom = Math.min(
    sourceHeight,
    Math.ceil(((viewport.top + viewport.height - stage.top) / stage.height) * sourceHeight),
  );
  return right > left && bottom > top
    ? { left, top, width: right - left, height: bottom - top }
    : null;
}
export function imageGalleryNeedsDetail(
  sourceWidth: number,
  sourceHeight: number,
  overviewEdge: number,
  pixelDemand: number,
) {
  return Math.max(sourceWidth, sourceHeight) > overviewEdge && pixelDemand > overviewEdge * 1.05;
}

/** One committed crop plus a hidden candidate. The owning viewer bounds/revokes their URLs. */
export function ImageGalleryDetail(props: {
  sourceKey: string;
  sourceWidth: number;
  sourceHeight: number;
  overviewEdge: number;
  viewport: HTMLDivElement | null;
  geometryKey: string;
  value?: ImageGalleryDetailValue;
  demand(region: ImageGalleryRegion | null): void;
  commit(requestId: string): void;
  fail(requestId: string): void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [committed, setCommitted] = useState<ImageGalleryDetailValue>();
  const current = useRef(props);
  current.current = props;
  const expected = useRef<string | null>(null);
  const mounted = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: zoom/layout changes invalidate measured source coordinates.
  useLayoutEffect(() => {
    mounted.current = true;
    const viewport = props.viewport;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      if (timer) clearTimeout(timer);
      expected.current = null;
      current.current.demand(null); // Abort obsolete in-flight bytes immediately, before debounce.
      timer = setTimeout(() => {
        const node = surface.current;
        if (!node || !viewport) return;
        const stage = node.getBoundingClientRect(),
          view = viewport.getBoundingClientRect(),
          p = current.current;
        const pixelDemand = Math.max(stage.width, stage.height) * (window.devicePixelRatio || 1);
        if (!imageGalleryNeedsDetail(p.sourceWidth, p.sourceHeight, p.overviewEdge, pixelDemand))
          return;
        const region = imageGalleryRegion(
          stage,
          {
            left: view.left + viewport.clientLeft,
            top: view.top + viewport.clientTop,
            width: viewport.clientWidth,
            height: viewport.clientHeight,
          },
          p.sourceWidth,
          p.sourceHeight,
        );
        if (!region) return;
        expected.current = JSON.stringify(region);
        p.demand(region);
      }, 150);
    };
    viewport?.addEventListener('scroll', changed, { passive: true });
    window.addEventListener('resize', changed);
    changed();
    return () => {
      mounted.current = false;
      if (timer) clearTimeout(timer);
      viewport?.removeEventListener('scroll', changed);
      window.removeEventListener('resize', changed);
      current.current.demand(null);
    };
  }, [props.viewport, props.geometryKey]);
  useLayoutEffect(() => {
    if (committed) current.current.commit(committed.requestId);
  }, [committed]);
  const incoming =
    props.value?.status === 'ready' && props.value.src && props.value.sourceKey === props.sourceKey
      ? props.value
      : undefined;
  const candidate = incoming?.requestId !== committed?.requestId ? incoming : undefined;
  const accepts = (value: ImageGalleryDetailValue) =>
    mounted.current &&
    current.current.value?.requestId === value.requestId &&
    expected.current === JSON.stringify(value.region) &&
    current.current.sourceKey === value.sourceKey;
  return (
    <div
      ref={surface}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      data-image-detail-source={props.sourceKey}
    >
      {[...(committed ? [committed] : []), ...(candidate ? [candidate] : [])].map((value) => (
        <img
          key={value.requestId}
          className="image-gallery-detail"
          alt=""
          aria-hidden="true"
          src={value.src}
          style={{
            position: 'absolute',
            left: `${(value.region.left / props.sourceWidth) * 100}%`,
            top: `${(value.region.top / props.sourceHeight) * 100}%`,
            width: `${(value.region.width / props.sourceWidth) * 100}%`,
            height: `${(value.region.height / props.sourceHeight) * 100}%`,
            maxWidth: 'none',
            maxHeight: 'none',
            visibility: value === committed ? 'visible' : 'hidden',
          }}
          onLoad={(event) => {
            const image = event.currentTarget;
            void (typeof image.decode === 'function' ? image.decode() : Promise.resolve())
              .then(() => {
                if (!accepts(value)) return;
                if (!image.naturalWidth || !image.naturalHeight) {
                  props.fail(value.requestId);
                  return;
                }
                setCommitted(value);
              })
              .catch(() => {
                if (accepts(value)) props.fail(value.requestId);
              });
          }}
          onError={() => {
            if (accepts(value)) props.fail(value.requestId);
          }}
        />
      ))}
    </div>
  );
}
