import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { type ParseError, parse } from 'jsonc-parser';
import { canonicalWorkspaceKey } from './mcp-project-approvals';
import { workspaceTrustPath } from './paths';
import {
  resolveWorkspaceExternalReadScope,
  type WorkspaceExternalReadScope,
} from './workspace-external-read-scope';

const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 20;
const LOCK_STALE_MS = 5000;

function lockPath(storePath: string) {
  return `${storePath}.lock`;
}

function acquireLock(path: string): () => void {
  const lock = lockPath(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = LOCK_RETRY_MS * 2 ** Math.min(attempt - 1, 4);
      Bun.sleepSync(delay);
    }
    try {
      const fd = openSync(lock, 'wx', 0o600);
      writeFileSync(fd, String(process.pid), 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      return () => {
        try {
          if (existsSync(lock)) unlinkSync(lock);
        } catch {
          /* best-effort */
        }
      };
    } catch {
      if (existsSync(lock)) {
        try {
          const age = Date.now() - statSync(lock).mtimeMs;
          if (age > LOCK_STALE_MS) {
            try {
              unlinkSync(lock);
            } catch {
              /* another process grabbed it */
            }
          }
        } catch {
          /* lock disappeared */
        }
      }
    }
  }
  throw new Error('Could not acquire workspace trust store lock after retries.');
}

/**
 * Who recorded the trust decision: 'user' = TUI confirmation dialog,
 * 'config' = explicit CLI attestation (--trust-workspace, mirrors the
 * authorization-source terminology), 'test' = test injection.
 */
export type WorkspaceTrustSource = 'user' | 'config' | 'test';

export interface WorkspaceTrustRecord {
  /** Canonical workspace identity (sha256 of the canonical realpath). */
  workspaceKey: string;
  /** Absolute path at trust time; audit aid only, never used for matching. */
  workspacePath: string;
  /** ISO 8601 timestamp of the decision. */
  trustedAt: string;
  source: WorkspaceTrustSource;
  /** Exact external read scope approved with this Workspace trust decision. */
  externalReadScopeDigest?: `sha256:${string}`;
}

interface WorkspaceTrustFile {
  version: 1;
  records: Record<string, WorkspaceTrustRecord>;
}

export type WorkspaceTrustStoreRead =
  | { status: 'ready'; records: Readonly<Record<string, WorkspaceTrustRecord>> }
  | { status: 'corrupt'; message: string }
  | { status: 'unavailable'; message: string };

/**
 * 'unknown' — never asked; 'corrupt'/'unavailable' — fail closed (prompt again
 * instead of silently trusting).
 */
export type WorkspaceTrustStatus = 'trusted' | 'unknown' | 'corrupt' | 'unavailable';

export type WorkspaceTrustDecisionResult =
  | { status: 'recorded'; record: WorkspaceTrustRecord }
  | { status: 'conflict'; message: string }
  | { status: 'store_corrupt' | 'store_unavailable'; message: string };

export interface WorkspaceTrustSnapshot {
  readonly canonicalPath: string;
  readonly workspaceKey: string;
  readonly status: WorkspaceTrustStatus;
  readonly revision: string;
  readonly externalReadScope: WorkspaceExternalReadScope;
}

// SECURITY: there is deliberately no environment-variable bypass. Bun injects
// `<cwd>/.env*` into process.env before user code runs, so any env switch could
// be set by attacker-controlled files inside the very directory the gate is
// protecting — a malicious repo committing `.env` would silently disable the
// gate on first open. Automation must use explicit attestations instead:
// CLI `--trust-workspace` (source=config) or a pre-seeded trust store.

function isRecord(value: unknown): value is WorkspaceTrustRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.workspaceKey === 'string' &&
    typeof record.workspacePath === 'string' &&
    typeof record.trustedAt === 'string' &&
    (record.source === 'user' || record.source === 'config' || record.source === 'test') &&
    (record.externalReadScopeDigest === undefined ||
      /^sha256:[a-f0-9]{64}$/u.test(String(record.externalReadScopeDigest)))
  );
}

export function readWorkspaceTrustStore(path = workspaceTrustPath()): WorkspaceTrustStoreRead {
  if (!existsSync(path)) return { status: 'ready', records: {} };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { status: 'unavailable', message: 'Workspace trust store is unreadable.' };
  }
  const errors: ParseError[] = [];
  const parsed = parse(text, errors) as unknown;
  if (
    errors.length > 0 ||
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as Record<string, unknown>).version !== 1 ||
    !(parsed as Record<string, unknown>).records ||
    typeof (parsed as Record<string, unknown>).records !== 'object' ||
    Array.isArray((parsed as Record<string, unknown>).records)
  ) {
    return { status: 'corrupt', message: 'Workspace trust store is malformed.' };
  }
  const records = (parsed as { records: Record<string, unknown> }).records;
  // The map key must equal the record's workspaceKey — a mismatch means the file
  // was hand-edited or tampered with, and the store is treated as corrupt.
  if (
    Object.entries(records).some(
      ([key, record]) => !isRecord(record) || record.workspaceKey !== key,
    )
  ) {
    return { status: 'corrupt', message: 'Workspace trust store contains an invalid record.' };
  }
  return { status: 'ready', records: records as Record<string, WorkspaceTrustRecord> };
}

function writeStore(path: string, file: WorkspaceTrustFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Current trust status of one workspace directory. */
export function getWorkspaceTrustStatus(
  workspace: string,
  storePath = workspaceTrustPath(),
): WorkspaceTrustStatus {
  let workspaceKey: string;
  let externalReadScope: WorkspaceExternalReadScope;
  try {
    workspaceKey = canonicalWorkspaceKey(workspace);
    externalReadScope = resolveWorkspaceExternalReadScope(workspace);
  } catch {
    return 'unavailable';
  }
  const store = readWorkspaceTrustStore(storePath);
  if (store.status !== 'ready') return store.status;
  return recordMatchesExternalReadScope(store.records[workspaceKey], externalReadScope)
    ? 'trusted'
    : 'unknown';
}

/**
 * Startup gate decision used by the TUI and CLI. Returns false (skip the
 * prompt) only when the workspace is already trusted; unknown, corrupt and
 * unavailable states all prompt (fail closed).
 */
export function shouldPromptWorkspaceTrust(workspace: string, storePath = workspaceTrustPath()) {
  return getWorkspaceTrustStatus(workspace, storePath) !== 'trusted';
}

function trustStoreRevision(store: WorkspaceTrustStoreRead): string {
  const material =
    store.status === 'ready'
      ? JSON.stringify(
          Object.entries(store.records)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, record]) => [key, record]),
        )
      : store.status;
  return `sha256:${createHash('sha256').update(`kite.workspace-trust.v1\0${material}`).digest('hex')}`;
}

function recordMatchesExternalReadScope(
  record: WorkspaceTrustRecord | undefined,
  scope: WorkspaceExternalReadScope,
): boolean {
  if (!record) return false;
  // Legacy records remain valid only for a Workspace with no external roots.
  // Adding a linked/external identity always requires a fresh confirmation.
  return (
    record.externalReadScopeDigest === scope.digest ||
    (record.externalReadScopeDigest === undefined && scope.roots.length === 0)
  );
}

function trustSnapshotRevision(
  store: WorkspaceTrustStoreRead,
  externalReadScope: WorkspaceExternalReadScope,
): string {
  return `sha256:${createHash('sha256')
    .update(
      `kite.workspace-trust-snapshot.v2\0${trustStoreRevision(store)}\0${externalReadScope.digest}`,
    )
    .digest('hex')}`;
}

/** Exact App Control snapshot; canonicalization happens before any project data is read. */
export function getWorkspaceTrustSnapshot(
  workspace: string,
  storePath = workspaceTrustPath(),
): WorkspaceTrustSnapshot | undefined {
  try {
    const canonicalPath = realpathSync.native(resolve(workspace));
    const workspaceKey = canonicalWorkspaceKey(canonicalPath);
    const externalReadScope = resolveWorkspaceExternalReadScope(canonicalPath);
    const store = readWorkspaceTrustStore(storePath);
    return Object.freeze({
      canonicalPath,
      workspaceKey,
      status:
        store.status === 'ready'
          ? recordMatchesExternalReadScope(store.records[workspaceKey], externalReadScope)
            ? 'trusted'
            : 'unknown'
          : store.status,
      revision: trustSnapshotRevision(store, externalReadScope),
      externalReadScope,
    });
  } catch {
    return undefined;
  }
}

/** External read roots become sandbox inputs only after the exact scope was trusted. */
export function getTrustedWorkspaceExternalReadRoots(
  workspace: string,
  storePath = workspaceTrustPath(),
): readonly string[] {
  const snapshot = getWorkspaceTrustSnapshot(workspace, storePath);
  return snapshot?.status === 'trusted' ? snapshot.externalReadScope.roots : Object.freeze([]);
}

/** Persist an explicit trust decision for one workspace. */
export function trustWorkspace(input: {
  workspace: string;
  source?: WorkspaceTrustSource;
  storePath?: string;
  expectedRevision?: string;
}): WorkspaceTrustDecisionResult {
  const path = input.storePath ?? workspaceTrustPath();
  let workspaceKey: string;
  let externalReadScope: WorkspaceExternalReadScope;
  try {
    workspaceKey = canonicalWorkspaceKey(input.workspace);
    externalReadScope = resolveWorkspaceExternalReadScope(input.workspace);
  } catch {
    return { status: 'store_unavailable', message: 'Workspace identity is unavailable.' };
  }
  const record: WorkspaceTrustRecord = {
    workspaceKey,
    workspacePath: resolve(input.workspace),
    trustedAt: new Date().toISOString(),
    source: input.source ?? 'user',
    externalReadScopeDigest: externalReadScope.digest,
  };
  let releaseLock: (() => void) | undefined;
  try {
    releaseLock = acquireLock(path);
    // Re-read after acquiring the lock to avoid TOCTOU.
    const locked = readWorkspaceTrustStore(path);
    if (locked.status === 'corrupt') return { status: 'store_corrupt', message: locked.message };
    if (locked.status === 'unavailable')
      return { status: 'store_unavailable', message: locked.message };
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== trustSnapshotRevision(locked, externalReadScope)
    ) {
      return {
        status: 'conflict',
        message: 'Workspace trust state changed before the decision was recorded.',
      };
    }
    writeStore(path, { version: 1, records: { ...locked.records, [workspaceKey]: record } });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Could not acquire')) {
      return { status: 'store_unavailable', message: err.message };
    }
    return { status: 'store_unavailable', message: 'Workspace trust store could not be written.' };
  } finally {
    if (releaseLock) releaseLock();
  }
  return { status: 'recorded', record };
}
