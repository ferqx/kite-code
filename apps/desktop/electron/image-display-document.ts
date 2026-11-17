import type { NativeImageDisplayEdge } from '../src/native-image-display-bridge';
import { imageDisplayViewportScript } from './image-display-viewport';

/** Classification is presentation only; the decoder verifies the actual source format. */
export function imageDisplayMediaType(name: string, declared: string) {
  if (/^image\/(png|jpeg|webp|gif)$/.test(declared))
    return declared as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  const extension = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase();
  const value = extension === 'jpg' || extension === 'jpeg' ? 'jpeg' : extension;
  if (!value || !['png', 'jpeg', 'webp', 'gif'].includes(value))
    throw Error('preview_format_unavailable');
  return `image/${value}` as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
}

export function imageDisplayReadingEdge(
  bounds: { width: number; height: number },
  scaleFactor: number,
): NativeImageDisplayEdge {
  const pixels = Math.max(bounds.width, bounds.height) * Math.min(4, Math.max(1, scaleFactor));
  return pixels <= 1024 ? 1024 : pixels <= 2048 ? 2048 : 4096;
}

export function imageDisplayDocument(image: {
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  animated: boolean;
}) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>
body{margin:0;font:12px system-ui;overflow:auto}#image-toolbar{position:fixed;inset:0 0 auto;height:48px;display:flex;align-items:center;gap:8px;padding:4px 8px;box-sizing:border-box;background:Canvas;z-index:2;overflow:auto;white-space:nowrap}button{flex-shrink:0;font:inherit;border:1px solid GrayText;border-radius:6px;background:Canvas;color:CanvasText;padding:4px 8px}#image-stage{position:relative;margin-top:48px}#image-overview{position:absolute;inset:0;width:100%;height:100%;max-width:none}.image-region{position:absolute;pointer-events:none;max-width:none}#image-region-status{color:GrayText}#image-region-status[hidden]{display:none}</style>
<div id="image-toolbar"><button id="image-fit" type="button">适合宽度</button><button id="image-original" type="button">原始大小</button><button id="image-out" type="button" aria-label="缩小">−</button><span id="image-zoom-label"></span><button id="image-in" type="button" aria-label="放大">+</button>${image.animated ? '<span role="note">动画图片 · 首帧预览</span>' : ''}<span id="image-region-status" role="status" hidden>高清预览暂时不可用 <button id="image-region-retry" type="button">重试</button></span></div>
<div id="image-stage"><img id="image-overview" src="image" width="${image.width}" height="${image.height}" data-source-width="${image.sourceWidth}" data-source-height="${image.sourceHeight}" alt="图片预览"></div><script>${imageDisplayViewportScript(image)}</script></html>`;
}
