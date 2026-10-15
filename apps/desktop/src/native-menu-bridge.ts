export const nativeWindowMenuChannel = 'kite:native:window-menu';
export const nativeWindowMenuActionChannel = 'kite:native:window-menu-action';

export type NativeWindowMenuId = 'file' | 'edit' | 'view' | 'help';
export type NativeWindowMenuAction = 'new-conversation' | 'add-workspace' | 'settings';
export type NativeWindowMenuRequest = {
  menu: NativeWindowMenuId;
  x: number;
  y: number;
  applicationEnabled: boolean;
};
export interface NativeWindowMenuBridge {
  showWindowMenu(request: NativeWindowMenuRequest): Promise<void>;
  watchWindowMenuAction(listener: (action: NativeWindowMenuAction) => void): () => void;
}

export function isNativeWindowMenuAction(value: unknown): value is NativeWindowMenuAction {
  return value === 'new-conversation' || value === 'add-workspace' || value === 'settings';
}
