import { isAbsolute, resolve } from 'node:path';
import type { KiteServiceManagerExecutable, KiteServiceManagerExecutableResolver } from './ports';

export interface KiteServiceExecutableResolverOptions {
  readonly source: string;
  readonly installed: string;
  readonly sourceBuildId?: string;
  readonly installedBuildId?: string;
}

function validateExecutablePath(path: string, label: string): string {
  if (
    path.length === 0 ||
    !isAbsolute(path) ||
    [...path].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    throw new TypeError(`${label} executable must be an absolute path without control characters.`);
  }
  return resolve(path);
}

/**
 * Explicit source/installed resolution. There is intentionally no cwd, PATH, or fallback lookup:
 * a managed candidate and a development executable are distinct lifecycle identities.
 */
export function createKiteServiceExecutableResolver(
  options: KiteServiceExecutableResolverOptions,
): KiteServiceManagerExecutableResolver {
  const source = validateExecutablePath(options.source, 'Source');
  const installed = validateExecutablePath(options.installed, 'Installed');
  const sourceBuildId = options.sourceBuildId;
  const installedBuildId = options.installedBuildId;
  return Object.freeze({
    resolve(mode: 'source' | 'installed'): Promise<KiteServiceManagerExecutable> {
      if (mode === 'source') {
        return Promise.resolve(
          Object.freeze({
            path: source,
            mode,
            ...(sourceBuildId ? { buildId: sourceBuildId } : {}),
          }),
        );
      }
      if (mode === 'installed') {
        return Promise.resolve(
          Object.freeze({
            path: installed,
            mode,
            ...(installedBuildId ? { buildId: installedBuildId } : {}),
          }),
        );
      }
      return Promise.reject(new TypeError('Service executable mode must be source or installed.'));
    },
  });
}
