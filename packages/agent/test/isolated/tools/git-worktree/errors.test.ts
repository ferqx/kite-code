import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, spyOn, test } from '#kite-test';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../../tests/fixtures/test-filesystem';
import {
  failureGuidance,
  gitCommandFailure,
  normalizeWorktreeError,
  processEventFailure,
  processStartFailure,
  validWorktreeFailure,
  WorktreeError,
} from '../../../../src/tools/git-worktree/errors';
import { Git } from '../../../../src/tools/git-worktree/git';
import { sha256 } from '../../../../src/tools/git-worktree/paths';
import { validateFrame, type WorktreeRequest } from '../../../../src/tools/git-worktree/protocol';
import { executeWorktreeRequest } from '../../../../src/tools/git-worktree/worker';

const secret = 'https://name:password@example.invalid/private?token=SECRET';
const system = (code: string, syscall: string) =>
  Object.assign(Error(secret), { code, syscall, path: secret });
test('process creation errno, filesystem access refusal and Git exit retain different safe categories', () => {
  for (const errno of ['EPERM', 'EACCES', 'ENOENT']) {
    const raw = system(errno, 'spawn private-executable');
    const start = processStartFailure(raw);
    expect(start.code).toBe('git_process_start_failed');
    expect(start.facts.failure).toEqual({ category: 'process_start', errno });
    expect(start.cause).toBe(raw);
    expect(JSON.stringify(start.facts)).not.toContain(secret);
    expect(normalizeWorktreeError(raw).facts.failure).toEqual(start.facts.failure);
  }
  expect(normalizeWorktreeError(system('EACCES', 'mkdir')).facts.failure).toEqual({
    category: 'permission_denied',
    errno: 'EACCES',
  });
  expect(normalizeWorktreeError(system('EPERM', 'unknown')).facts.failure).toEqual({
    category: 'verification',
    errno: 'EPERM',
  });
  const command = gitCommandFailure(128);
  expect(command.code).toBe('git_operation_failed');
  expect(command.facts).toEqual({
    gitExitCode: 128,
    failure: { category: 'git_command', exitCode: 128 },
  });
  expect(normalizeWorktreeError(Error(secret)).facts.failure).toEqual({ category: 'verification' });
  const aggregate = normalizeWorktreeError(
    new AggregateError(
      [processStartFailure(system('EPERM', 'spawn')), system('EACCES', 'unlink')],
      'worktree_output_cleanup_unconfirmed',
    ),
  );
  expect(aggregate.facts.failure).toEqual({
    category: 'process_start',
    errno: 'EPERM',
    cleanupUnconfirmed: true,
  });
  expect(aggregate.code).toBe('worktree_output_cleanup_unconfirmed');
  const commandCleanup = normalizeWorktreeError(
    new AggregateError(
      [gitCommandFailure(128), Error('cleanup')],
      'worktree_output_cleanup_unconfirmed',
    ),
  );
  expect(commandCleanup.facts).toEqual({
    gitExitCode: 128,
    failure: { category: 'git_command', exitCode: 128, cleanupUnconfirmed: true },
  });
  expect(processEventFailure(system('EPERM', 'kill'), true).facts.failure).toEqual({
    category: 'verification',
    errno: 'EPERM',
  });
  expect(processEventFailure(system('EPERM', 'spawn'), true).facts.failure).toEqual({
    category: 'verification',
    errno: 'EPERM',
  });
  expect(processEventFailure(system('EPERM', 'spawn'), false).facts.failure).toEqual({
    category: 'process_start',
    errno: 'EPERM',
  });
  expect(normalizeWorktreeError(system('EACCES', 'mkdtemp')).facts.failure).toEqual({
    category: 'permission_denied',
    errno: 'EACCES',
  });
});

test('failure protocol is closed, validates safe metadata, preserves mutation and accepts unclassified history', () => {
  const frame = {
    protocolVersion: 1,
    operationToken: 'a'.repeat(64),
    phase: 'create',
    businessOutcome: 'failed',
    details: {
      action: 'create',
      observedAt: '2026-11-06T00:00:00.000Z',
      cwdChanged: false,
      mutation: 'partial',
      code: 'git_operation_failed',
      failure: { category: 'git_command', exitCode: 128 },
    },
  };
  const request = { operationToken: frame.operationToken, phase: 'create' as const };
  expect(validateFrame(frame, request)).toBe(true);
  expect(frame.details.mutation).toBe('partial');
  for (const failure of [
    null,
    {},
    { category: 'git_command' },
    { category: 'git_command', exitCode: 0 },
    { category: 'other' },
    { category: { toString: null, valueOf: null } },
    { category: 'process_start', errno: secret },
    { category: 'verification', cleanupUnconfirmed: false },
    { category: 'verification', diagnostic: secret },
  ]) {
    expect(() => validWorktreeFailure(failure)).not.toThrow();
    expect(validWorktreeFailure(failure)).toBe(false);
    expect(validateFrame({ ...frame, details: { ...frame.details, failure } }, request)).toBe(
      false,
    );
  }
  const historical = {
    ...frame,
    details: { ...frame.details, failure: undefined, diagnostic: 'historical diagnostic' },
  };
  expect(validateFrame(historical, request)).toBe(true);
  expect(failureGuidance(undefined, 'unknown')).toBe('');
  for (const mutation of ['partial', 'unknown', 'completed'])
    expect(failureGuidance(frame.details.failure, mutation)).toContain(
      'Observe only the original key and Job',
    );
  expect(failureGuidance({ category: 'process_start', errno: 'EPERM' }, 'not_started')).toContain(
    'does not mean the user denied authorization',
  );
  expect(failureGuidance(frame.details.failure, 'not_started')).toContain(
    'does not authorize automatic retry',
  );
  expect(failureGuidance(frame.details.failure, undefined)).not.toContain(
    'No mutation was started',
  );
});

test('new worker frames carry exact categories without raw errors or changing their original effect boundary', async () => {
  const root = temporaryDirectory('kite-worktree-errors-');
  const hooks = join(root, 'hooks');
  mkdirSync(hooks);
  const request: WorktreeRequest = {
    schemaVersion: 1,
    configurationId: 'test',
    operationToken: 'a'.repeat(64),
    phase: 'list',
    sourceCwd: root,
    git: { path: process.execPath, sha256: sha256(readFileSync(process.execPath)) },
    hooksPath: hooks,
    input: { action: 'list' },
  };
  const repository = spyOn(Git.prototype, 'repository');
  try {
    for (const [error, category] of [
      [processStartFailure(system('EPERM', 'spawn')), 'process_start'],
      [system('EACCES', 'open'), 'permission_denied'],
      [gitCommandFailure(128), 'git_command'],
      [Error(secret), 'verification'],
    ] as const) {
      repository.mockRejectedValue(error);
      const frame = await executeWorktreeRequest(request);
      expect(frame.businessOutcome).toBe('failed');
      expect(frame.details).toMatchObject({
        mutation: 'not_started',
        cwdChanged: false,
        failure: { category },
      });
      expect(validateFrame(frame, request)).toBe(true);
      expect(JSON.stringify(frame)).not.toContain(secret);
    }
    // Old live generic failures acquire only verification, never guessed process/permission identity.
    repository.mockRejectedValue(new WorktreeError('git_operation_failed', 'Legacy failure'));
    expect((await executeWorktreeRequest(request)).details.failure).toEqual({
      category: 'verification',
    });
  } finally {
    repository.mockRestore();
    removeTemporaryDirectory(root);
  }
});
