/** Sandboxed preview documents cannot inherit the renderer’s CSS. Mirror the desktop
 * content tokens here; Electron’s nativeTheme.themeSource drives the active scheme.
 * --office-* names are shared with the existing Office controls. */
export const isolatedPreviewChromeCss = `
.kite-office-chrome, .kite-file-preview-chrome {
  color-scheme: light dark;
  --office-background: light-dark(#fafafa, #181818);
  --office-card: light-dark(#fff, #222);
  --office-composer: light-dark(#fff, #262626);
  --office-composer-border: light-dark(rgb(0 0 0 / 10%), #333);
  --office-foreground: light-dark(#222, #ededed);
  --office-muted: light-dark(#666, #c6c6c6);
  --office-border: light-dark(#e7e7e7, #282828);
  --office-primary: light-dark(#252525, #ededed);
  --office-primary-hover: light-dark(#414141, #ccc);
  --office-primary-foreground: light-dark(#fff, #1c1c1c);
  --office-hover: color-mix(in srgb, var(--office-foreground) 5%, transparent);
  --office-selected: color-mix(in srgb, var(--office-foreground) 7%, transparent);
  --office-pressed: color-mix(in srgb, var(--office-foreground) 9%, transparent);
  --office-font: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font: 13px/1.4 var(--office-font);
  color: var(--office-foreground);
}
@media (prefers-color-scheme: dark) {
  .kite-office-chrome, .kite-file-preview-chrome {
    --office-hover: color-mix(in srgb, var(--office-foreground) 7%, transparent);
    --office-selected: color-mix(in srgb, var(--office-foreground) 11%, transparent);
    --office-pressed: color-mix(in srgb, var(--office-foreground) 13%, transparent);
  }
}
`;
