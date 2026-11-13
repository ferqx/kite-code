import { expect, test } from '#kite-test';
import {
  buildWorkerCommand,
  decodeWorkerRequest,
  digest,
  type GitWorktreeConfiguration,
  limits,
  parseGitWorktreeInput,
  parseWorkerCommand,
  resolveDefaultWorktreeTarget,
  validateFrame,
  validateRequest,
  type WorktreeRequest,
} from '../../../../src/tools/git-worktree/protocol';

const config: GitWorktreeConfiguration = {
  configurationId: 'fixture',
  sourceCwd: '/repo',
  runtimePath: "/trusted/Node '中文'",
  workerPath: '/trusted/worker.js',
  git: { path: '/trusted/git', sha256: 'a'.repeat(64) },
  hooksPath: '/trusted/hooks',
};
const request: WorktreeRequest = {
  schemaVersion: 1,
  configurationId: config.configurationId,
  operationToken: 'b'.repeat(64),
  phase: 'list',
  sourceCwd: config.sourceCwd,
  git: config.git,
  hooksPath: config.hooksPath,
  input: { action: 'list' },
};
test('closed action input rejects cross-action fields and preserves literal hostile paths', () => {
  for (const value of [
    null,
    [],
    {},
    { action: 'other' },
    { action: 'list', key: 'x' },
    { action: 'list', permissions: { filesystem: 'workspace_write', network: 'none' } },
    { action: 'remove', key: 'x', path: '/x', baseRef: 'HEAD' },
    { action: 'create', key: 'x', path: 'relative' },
    { action: 'create', key: 'bad/key', path: '/x' },
    { action: 'create', key: 'x', path: '/x', timeoutMs: 999 },
    { action: 'create', key: 'x', path: '/x', timeoutMs: 600001 },
    {
      action: 'create',
      key: 'x',
      path: '/x',
      permissions: { filesystem: 'full_access', network: 'internet' },
    },
    { action: 'create', key: 'x', path: '/x', permissions: { filesystem: 'full_access' } },
    { action: 'create', key: 'x', path: '/x', newBranch: '@{-1}' },
    { action: 'create', key: 'x', path: '/x', newBranch: 'refs/heads/x' },
    { action: 'create', key: 'x', path: '/x', newBranch: '-x' },
    { action: 'create', key: 'x', path: '/x', extra: true },
    { action: 'create', key: 'x', path: '/\ud800' },
  ])
    expect(parseGitWorktreeInput(value)).toBeNull();
  expect(
    parseGitWorktreeInput({ action: 'create', key: 'x', path: "/目标 a'\n$(touch nope)" }),
  ).toEqual({
    action: 'create',
    key: 'x',
    path: "/目标 a'\n$(touch nope)",
    baseRef: 'HEAD',
    timeoutMs: 120000,
    permissions: { filesystem: 'workspace_write', network: 'none' },
  });
  expect(parseGitWorktreeInput({ action: 'remove', key: 'x', path: '/x' })).toMatchObject({
    timeoutMs: 60000,
  });
  expect(
    parseGitWorktreeInput({ action: 'create', key: 'x', path: '/x', baseRef: '中'.repeat(86) }),
  ).toBeNull();
});
test('create alone may omit path; default resolution is stable and private target fields stay closed', () => {
  const input = parseGitWorktreeInput({ action: 'create', key: 'same' })!;
  expect(input).toMatchObject({ action: 'create', key: 'same', baseRef: 'HEAD' });
  expect(input).not.toHaveProperty('path');
  expect(parseGitWorktreeInput({ action: 'remove', key: 'same' })).toBeNull();
  const identity = {
    defaultRoot: '/persistent/worktrees',
    sourceCwd: '/repo',
    sessionId: 's',
    key: 'same',
  };
  const path = resolveDefaultWorktreeTarget(identity);
  expect(path).toBe(resolveDefaultWorktreeTarget(identity));
  expect(path).not.toBe(resolveDefaultWorktreeTarget({ ...identity, sessionId: 'other' }));
  const prepared = {
    ...request,
    phase: 'prepare_create' as const,
    input,
    resolvedTarget: { path, defaultRoot: identity.defaultRoot },
  };
  expect(validateRequest(prepared)).toBe(true);
  expect(validateRequest({ ...prepared, resolvedTarget: undefined })).toBe(false);
  expect(
    validateRequest({ ...prepared, resolvedTarget: { ...prepared.resolvedTarget, extra: true } }),
  ).toBe(false);
  expect(validateRequest({ ...prepared, input: { ...input, path } })).toBe(false);
  expect(() => buildWorkerCommand(config, prepared as WorktreeRequest)).toThrow();
  const withDefault = { ...config, defaultRoot: identity.defaultRoot };
  expect(
    parseWorkerCommand(buildWorkerCommand(withDefault, prepared as WorktreeRequest), withDefault),
  ).toEqual(prepared);
});
test('canonical worker command binds exact trusted assets, cwd, closed payload and flags', () => {
  const command = buildWorkerCommand(config, request);
  expect(parseWorkerCommand(command, config)).toEqual(request);
  for (const text of [
    command + '; echo injected',
    command + ' > /tmp/out',
    'X=1 ' + command,
    command.replace("'--no-global-search-paths' ", ''),
    command.replace('worker.js', 'other.js'),
  ])
    expect(parseWorkerCommand(text, config)).toBeNull();
  expect(parseWorkerCommand(command, { ...config, sourceCwd: '/other' })).toBeNull();
  expect(
    parseWorkerCommand(command, { ...config, git: { ...config.git, sha256: 'c'.repeat(64) } }),
  ).toBeNull();
  const payload = Buffer.from(JSON.stringify({ ...request, readOnly: true })).toString('base64url');
  expect(() => decodeWorkerRequest(payload)).toThrow();
  expect(() => decodeWorkerRequest('x'.repeat(limits.payloadBytes * 2))).toThrow();
  expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
});
test('historical command matching retains the old flags without producing them for new work', () => {
  const old = { ...config, configPath: '/trusted/empty.toml' };
  const command = buildWorkerCommand(config, request);
  const historical = command.replace(
    "'--no-global-search-paths'",
    "'--no-env-file' '--config=/trusted/empty.toml'",
  );
  expect(parseWorkerCommand(historical, old)).toEqual(request);
  expect(parseWorkerCommand(historical, config)).toBeNull();
  expect(buildWorkerCommand(old, request)).toBe(command);
});
test('frames enforce phase/token and prepare cannot represent business success', () => {
  const good = {
    protocolVersion: 1,
    operationToken: request.operationToken,
    phase: 'list',
    businessOutcome: 'succeeded',
    details: {
      action: 'list',
      observedAt: '2026-11-06T00:00:00.000Z',
      cwdChanged: false,
      mutation: 'not_started',
      repository: { root: '/repo', commonDir: '/repo/.git' },
      sourceWorktree: '/repo',
      worktrees: [],
    },
  };
  expect(validateFrame(good, request)).toBe(true);
  for (const value of [
    { ...good, operationToken: 'wrong' },
    { ...good, phase: 'create' },
    { ...good, extra: true },
    { ...good, details: { mutation: 'completed' } },
  ])
    expect(validateFrame(value, request)).toBe(false);
  expect(
    validateFrame({ ...good, phase: 'prepare_create' }, { ...request, phase: 'prepare_create' }),
  ).toBe(false);
});
test('semantic success requires closed complete phase facts, action, time and cwd invariant', () => {
  const details = {
    action: 'list',
    observedAt: '2026-11-06T00:00:00.000Z',
    cwdChanged: false,
    mutation: 'not_started',
    repository: { root: '/repo', commonDir: '/repo/.git' },
    sourceWorktree: '/repo',
    worktrees: [],
  };
  const frame = {
    protocolVersion: 1,
    operationToken: request.operationToken,
    phase: 'list',
    businessOutcome: 'succeeded',
    details,
  };
  for (const field of [
    'action',
    'observedAt',
    'cwdChanged',
    'repository',
    'sourceWorktree',
    'worktrees',
  ]) {
    const altered: Record<string, unknown> = { ...details };
    delete altered[field];
    expect(validateFrame({ ...frame, details: altered }, request)).toBe(false);
  }
  expect(validateFrame({ ...frame, details: { ...details, extra: true } }, request)).toBe(false);
  expect(
    validateFrame(
      { ...frame, details: { ...details, repository: { ...details.repository, extra: true } } },
      request,
    ),
  ).toBe(false);
});
