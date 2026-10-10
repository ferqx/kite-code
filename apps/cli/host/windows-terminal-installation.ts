import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { defaultWindowsPathSecurity } from '@kite-ai/agent/windows-path-security';

export const windowsTerminalFrontdoorNames = Object.freeze([
  'kite.exe',
  'kite-tui.exe',
  'terminal-verifier.exe',
] as const);
export interface WindowsTerminalInstallationMarker {
  readonly version: 2;
  readonly root: string;
  readonly bootstrap: {
    readonly candidateId: string;
    readonly files: readonly {
      readonly name: string;
      readonly size: number;
      readonly sha256: string;
    }[];
  };
}
const closed = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
function denied(): never {
  throw Error('terminal_windows_install_identity_mismatch');
}
/** Closed Windows-only bootstrap identity; hashes bind bytes, never publisher authority. */
export function parseWindowsTerminalInstallationMarker(
  value: unknown,
  root: string,
): WindowsTerminalInstallationMarker {
  if (
    !closed(value, ['version', 'root', 'bootstrap']) ||
    value.version !== 2 ||
    value.root !== root ||
    !closed(value.bootstrap, ['candidateId', 'files']) ||
    typeof value.bootstrap.candidateId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.bootstrap.candidateId) ||
    !Array.isArray(value.bootstrap.files) ||
    value.bootstrap.files.length !== windowsTerminalFrontdoorNames.length
  )
    denied();
  const files = value.bootstrap.files.map((file, index) => {
    if (
      !closed(file, ['name', 'size', 'sha256']) ||
      file.name !== windowsTerminalFrontdoorNames[index] ||
      typeof file.size !== 'number' ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      file.size > 512 * 1048576 ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      denied();
    return Object.freeze({ name: file.name as string, size: file.size, sha256: file.sha256 });
  });
  return Object.freeze({
    version: 2,
    root,
    bootstrap: Object.freeze({
      candidateId: value.bootstrap.candidateId,
      files: Object.freeze(files),
    }),
  });
}
export function readWindowsTerminalInstallation(root: string): WindowsTerminalInstallationMarker {
  if (process.platform !== 'win32' || realpathSync(root) !== root) denied();
  const security = defaultWindowsPathSecurity()!;
  security.verifyDirectory(root);
  const bytes = security.readScopeFile(join(root, '.kite-terminal-install.json'), 16384, true);
  if (!bytes) denied();
  return parseWindowsTerminalInstallationMarker(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    root,
  );
}
/** Keeps exact stable bootstrap files retained through the caller's admitted operation. */
export function retainWindowsTerminalFrontdoor(marker: WindowsTerminalInstallationMarker): {
  verify(): void;
  release(): void;
} {
  if (process.platform !== 'win32') denied();
  const { retainWindowsCandidateFiles } =
    require('@kite-ai/agent/artifact-access') as typeof import('@kite-ai/agent/artifact-access');
  const bin = join(marker.root, 'bin');
  const retained = retainWindowsCandidateFiles(bin, windowsTerminalFrontdoorNames);
  try {
    const verify = () => {
      retained.verify();
      if (readdirSync(bin).sort().join(',') !== [...windowsTerminalFrontdoorNames].sort().join(','))
        denied();
      for (const file of marker.bootstrap.files) {
        const path = join(bin, file.name);
        const stat = lstatSync(path);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.size !== file.size ||
          createHash('sha256').update(readFileSync(path)).digest('hex') !== file.sha256
        )
          denied();
      }
      retained.verify();
    };
    verify();
    return Object.freeze({ verify, release: () => retained.release() });
  } catch (error) {
    retained.release();
    throw error;
  }
}
