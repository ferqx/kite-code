import { spawn } from 'node:child_process';
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface LoggedShellArguments {
  log: string;
  script: string;
}

export function parseLoggedShellArguments(args: readonly string[]): LoggedShellArguments {
  if (args.length !== 2 || !/^--log=dist\/unified-evidence\/[a-z0-9-]+\.log$/.test(args[0] ?? '')) {
    throw new Error('Expected --log=dist/unified-evidence/<slug>.log and one script path');
  }
  const script = args[1];
  if (!script || script.startsWith('-') || script.includes('\0')) {
    throw new Error('Invalid script path');
  }
  return { log: args[0]!.slice('--log='.length), script };
}

// A separate bootstrap keeps the runner script intact, including a possible BOM.
// The original path is a structured -File argument, never command interpolation.
export function powershellBootstrap(): string {
  return (
    'param([Parameter(Mandatory = $true)][string]$OriginalScript)\n' +
    "$ErrorActionPreference = 'stop'\n" +
    '& $OriginalScript\n' +
    'if (Test-Path -LiteralPath variable:\\LASTEXITCODE) { exit $LASTEXITCODE }\n'
  );
}

function openLog(cwd: string, relativePath: string): number {
  let directory = realpathSync(cwd);
  for (const component of ['dist', 'unified-evidence']) {
    directory = join(directory, component);
    try {
      mkdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe log directory');
  }
  return openSync(
    join(directory, relativePath.split('/')[2]!),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('Incomplete log write');
    offset += written;
  }
}

export interface LoggedShellOptions {
  cwd?: string;
  platform?: NodeJS.Platform;
  // Tests can exercise executable startup failure without replacing command execution.
  executable?: string;
  stdout?: (bytes: Buffer) => void;
  stderr?: (bytes: Buffer) => void;
}

export async function runLoggedShell(
  args: readonly string[],
  options: LoggedShellOptions = {},
): Promise<number> {
  const parsed = parseLoggedShellArguments(args);
  const cwd = options.cwd ?? process.cwd();
  const script = resolve(cwd, parsed.script);
  if (!lstatSync(script).isFile()) throw new Error('Script must be a regular file');
  const source = readFileSync(script);
  new TextDecoder('utf-8', { fatal: true }).decode(source);
  const log = openLog(cwd, parsed.log);
  let temporary: string | undefined;
  try {
    const windows = (options.platform ?? process.platform) === 'win32';
    let scriptPath = script;
    let originalPowerShellPath: string | undefined;
    if (windows) {
      temporary = mkdtempSync(join(tmpdir(), 'kite-ci-shell-'));
      originalPowerShellPath = join(temporary, 'original.ps1');
      writeFileSync(originalPowerShellPath, source, { flag: 'wx', mode: 0o600 });
      scriptPath = join(temporary, 'bootstrap.ps1');
      writeFileSync(scriptPath, powershellBootstrap(), { flag: 'wx', mode: 0o600 });
    }
    const executable = options.executable ?? (windows ? 'pwsh' : 'bash');
    const argv = windows
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath, originalPowerShellPath!]
      : ['--noprofile', '--norc', '-e', '-o', 'pipefail', scriptPath];
    return await new Promise<number>((resolveExit) => {
      const child = spawn(executable, argv, { cwd, stdio: ['inherit', 'pipe', 'pipe'] });
      let failed = false;
      let interrupted = false;
      const forwardSignal = (signal: NodeJS.Signals) => {
        interrupted = true;
        child.kill(signal);
      };
      const onInterrupt = () => forwardSignal('SIGINT');
      const onTerminate = () => forwardSignal('SIGTERM');
      process.on('SIGINT', onInterrupt);
      process.on('SIGTERM', onTerminate);
      const capture = (bytes: Buffer, output: (bytes: Buffer) => void) => {
        try {
          writeAll(log, bytes);
          output(bytes);
        } catch {
          failed = true;
          child.kill('SIGTERM');
        }
      };
      child.stdout.on('data', (bytes: Buffer) =>
        capture(bytes, options.stdout ?? ((chunk) => writeAll(1, chunk))),
      );
      child.stderr.on('data', (bytes: Buffer) =>
        capture(bytes, options.stderr ?? ((chunk) => writeAll(2, chunk))),
      );
      child.on('error', () => {
        failed = true;
      });
      child.on('close', (code, signal) => {
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onTerminate);
        resolveExit(failed ? 1 : signal || interrupted ? 128 : (code ?? 1));
      });
    });
  } finally {
    try {
      closeSync(log);
    } finally {
      if (temporary) rmSync(temporary, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await runLoggedShell(process.argv.slice(2));
  } catch (error) {
    console.error(
      `CI logged shell failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
