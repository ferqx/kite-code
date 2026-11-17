import type { NativeImageDisplayRegion } from '../src/native-image-display-bridge';

/** A closed coordinate resource family within one admitted preview, never a source locator. */
export function imageDisplayRegionRequest(path: string, source: { width: number; height: number }) {
  const match =
    /^\/region\/([1-9]\d{0,9})\/(\d{1,5})\/(\d{1,5})\/([1-9]\d{0,4})\/([1-9]\d{0,4})\.webp$/.exec(
      path,
    );
  if (!match) return undefined;
  const [serial, left, top, width, height] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (left + width > source.width || top + height > source.height) return undefined;
  return { serial, region: { left, top, width, height } satisfies NativeImageDisplayRegion };
}

/** Fixed script for the isolated preview. The overview stays while current/candidate ROI images are bounded. */
export function imageDisplayViewportScript(input: {
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
}) {
  return `(() => {
    const source = ${JSON.stringify(input)};
    const stage = document.getElementById('image-stage');
    const overview = document.getElementById('image-overview');
    const status = document.getElementById('image-region-status');
    const retry = document.getElementById('image-region-retry');
    const label = document.getElementById('image-zoom-label');
    let scale = 1, fit = true, timer, serial = 0, candidate, current, last = '', retired = false;
    const position = (image) => {
      if (!image || !image.region) return;
      const r = image.region;
      Object.assign(image.style, { left: r.left * scale + 'px', top: r.top * scale + 'px', width: r.width * scale + 'px', height: r.height * scale + 'px' });
    };
    const discard = (image) => { if (image) { image.onload = image.onerror = null; image.removeAttribute('src'); image.remove(); } };
    const request = (force = false) => {
      if (retired || document.hidden) return;
      const base = Math.min(source.width / source.sourceWidth, source.height / source.sourceHeight);
      if (base >= 0.999 || scale * (window.devicePixelRatio || 1) <= base * 1.05) {
        last = ''; serial++; discard(candidate); candidate = undefined; discard(current); current = undefined; status.hidden = true; return;
      }
      const rect = stage.getBoundingClientRect();
      const left = Math.max(0, Math.floor(-rect.left / scale));
      const top = Math.max(0, Math.floor((48 - rect.top) / scale));
      const right = Math.min(source.sourceWidth, Math.ceil((innerWidth - rect.left) / scale));
      const bottom = Math.min(source.sourceHeight, Math.ceil((innerHeight - rect.top) / scale));
      if (right <= left || bottom <= top) return;
      const region = { left, top, width: right - left, height: bottom - top };
      const key = JSON.stringify(region);
      if (!force && key === last) return;
      last = key; const id = ++serial; discard(candidate);
      const next = new Image(); candidate = next; next.region = region;
      next.className = 'image-region'; next.alt = ''; next.setAttribute('aria-hidden', 'true');
      const fail = () => {
        if (id !== serial || retired) return;
        discard(next); candidate = undefined; status.hidden = false;
      };
      next.onload = async () => {
        try { await next.decode(); } catch { fail(); return; }
        if (retired || id !== serial || document.hidden) { discard(next); return; }
        discard(current); current = next; candidate = undefined; position(next); stage.append(next);
        next.setAttribute('data-image-region', 'current'); status.hidden = true;
      };
      next.onerror = fail;
      next.src = 'region/' + id + '/' + left + '/' + top + '/' + region.width + '/' + region.height + '.webp';
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => request(), 120); };
    const layout = (next, fitting) => {
      const old = scale, centerX = (scrollX + innerWidth / 2) / old, centerY = (scrollY + innerHeight / 2 - 48) / old;
      fit = fitting; const minimum = Math.min(0.01, Math.max(1, innerWidth) / source.sourceWidth);
      scale = Math.max(minimum, Math.min(8, next));
      Object.assign(stage.style, { width: source.sourceWidth * scale + 'px', height: source.sourceHeight * scale + 'px' });
      position(current); position(candidate); label.textContent = (scale < 0.01 ? (scale * 100).toFixed(1) : Math.round(scale * 100)) + '%';
      scrollTo(Math.max(0, centerX * scale - innerWidth / 2), Math.max(0, centerY * scale - innerHeight / 2 + 48));
      schedule();
    };
    document.getElementById('image-fit').onclick = () => layout(Math.min(1, innerWidth / source.sourceWidth), true);
    document.getElementById('image-original').onclick = () => layout(1, false);
    document.getElementById('image-out').onclick = () => layout(scale / 1.25, false);
    document.getElementById('image-in').onclick = () => layout(scale * 1.25, false);
    retry.onclick = () => request(true);
    addEventListener('scroll', schedule, { passive: true });
    addEventListener('resize', () => fit ? layout(Math.min(1, innerWidth / source.sourceWidth), true) : schedule());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { clearTimeout(timer); serial++; last = ''; discard(candidate); candidate = undefined; discard(current); current = undefined; }
      else schedule();
    });
    addEventListener('pagehide', () => { retired = true; clearTimeout(timer); serial++; discard(candidate); discard(current); });
    layout(Math.min(1, innerWidth / source.sourceWidth), true); scrollTo(0, 0);
  })();`;
}
