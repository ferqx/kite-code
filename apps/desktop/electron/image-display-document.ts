import type { NativeImageDisplayEdge } from '../src/native-image-display-bridge';
import { imageDisplayToolbarHeight, imageDisplayViewportScript } from './image-display-viewport';
import { isolatedPreviewChromeCss } from './isolated-preview-chrome';

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

export function imageDisplayDocument(
  image: {
    width: number;
    height: number;
    sourceWidth: number;
    sourceHeight: number;
    animated: boolean;
  },
  hosted = false,
) {
  return `<!doctype html><html lang="zh-CN" class="kite-file-preview-chrome${hosted ? ' hosted-image' : ''}"><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>
${isolatedPreviewChromeCss}
body{margin:0;font:13px/1.4 var(--office-font);background:var(--office-background);overflow:auto}
#image-toolbar{position:fixed;inset:0 0 auto;height:${imageDisplayToolbarHeight}px;display:flex;align-items:center;justify-content:safe center;gap:12px;padding:6px 8px;box-sizing:border-box;background:var(--office-background);z-index:2;overflow:auto}
.image-controls{display:flex;flex:none;padding:1px 4px;border:1px solid color-mix(in srgb,var(--office-foreground) 8%,transparent);border-radius:999px;background:color-mix(in srgb,var(--office-foreground) var(--tool-fill),var(--office-background));--tool-fill:6%;--tool-hover:12%}
@media(prefers-color-scheme:dark){.image-controls{--tool-fill:9%;--tool-hover:16%}}
.image-zoom-control{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:54px;height:30px;border-radius:999px;font:510 12px/1 var(--office-font);font-variant-numeric:tabular-nums;white-space:nowrap}
.image-zoom-control:hover,.image-zoom-control:focus-within{background:color-mix(in srgb,var(--office-foreground) var(--tool-hover),var(--office-background))}
.image-zoom-control:has(:focus-visible){outline:1px solid var(--office-foreground);outline-offset:-2px}
.image-zoom-control svg{width:10px;height:10px}
#image-zoom{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;font:inherit}
.image-messages{display:grid;min-width:0;font-size:12px;line-height:16px;color:var(--office-muted)}
.image-messages:not(:has([role=note],[role=status]:not([hidden]))){display:none}
#image-region-retry{border:0;border-radius:6px;padding:1px 4px;min-height:22px;background:transparent;color:inherit;font:inherit;text-decoration:underline;cursor:pointer}
#image-region-retry:hover{background:var(--office-hover)}#image-region-retry:focus-visible{outline:1px solid var(--office-foreground)}
#image-stage{position:relative;margin:${imageDisplayToolbarHeight}px auto 0}#image-overview{position:absolute;inset:0;width:100%;height:100%;max-width:none}.image-region{position:absolute;pointer-events:none;max-width:none}
/* The host owns zoom on deliveries. Reserve space in the image only for an actual note or retry. */
.hosted-image #image-toolbar{height:auto;min-height:0;padding:0;position:sticky;top:0;left:0;width:100vw}
.hosted-image #image-toolbar:has([role=note],[role=status]:not([hidden])){padding:2px 8px}
.hosted-image #image-stage{margin:0 auto}
</style>
<div id="image-toolbar">${
    hosted
      ? ''
      : `<div class="image-controls" role="group" aria-label="阅读控制">
<label class="image-zoom-control"><span id="image-zoom-label" aria-hidden="true">适应</span><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2.5 4.5 3.5 3.5 3.5-3.5"/></svg>
<select id="image-zoom" aria-label="图片缩放"><option value="fit">适合宽度</option><option value="out">缩小</option><option value="in">放大</option>
${[0.5, 0.75, 1, 1.25, 1.5, 2].map((scale) => `<option value="${scale}">${scale === 1 ? '100% 原始大小' : `${scale * 100}%`}</option>`).join('')}
<option value="current" hidden></option></select></label></div>`
  }<div class="image-messages">${image.animated ? '<span role="note">动画图片 · 首帧预览</span>' : ''}<span id="image-region-status" role="status" hidden>高清暂不可用 <button id="image-region-retry" type="button">重试</button></span></div></div>
<div id="image-stage"><img id="image-overview" src="image" width="${image.width}" height="${image.height}" data-source-width="${image.sourceWidth}" data-source-height="${image.sourceHeight}" alt="图片预览"></div>${hosted ? '' : `<script>${imageDisplayViewportScript(image)}</script>`}</html>`;
}
