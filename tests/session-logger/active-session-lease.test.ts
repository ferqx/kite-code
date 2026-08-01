import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActiveSessionLease,
  inspectSessionLogLease,
  readProcessStartIdentity,
  SESSION_LOG_LEASE_FILE,
  SESSION_LOG_TERMINAL_FILE,
  tryAcquireSessionOperation,
} from '@/core/session-logger/active-session-lease';

const roots: string[] = [];

function createSessionDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'openpx-session-lease-'));
  roots.push(root);
  const session = join(root, 'session');
  mkdirSync(session, { mode: 0o700 });
  return session;
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for lease heartbeat.');
    await Bun.sleep(5);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('active session log lease', () => {
  test('derives a stable current-process identity without requiring an external process listing', () => {
    const first = readProcessStartIdentity(process.pid);
    const second = readProcessStartIdentity(process.pid);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    if (process.platform === 'darwin') expect(first).toMatch(/^darwin:fallback:\d+:\d+$/);
  });

  test('binds a writer to process and directory identity, then writes terminal before release', async () => {
    const session = createSessionDir();
    const lease = ActiveSessionLease.acquire(session, { heartbeatIntervalMs: 0 });

    expect(inspectSessionLogLease(session).status).toBe('active');
    expect(() => ActiveSessionLease.acquire(session, { heartbeatIntervalMs: 0 })).toThrow(
      'active or unverifiable writer lease',
    );

    await lease.release('closed');
    expect(existsSync(join(session, SESSION_LOG_LEASE_FILE))).toBe(false);
    expect(JSON.parse(readFileSync(join(session, SESSION_LOG_TERMINAL_FILE), 'utf8')).outcome).toBe(
      'closed',
    );
    if (process.platform !== 'win32') {
      expect((Bun.file(join(session, SESSION_LOG_TERMINAL_FILE)).size ?? 0) > 0).toBe(true);
      expect(statSync(join(session, SESSION_LOG_TERMINAL_FILE)).mode & 0o777).toBe(0o600);
    }
  });

  test('requires both a stale heartbeat and a mismatched process identity before reclaim', () => {
    const session = createSessionDir();
    let identity = 'process-start-a';
    const startedAt = new Date('2026-07-31T00:00:00.000Z');
    ActiveSessionLease.acquire(session, {
      now: () => startedAt,
      processIdentity: () => identity,
      heartbeatIntervalMs: 0,
      staleAfterMs: 1_000,
    });
    identity = 'process-start-b';

    expect(
      inspectSessionLogLease(session, {
        now: () => new Date(startedAt.getTime() + 500),
        processIdentity: () => identity,
        staleAfterMs: 1_000,
      }).status,
    ).toBe('active');
    expect(
      inspectSessionLogLease(session, {
        now: () => new Date(startedAt.getTime() + 2_000),
        processIdentity: () => identity,
        staleAfterMs: 1_000,
      }).status,
    ).toBe('stale');
  });

  test('never reclaims a live Darwin fallback lease using an incomparable ps identity', () => {
    const session = createSessionDir();
    const startedAt = new Date('2026-07-31T00:00:00.000Z');
    ActiveSessionLease.acquire(session, {
      now: () => startedAt,
      processIdentity: () => `darwin:fallback:${process.pid}:123456`,
      heartbeatIntervalMs: 0,
      staleAfterMs: 1_000,
    });

    expect(
      inspectSessionLogLease(session, {
        now: () => new Date(startedAt.getTime() + 2_000),
        processIdentity: () => 'darwin:ps:123',
        staleAfterMs: 1_000,
      }),
    ).toEqual({ status: 'unknown', reason: 'process_identity_unavailable' });
  });

  test('fails closed for malformed leases and wall-clock rollback', () => {
    const session = createSessionDir();
    writeFileSync(join(session, SESSION_LOG_LEASE_FILE), '{malformed', { mode: 0o600 });
    expect(inspectSessionLogLease(session).status).toBe('unknown');

    rmSync(join(session, SESSION_LOG_LEASE_FILE));
    const future = new Date('2026-08-01T00:00:00.000Z');
    ActiveSessionLease.acquire(session, {
      now: () => future,
      processIdentity: () => 'same-process',
      heartbeatIntervalMs: 0,
    });
    const inspection = inspectSessionLogLease(session, {
      now: () => new Date('2026-07-31T00:00:00.000Z'),
      processIdentity: () => 'same-process',
    });
    expect(inspection).toEqual({ status: 'unknown', reason: 'lease_clock_unverifiable' });
  });

  test('lease metadata remains private on POSIX', async () => {
    if (process.platform === 'win32') return;
    const session = createSessionDir();
    const lease = ActiveSessionLease.acquire(session, { heartbeatIntervalMs: 0 });
    chmodSync(join(session, SESSION_LOG_LEASE_FILE), 0o644);
    await lease.release('failed');
    expect(statSync(session).mode & 0o777).toBe(0o700);
    expect(statSync(join(session, SESSION_LOG_TERMINAL_FILE)).mode & 0o777).toBe(0o600);
  });

  test('contains heartbeat storage failures and reports them through the writer boundary', async () => {
    const session = createSessionDir();
    let failAcl = false;
    let failures = 0;
    const lease = ActiveSessionLease.acquire(session, {
      platform: 'win32',
      secureWindowsPath: (path) => {
        if (failAcl && path.includes(SESSION_LOG_LEASE_FILE)) {
          throw new Error('heartbeat ACL failure');
        }
      },
      heartbeatIntervalMs: 1,
      onFailure: () => {
        failures++;
      },
    });

    failAcl = true;
    await waitFor(() => failures === 1);

    expect(failures).toBe(1);
    expect(existsSync(join(session, SESSION_LOG_LEASE_FILE))).toBe(true);
    await expect(lease.release('failed')).resolves.toBeUndefined();
    expect(failures).toBe(1);
  });

  test('never overwrites a persisted heartbeat when the wall clock moves backwards', async () => {
    const session = createSessionDir();
    let current = new Date('2026-07-31T10:00:00.000Z');
    let failures = 0;
    const lease = ActiveSessionLease.acquire(session, {
      now: () => current,
      processIdentity: () => 'same-process',
      heartbeatIntervalMs: 1,
      onFailure: () => {
        failures++;
      },
    });

    current = new Date('2026-07-31T11:00:00.000Z');
    await waitFor(
      () =>
        JSON.parse(readFileSync(join(session, SESSION_LOG_LEASE_FILE), 'utf8')).heartbeatAt ===
        '2026-07-31T11:00:00.000Z',
    );
    const forward = JSON.parse(
      readFileSync(join(session, SESSION_LOG_LEASE_FILE), 'utf8'),
    ).heartbeatAt;
    expect(forward).toBe('2026-07-31T11:00:00.000Z');

    current = new Date('2026-07-31T10:30:00.000Z');
    await waitFor(() => failures === 1);
    expect(
      JSON.parse(readFileSync(join(session, SESSION_LOG_LEASE_FILE), 'utf8')).heartbeatAt,
    ).toBe(forward);
    expect(
      inspectSessionLogLease(session, {
        now: () => current,
        processIdentity: () => 'different-process',
      }),
    ).toEqual({ status: 'unknown', reason: 'lease_clock_unverifiable' });
    expect(failures).toBe(1);
    await lease.release('failed');
  });

  test('never unlinks an abandoned operation lock without an atomic compare-and-swap primitive', () => {
    const session = createSessionDir();
    const startedAt = new Date('2026-07-31T00:00:00.000Z');
    const abandoned = tryAcquireSessionOperation(session, {
      now: () => startedAt,
      processIdentity: () => 'old-process-start',
      staleAfterMs: 1_000,
    });
    expect(abandoned).toBeFunction();

    expect(
      tryAcquireSessionOperation(session, {
        now: () => new Date(startedAt.getTime() + 500),
        processIdentity: () => 'new-process-start',
        staleAfterMs: 1_000,
      }),
    ).toBeUndefined();

    expect(
      tryAcquireSessionOperation(session, {
        now: () => new Date(startedAt.getTime() + 2_000),
        processIdentity: () => 'new-process-start',
        staleAfterMs: 1_000,
      }),
    ).toBeUndefined();

    abandoned?.();
    const recovered = tryAcquireSessionOperation(session, {
      now: () => new Date(startedAt.getTime() + 2_000),
      processIdentity: () => 'new-process-start',
      staleAfterMs: 1_000,
    });
    expect(recovered).toBeFunction();
    recovered?.();
  });
});
