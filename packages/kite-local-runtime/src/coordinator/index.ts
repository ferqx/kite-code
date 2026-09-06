export * from './carrier';
export * from './catalog';
export * from './codecs';
export * from './control-plane';
export * from './dispatcher';
export * from './framing';
export * from './identity';
export * from './manager';
export * from './process-host';
export * from './process-state';
export * from './registry';
export * from './socket-transport';

export const KITE_LOCAL_RUNTIME_COORDINATOR_BOUNDARY_ = Object.freeze({
  nativeOnly: true,
  ownsControlPlane: true,
  ownsRuntimeExecution: false,
  ownsStore: false,
  ownsHost: false,
  ownsWebGateway: false,
  genericRpc: false,
} as const);
