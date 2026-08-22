import type { ShellNetworkMode } from './types';

/** Only these ephemeral proxy facts may cross the approved POSIX spawn seam. */
const APPROVED_PROXY_ENV_KEYS_V1 = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const;

/**
 * Project the current process proxy facts for one approved allow_all attempt.
 * The result is deliberately ephemeral and must never be placed in a
 * preparation, grant, artifact, or Runtime event.
 */
export function projectApprovedProxyEnvironmentV1(input: {
  readonly networkMode: ShellNetworkMode;
  readonly source?: NodeJS.ProcessEnv;
}): Readonly<Record<string, string>> {
  if (input.networkMode !== 'allow_all') return Object.freeze({});
  const source = input.source ?? process.env;
  const overlay: Record<string, string> = {};
  for (const key of APPROVED_PROXY_ENV_KEYS_V1) {
    const value = source[key];
    if (value !== undefined) overlay[key] = value;
  }
  return Object.freeze(overlay);
}
