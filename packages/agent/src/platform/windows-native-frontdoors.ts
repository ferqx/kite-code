export const windowsNativeFrontdoorNames = Object.freeze([
  'kite.exe',
  'kite-tui.exe',
  'kite-desktop.exe',
  'native-verifier.exe',
] as const);
export const windowsNodeNativeFrontdoorNames = Object.freeze([
  ...windowsNativeFrontdoorNames,
  'runtime-native.node',
] as const);

export const windowsDesktopFrontdoorNames = Object.freeze([
  'kite-desktop.exe',
  'native-verifier.js',
] as const);
export const windowsNodeDesktopFrontdoorNames = Object.freeze([
  'kite-desktop.exe',
  'native-verifier.mjs',
] as const);
