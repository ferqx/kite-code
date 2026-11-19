import { useEffect, useRef, useState } from 'react';
import {
  type ImageZoomChoice,
  type ImageZoomControl,
  type ImageZoomState,
  imageZoomChoices,
} from './image-zoom';
import type { NativeBridge } from './native-bridge';
import { PreviewIcon } from './native-office-toolbar';

/** The image viewport owns actual scale, scrolling, pixel mapping and ROI. The Root only presents its controls. */
export function NativeImageZoom({
  bridge,
  previewId,
  generation,
  onIssue,
}: {
  bridge?: NativeBridge;
  previewId?: string;
  generation: number;
  onIssue: (issue: string) => void;
}) {
  const node = useRef<HTMLSpanElement>(null);
  const dispatch = useRef<((choice: ImageZoomChoice) => void) | undefined>(undefined);
  const [state, setState] = useState<ImageZoomState>();
  useEffect(() => {
    setState(undefined);
    if (!bridge || !previewId) return;
    let live = true,
      tail = Promise.resolve(),
      resizeTimer: ReturnType<typeof setTimeout>;
    const run = (value: ImageZoomControl['value']) => {
      tail = tail
        .then(async () => {
          if (!live) return;
          const result = await bridge.request({
            method: 'outputs.preview.control',
            generation,
            previewId,
            control: { kind: 'image-zoom', value },
          });
          if (!live) return;
          if (
            !result ||
            !('kind' in result) ||
            result.kind !== 'outputs.preview.imageZoom' ||
            !('zoom' in result)
          )
            throw Error('preview_control_invalid');
          setState(result.zoom);
          if (value !== 'state') onIssue('');
        })
        .catch(() => {
          if (live && value !== 'state') onIssue('图片缩放未完成，请重试。');
        });
    };
    dispatch.current = run;
    run('state');
    // Fit and the minimum can change when the native viewport resizes.
    const Observer = node.current?.ownerDocument.defaultView?.ResizeObserver;
    const panel = node.current?.closest('.native-file-preview');
    const observer = Observer
      ? new Observer(() => {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => run('state'), 140);
        })
      : undefined;
    if (panel) observer?.observe(panel);
    return () => {
      live = false;
      dispatch.current = undefined;
      observer?.disconnect();
      clearTimeout(resizeTimer);
    };
  }, [bridge, previewId, generation, onIssue]);
  const percent = state
    ? `${state.scale < 0.01 ? (100 * state.scale).toFixed(1) : Math.round(100 * state.scale)}%`
    : '';
  const selected = !state || state.fit ? 'fit' : String(state.scale);
  const custom = !imageZoomChoices.includes(selected as ImageZoomChoice);
  return (
    <span ref={node} className="native-preview-zoom">
      <select
        className="ui-form-control"
        aria-label="图片缩放"
        title={state?.fit ? `适合宽度（${percent}）` : `图片缩放：${percent}`}
        disabled={!previewId}
        value={selected}
        onChange={(e) => dispatch.current?.(e.currentTarget.value as ImageZoomChoice)}
      >
        <option value="fit">适应</option>
        <option value="out" disabled={!!state && state.scale <= state.minimum}>
          缩小
        </option>
        <option value="in" disabled={state?.scale === 8}>
          放大
        </option>
        {imageZoomChoices.slice(3).map((v) => (
          <option key={v} value={v}>
            {v === '1' ? '100% 原始大小' : `${Number(v) * 100}%`}
          </option>
        ))}
        {custom && (
          <option value={selected} hidden>
            {percent}
          </option>
        )}
      </select>
      <PreviewIcon name="down" />
    </span>
  );
}
