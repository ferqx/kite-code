export * from './codecs';
export * from './lifecycle-reservation';
export * from './paths';
export * from './process-identity';
export * from './state';
export {
  resolveCurrentWindowsUserSid,
  secureWindowsStatePath,
  verifyWindowsStatePath,
  type WindowsStatePathKind,
  WindowsStateSecurityError,
  windowsStateSecurityDiagnostic,
} from './windows-state-security';

export const KITE_LOCAL_RUNTIME_SERVICE_BOUNDARY_ = Object.freeze({
  nativeOnly: true,
  ownsFilesystemPrimitives: true,
  ownsListener: false,
  ownsProcess: false,
  ownsRuntimeComposition: false,
} as const);
