import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '#kite-test';
import { which as findExecutable } from '../../../../../../scripts/tooling/process';
import { persistentWorktreeDirectory } from '../../../../../../tests/fixtures/worktree-filesystem';
import type { AuthorizationRequest, Json, ToolDefinition } from '../../../../src/extensions';
import { createWorktreeToolBehavior } from '../../../../src/tools/git-worktree/approval';
import { matchesWorktreeApprovalScope } from '../../../../src/tools/git-worktree/approval-scope';
import { sha256 } from '../../../../src/tools/git-worktree/paths';
import {
  type GitWorktreeConfiguration,
  parseGitWorktreeInput,
  type WorktreeRequest,
} from '../../../../src/tools/git-worktree/protocol';
import { executeWorktreeRequest } from '../../../../src/tools/git-worktree/worker';

test('worktree owner freezes commit and direct parent before approval; later HEAD or parent drift cannot satisfy a prepared mutation', async () => {
  const root = realpathSync(persistentWorktreeDirectory('kite-worktree-grant-'));
  const source = join(root, 'source'),
    parent = join(root, 'destinations'),
    hooks = join(root, 'hooks');
  for (const path of [source, parent, hooks]) mkdirSync(path);
  const gitPath = realpathSync(findExecutable('git')!);
  const run = (args: string[]) =>
    execFileSync(gitPath, args, {
      cwd: source,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '0',
        GIT_CONFIG_PARAMETERS: undefined,
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      },
    }).trim();
  run(['init', '-q']);
  run(['config', 'user.name', 'Scope Test']);
  run(['config', 'user.email', 'scope@example.test']);
  writeFileSync(join(source, 'tracked.txt'), 'A\n');
  run(['add', '.']);
  run(['commit', '-qm', 'A']);
  const a = run(['rev-parse', 'HEAD']);
  const configuration: GitWorktreeConfiguration = {
    configurationId: 'scope-fixture',
    sourceCwd: source,
    runtimePath: process.execPath,
    workerPath: 'unused',
    configPath: 'unused',
    git: { path: gitPath, sha256: sha256(readFileSync(gitPath)) },
    hooksPath: hooks,
  };
  const definition: ToolDefinition = {
    id: 'git.worktree',
    version: '1',
    description: 'fixture',
    inputSchema: { type: 'object' },
    async execute() {
      return { outcome: 'failed', content: 'not used' };
    },
  };
  const behavior = createWorktreeToolBehavior({
    definition,
    configuration,
    configurationDigest: 'a'.repeat(64),
  });
  const input = (name: string, extra: Record<string, Json> = {}) => ({
    action: 'create',
    key: name,
    path: join(parent, name),
    baseRef: 'HEAD',
    permissions: { filesystem: 'full_access', network: 'none' },
    ...extra,
  });
  const request = (value: Json): AuthorizationRequest => ({
    kind: 'tool',
    definitionId: 'git.worktree',
    definitionVersion: '1',
    sessionId: 'session',
    runId: 'run',
    executionId: 'execution',
    input: value,
    signal: new AbortController().signal,
  });
  const original = (await behavior.grantOffers!(request(input('first'))))[0]!;
  expect((original.scope as Record<string, Json>).baseOid).toBe(a);
  expect(original.presentation.details.join('\n')).toContain(parent);
  expect(readdirSync(parent)).toEqual([]);
  const sibling = (await behavior.grantOffers!(request(input('second'))))[0]!;
  expect(sibling.scopeDigest).toBe(original.scopeDigest);
  const newBranch = (
    await behavior.grantOffers!(request(input('branch', { newBranch: 'brand-new' })))
  )[0]!;
  expect(newBranch.scopeDigest).not.toBe(original.scopeDigest);
  const worker = (name: string): WorktreeRequest => ({
    schemaVersion: 1,
    configurationId: 'scope-fixture',
    operationToken: sha256(name),
    phase: 'prepare_create',
    sourceCwd: source,
    git: configuration.git,
    hooksPath: hooks,
    input: parseGitWorktreeInput(input(name))!,
  });
  const preparedA = await executeWorktreeRequest(worker('first'));
  expect(preparedA.businessOutcome).toBe('prepared');
  expect(matchesWorktreeApprovalScope(original.scope, preparedA.plan!)).toBe(true);
  writeFileSync(join(source, 'tracked.txt'), 'B\n');
  run(['add', '.']);
  run(['commit', '-qm', 'B']);
  const preparedB = await executeWorktreeRequest(worker('second'));
  expect(preparedB.businessOutcome).toBe('prepared');
  expect(matchesWorktreeApprovalScope(original.scope, preparedB.plan!)).toBe(false);
  expect(existsSync(join(parent, 'first'))).toBe(false);
  expect(existsSync(join(parent, 'second'))).toBe(false);
  const atB = (await behavior.grantOffers!(request(input('third'))))[0]!;
  renameSync(parent, join(root, 'old-destinations'));
  mkdirSync(parent);
  const replaced = await executeWorktreeRequest(worker('third'));
  expect(replaced.businessOutcome).toBe('prepared');
  expect(matchesWorktreeApprovalScope(atB.scope, replaced.plan!)).toBe(false);
  expect(readdirSync(parent)).toEqual([]);
  expect(
    await behavior.grantOffers!(
      request(input('missing', { path: join(root, 'missing-parent', 'child') })),
    ),
  ).toEqual([]);
}, 30000);
