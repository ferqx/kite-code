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
export * from '../paired-desktop-manifest';
export * from './installed-store-admission';
export * from './legacy-store-processes';
export * from './managed-release-selection-lock';
export * from './paired-desktop-admission';
export * from './source-store-admission';
