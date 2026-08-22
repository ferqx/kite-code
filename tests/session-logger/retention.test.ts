import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { SessionLoggingPolicyV1 } from '#app/config/session-logging-policy';
import { ActiveSessionLease, SESSION_LOG_LEASE_FILE } from '#app/session-logger';
import { runSessionLogMaintenance } from '#app/session-logger/retention';

const roots: string[] = [];
const POLICY: SessionLoggingPolicyV1 = {
  version: 1,
  mode: 'metadata',
  retentionDays: 7,
  maxTotalBytes: 4096,
  maxSessionBytes: 1024,
  includeReasoning: false,
  includeFileContent: false,
  includeToolContent: false,
};

function createRoot(): string {
  const container = mkdtempSync(join(tmpdir(), 'openpx-session-retention-'));
  roots.push(container);
  const root = join(container, 'sessions');
  mkdirSync(root, { mode: 0o700 });
  return root;
}

function createSession(root: string, name: string, contents = 'event\n'): string {
  const frontend = join(root, 'tui');
  mkdirSync(frontend, { recursive: true, mode: 0o700 });
  const session = join(frontend, name);
  mkdirSync(session, { mode: 0o700 });
  writeFileSync(join(session, 'events.jsonl'), contents, { mode: 0o600 });
  return session;
}

function quarantineRoot(root: string): string {
  return join(dirname(root), `${basename(root)}-quarantine`);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('session log retention and migration', () => {
  test('tightens legacy POSIX permissions idempotently', () => {
    if (process.platform === 'win32') return;
    const root = createRoot();
    const session = createSession(root, 'legacy');
    chmodSync(root, 0o755);
    chmodSync(join(root, 'tui'), 0o755);
    chmodSync(session, 0o755);
    chmodSync(join(session, 'events.jsonl'), 0o644);

    const first = runSessionLogMaintenance(POLICY, { root, reserveBytes: 0 });
    const second = runSessionLogMaintenance(POLICY, { root, reserveBytes: 0 });

    expect(first.quarantinedSessions).toBe(0);
    expect(second.quarantinedSessions).toBe(0);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'tui')).mode & 0o777).toBe(0o700);
    expect(statSync(session).mode & 0o777).toBe(0o700);
    expect(statSync(join(session, 'events.jsonl')).mode & 0o777).toBe(0o600);
  });

  test('protects active and unverifiable leases from retention deletion', async () => {
    const root = createRoot();
    const active = createSession(root, 'active');
    const malformed = createSession(root, 'malformed');
    const lease = ActiveSessionLease.acquire(active, {
      heartbeatIntervalMs: 0,
    });
    writeFileSync(join(malformed, SESSION_LOG_LEASE_FILE), '{bad', {
      mode: 0o600,
    });
    const old = new Date('2020-01-01T00:00:00.000Z');
    utimesSync(active, old, old);
    utimesSync(join(active, 'events.jsonl'), old, old);
    utimesSync(malformed, old, old);
    utimesSync(join(malformed, 'events.jsonl'), old, old);

    const report = runSessionLogMaintenance({ ...POLICY, retentionDays: 1 }, { root });

    expect(report.protectedSessions).toBe(2);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(malformed)).toBe(true);
    await lease.release('closed');
  });

  test('removes expired inactive sessions in stable oldest-first order', () => {
    const root = createRoot();
    const oldest = createSession(root, 'oldest', 'a'.repeat(300));
    const newer = createSession(root, 'newer', 'b'.repeat(300));
    const recent = createSession(root, 'recent', 'c'.repeat(300));
    utimesSync(oldest, new Date('2020-01-01'), new Date('2020-01-01'));
    utimesSync(join(oldest, 'events.jsonl'), new Date('2020-01-01'), new Date('2020-01-01'));
    utimesSync(newer, new Date('2021-01-01'), new Date('2021-01-01'));
    utimesSync(join(newer, 'events.jsonl'), new Date('2021-01-01'), new Date('2021-01-01'));

    const report = runSessionLogMaintenance(
      {
        ...POLICY,
        retentionDays: 1,
        maxTotalBytes: 2048,
        maxSessionBytes: 1024,
      },
      { root, reserveBytes: 1024 },
    );

    expect(report.removedSessions).toBe(2);
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(newer)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(report.capacitySatisfied).toBe(true);
  });

  test('quarantines a legacy session containing a symlink without following it', async () => {
    if (process.platform === 'win32') return;
    const root = createRoot();
    const target = join(dirname(root), 'outside.txt');
    writeFileSync(target, 'must remain');
    const frontend = join(root, 'tui');
    const session = join(frontend, 'linked');
    mkdirSync(session, { recursive: true, mode: 0o700 });
    symlinkSync(target, join(session, 'events.jsonl'));

    const report = runSessionLogMaintenance(POLICY, { root, reserveBytes: 0 });

    expect(report.quarantinedSessions).toBe(1);
    expect(report.capacitySatisfied).toBe(true);
    expect(existsSync(session)).toBe(false);
    await expect(Bun.file(target).text()).resolves.toBe('must remain');
    expect(readdirSync(quarantineRoot(root))).toHaveLength(1);

    const second = runSessionLogMaintenance(POLICY, { root, reserveBytes: 0 });
    expect(second.capacitySatisfied).toBe(true);
  });

  test('quarantines a legacy session containing a hardlinked log file', () => {
    const root = createRoot();
    const target = join(dirname(root), 'sensitive.txt');
    writeFileSync(target, 'must remain');
    const session = createSession(root, 'hardlinked');
    rmSync(join(session, 'events.jsonl'));
    linkSync(target, join(session, 'events.jsonl'));

    const report = runSessionLogMaintenance(POLICY, { root, reserveBytes: 0 });

    expect(report.quarantinedSessions).toBe(1);
    expect(report.capacitySatisfied).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('must remain');
  });

  test('moves a legacy in-root quarantine aside without scanning its contents', () => {
    const root = createRoot();
    const legacy = join(root, '_quarantine');
    mkdirSync(legacy, { mode: 0o700 });
    for (let index = 0; index < 600; index++) {
      mkdirSync(join(legacy, `legacy-${index}`), { mode: 0o700 });
    }

    const report = runSessionLogMaintenance(POLICY, {
      root,
      maxEntries: 4,
      reserveBytes: 0,
    });

    expect(report.capacitySatisfied).toBe(true);
    expect(report.bounded).toBe(false);
    expect(report.quarantinedSessions).toBe(1);
    expect(existsSync(legacy)).toBe(false);
    expect(readdirSync(quarantineRoot(root))).toHaveLength(1);
  });

  test('moves unknown root entries aside so they do not permanently block logging', () => {
    const root = createRoot();
    writeFileSync(join(root, '.DS_Store'), 'metadata');

    const first = runSessionLogMaintenance(POLICY, { root, reserveBytes: 0 });
    const second = runSessionLogMaintenance(POLICY, { root, reserveBytes: 0 });

    expect(first.quarantinedSessions).toBe(1);
    expect(first.capacitySatisfied).toBe(true);
    expect(second.capacitySatisfied).toBe(true);
    expect(existsSync(join(root, '.DS_Store'))).toBe(false);
    expect(readdirSync(quarantineRoot(root))).toHaveLength(1);
  });

  test('moves macOS metadata out of frontend directories', () => {
    const root = createRoot();
    const frontend = join(root, 'tui');
    mkdirSync(frontend, { mode: 0o700 });
    writeFileSync(join(frontend, '.DS_Store'), 'metadata');

    const report = runSessionLogMaintenance(POLICY, { root, reserveBytes: 0 });

    expect(report.quarantinedSessions).toBe(1);
    expect(report.capacitySatisfied).toBe(true);
    expect(existsSync(join(frontend, '.DS_Store'))).toBe(false);
  });

  test('returns a fail-closed capacity result when the scan budget is exhausted', () => {
    const root = createRoot();
    createSession(root, 'one');
    createSession(root, 'two');

    const report = runSessionLogMaintenance(POLICY, {
      root,
      maxEntries: 1,
      reserveBytes: POLICY.maxSessionBytes,
    });

    expect(report.bounded).toBe(true);
    expect(report.capacitySatisfied).toBe(false);
    expect(report.scannedEntries).toBe(1);
  });

  test('allows bounded Windows ACL setup to exceed the POSIX maintenance deadline', () => {
    const root = createRoot();
    let aclCalls = 0;

    const report = runSessionLogMaintenance(POLICY, {
      root,
      platform: 'win32',
      reserveBytes: 0,
      secureWindowsPath: () => {
        aclCalls++;
        const completedAt = Date.now() + 75;
        while (Date.now() < completedAt) {
          // Model the bounded system PowerShell startup used by native ACL setup.
        }
      },
    });

    expect(aclCalls).toBe(1);
    expect(report.bounded).toBe(false);
    expect(report.capacitySatisfied).toBe(true);
  });

  test('bounds individual session scans without deleting from a partial candidate set', () => {
    const root = createRoot();
    const newer = createSession(root, 'newer');
    const older = createSession(root, 'older');
    utimesSync(newer, new Date('2025-01-01'), new Date('2025-01-01'));
    utimesSync(join(newer, 'events.jsonl'), new Date('2025-01-01'), new Date('2025-01-01'));
    utimesSync(older, new Date('2020-01-01'), new Date('2020-01-01'));
    utimesSync(join(older, 'events.jsonl'), new Date('2020-01-01'), new Date('2020-01-01'));

    const report = runSessionLogMaintenance(
      { ...POLICY, retentionDays: 1 },
      { root, maxEntries: 3, reserveBytes: 0 },
    );

    expect(report.bounded).toBe(true);
    expect(report.capacitySatisfied).toBe(false);
    expect(existsSync(newer)).toBe(true);
    expect(existsSync(older)).toBe(true);
  });

  test('reserves the full cap for active sessions before admitting another writer', async () => {
    const root = createRoot();
    const active = createSession(root, 'active');
    const inactive = createSession(root, 'inactive');
    const lease = ActiveSessionLease.acquire(active, {
      heartbeatIntervalMs: 0,
    });

    const report = runSessionLogMaintenance(
      { ...POLICY, maxTotalBytes: 2048, maxSessionBytes: 1024 },
      { root, reserveBytes: 1024 },
    );

    expect(existsSync(active)).toBe(true);
    expect(existsSync(inactive)).toBe(false);
    expect(report.capacitySatisfied).toBe(true);
    await lease.release('closed');
  });

  test('removes an inactive session that already exceeds the per-session cap', () => {
    const root = createRoot();
    const oversized = createSession(root, 'oversized', 'x'.repeat(1200));

    const report = runSessionLogMaintenance(POLICY, { root, reserveBytes: 0 });

    expect(existsSync(oversized)).toBe(false);
    expect(report.removedSessions).toBe(1);
  });

  test('counts root metadata and fails closed on an unverifiable operation lock', () => {
    const root = createRoot();
    writeFileSync(join(root, 'index.json'), 'x'.repeat(3500), { mode: 0o600 });
    const locked = createSession(root, 'locked');
    writeFileSync(join(locked, '.session-operation.lock'), '', { mode: 0o600 });

    const report = runSessionLogMaintenance(POLICY, {
      root,
      reserveBytes: 1024,
    });

    expect(report.capacitySatisfied).toBe(false);
    expect(report.observedBytes).toBeGreaterThanOrEqual(3500);
    expect(existsSync(locked)).toBe(true);
  });
});
