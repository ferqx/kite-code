export * from './agent-api';
export * from './carrier';
export * from './composition';
export * from './native-endpoint';
export * from './native-infrastructure';
export * from './ports';
export * from './readiness';
export * from './shell';
export * from './single-service-infrastructure';

export const KITE_SERVICE_BOUNDARY = Object.freeze({
  privatePackage: true,
  internalExecutable: true,
  importsCliOrTui: false,
  ownsRuntimeApplication: true,
  ownsRuntimeStore: true,
  ownsRuntimeHost: true,
  ownsProtocol: false,
} as const);
