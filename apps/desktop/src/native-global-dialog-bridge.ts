export const nativeGlobalDialogEventChannel = 'kite:native:global-dialog-event';
export const nativeGlobalDialogStateChannel = 'kite:native:global-dialog-state';
export const nativeGlobalDialogActiveChannel = 'kite:native:global-dialog-active';

export type NativeGlobalDialogContent = { language: 'zh' | 'en' } & (
  | { kind: 'full-permission' }
  | { kind: 'workspace-removal'; label: string }
);

export type NativeGlobalDialogState =
  | ({
      requestId: string;
      theme: 'light' | 'dark';
    } & NativeGlobalDialogContent)
  | null;

/** This view renders fixed application confirmations and returns decisions only. */
export interface NativeGlobalDialogBridge {
  watch(listener: (state: NativeGlobalDialogState) => void): () => void;
  ready(): void;
  presented(requestId: string): void;
  decide(requestId: string, confirmed: boolean): void;
}

declare global {
  interface Window {
    kiteGlobalDialog?: NativeGlobalDialogBridge;
  }
}
