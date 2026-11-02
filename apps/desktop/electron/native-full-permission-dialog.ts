import type { IpcMain } from 'electron';
import {
  nativeFullPermissionConfirmationCancelChannel,
  nativeFullPermissionConfirmationChannel,
} from '../src/native-bridge';
import type { NativeRootWindow } from './native-root-window';
import { nativeDialogPayload, registerNativeWindowDialogIpc } from './native-window-dialog';

/** The existing permission controller owns any change after confirmation. */
export function registerNativeFullPermissionDialogIpc(options: {
  ipcMain: IpcMain;
  window: () => NativeRootWindow | undefined;
  rendererUrl: string;
  showDialog: (
    window: NativeRootWindow,
    language: 'zh' | 'en',
    signal: AbortSignal,
  ) => Promise<boolean>;
}): () => void {
  return registerNativeWindowDialogIpc({
    ...options,
    channel: nativeFullPermissionConfirmationChannel,
    cancelChannel: nativeFullPermissionConfirmationCancelChannel,
    code: 'native_full_permission_confirmation',
    parse(input) {
      const value = nativeDialogPayload(input, ['requestId', 'language']);
      if (value.language !== 'zh' && value.language !== 'en') throw Error('invalid_native_request');
      return { requestId: value.requestId as string, value: value.language as 'zh' | 'en' };
    },
  });
}
