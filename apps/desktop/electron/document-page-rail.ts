/** Trusted document chrome shared by Word, PowerPoint and PDF; serialize into the isolated world. */
export function installPageRail(rail: HTMLElement, presenting: () => boolean = () => false) {
  rail.classList.add('kite-page-rail');
  rail.tabIndex = 0;
  rail.style.setProperty('--kite-thumb-scale', '1', 'important');
  const css = document.createElement('style');
  css.textContent = `.kite-page-rail{position:fixed!important;left:0!important;top:0!important;bottom:auto!important;z-index:100;flex:none!important;width:104px!important;min-width:104px!important;--kite-thumb-scale:1!important;border-right:1px solid var(--office-border)}
.kite-page-rail.kite-rail-compact{width:32px!important;min-width:32px!important;top:50%!important;transform:translateY(-50%);height:auto!important;max-height:80vh;background:transparent;border:0;border-radius:12px}
.kite-page-rail.kite-rail-compact:not(:hover):not(:focus-within)>button{height:16px!important;min-height:16px!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:hidden}
.kite-page-rail.kite-rail-compact:not(:hover):not(:focus-within)>button:after{content:'';position:absolute;left:4px;right:4px;top:7px;height:2px;border-radius:2px;background:var(--office-muted)}
.kite-page-rail.kite-rail-compact:not(:hover):not(:focus-within)>button[aria-current=true]:after{background:var(--office-foreground);left:2px;right:2px}
.kite-page-rail.kite-rail-compact:not(:hover):not(:focus-within)>button>*{visibility:hidden}
.kite-page-rail.kite-rail-compact:hover,.kite-page-rail.kite-rail-compact:focus-within{width:104px!important;min-width:104px!important;background:var(--office-background);border:1px solid var(--office-border);box-shadow:0 8px 24px #0003}
body.kite-present>.kite-page-rail{display:none!important}`;
  document.head.append(css);
  const layout = () => {
    const scale = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const compact = window.innerWidth < 600;
    rail.classList.toggle('kite-rail-compact', compact);
    rail.style.zoom = String(1 / scale);
    rail.style.height = `${window.innerHeight}px`;
    // Interface-space gutter is invariant even when the document root zooms.
    document.body.style.setProperty(
      'padding-left',
      `${(presenting() ? 0 : compact ? 40 : 112) / scale}px`,
      'important',
    );
  };
  window.addEventListener('resize', layout);
  layout();
}
