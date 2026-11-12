import { isAbsolute } from 'node:path';
import {
  parseRuntimeProtection,
  type RuntimeProtection,
} from '@kite-ai/service/runtime-protection';

/** Installer or development host selection, never a public command/token override. */
export interface CLIServiceArtifact {
  readonly entrypoint: string;
  readonly entrypointSha256: string;
  readonly executable: string;
  readonly executableSha256: string;
  readonly buildId: string;
  readonly apiMajor: 1;
  readonly runtimeProtection?: RuntimeProtection;
  readonly daemon?: {
    readonly entrypoint: string;
    readonly entrypointSha256: string;
    readonly web: { readonly directory: string; readonly manifestSha256: string };
  };
}
export class CLIHostError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
/** The adjacent manifest is a closed installer input, not unchecked JSON cast as trusted assets. */
export function parseCLIServiceArtifact(value: unknown): Readonly<CLIServiceArtifact> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CLIHostError('invalid_cli_artifact');
  const fields = [
    'entrypoint',
    'entrypointSha256',
    'executable',
    'executableSha256',
    'buildId',
    'apiMajor',
  ];
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !==
      fields.length + ('daemon' in input ? 1 : 0) + ('runtimeProtection' in input ? 1 : 0) ||
    Object.keys(input).some(
      (key) => !fields.includes(key) && key !== 'daemon' && key !== 'runtimeProtection',
    ) ||
    input.apiMajor !== 1 ||
    typeof input.buildId !== 'string' ||
    !/^[a-zA-Z0-9._-]{1,160}$/.test(input.buildId) ||
    typeof input.entrypoint !== 'string' ||
    !isAbsolute(input.entrypoint) ||
    !/\.m?js$/.test(input.entrypoint) ||
    typeof input.executable !== 'string' ||
    !isAbsolute(input.executable) ||
    typeof input.entrypointSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.entrypointSha256) ||
    typeof input.executableSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.executableSha256)
  )
    throw new CLIHostError('invalid_cli_artifact');
  let runtimeProtection: RuntimeProtection | undefined;
  if ('runtimeProtection' in input) {
    try {
      runtimeProtection = parseRuntimeProtection(input.runtimeProtection);
    } catch {
      throw new CLIHostError('invalid_cli_artifact');
    }
  }
  let daemon: CLIServiceArtifact['daemon'];
  if ('daemon' in input) {
    const candidate = input.daemon as Record<string, unknown> | null;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate) ||
      Object.keys(candidate).length !== 3 ||
      Object.keys(candidate).some(
        (key) => !['entrypoint', 'entrypointSha256', 'web'].includes(key),
      ) ||
      typeof candidate.entrypoint !== 'string' ||
      !isAbsolute(candidate.entrypoint) ||
      !/\.m?js$/.test(candidate.entrypoint) ||
      typeof candidate.entrypointSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(candidate.entrypointSha256)
    )
      throw new CLIHostError('invalid_cli_artifact');
    const web = candidate.web as Record<string, unknown> | null;
    if (
      !web ||
      typeof web !== 'object' ||
      Array.isArray(web) ||
      Object.keys(web).length !== 2 ||
      Object.keys(web).some((key) => !['directory', 'manifestSha256'].includes(key)) ||
      typeof web.directory !== 'string' ||
      !isAbsolute(web.directory) ||
      typeof web.manifestSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(web.manifestSha256)
    )
      throw new CLIHostError('invalid_cli_artifact');
    daemon = Object.freeze({
      entrypoint: candidate.entrypoint,
      entrypointSha256: candidate.entrypointSha256,
      web: Object.freeze({ directory: web.directory, manifestSha256: web.manifestSha256 }),
    });
  }
  return Object.freeze({
    entrypoint: input.entrypoint,
    entrypointSha256: input.entrypointSha256,
    executable: input.executable,
    executableSha256: input.executableSha256,
    buildId: input.buildId,
    apiMajor: 1,
    ...(runtimeProtection ? { runtimeProtection } : {}),
    ...(daemon ? { daemon } : {}),
  });
}
