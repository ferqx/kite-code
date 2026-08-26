import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WINDOWS_SESSION_LOG_ACL_TIMEOUT_MS } from '@kite-ai/builtin-runtime/model';
import { sessionLogDir, sessionLogFrontendDir, sessionLogRoot } from '#kite-service/config/paths';
import type { SessionLoggingPolicy } from '#kite-service/config/session-logging-policy';
import { SessionLogCollector } from '#kite-service/session-logger/collector';
import { SessionLogWriter } from '#kite-service/session-logger/writer';

const POLICY: SessionLoggingPolicy = {
  version: 1,
  mode: 'metadata',
  retentionDays: 7,
  maxTotalBytes: 4096,
  maxSessionBytes: 1024,
  includeReasoning: false,
  includeFileContent: false,
  includeToolContent: false,
};
const roots: string[] = [];
const originalHome = process.env.KITE_CODE_HOME;

function isolateHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'openpx-writer-security-'));
  roots.push(root);
  process.env.KITE_CODE_HOME = root;
  return root;
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the secure writer.');
    await Bun.sleep(5);
  }
}

afterEach(() => {
  if (originalHome == null) delete process.env.KITE_CODE_HOME;
  else process.env.KITE_CODE_HOME = originalHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('secure session log writer', () => {
  test('bounds the native Windows ACL operation', () => {
    expect(WINDOWS_SESSION_LOG_ACL_TIMEOUT_MS).toBe(10_000);
  });

  test('rejects path traversal and Windows reserved path segments before touching storage', () => {
    expect(() => new SessionLogWriter('../escape', 'thread')).toThrow('safe session-log');
    expect(() => new SessionLogWriter('tui', '..')).toThrow('safe session-log');
    expect(() => new SessionLogWriter('tui', 'CON')).toThrow('safe session-log');
    expect(() => new SessionLogWriter('tui', 'thread', 'events/escape')).toThrow(
      'safe session-log',
    );
  });

  test('creates private directories/files and a durable terminal marker', async () => {
    isolateHome();
    const writer = new SessionLogWriter('tui', 'private-session', 'events', undefined, undefined, {
      policy: POLICY,
      heartbeatIntervalMs: 0,
    });
    writer.write({ event: 'safe' });
    await writer.finalize();

    const session = sessionLogDir('tui', 'private-session');
    const events = join(session, 'events.jsonl');
    const terminal = join(session, 'terminal.json');
    expect(existsSync(events)).toBe(true);
    expect(existsSync(terminal)).toBe(true);
    expect(existsSync(join(session, '.active-session-lease.json'))).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(sessionLogRoot()).mode & 0o777).toBe(0o700);
      expect(statSync(sessionLogFrontendDir('tui')).mode & 0o777).toBe(0o700);
      expect(statSync(session).mode & 0o777).toBe(0o700);
      expect(statSync(events).mode & 0o777).toBe(0o600);
      expect(statSync(terminal).mode & 0o777).toBe(0o600);
    }
  });

  test('refuses a pre-positioned events symlink without modifying its target', () => {
    if (process.platform === 'win32') return;
    const root = isolateHome();
    const target = join(root, 'outside.txt');
    writeFileSync(target, 'unchanged');
    const session = sessionLogDir('tui', 'linked-session');
    mkdirSync(session, { recursive: true, mode: 0o700 });
    const events = join(session, 'events.jsonl');
    symlinkSync(target, events);

    expect(
      () =>
        new SessionLogWriter('tui', 'linked-session', 'events', undefined, undefined, {
          heartbeatIntervalMs: 0,
        }),
    ).toThrow('single-link');

    expect(readFileSync(target, 'utf8')).toBe('unchanged');
    expect(lstatSync(events).isSymbolicLink()).toBe(true);
  });

  test('refuses a pre-positioned events hardlink without modifying its target', () => {
    const root = isolateHome();
    const target = join(root, 'sensitive.txt');
    writeFileSync(target, 'unchanged');
    const session = sessionLogDir('tui', 'hardlinked-session');
    mkdirSync(session, { recursive: true, mode: 0o700 });
    linkSync(target, join(session, 'events.jsonl'));

    expect(
      () =>
        new SessionLogWriter('tui', 'hardlinked-session', 'events', undefined, undefined, {
          heartbeatIntervalMs: 0,
        }),
    ).toThrow('single-link');

    expect(readFileSync(target, 'utf8')).toBe('unchanged');
  });

  test('fails closed when an opened events path is replaced with a hardlink', async () => {
    if (process.platform === 'win32') return;
    const root = isolateHome();
    const diagnostics: string[] = [];
    const writer = new SessionLogWriter(
      'tui',
      'replaced-hardlink',
      'events',
      (diagnostic) => diagnostics.push(diagnostic.code),
      undefined,
      { policy: POLICY, heartbeatIntervalMs: 0 },
    );
    const target = join(root, 'sensitive.txt');
    writeFileSync(target, 'unchanged');
    const events = join(sessionLogDir('tui', 'replaced-hardlink'), 'events.jsonl');
    unlinkSync(events);
    linkSync(target, events);

    writer.write({ mustNotEscape: true });
    await writer.finalize();

    expect(readFileSync(target, 'utf8')).toBe('unchanged');
    expect(diagnostics).toContain('writer_unavailable');
  });

  test('fails closed when the verified session root is moved and linked back', async () => {
    if (process.platform === 'win32') return;
    const home = isolateHome();
    const diagnostics: string[] = [];
    const writer = new SessionLogWriter(
      'tui',
      'moved-root',
      'events',
      (diagnostic) => diagnostics.push(diagnostic.code),
      undefined,
      { policy: POLICY, heartbeatIntervalMs: 0 },
    );
    const root = sessionLogRoot();
    const movedRoot = join(home, 'outside-sessions');
    renameSync(root, movedRoot);
    symlinkSync(movedRoot, root, 'dir');

    writer.write({ secret: 'must-not-escape' });
    await writer.finalize('fatal');

    expect(readFileSync(join(movedRoot, 'tui', 'moved-root', 'events.jsonl'), 'utf8')).toBe('');
    expect(existsSync(join(movedRoot, 'tui', 'moved-root', 'terminal.json'))).toBe(false);
    expect(diagnostics).toContain('writer_unavailable');
  });

  test('rejects a linked session root before creating frontend/session directories', () => {
    if (process.platform === 'win32') return;
    const root = isolateHome();
    const outside = join(root, 'outside-sessions');
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, join(root, 'sessions'));

    expect(
      () =>
        new SessionLogWriter('tui', 'linked-root', 'events', undefined, undefined, {
          policy: POLICY,
          heartbeatIntervalMs: 0,
        }),
    ).toThrow('real directories');
    expect(existsSync(join(outside, 'tui'))).toBe(false);
  });

  test('rejects a linked user data directory before creating the session root', () => {
    if (process.platform === 'win32') return;
    const root = isolateHome();
    const linkedHome = join(root, 'linked-kite-home');
    const outside = join(root, 'outside-kite-code');
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, linkedHome);
    process.env.KITE_CODE_HOME = linkedHome;

    expect(
      () =>
        new SessionLogWriter('tui', 'linked-base', 'events', undefined, undefined, {
          policy: POLICY,
          heartbeatIntervalMs: 0,
        }),
    ).toThrow('real directories');
    expect(existsSync(join(outside, 'sessions'))).toBe(false);
  });

  test('writes one bounded metadata terminal when the per-session cap is reached', async () => {
    isolateHome();
    const diagnostics: string[] = [];
    const writer = new SessionLogWriter(
      'cli',
      'limited-session',
      'events',
      (diagnostic) => diagnostics.push(diagnostic.code),
      undefined,
      { policy: POLICY, heartbeatIntervalMs: 0 },
    );
    for (let index = 0; index < 20; index++) {
      writer.write({ index, content: 'x'.repeat(180) });
    }
    const session = sessionLogDir('cli', 'limited-session');
    await waitFor(() => diagnostics.includes('session_limit_reached'));
    const activeTotal = ['events.jsonl', '.active-session-lease.json']
      .map((file) => statSync(join(session, file)).size)
      .reduce((total, size) => total + size, 0);
    expect(activeTotal).toBeLessThanOrEqual(POLICY.maxSessionBytes);
    await writer.finalize('aborted');

    const events = readFileSync(join(session, 'events.jsonl'), 'utf8');
    const total =
      statSync(join(session, 'events.jsonl')).size + statSync(join(session, 'terminal.json')).size;
    expect(events.match(/session\.logging_limited/g)).toHaveLength(1);
    expect(diagnostics).toContain('session_limit_reached');
    expect(total).toBeLessThanOrEqual(POLICY.maxSessionBytes);
    expect(JSON.parse(readFileSync(join(session, 'terminal.json'), 'utf8')).runOutcome).toBe(
      'aborted',
    );
  });

  test('prevents two processes/composition roots from owning the same session lease', async () => {
    isolateHome();
    const first = new SessionLogWriter('tui', 'same-thread', 'events', undefined, undefined, {
      policy: POLICY,
      heartbeatIntervalMs: 0,
    });
    expect(
      () =>
        new SessionLogWriter('tui', 'same-thread', 'events', undefined, undefined, {
          policy: POLICY,
          heartbeatIntervalMs: 0,
        }),
    ).toThrow('active or unverifiable writer lease');
    await first.finalize();
  });

  test('protects a live lease held by a separate process', async () => {
    isolateHome();
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        resolve(import.meta.dir, '../../../../../tests/fixtures/session-logger/lease-holder.ts'),
      ],
      cwd: process.cwd(),
      env: { ...process.env },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
    });
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toContain('lease-acquired');
      reader.releaseLock();

      expect(
        () =>
          new SessionLogWriter('tui', 'cross-process-thread', 'events', undefined, undefined, {
            heartbeatIntervalMs: 0,
          }),
      ).toThrow('active or unverifiable writer lease');
    } finally {
      child.stdin.end();
      expect(await child.exited).toBe(0);
    }
    expect(existsSync(join(sessionLogDir('tui', 'cross-process-thread'), 'terminal.json'))).toBe(
      true,
    );
  });

  test('serializes capacity admission across processes and reserves an active session cap', async () => {
    isolateHome();
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        resolve(import.meta.dir, '../../../../../tests/fixtures/session-logger/lease-holder.ts'),
      ],
      cwd: process.cwd(),
      env: { ...process.env, KITE_TEST_BOUNDED_POLICY: '1' },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
    });
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toContain('lease-acquired');
      reader.releaseLock();

      expect(
        () =>
          new SessionLogWriter('cli', 'different-thread', 'events', undefined, undefined, {
            policy: { ...POLICY, maxTotalBytes: 1024, maxSessionBytes: 1024 },
            heartbeatIntervalMs: 0,
          }),
      ).toThrow('total capacity');
    } finally {
      child.stdin.end();
      expect(await child.exited).toBe(0);
    }
    expect(existsSync(sessionLogDir('cli', 'different-thread'))).toBe(false);
  });

  test('collector retains real writer finalization after an asynchronous append failure', async () => {
    isolateHome();
    const diagnostics: string[] = [];
    const collector = new SessionLogCollector(
      'failed-through-collector',
      '/workspace',
      'tui',
      { provider: 'fixture', name: 'fixture' },
      {
        policy: POLICY,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
        writerFactory: (frontend, threadId, basename, onDiagnostic, policy) =>
          new SessionLogWriter(
            frontend,
            threadId,
            basename,
            onDiagnostic,
            async () => {
              throw new Error('injected append failure');
            },
            { policy, heartbeatIntervalMs: 0 },
          ),
      },
    );

    await expect(collector.finalize('fatal')).resolves.toBeUndefined();

    const session = sessionLogDir('tui', 'failed-through-collector');
    expect(diagnostics).toEqual(['writer_unavailable']);
    expect(existsSync(join(session, '.active-session-lease.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(session, 'terminal.json'), 'utf8'))).toMatchObject({
      outcome: 'failed',
      runOutcome: 'fatal',
    });
  });
});
