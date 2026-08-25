import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  assertSafeSessionLogSegment,
  assertSecureOwnedRegularFile,
  ensureSecureSessionLogDirectory,
  type SecureSessionStorageOptions,
} from '@kite/builtin-runtime/model';
import { sessionLogRoot } from '#app/config/paths';
import type { SessionLoggingPolicy } from '#app/config/session-logging-policy';
import {
  type ActiveSessionLeaseOptions,
  inspectSessionLogLease,
  SESSION_LOG_ADMISSION_LOCK_FILE,
  SESSION_LOG_LEASE_FILE,
  SESSION_LOG_LEASE_RESERVE_BYTES,
  tryAcquireSessionOperation,
} from './active-session-lease';

const SESSION_FILE_ALLOWLIST = new Set([
  'events.jsonl',
  'terminal.json',
  SESSION_LOG_LEASE_FILE,
  '.session-operation.lock',
]);
const DEFAULT_MAINTENANCE_DEADLINE_MS = 50;
const DEFAULT_WINDOWS_MAINTENANCE_DEADLINE_MS = 30_000;

export interface SessionLogMaintenanceOptions
  extends SecureSessionStorageOptions,
    Pick<ActiveSessionLeaseOptions, 'now' | 'processIdentity' | 'staleAfterMs'> {
  root?: string;
  maxEntries?: number;
  deadlineMs?: number;
  reserveBytes?: number;
}

export interface SessionLogMaintenanceReport {
  scannedEntries: number;
  removedSessions: number;
  quarantinedSessions: number;
  protectedSessions: number;
  reclaimedBytes: number;
  bounded: boolean;
  observedBytes: number;
  capacitySatisfied: boolean;
}

interface SessionCandidate {
  path: string;
  size: number;
  modifiedAtMs: number;
  identity: string;
}

interface ScanBudget {
  deadlineAt: number;
  maxEntries: number;
  report: SessionLogMaintenanceReport;
}

export function runSessionLogMaintenance(
  policy: SessionLoggingPolicy,
  options: SessionLogMaintenanceOptions = {},
): SessionLogMaintenanceReport {
  const root = options.root ?? sessionLogRoot();
  const now = options.now ?? (() => new Date());
  const platform = options.platform ?? process.platform;
  const deadlineAt =
    Date.now() +
    (options.deadlineMs ??
      (platform === 'win32'
        ? DEFAULT_WINDOWS_MAINTENANCE_DEADLINE_MS
        : DEFAULT_MAINTENANCE_DEADLINE_MS));
  const maxEntries = options.maxEntries ?? 512;
  const report: SessionLogMaintenanceReport = {
    scannedEntries: 0,
    removedSessions: 0,
    quarantinedSessions: 0,
    protectedSessions: 0,
    reclaimedBytes: 0,
    bounded: false,
    observedBytes: 0,
    capacitySatisfied: true,
  };
  ensureRoot(root, options);
  const candidates: SessionCandidate[] = [];
  let activeReservationBytes = 0;
  const scanBudget: ScanBudget = { deadlineAt, maxEntries, report };

  let stopScan = false;
  let scanFailed = false;
  let rootDirectory: ReturnType<typeof opendirSync> | undefined;
  try {
    rootDirectory = opendirSync(root);
    let frontendEntry = rootDirectory.readSync();
    while (frontendEntry != null && !stopScan) {
      if (!consumeScanBudget(scanBudget)) {
        stopScan = true;
        break;
      }
      if (frontendEntry.name === SESSION_LOG_ADMISSION_LOCK_FILE) {
        frontendEntry = rootDirectory.readSync();
        continue;
      }
      if (frontendEntry.name === 'index.json') {
        try {
          report.observedBytes += assertSecureOwnedRegularFile(
            join(root, frontendEntry.name),
            options,
          );
        } catch {
          report.capacitySatisfied = false;
        }
        frontendEntry = rootDirectory.readSync();
        continue;
      }
      const frontendPath = join(root, frontendEntry.name);
      if (!isSafeDirectoryEntry(frontendEntry.name, frontendPath, options)) {
        if (frontendEntry.name === '.DS_Store' && frontendEntry.isFile()) {
          try {
            quarantineRootEntry(root, frontendPath, options);
            report.quarantinedSessions++;
          } catch {
            report.capacitySatisfied = false;
          }
        } else {
          report.capacitySatisfied = false;
        }
        frontendEntry = rootDirectory.readSync();
        continue;
      }

      let frontendDirectory: ReturnType<typeof opendirSync> | undefined;
      try {
        frontendDirectory = opendirSync(frontendPath);
        let sessionEntry = frontendDirectory.readSync();
        while (sessionEntry != null) {
          if (!consumeScanBudget(scanBudget)) {
            stopScan = true;
            break;
          }
          const sessionPath = join(frontendPath, sessionEntry.name);
          if (!isSafeDirectoryEntry(sessionEntry.name, sessionPath, options)) {
            if (sessionEntry.name === '.DS_Store' && sessionEntry.isFile()) {
              try {
                quarantineRootEntry(root, sessionPath, options);
                report.quarantinedSessions++;
              } catch {
                report.capacitySatisfied = false;
              }
            } else {
              report.capacitySatisfied = false;
            }
            sessionEntry = frontendDirectory.readSync();
            continue;
          }
          const releaseOperation = tryAcquireSessionOperation(sessionPath, options);
          if (!releaseOperation) {
            report.protectedSessions++;
            report.capacitySatisfied = false;
            sessionEntry = frontendDirectory.readSync();
            continue;
          }
          try {
            const lease = inspectSessionLogLease(sessionPath, options);
            if (lease.status === 'active' || lease.status === 'unknown') {
              report.protectedSessions++;
              const protectedStorage = inspectSessionDirectory(sessionPath, options, scanBudget);
              if (protectedStorage) {
                report.observedBytes += protectedStorage.size;
                if (lease.status === 'active') {
                  activeReservationBytes += Math.max(
                    0,
                    policy.maxSessionBytes - protectedStorage.size,
                  );
                } else {
                  report.capacitySatisfied = false;
                }
              } else {
                report.capacitySatisfied = false;
              }
              if (report.bounded) stopScan = true;
            } else {
              if (lease.status === 'stale') {
                const leasePath = join(sessionPath, SESSION_LOG_LEASE_FILE);
                if (existsSync(leasePath)) unlinkSync(leasePath);
              }
              const inspected = inspectSessionDirectory(sessionPath, options, scanBudget);
              if (!inspected) {
                if (report.bounded) {
                  report.protectedSessions++;
                  stopScan = true;
                } else {
                  quarantineSession(
                    root,
                    frontendEntry.name,
                    sessionEntry.name,
                    sessionPath,
                    options,
                  );
                  report.quarantinedSessions++;
                }
              } else {
                candidates.push({ path: sessionPath, ...inspected });
                report.observedBytes += inspected.size;
              }
            }
          } finally {
            releaseOperation();
          }
          if (!stopScan) sessionEntry = frontendDirectory.readSync();
        }
      } catch {
        scanFailed = true;
        report.capacitySatisfied = false;
      } finally {
        frontendDirectory?.closeSync();
      }
      if (!stopScan) frontendEntry = rootDirectory.readSync();
    }
  } catch {
    scanFailed = true;
    report.capacitySatisfied = false;
  } finally {
    rootDirectory?.closeSync();
  }

  if (Date.now() > deadlineAt) report.bounded = true;
  if (report.bounded || scanFailed) {
    report.capacitySatisfied = false;
    return report;
  }

  const retentionCutoff = now().getTime() - policy.retentionDays * 24 * 60 * 60 * 1000;
  const removable = candidates.sort(
    (a, b) => a.modifiedAtMs - b.modifiedAtMs || a.path.localeCompare(b.path),
  );
  let totalBytes = report.observedBytes;
  const capacityTarget = Math.max(
    0,
    policy.maxTotalBytes - (options.reserveBytes ?? policy.maxSessionBytes),
  );
  for (const candidate of removable) {
    if (Date.now() > deadlineAt) {
      report.bounded = true;
      break;
    }
    if (
      candidate.size <= policy.maxSessionBytes - SESSION_LOG_LEASE_RESERVE_BYTES &&
      candidate.modifiedAtMs >= retentionCutoff &&
      totalBytes + activeReservationBytes <= capacityTarget
    ) {
      continue;
    }
    const releaseOperation = tryAcquireSessionOperation(candidate.path, options);
    if (!releaseOperation) {
      report.protectedSessions++;
      continue;
    }
    try {
      const lease = inspectSessionLogLease(candidate.path, options);
      if (lease.status !== 'absent' && lease.status !== 'stale') {
        report.protectedSessions++;
        continue;
      }
      const rechecked = inspectSessionDirectory(candidate.path, options, scanBudget);
      if (!rechecked || rechecked.identity !== candidate.identity) {
        report.protectedSessions++;
        if (report.bounded) break;
        continue;
      }
      if (!moveAndRemoveSession(root, candidate.path, candidate.identity, options)) {
        report.protectedSessions++;
        report.capacitySatisfied = false;
        continue;
      }
      totalBytes = Math.max(0, totalBytes - rechecked.size);
      report.removedSessions++;
      report.reclaimedBytes += rechecked.size;
    } finally {
      releaseOperation();
    }
  }
  report.observedBytes = totalBytes;
  if (Date.now() > deadlineAt) report.bounded = true;
  if (report.bounded || totalBytes + activeReservationBytes > capacityTarget) {
    report.capacitySatisfied = false;
  }
  return report;
}

function ensureRoot(root: string, options: SecureSessionStorageOptions): void {
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  ensureSecureSessionLogDirectory(root, options);
}

function isSafeDirectoryEntry(
  name: string,
  path: string,
  options: SecureSessionStorageOptions,
): boolean {
  try {
    assertSafeSessionLogSegment(name, 'session-log directory');
    ensureSecureSessionLogDirectory(path, options);
    return true;
  } catch {
    return false;
  }
}

function inspectSessionDirectory(
  sessionPath: string,
  options: SecureSessionStorageOptions,
  budget: ScanBudget,
): { size: number; modifiedAtMs: number; identity: string } | undefined {
  let size = 0;
  const directory = lstatSync(sessionPath);
  let modifiedAtMs = 0;
  let handle: ReturnType<typeof opendirSync> | undefined;
  try {
    handle = opendirSync(sessionPath);
    let entry = handle.readSync();
    while (entry != null) {
      if (!consumeScanBudget(budget)) return undefined;
      if (!SESSION_FILE_ALLOWLIST.has(entry.name) || !entry.isFile()) return undefined;
      const path = join(sessionPath, entry.name);
      size += assertSecureOwnedRegularFile(path, options);
      if (entry.name !== '.session-operation.lock' && entry.name !== SESSION_LOG_LEASE_FILE) {
        modifiedAtMs = Math.max(modifiedAtMs, statSync(path).mtimeMs);
      }
      entry = handle.readSync();
    }
    if (Date.now() > budget.deadlineAt) {
      budget.report.bounded = true;
      return undefined;
    }
    if (modifiedAtMs === 0) modifiedAtMs = directory.mtimeMs;
    return {
      size,
      modifiedAtMs,
      identity: `${directory.dev}:${directory.ino}`,
    };
  } catch {
    return undefined;
  } finally {
    handle?.closeSync();
  }
}

function consumeScanBudget(budget: ScanBudget): boolean {
  if (Date.now() > budget.deadlineAt || budget.report.scannedEntries >= budget.maxEntries) {
    budget.report.bounded = true;
    budget.report.capacitySatisfied = false;
    return false;
  }
  budget.report.scannedEntries++;
  return true;
}

function quarantineSession(
  root: string,
  frontend: string,
  session: string,
  source: string,
  options: SecureSessionStorageOptions,
): void {
  const quarantine = ensureQuarantine(root, options);
  renameSync(source, join(quarantine, `${frontend}-${session}-${randomUUID()}`));
}

function moveAndRemoveSession(
  root: string,
  source: string,
  expectedIdentity: string,
  options: SecureSessionStorageOptions,
): boolean {
  const quarantine = ensureQuarantine(root, options);
  const moved = join(quarantine, `.deleting-${randomUUID()}`);
  try {
    renameSync(source, moved);
    const identity = lstatSync(moved);
    if (
      identity.isSymbolicLink() ||
      !identity.isDirectory() ||
      `${identity.dev}:${identity.ino}` !== expectedIdentity
    ) {
      return false;
    }
    rmSync(moved, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

function ensureQuarantine(root: string, options: SecureSessionStorageOptions): string {
  const quarantine = join(dirname(root), `${basename(root)}-quarantine`);
  if (!existsSync(quarantine)) mkdirSync(quarantine, { mode: 0o700 });
  ensureSecureSessionLogDirectory(quarantine, options);
  return quarantine;
}

function quarantineRootEntry(
  root: string,
  source: string,
  options: SecureSessionStorageOptions,
): void {
  renameSync(source, join(ensureQuarantine(root, options), `root-entry-${randomUUID()}`));
}
