export type { LocalRuntimeServiceDescriptor } from '../service/codecs';
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
