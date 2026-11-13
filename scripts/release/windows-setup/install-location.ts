import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { win32 } from 'node:path';
import { dlopen, ptr } from '@kite-ai/agent/runtime-ffi';
import { readWindowsNativeInstallation } from '../../../apps/cli/host/windows-native-installation';
import { windowsInstallationCoordination } from '../../../packages/agent/src/platform/windows-installation-coordination';
import {
  defaultWindowsPathSecurity,
  privateDirectory,
} from '../../../packages/agent/src/platform/windows-path-security';

interface SetupLocation {
  prefix: string;
  layout: 'desktop' | 'desktop-update';
  replacing?: string;
}

/** Keep the durable lock namespace out of the normal Explorer view. */
export function hideSetupCoordination(prefix: string) {
  const coordination = windowsInstallationCoordination(prefix);
  try {
    coordination.verify();
    const kernel = dlopen('kernel32.dll', {
      GetFileAttributesW: { args: ['ptr'], returns: 'u32' },
      SetFileAttributesW: { args: ['ptr', 'u32'], returns: 'bool' },
    });
    try {
      const path = Buffer.from(`${coordination.root}\0`, 'utf16le');
      const attributes = kernel.symbols.GetFileAttributesW(ptr(path));
      if (
        attributes === 0xffffffff ||
        !(attributes & 0x10) ||
        attributes & 0x400 ||
        (!(attributes & 2) && !kernel.symbols.SetFileAttributesW(ptr(path), attributes | 2))
      )
        throw Error('native_setup_coordination_attribute_failed');
    } finally {
      kernel.close();
    }
  } finally {
    coordination.release();
  }
}

export function prepareSetupLocation(
  location: string,
  desktop: { candidate: string; registered?: string },
): SetupLocation {
  const security = defaultWindowsPathSecurity();
  if (
    !security ||
    location.length > 32760 ||
    !/^[A-Za-z]:\\./u.test(location) ||
    win32.resolve(location) !== location ||
    [...location].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    location
      .slice(3)
      .split('\\')
      .some(
        (name) =>
          !name ||
          name.length > 255 ||
          /[<>:"/|?*]/u.test(name) ||
          /[. ]$/u.test(name) ||
          /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name),
      )
  ) {
    throw Error('native_setup_location_invalid');
  }

  security.verifyPath(location);
  if (!lstatSync(location, { throwIfNoEntry: false })) privateDirectory(location);
  const directory = realpathSync.native(location);
  if (directory.toLowerCase() !== location.toLowerCase())
    throw Error('native_setup_location_alias');
  security.verifyScopeDirectory(directory);

  const marker = (prefix: string) =>
    lstatSync(win32.join(prefix, '.kite-native-install.json'), { throwIfNoEntry: false })
      ? readWindowsNativeInstallation(prefix)
      : undefined;
  const direct = marker(directory);
  // A private application directory can be created below a writable volume root.
  // Its managed child keeps the existing ownership rule for the coordination directory.
  const inspect = (prefix: string) => {
    security.verifyPath(prefix);
    if (!lstatSync(prefix, { throwIfNoEntry: false })) return undefined;
    security.verifyScopeDirectory(prefix);
    const existing = realpathSync.native(prefix);
    if (existing.toLowerCase() !== prefix.toLowerCase()) throw Error('native_setup_location_alias');
    return readdirSync(existing).length ? readWindowsNativeInstallation(existing) : undefined;
  };
  const legacy = win32.join(directory, 'client');
  const resources = win32.join(directory, 'resources');
  const primary = win32.join(resources, 'app');
  const alternate = win32.join(resources, 'app-update');
  if (direct) return { prefix: primary, layout: 'desktop', replacing: directory };
  privateDirectory(resources, security);
  const installed = [legacy, primary, alternate].flatMap((prefix) => {
    const candidate = inspect(prefix);
    return candidate ? [{ prefix, candidate }] : [];
  });
  const current =
    installed.find(({ prefix }) => prefix.toLowerCase() === desktop.registered?.toLowerCase()) ??
    (installed.length === 1 ? installed[0] : undefined);
  if (!current && installed.length > 1) throw Error('native_setup_installation_ambiguous');
  const same =
    current &&
    current.prefix !== legacy &&
    current.candidate.bootstrap.candidateId === desktop.candidate;
  const prefix = same ? current.prefix : current?.prefix === primary ? alternate : primary;
  const staged = installed.find((item) => item.prefix === prefix);
  if (staged && staged.candidate.bootstrap.candidateId !== desktop.candidate)
    throw Error('native_setup_installation_ambiguous');
  return {
    prefix,
    layout: prefix === primary ? 'desktop' : 'desktop-update',
    ...(current && current.prefix !== prefix ? { replacing: current.prefix } : {}),
  };
}
