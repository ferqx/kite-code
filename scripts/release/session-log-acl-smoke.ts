import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { version as osVersion, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  sessionLogDir,
  sessionLogFrontendDir,
  sessionLogRoot,
  userKiteCodeDir,
} from '#kite-service/config/paths';
import type { SessionLoggingPolicy } from '#kite-service/config/session-logging-policy';
import { SESSION_LOG_LEASE_FILE } from '../../apps/kite-service/src/session-logger/active-session-lease';
import { SessionLogWriter } from '../../apps/kite-service/src/session-logger/writer';

const WINDOWS_SESSION_LOG_ACL_EVIDENCE_TIMEOUT_MS = 30_000;

const SMOKE_POLICY: SessionLoggingPolicy = {
  version: 1,
  mode: 'metadata',
  retentionDays: 7,
  maxTotalBytes: 4 * 1024 * 1024,
  maxSessionBytes: 1024 * 1024,
  includeReasoning: false,
  includeFileContent: false,
  includeToolContent: false,
};

export interface SessionLogAclSmokeEvidence {
  version: 1;
  evidenceId: string;
  capturedAt: string;
  platform: NodeJS.Platform;
  osRelease: string;
  osVersion: string;
  arch: string;
  bunVersion: string;
  directoryIsolation: 'verified';
  fileIsolation: 'verified';
  linkRejection: 'verified';
  atomicTerminal: 'verified';
}

export async function runSessionLogAclSmoke(): Promise<SessionLogAclSmokeEvidence> {
  const container = mkdtempSync(join(tmpdir(), 'kite-session-log-acl-smoke-'));
  const root = join(container, 'kite-code');
  mkdirSync(root, { mode: 0o700 });
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = root;
  try {
    const writer = new SessionLogWriter('native-smoke', 'session', 'events', undefined, undefined, {
      policy: SMOKE_POLICY,
      heartbeatIntervalMs: 0,
    });
    writer.write({
      schemaVersion: 1,
      eventType: 'native.smoke',
      status: 'ok',
      metadata: {},
    });

    const session = sessionLogDir('native-smoke', 'session');
    const events = join(session, 'events.jsonl');
    const lease = join(session, SESSION_LOG_LEASE_FILE);
    const terminal = join(session, 'terminal.json');
    if (!existsSync(lease)) throw new Error('Session-log ACL smoke did not create its live lease.');
    if (process.platform === 'win32') {
      verifyWindowsAcl([
        userKiteCodeDir(),
        sessionLogRoot(),
        sessionLogFrontendDir('native-smoke'),
        session,
        lease,
      ]);
    } else if ((statSync(lease).mode & 0o777) !== 0o600) {
      throw new Error('Session-log live lease is not 0600.');
    }

    await writer.finalize('completed');
    if (!existsSync(events) || !existsSync(terminal)) {
      throw new Error('Session-log ACL smoke did not create its bounded artifacts.');
    }
    if (process.platform === 'win32') {
      verifyWindowsAcl([
        userKiteCodeDir(),
        sessionLogRoot(),
        sessionLogFrontendDir('native-smoke'),
        session,
        events,
        terminal,
      ]);
    } else {
      for (const directory of [
        userKiteCodeDir(),
        sessionLogRoot(),
        sessionLogFrontendDir('native-smoke'),
        session,
      ]) {
        if ((statSync(directory).mode & 0o777) !== 0o700) {
          throw new Error(`Session-log directory is not 0700: ${directory}`);
        }
      }
      for (const file of [events, terminal]) {
        if ((statSync(file).mode & 0o777) !== 0o600) {
          throw new Error(`Session-log file is not 0600: ${file}`);
        }
      }
    }
    const terminalRecord = JSON.parse(readFileSync(terminal, 'utf8'));
    if (
      terminalRecord.version !== 1 ||
      terminalRecord.outcome !== 'closed' ||
      terminalRecord.runOutcome !== 'completed' ||
      readdirSync(session).some(
        (entry) => entry.includes('terminal.json') && entry.endsWith('.tmp'),
      )
    ) {
      throw new Error('Session-log terminal marker is not a complete atomic terminal record.');
    }

    await verifyLinkRejection(root);
    return {
      version: 1,
      evidenceId: randomUUID(),
      capturedAt: new Date().toISOString(),
      platform: process.platform,
      osRelease: release(),
      osVersion: osVersion(),
      arch: process.arch,
      bunVersion: Bun.version,
      directoryIsolation: 'verified',
      fileIsolation: 'verified',
      linkRejection: 'verified',
      atomicTerminal: 'verified',
    };
  } finally {
    if (previousHome == null) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(container, { recursive: true, force: true });
  }
}

async function verifyLinkRejection(root: string): Promise<void> {
  await verifyFileAndDirectoryLinkRejection(root);
  const secondHome = join(root, 'linked-home');
  const outside = join(root, 'outside');
  mkdirSync(secondHome);
  mkdirSync(outside);
  symlinkSync(
    outside,
    join(secondHome, 'sessions'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = secondHome;
  try {
    let rejected = false;
    try {
      new SessionLogWriter('native-smoke', 'linked', 'events', undefined, undefined, {
        policy: SMOKE_POLICY,
        heartbeatIntervalMs: 0,
      });
    } catch {
      rejected = true;
    }
    if (!rejected || !lstatSync(join(secondHome, 'sessions')).isSymbolicLink()) {
      throw new Error('Session-log writer did not reject the linked/reparse-point root.');
    }
    if (existsSync(join(outside, 'native-smoke'))) {
      throw new Error('Session-log writer followed a linked/reparse-point root.');
    }
  } finally {
    if (previousHome == null) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
  }
}

async function verifyFileAndDirectoryLinkRejection(root: string): Promise<void> {
  const frontend = sessionLogFrontendDir('native-smoke');
  const outsideFile = join(root, 'outside-file.txt');
  writeFileSync(outsideFile, 'unchanged');
  const fileWriter = new SessionLogWriter(
    'native-smoke',
    'linked-file',
    'events',
    undefined,
    undefined,
    {
      heartbeatIntervalMs: 0,
    },
  );
  const linkedEvents = join(sessionLogDir('native-smoke', 'linked-file'), 'events.jsonl');
  unlinkSync(linkedEvents);
  symlinkSync(outsideFile, linkedEvents, 'file');
  fileWriter.write({ mustNotEscape: true });

  await verifyFailedFileWriter(fileWriter, outsideFile, frontend, root);
  verifyHardlinkRejection(root);
}

function verifyHardlinkRejection(root: string): void {
  const outsideFile = join(root, 'outside-hardlink-target.txt');
  writeFileSync(outsideFile, 'unchanged');
  const session = sessionLogDir('native-smoke', 'hardlinked-file');
  mkdirSync(session, { mode: 0o700 });
  linkSync(outsideFile, join(session, 'events.jsonl'));
  let rejected = false;
  try {
    new SessionLogWriter('native-smoke', 'hardlinked-file', 'events', undefined, undefined, {
      heartbeatIntervalMs: 0,
    });
  } catch {
    rejected = true;
  }
  if (!rejected || readFileSync(outsideFile, 'utf8') !== 'unchanged') {
    throw new Error('Session-log writer accepted a hardlinked events target.');
  }
}

async function verifyFailedFileWriter(
  writer: SessionLogWriter,
  outsideFile: string,
  frontend: string,
  root: string,
): Promise<void> {
  await writer.finalize('fatal');
  if (readFileSync(outsideFile, 'utf8') !== 'unchanged') {
    throw new Error('Session-log writer followed a file symlink/reparse point.');
  }
  const outsideDirectory = join(root, 'outside-session-directory');
  mkdirSync(outsideDirectory);
  const linkedDirectory = join(frontend, 'linked-directory');
  symlinkSync(outsideDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  let rejected = false;
  try {
    new SessionLogWriter('native-smoke', 'linked-directory', 'events', undefined, undefined, {
      heartbeatIntervalMs: 0,
    });
  } catch {
    rejected = true;
  }
  if (!rejected || existsSync(join(outsideDirectory, SESSION_LOG_LEASE_FILE))) {
    throw new Error('Session-log writer followed a directory reparse point.');
  }
}

function verifyWindowsAcl(paths: readonly string[]): void {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const script = `
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$paths = $env:KITE_SESSION_LOG_ACL_SMOKE_PATHS | ConvertFrom-Json
foreach ($path in $paths) {
  $item = Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 51 }
  $acl = Get-Acl -LiteralPath $path
  if (-not $acl.AreAccessRulesProtected) { exit 52 }
  $ownerSid = ([System.Security.Principal.NTAccount]$acl.Owner).Translate(
    [System.Security.Principal.SecurityIdentifier]
  ).Value
  if ($ownerSid -ne $identity.Value) { exit 53 }
  if (@($acl.Access).Count -eq 0) { exit 54 }
  foreach ($rule in @($acl.Access)) {
    if (
      $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.Value -or
      $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
      ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne
        [System.Security.AccessControl.FileSystemRights]::FullControl
    ) {
      exit 55
    }
  }
}
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync(
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: WINDOWS_SESSION_LOG_ACL_EVIDENCE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        PSModulePath: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
        KITE_SESSION_LOG_ACL_SMOKE_PATHS: JSON.stringify(paths),
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Windows owner-only ACL verification failed with status ${result.status ?? 'unknown'}.`,
    );
  }
}

if (import.meta.main) {
  const evidence = await runSessionLogAclSmoke();
  const serialized = `${JSON.stringify(evidence)}\n`;
  const outputPath = process.argv[2];
  if (outputPath) writeFileSync(resolve(outputPath), serialized, { mode: 0o600 });
  process.stdout.write(serialized);
}
