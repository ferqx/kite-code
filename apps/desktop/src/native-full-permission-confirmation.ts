import type { NativeWindowBridge } from './native-bridge';

let confirmationSequence = 0;

/** The native modal only returns a decision; the existing permission command owns mutation. */
export async function confirmNativeFullPermission(
  host: Partial<NativeWindowBridge>,
  { language, signal }: { language: 'zh' | 'en'; signal: AbortSignal },
): Promise<boolean> {
  if (signal.aborted) return false;
  if (!host.confirmFullPermission || !host.cancelFullPermissionConfirmation)
    throw Error('native_full_permission_confirmation_unavailable');
  const requestId = `full-permission-${Date.now().toString(36)}-${++confirmationSequence}`;
  let cancel!: () => void;
  const cancelled = new Promise<boolean>((resolve) => {
    cancel = () => {
      try {
        host.cancelFullPermissionConfirmation!(requestId);
      } catch {}
      resolve(false);
    };
  });
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const confirmed = await Promise.race([
      host.confirmFullPermission({ requestId, language }),
      cancelled,
    ]);
    return !signal.aborted && confirmed === true;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
