import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getWorkspaceTrustStatus,
  readWorkspaceTrustStore,
  shouldPromptWorkspaceTrust,
  trustWorkspace,
} from '#app/config/workspace-trust';

function tempStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'kite-trust-test-')), 'workspace-trust.jsonc');
}

const workspace = mkdtempSync(join(tmpdir(), 'kite-trust-ws-'));

describe('workspace trust store', () => {
  test('unknown workspace has no trust record', () => {
    const storePath = tempStorePath();
    expect(getWorkspaceTrustStatus(workspace, storePath)).toBe('unknown');
  });

  test('trustWorkspace persists a record and marks the workspace trusted', () => {
    const storePath = tempStorePath();
    const result = trustWorkspace({ workspace, storePath });
    expect(result.status).toBe('recorded');
    if (result.status !== 'recorded') return;
    expect(result.record.source).toBe('user');
    expect(result.record.workspacePath).toBe(workspace);
    expect(result.record.trustedAt).toBeTruthy();

    expect(getWorkspaceTrustStatus(workspace, storePath)).toBe('trusted');

    // The persisted file round-trips through the reader.
    const store = readWorkspaceTrustStore(storePath);
    expect(store.status).toBe('ready');
    if (store.status !== 'ready') return;
    const records = Object.values(store.records);
    expect(records.length).toBe(1);
    expect(records[0]?.workspaceKey).toBe(result.record.workspaceKey);
  });

  test('re-trusting the same workspace updates a single record', () => {
    const storePath = tempStorePath();
    trustWorkspace({ workspace, storePath });
    trustWorkspace({ workspace, source: 'test', storePath });
    const store = readWorkspaceTrustStore(storePath);
    expect(store.status).toBe('ready');
    if (store.status !== 'ready') return;
    const records = Object.values(store.records);
    expect(records.length).toBe(1);
    expect(records[0]?.source).toBe('test');
  });

  test('equivalent paths resolve to the same workspace key', () => {
    const storePath = tempStorePath();
    trustWorkspace({ workspace, storePath });
    // A path with a trailing self-reference canonicalizes to the same identity.
    expect(getWorkspaceTrustStatus(join(workspace, '.'), storePath)).toBe('trusted');
  });

  test('different workspaces stay independent', () => {
    const storePath = tempStorePath();
    const other = mkdtempSync(join(tmpdir(), 'kite-trust-ws2-'));
    trustWorkspace({ workspace, storePath });
    expect(getWorkspaceTrustStatus(other, storePath)).toBe('unknown');
  });

  test('malformed store is reported corrupt and refuses writes', () => {
    const storePath = tempStorePath();
    writeFileSync(storePath, '{ not json', 'utf8');
    expect(getWorkspaceTrustStatus(workspace, storePath)).toBe('corrupt');
    const result = trustWorkspace({ workspace, storePath });
    expect(result.status).toBe('store_corrupt');
  });

  test('version mismatch is corrupt', () => {
    const storePath = tempStorePath();
    writeFileSync(storePath, JSON.stringify({ version: 2, records: {} }), 'utf8');
    expect(getWorkspaceTrustStatus(workspace, storePath)).toBe('corrupt');
  });

  test('records as an array is corrupt', () => {
    const storePath = tempStorePath();
    writeFileSync(storePath, JSON.stringify({ version: 1, records: [] }), 'utf8');
    expect(getWorkspaceTrustStatus(workspace, storePath)).toBe('corrupt');
  });

  test('record stored under a mismatched key is corrupt', () => {
    const storePath = tempStorePath();
    const good = trustWorkspace({ workspace, storePath });
    expect(good.status).toBe('recorded');
    if (good.status !== 'recorded') return;
    const tampered = {
      version: 1,
      records: { 'wrong-key': good.record },
    };
    writeFileSync(storePath, JSON.stringify(tampered, null, 2), 'utf8');
    expect(getWorkspaceTrustStatus(workspace, storePath)).toBe('corrupt');
  });

  test('unreadable store path is unavailable and refuses writes', () => {
    // Point the store at a directory: existsSync passes, readFileSync throws.
    const dir = mkdtempSync(join(tmpdir(), 'kite-trust-dir-'));
    const storePath = join(dir, 'blocked');
    mkdirSync(storePath, { recursive: true });
    expect(getWorkspaceTrustStatus(workspace, storePath)).toBe('unavailable');
    const result = trustWorkspace({ workspace, storePath });
    expect(result.status).toBe('store_unavailable');
  });
});

describe('shouldPromptWorkspaceTrust', () => {
  test('unknown and corrupt states prompt (fail closed)', () => {
    const storePath = tempStorePath();
    expect(shouldPromptWorkspaceTrust(workspace, storePath)).toBe(true);
    writeFileSync(storePath, '{ broken', 'utf8');
    expect(shouldPromptWorkspaceTrust(workspace, storePath)).toBe(true);
  });

  test('trusted workspaces do not prompt', () => {
    const storePath = tempStorePath();
    trustWorkspace({ workspace, storePath });
    expect(shouldPromptWorkspaceTrust(workspace, storePath)).toBe(false);
  });
});
