export const previewMenuOpenChannel = 'kite:native:preview-menu-open';
export const previewMenuCloseChannel = 'kite:native:preview-menu-close';
export const previewMenuActiveChannel = 'kite:native:preview-menu-active';
export const previewMenuStateChannel = 'kite:native:preview-menu-state';
export const previewMenuEventChannel = 'kite:native:preview-menu-event';

export type PreviewMenuOption = { value: string; label: string; disabled?: boolean };
export type PreviewMenu = {
  id: string;
  anchor: { x: number; y: number; width: number; height: number };
  label: string;
  value: string;
  options: readonly PreviewMenuOption[];
};
export type PreviewMenuState = (PreviewMenu & { theme: 'light' | 'dark' }) | null;

export type PreviewMenuBridge = {
  open(menu: PreviewMenu): Promise<string | null>;
  close(id: string): void;
};
export type PreviewMenuOverlayBridge = {
  watch(listener: (menu: PreviewMenuState) => void): () => void;
  ready(): void;
  shown(id: string): void;
  finish(id: string, value: string | null): void;
};

declare global {
  interface Window {
    kitePreviewMenu?: PreviewMenuBridge;
    kitePreviewMenuOverlay?: PreviewMenuOverlayBridge;
  }
}
