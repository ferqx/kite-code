import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import {
  startWindowsOwnedChild,
  WindowsOwnedChildStartError,
} from '../platform/process/windows-owned-child';
import { dlopen, ptr } from '../runtime-ffi';
import {
  type LaunchIdentity,
  launchIdentityAsync,
  verifyLaunchIdentitiesAsync,
} from './launch-identity';

export interface WindowsPowerShell {
  readonly systemDirectory: string;
  readonly executable: LaunchIdentity;
  readonly engine: LaunchIdentity;
}

function systemDirectory() {
  const kernel = dlopen('kernel32.dll', {
    GetSystemDirectoryW: { args: ['ptr', 'u32'], returns: 'u32' },
  });
  try {
    const buffer = new Uint16Array(32768);
    const length = kernel.symbols.GetSystemDirectoryW(ptr(buffer), buffer.length);
    if (!length || length >= buffer.length) throw Error('windows_system_directory_unavailable');
    return Buffer.from(buffer.buffer, 0, length * 2).toString('utf16le');
  } finally {
    kernel.close();
  }
}

export async function discoverWindowsPowerShell(): Promise<WindowsPowerShell> {
  const directory = systemDirectory();
  const path = join(directory, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw Error('windows_powershell_unavailable');
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('windows_powershell_asset_invalid');
  const executable = await launchIdentityAsync(path, true);
  if (path.toLowerCase() !== executable.canonical.toLowerCase())
    throw Error('windows_powershell_asset_invalid');
  const result = await runWindowsPowerShellInspection(
    { systemDirectory: directory, executable },
    '[Console]::WriteLine($PSVersionTable.PSVersion.ToString()); [Console]::WriteLine([System.Management.Automation.Language.Parser].Assembly.Location)',
    '',
  );
  const [version, assembly] = result.trim().split(/\r?\n/u);
  if (!/^5\.1\.\d+(?:\.\d+)?$/u.test(version ?? '')) throw Error('windows_powershell_unavailable');
  if (
    !assembly ||
    !isAbsolute(assembly) ||
    !assembly.toLowerCase().startsWith(`${dirname(directory).toLowerCase()}\\`)
  )
    throw Error('windows_powershell_asset_invalid');
  return {
    systemDirectory: directory,
    executable,
    engine: await launchIdentityAsync(assembly, true),
  };
}

/** Fixed host inspection code. Model text is UTF-8 input data, never part of its arguments. */
export async function runWindowsPowerShellInspection(
  shell: Pick<WindowsPowerShell, 'systemDirectory' | 'executable'> &
    Partial<Pick<WindowsPowerShell, 'engine'>>,
  inspection: string,
  source: string,
  signal?: AbortSignal,
): Promise<string> {
  await verifyLaunchIdentitiesAsync(
    [shell.executable, ...(shell.engine ? [shell.engine] : [])],
    signal,
  );
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = [System.Text.UTF8Encoding]::new($false, $true)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$env:PSModulePath = $PSHOME + '\\Modules'
${inspection}`;
  const directory = shell.systemDirectory;
  let owner: ReturnType<typeof startWindowsOwnedChild>;
  try {
    owner = startWindowsOwnedChild({
      executable: shell.executable.canonical,
      argv: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-OutputFormat',
        'Text',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      cwd: dirname(shell.executable.canonical),
      env: {
        SystemRoot: dirname(directory),
        PATH: directory,
        PSModulePath: join(dirname(shell.executable.canonical), 'Modules'),
      },
      stdin: 'pipe',
    });
  } catch (error) {
    if (error instanceof WindowsOwnedChildStartError) await error.cleanup;
    throw error;
  }
  const deadline = AbortSignal.timeout(5000);
  const inspectionSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const stop = () => {
    void owner.stop({ graceMs: 0 }).catch(() => {});
  };
  inspectionSignal.addEventListener('abort', stop, { once: true });
  if (inspectionSignal.aborted) stop();
  const read = async (stream: AsyncIterable<Uint8Array>, maximum: number) => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (bytes > maximum) throw Error('windows_powershell_inspection_output_limit');
      chunks.push(chunk);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  };
  const output = read(owner.stdout, 1024 * 1024);
  const errors = read(owner.stderr, 64 * 1024);
  const input = (async () => {
    if (source) await owner.writeStdin(Buffer.from(source, 'utf8'));
    await owner.endStdin();
  })();
  const tasks = [output, errors, input, owner.exited] as const;
  try {
    const [stdout, stderr, , code] = await Promise.all(tasks);
    inspectionSignal.throwIfAborted();
    if (code !== 0 || stderr.trim()) throw Error('windows_powershell_inspection_failed');
    return stdout;
  } finally {
    inspectionSignal.removeEventListener('abort', stop);
    await owner.close();
    await Promise.allSettled(tasks);
  }
}
