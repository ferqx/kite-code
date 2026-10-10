import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { defaultWindowsPathSecurity } from '@kite-ai/agent/windows-path-security';
import { readWindowsNativeInstallation } from './windows-native-installation';
import { readWindowsTerminalInstallation } from './windows-terminal-installation';

export const CLI_REGISTRATION_FILE = '.kite-cli-registration.json';
export const OWNED_CLI_REGISTRATION_FILE = '.cli-registration.json';
export interface CLIRegistration {
  readonly version: 1;
  readonly terminalPrefix: string;
  readonly nativePrefix: string;
  readonly candidateId: string;
  readonly nonce: string;
}
export function parseCLIRegistration(value: unknown): Readonly<CLIRegistration> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('cli_registration_invalid');
  const input = value as Record<string, unknown>;
  const keys = ['version', 'terminalPrefix', 'nativePrefix', 'candidateId', 'nonce'];
  if (
    Object.keys(input).length !== keys.length ||
    !Object.keys(input).every((key) => keys.includes(key)) ||
    input.version !== 1 ||
    !['terminalPrefix', 'nativePrefix'].every(
      (key) =>
        typeof input[key] === 'string' &&
        isAbsolute(input[key]) &&
        input[key].length <= 4096 &&
        !Array.from(input[key]).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    ) ||
    input.terminalPrefix === input.nativePrefix ||
    typeof input.candidateId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.candidateId) ||
    typeof input.nonce !== 'string' ||
    !/^[a-f0-9]{32}$/.test(input.nonce)
  )
    throw Error('cli_registration_invalid');
  return Object.freeze({
    version: 1,
    terminalPrefix: input.terminalPrefix as string,
    nativePrefix: input.nativePrefix as string,
    candidateId: input.candidateId,
    nonce: input.nonce,
  });
}
export function readCLIRegistration(
  prefix: string,
  owned = false,
): Readonly<CLIRegistration> | undefined {
  const path = join(prefix, owned ? OWNED_CLI_REGISTRATION_FILE : CLI_REGISTRATION_FILE);
  const bytes =
    process.platform === 'win32'
      ? defaultWindowsPathSecurity()!.readScopeFile(path, 16384, true)
      : undefined;
  if (process.platform === 'win32' && bytes === null) return undefined;
  const stat =
    process.platform === 'win32' ? undefined : lstatSync(path, { throwIfNoEntry: false });
  if (process.platform !== 'win32' && !stat) return undefined;
  if (
    process.platform !== 'win32' &&
    (!stat!.isFile() ||
      stat!.isSymbolicLink() ||
      stat!.nlink !== 1 ||
      (stat!.mode & 0o777) !== 0o600 ||
      stat!.size > 16384 ||
      (process.getuid && stat!.uid !== process.getuid()))
  )
    throw Error('cli_registration_unsafe');
  const result = parseCLIRegistration(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes ?? readFileSync(path))),
  );
  if (
    (owned ? result.nativePrefix : result.terminalPrefix) !== prefix ||
    realpathSync(prefix) !== prefix
  )
    throw Error('cli_registration_identity_mismatch');
  return result;
}
export function sameCLIRegistration(
  a: CLIRegistration | undefined,
  b: CLIRegistration | undefined,
): boolean {
  return (
    a?.version === b?.version &&
    a?.terminalPrefix === b?.terminalPrefix &&
    a?.nativePrefix === b?.nativePrefix &&
    a?.candidateId === b?.candidateId &&
    a?.nonce === b?.nonce
  );
}
export function assertManagedCLIPrefix(prefix: string, native = false): void {
  if (process.platform === 'win32') {
    if (native) readWindowsNativeInstallation(prefix);
    else readWindowsTerminalInstallation(prefix);
    return;
  }
  const directory = lstatSync(prefix);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    realpathSync(prefix) !== prefix ||
    (directory.mode & 0o022) !== 0 ||
    (process.getuid && directory.uid !== process.getuid())
  )
    throw Error('cli_registration_prefix_unsafe');
  const path = join(prefix, native ? '.kite-native-install.json' : '.kite-terminal-install.json');
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > 16384 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw Error('cli_registration_prefix_unsafe');
  const marker = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)));
  if (
    !marker ||
    typeof marker !== 'object' ||
    Array.isArray(marker) ||
    Object.keys(marker).length !== 2 ||
    !Object.keys(marker).every((key) => ['version', 'root'].includes(key)) ||
    marker.version !== 1 ||
    marker.root !== prefix
  )
    throw Error('cli_registration_prefix_mismatch');
}

export function readManagedCLIActive(prefix: string): string {
  const path = join(prefix, 'active'),
    stat = lstatSync(path);
  if (process.platform === 'win32') {
    const bytes = defaultWindowsPathSecurity()!.readScopeFile(path, 256, true);
    if (!bytes) throw Error('cli_registration_active_invalid');
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n');
    if (
      lines.length !== 3 ||
      lines[2] !== '' ||
      !/^[a-f0-9]{64}$/.test(lines[0]!) ||
      (lines[1] !== '' && (!/^[a-f0-9]{64}$/.test(lines[1]!) || lines[1] === lines[0]))
    )
      throw Error('cli_registration_active_invalid');
    return lines[0]!;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > 256 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw Error('cli_registration_active_invalid');
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)).split('\n');
  if (
    lines.length !== 3 ||
    lines[2] !== '' ||
    !/^[a-f0-9]{64}$/.test(lines[0]!) ||
    (lines[1] !== '' && (!/^[a-f0-9]{64}$/.test(lines[1]!) || lines[1] === lines[0]))
  )
    throw Error('cli_registration_active_invalid');
  return lines[0]!;
}
