export * from './carrier';
export * from './composition';
export * from './native-infrastructure';
export * from './ports';
export * from './readiness';
export * from './shell';

export const KITE_SERVICE_BOUNDARY = Object.freeze({
  privatePackage: true,
  internalExecutable: true,
  importsCliOrTui: false,
  ownsRuntimeApplication: true,
  ownsRuntimeStore: true,
  ownsRuntimeHost: true,
  ownsProtocol: false,
} as const);
