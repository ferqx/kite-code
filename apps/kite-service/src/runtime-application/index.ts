export * from './admission';
export * from './application';
export * from './context';
export * from './in-process-application';
export * from './interaction-broker';
export * from './operation-gate';
export * from './router';

export const KITE_RUNTIME_APPLICATION_BOUNDARY_ = Object.freeze({
  appLocal: true,
  uiFree: true,
  createsStore: false,
  createsHost: false,
  createsServer: false,
  createsListener: false,
  ownsWorkspaceSelection: true,
} as const);
