export {
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  type LocalRuntimeServiceDescriptor,
} from '../service/codecs';
export * from './bun-stdio-child-transport';
export * from './bun-websocket-transport';
export * from './codecs';
export * from './connection';
export * from './native-connector';

export const KITE_LOCAL_RUNTIME_CLIENT_BOUNDARY_ = Object.freeze({
  nativeOnly: true,
  automaticMutationRetry: false,
  connectionCarriesControlToken: false,
  ownsRuntimeExecution: false,
  ownsStore: false,
} as const);
