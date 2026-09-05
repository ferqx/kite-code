export * from './agent-api';
export * from './carrier';
export * from './composition';
export { runKiteServiceMain } from './executable';
export * from './native-endpoint';

export const KITE_SERVICE_BOUNDARY = Object.freeze({
  privatePackage: true,
  internalExecutable: true,
  importsCliOrTui: false,
  ownsRuntimeApplication: true,
  ownsRuntimeStore: true,
  ownsRuntimeHost: true,
  ownsProtocol: false,
} as const);
