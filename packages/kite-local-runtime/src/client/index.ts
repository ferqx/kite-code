export {
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  type LocalRuntimeServiceDescriptor,
} from '../service/codecs';
export * from './app-server-client';
export * from './bun-stdio-child-transport';
export * from './bun-websocket-transport';
export * from './codecs';
export * from './connection';
export * from './daemon-control';
export * from './node-socket-transport';
export * from './protocol-app-control';

export const KITE_LOCAL_RUNTIME_CLIENT_BOUNDARY_ = Object.freeze({
  nativeOnly: true,
  automaticMutationRetry: false,
  connectionCarriesControlToken: false,
  ownsRuntimeExecution: false,
  ownsStore: false,
} as const);
