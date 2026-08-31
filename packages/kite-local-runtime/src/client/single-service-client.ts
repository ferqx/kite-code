import { randomUUID } from 'node:crypto';
import {
  KITE_LOCAL_NATIVE_PROTOCOL_VERSION,
  KITE_LOCAL_NATIVE_REQUEST_SCHEMA_,
  type KiteLocalNativeRequest,
  type KiteLocalNativeResponse,
  type KiteLocalRuntimeEndpoint,
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
} from '../service';
import { type KiteLocalNativeRequestOptions, requestKiteLocalNativeEndpoint } from './native-ipc';

export type KiteSingleServiceClientDiagnostic =
  | 'invalid_request'
  | 'incompatible'
  | 'unavailable'
  | 'invalid_response';

export class KiteSingleServiceClientError extends Error {
  readonly diagnostic: KiteSingleServiceClientDiagnostic;

  constructor(diagnostic: KiteSingleServiceClientDiagnostic) {
    super(`Single-Service native request failed: ${diagnostic}.`);
    this.name = 'KiteSingleServiceClientError';
    this.diagnostic = diagnostic;
  }
}

export interface KiteSingleServiceClientOptions {
  readonly endpoint: KiteLocalRuntimeEndpoint;
  readonly expectedBuildId: string;
  readonly webContractRevision: string;
  readonly requestId?: () => string;
  readonly request?: typeof requestKiteLocalNativeEndpoint;
  readonly requestOptions?: KiteLocalNativeRequestOptions;
}

export interface KiteSingleServiceClient {
  describe(): Promise<Extract<KiteLocalNativeResponse, { operation: 'describe' }>>;
  ensureWeb(
    staticAssetRoot: string,
  ): Promise<Extract<KiteLocalNativeResponse, { operation: 'web_ensure' }>>;
  statusWeb(): Promise<Extract<KiteLocalNativeResponse, { operation: 'web_status' }>>;
  stopWeb(): Promise<Extract<KiteLocalNativeResponse, { operation: 'web_stop' }>>;
  stopService(): Promise<Extract<KiteLocalNativeResponse, { operation: 'service_stop' }>>;
}

/**
 * Typed native client for the accepted single-Service topology. Each method performs exactly one
 * transport exchange; callers decide whether an unavailable result is safe to retry.
 */
export function createKiteSingleServiceClient(
  options: KiteSingleServiceClientOptions,
): KiteSingleServiceClient {
  const requestId = options.requestId ?? randomUUID;
  const transport = options.request ?? requestKiteLocalNativeEndpoint;
  const invoke = async <Operation extends KiteLocalNativeRequest['operation']>(
    request: Extract<KiteLocalNativeRequest, { operation: Operation }>,
    operation: Operation,
  ): Promise<Extract<KiteLocalNativeResponse, { operation: Operation }>> => {
    const response = await transport(options.endpoint, request, options.requestOptions);
    if (response.operation === 'rejected') {
      throw new KiteSingleServiceClientError(response.diagnostic);
    }
    if (response.operation !== operation) {
      throw new KiteSingleServiceClientError('invalid_response');
    }
    return response as Extract<KiteLocalNativeResponse, { operation: Operation }>;
  };
  const base = () => ({
    schema: KITE_LOCAL_NATIVE_REQUEST_SCHEMA_,
    requestId: boundedRequestId(requestId()),
    protocolVersion: KITE_LOCAL_NATIVE_PROTOCOL_VERSION,
    clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
    expectedBuildId: boundedIdentity(options.expectedBuildId, 'expected build identity'),
  });

  return Object.freeze({
    describe: () => invoke({ ...base(), operation: 'describe' }, 'describe'),
    ensureWeb: (staticAssetRoot: string) =>
      invoke(
        {
          ...base(),
          operation: 'web_ensure',
          staticAssetRoot,
          expectedWebContractRevision: boundedIdentity(
            options.webContractRevision,
            'Web contract revision',
          ),
        },
        'web_ensure',
      ),
    statusWeb: () => invoke({ ...base(), operation: 'web_status' }, 'web_status'),
    stopWeb: () => invoke({ ...base(), operation: 'web_stop' }, 'web_stop'),
    stopService: () => invoke({ ...base(), operation: 'service_stop' }, 'service_stop'),
  });
}

function boundedRequestId(value: string): string {
  if (value.length < 1 || value.length > 512 || /\p{Cc}/u.test(value)) {
    throw new TypeError('Single-Service request identity is invalid.');
  }
  return value;
}

function boundedIdentity(value: string, label: string): string {
  if (value.length < 1 || value.length > 512 || /\p{Cc}/u.test(value)) {
    throw new TypeError(`Single-Service ${label} is invalid.`);
  }
  return value;
}
