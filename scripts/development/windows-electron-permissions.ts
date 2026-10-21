import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, win32 } from 'node:path';

interface PermissionResult {
  readonly checked: number;
  readonly repaired: number;
}
type Run = (
  executable: string,
  args: string[],
  input: string,
) => {
  status: number | null;
  stdout: string;
  error?: Error;
};
const failure = 'development_electron_permissions_failed';
const scopeFailure = 'development_electron_runtime_scope_invalid';
const errors = new Set([failure, scopeFailure, 'development_electron_permissions_denied']);

/** Only the installed npm Electron's physical dist is eligible; no profile or project ACLs. */
export function ensureWindowsElectronPermissions(input: {
  readonly executable: string;
  readonly packageDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly run?: Run;
}): PermissionResult {
  if ((input.platform ?? process.platform) !== 'win32') return { checked: 0, repaired: 0 };
  let packageDirectory: string, executable: string;
  try {
    packageDirectory = realpathSync(input.packageDirectory);
    const runtime = join(packageDirectory, 'dist');
    if (lstatSync(runtime).isSymbolicLink() || !lstatSync(runtime).isDirectory())
      throw Error(scopeFailure);
    executable = realpathSync(input.executable);
    if (executable.toLowerCase() !== join(runtime, 'electron.exe').toLowerCase())
      throw Error(scopeFailure);
    const metadata: unknown = JSON.parse(
      readFileSync(join(packageDirectory, 'package.json'), 'utf8'),
    );
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      !('name' in metadata) ||
      metadata.name !== 'electron' ||
      !('version' in metadata) ||
      typeof metadata.version !== 'string' ||
      readFileSync(join(runtime, 'version'), 'utf8').trim().replace(/^v/, '') !== metadata.version
    )
      throw Error(scopeFailure);
  } catch {
    throw Error(scopeFailure);
  }
  const program = readFileSync(join(import.meta.dir, 'windows-electron-permissions.ps1'), 'utf8');
  const powershell = win32.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  const run: Run =
    input.run ??
    ((command, args, data) =>
      spawnSync(command, args, {
        input: data,
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 131072,
        windowsHide: true,
      }));
  const result = run(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(program, 'utf16le').toString('base64'),
    ],
    JSON.stringify({ executable, packageDirectory }),
  );
  let report: unknown;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw Error(failure);
  }
  if (result.error || result.status !== 0) {
    const code = report && typeof report === 'object' && 'code' in report ? report.code : undefined;
    throw Error(typeof code === 'string' && errors.has(code) ? code : failure);
  }
  if (
    !report ||
    typeof report !== 'object' ||
    Object.keys(report).sort().join(',') !== 'checked,ok,repaired' ||
    !('ok' in report) ||
    report.ok !== true ||
    !('checked' in report) ||
    !('repaired' in report) ||
    typeof report.checked !== 'number' ||
    !Number.isSafeInteger(report.checked) ||
    report.checked < 1 ||
    typeof report.repaired !== 'number' ||
    !Number.isSafeInteger(report.repaired) ||
    report.repaired < 0 ||
    report.repaired > report.checked
  )
    throw Error(failure);
  return { checked: report.checked, repaired: report.repaired };
}
