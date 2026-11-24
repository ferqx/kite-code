/** Sandboxed preview documents cannot inherit the renderer’s CSS. Mirror the desktop
 * content tokens here; Electron’s nativeTheme.themeSource drives the active scheme.
 * --office-* names are shared with the existing Office controls. */
export const isolatedPreviewChromeCss = `
.kite-office-chrome, .kite-file-preview-chrome, .kite-office-preview-document {
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
}
.kite-office-chrome, .kite-file-preview-chrome {
  font: 13px/1.4 var(--office-font);
  color: var(--office-foreground);
}
@media (prefers-color-scheme: dark) {
  .kite-office-chrome, .kite-file-preview-chrome, .kite-office-preview-document {
    --office-hover: color-mix(in srgb, var(--office-foreground) 7%, transparent);
    --office-selected: color-mix(in srgb, var(--office-foreground) 11%, transparent);
    --office-pressed: color-mix(in srgb, var(--office-foreground) 13%, transparent);
  }
}
`;

// The iframe has its own viewport and scroll containers. Match the desktop thumb and gutter.
export const isolatedOfficeDocumentCss = `${isolatedPreviewChromeCss}
:root.kite-office-preview-document {
  background: var(--office-background);
  color: #000;
}
@media (forced-colors: none) {
  .kite-office-preview-document::-webkit-scrollbar,
  .kite-office-preview-document ::-webkit-scrollbar {
    width: 10px;
    height: 10px;
    background: transparent;
  }
  .kite-office-preview-document::-webkit-scrollbar-track,
  .kite-office-preview-document ::-webkit-scrollbar-track,
  .kite-office-preview-document::-webkit-scrollbar-corner,
  .kite-office-preview-document ::-webkit-scrollbar-corner {
    background: transparent;
  }
  .kite-office-preview-document::-webkit-scrollbar-button,
  .kite-office-preview-document ::-webkit-scrollbar-button {
    display: none;
  }
  .kite-office-preview-document::-webkit-scrollbar-thumb,
  .kite-office-preview-document ::-webkit-scrollbar-thumb {
    border: 1px solid transparent;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--office-foreground) 10%, transparent);
    background-clip: padding-box;
  }
  .kite-office-preview-document::-webkit-scrollbar-thumb:hover,
  .kite-office-preview-document ::-webkit-scrollbar-thumb:hover,
  .kite-office-preview-document::-webkit-scrollbar-thumb:active,
  .kite-office-preview-document ::-webkit-scrollbar-thumb:active {
    background: color-mix(in srgb, var(--office-foreground) 18%, transparent);
    background-clip: padding-box;
  }
}
`;
