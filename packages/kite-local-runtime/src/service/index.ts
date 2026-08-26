export * from './codecs';
export * from './paths';

export const KITE_LOCAL_RUNTIME_SERVICE_BOUNDARY_ = Object.freeze({
  nativeOnly: true,
  ownsFilesystemPrimitives: true,
  ownsListener: false,
  ownsProcess: false,
  ownsRuntimeComposition: false,
} as const);
