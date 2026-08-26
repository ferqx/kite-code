import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trustWorkspace } from '#kite-cli/config/workspace-trust';

const cliPath = join(import.meta.dir, '../../src/cli/executable.ts');
const NOT_TRUSTED = 'Workspace is not trusted';

/**
 * Spawn the real CLI entry point against an isolated home/workspace so the
 * gate is exercised exactly as in production. The run always stops after the
 * gate (no provider configured in the temp home), so assertions focus on the
 * gate decision itself.
 */
function runCli(args: string[], env: Record<string, string>, cwd?: string) {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  Object.assign(merged, env);
  const result = Bun.spawnSync({
    cmd: [process.execPath, 'run', cliPath, ...args],
    env: merged,
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function tempEnv() {
  const home = mkdtempSync(join(tmpdir(), 'kite-cli-trust-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'kite-cli-trust-ws-'));
  return {
    home,
    workspace,
    env: { HOME: home, KITE_CODE_HOME: home },
    trustFile: join(home, '.kite-code', 'workspace-trust.jsonc'),
  };
}

describe('CLI workspace trust gate', () => {
  test('rejects an untrusted workspace before any runtime output', () => {
    const { workspace, env, trustFile } = tempEnv();
    const result = runCli(['run', '--workspace', workspace, '--task', 'hello'], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(NOT_TRUSTED);
    expect(result.stderr).toContain(workspace);
    // No runtime events may leak to stdout before the gate.
    expect(result.stdout).toBe('');
    expect(existsSync(trustFile)).toBe(false);
  });

  test('--trust-workspace records trust (source=config) and passes the gate', () => {
    const { workspace, env, trustFile } = tempEnv();
    const result = runCli(
      ['run', '--workspace', workspace, '--task', 'hello', '--trust-workspace'],
      env,
    );
    expect(result.stderr).not.toContain(NOT_TRUSTED);
    expect(existsSync(trustFile)).toBe(true);
    const file = JSON.parse(readFileSync(trustFile, 'utf8')) as {
      records: Record<string, { source: string }>;
    };
    const records = Object.values(file.records);
    expect(records.length).toBe(1);
    expect(records[0]?.source).toBe('config');
  });

  test('a workspace .env cannot bypass the gate (Bun dotenv injection)', () => {
    // Bun auto-injects `<cwd>/.env*` into process.env before user code runs.
    // A malicious repo committing this variable must NOT disable the gate —
    // the gate exists precisely to defend against in-directory attacker files.
    const { workspace, env, trustFile } = tempEnv();
    writeFileSync(join(workspace, '.env'), 'KITE_TRUST_ALL_WORKSPACES=1\n', 'utf8');
    const result = runCli(
      ['run', '--workspace', workspace, '--task', 'hello'],
      env,
      workspace, // child cwd = workspace, so Bun loads the forged .env
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(NOT_TRUSTED);
    expect(existsSync(trustFile)).toBe(false);
  });

  test('a previously trusted workspace passes without the flag', () => {
    const { workspace, env, trustFile } = tempEnv();
    const decision = trustWorkspace({ workspace, source: 'user', storePath: trustFile });
    expect(decision.status).toBe('recorded');
    const result = runCli(['run', '--workspace', workspace, '--task', 'hello'], env);
    expect(result.stderr).not.toContain(NOT_TRUSTED);
  });
});
