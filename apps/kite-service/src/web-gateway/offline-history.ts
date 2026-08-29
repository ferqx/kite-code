import { createKiteRuntimeObserverHistoryFromActiveWorkspace } from '../bootstrap';
import type { WebObserverHistoryTranscript } from '../web-observer';

export interface OfflineWebHistoryRequest {
  readonly workerScopeId: string;
  readonly sessionId: string;
}

/** Private Gateway-side facade; it never appears in the Browser contract. */
export interface OfflineWebHistoryPort {
  readonly loadSession: (
    request: OfflineWebHistoryRequest,
  ) => Promise<WebObserverHistoryTranscript>;
}

/**
 * Read current-format Store 7 History while its Worker is idle. The canonical
 * Store path is derived exclusively from the explicit Kite home and current
 * active-layout pointer. Storage revalidates pointer/manifest/journal/fence,
 * file identity and Workspace binding before and after each query.
 */
export function createOfflineWebHistoryPort(kiteHomeRoot: string): OfflineWebHistoryPort {
  return Object.freeze({
    async loadSession(request: OfflineWebHistoryRequest) {
      assertOpaqueIdentity(request.workerScopeId, 'Worker scope');
      assertOpaqueIdentity(request.sessionId, 'Session');
      return createKiteRuntimeObserverHistoryFromActiveWorkspace({
        kiteHomeRoot,
        workerScopeId: request.workerScopeId,
      }).loadSession(request.sessionId);
    },
  });
}

function assertOpaqueIdentity(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\0') ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(`${label} identity is invalid.`);
  }
}
