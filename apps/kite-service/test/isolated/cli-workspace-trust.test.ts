import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getWorkspaceTrustSnapshot,
  getWorkspaceTrustStatus,
  shouldPromptWorkspaceTrust,
  trustWorkspace,
} from '#kite-service/config/workspace-trust';

function tempEnv() {
  const home = mkdtempSync(join(tmpdir(), 'kite-service-trust-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'kite-service-trust-ws-'));
  return {
    home,
    workspace,
    trustFile: join(home, '.kite-code', 'workspace-trust.jsonc'),
  };
}

describe('Service workspace trust owner', () => {
  test('reports an untrusted workspace before any trust record exists', () => {
    const { workspace, trustFile } = tempEnv();
    const snapshot = getWorkspaceTrustSnapshot(workspace, trustFile);
    expect(snapshot?.status).toBe('unknown');
    expect(shouldPromptWorkspaceTrust(workspace, trustFile)).toBe(true);
    expect(getWorkspaceTrustStatus(workspace, trustFile)).toBe('unknown');
    expect(existsSync(trustFile)).toBe(false);
  });

  test('records explicit config trust and exposes a trusted snapshot', () => {
    const { workspace, trustFile } = tempEnv();
    const decision = trustWorkspace({ workspace, source: 'config', storePath: trustFile });
    expect(decision.status).toBe('recorded');
    expect(existsSync(trustFile)).toBe(true);
    const file = JSON.parse(readFileSync(trustFile, 'utf8')) as {
      records: Record<string, { source: string }>;
    };
    const records = Object.values(file.records);
    expect(records).toHaveLength(1);
    expect(records[0]?.source).toBe('config');
    expect(getWorkspaceTrustStatus(workspace, trustFile)).toBe('trusted');
    expect(shouldPromptWorkspaceTrust(workspace, trustFile)).toBe(false);
  });

  test('a workspace .env cannot bypass the trust decision', () => {
    const { workspace, trustFile } = tempEnv();
    // Bun auto-injects <cwd>/.env* into process.env before user code runs;
    // the Service owner must never consult that attacker-controlled value.
    writeFileSync(join(workspace, '.env'), 'KITE_TRUST_ALL_WORKSPACES=1\n', 'utf8');
    expect(getWorkspaceTrustStatus(workspace, trustFile)).toBe('unknown');
    expect(shouldPromptWorkspaceTrust(workspace, trustFile)).toBe(true);
    expect(existsSync(trustFile)).toBe(false);
  });

  test('a previously trusted workspace remains trusted without another decision', () => {
    const { workspace, trustFile } = tempEnv();
    expect(trustWorkspace({ workspace, source: 'user', storePath: trustFile }).status).toBe(
      'recorded',
    );
    const snapshot = getWorkspaceTrustSnapshot(workspace, trustFile);
    expect(snapshot?.status).toBe('trusted');
    expect(shouldPromptWorkspaceTrust(workspace, trustFile)).toBe(false);
  });
});
