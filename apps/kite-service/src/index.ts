export * from './carrier';
export * from './environment';
export * from './manager';
export * from './native-infrastructure';
export * from './ports';
export * from './readiness';
export * from './shell';

export const KITE_SERVICE_BOUNDARY = Object.freeze({
  privatePackage: true,
  internalExecutable: true,
  importsCliOrTui: false,
  ownsRuntimeApplication: false,
  ownsRuntimeStore: false,
  ownsRuntimeHost: false,
  ownsProtocol: false,
} as const);
