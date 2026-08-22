import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  LocalWorkspaceFilesystemProviderV1,
  WorkspaceFilesystemGrantAuthorityV1,
  workspaceFilesystemMutationReadyDigestV1,
  workspaceFilesystemProtectedBoundaryDigestV1,
  workspaceFilesystemTargetEvidenceV1,
} from '@kite/builtin-runtime/filesystem';
import { createProtectedPathEvaluatorV1 } from '@kite/builtin-runtime/sandbox';
import type {
  FilesystemObserveGrantV1,
  WorkspaceFilesystemGrantBindingV1,
  WorkspaceFilesystemMutationOperationV1,
  WorkspaceFilesystemObserveOperationV1,
  WorkspaceFilesystemProtectedBoundaryV1,
  WorkspaceFilesystemProviderFailureCodeV1,
  WorkspaceFilesystemProviderResultV1,
} from '@kite/runtime-spi';
import { ScriptableFakeWorkspaceFilesystemProviderV1 } from '../helpers/workspace-filesystem-provider';

const workspaces: string[] = [];
const PREIMAGE_ARTIFACT = Object.freeze({
  artifactId: `pa_${'a'.repeat(64)}`,
  kind: 'filesystem_preimage' as const,
  integrityIdentifier: `hmac-sha256:${'b'.repeat(64)}`,
  byteLength: 42,
});

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe('WorkspaceFilesystemProviderV1 contract', () => {
  test('observe preserves bounded read and search semantics with durable target evidence', async () => {
    const harness = createHarness();
    mkdirSync(join(harness.workspace, 'src'));
    writeFileSync(join(harness.workspace, 'src', 'a.ts'), 'first\nneedle\nthird\n', 'utf8');
    writeFileSync(join(harness.workspace, 'src', 'ignored.log'), 'needle\n', 'utf8');

    const read = await harness.local.observe({
      grant: harness.authority.issueObserveGrant({
        binding: harness.binding,
        operation: observeOperation({ kind: 'read_file', path: 'src/a.ts', offset: 2, limit: 1 }),
        protectedBoundary: harness.protectedBoundary,
        ttlMs: 1_000,
      }),
    });
    if (!read.ok || read.observation.kind !== 'read_file') throw new Error('read failed');
    expect(read.observation.content).toBe('2|needle');
    expect(read.observation.rawContent).toBe('first\nneedle\nthird\n');
    expect(read.observation.totalLines).toBe(3);
    expect(read.observation.targetEvidence).toEqual(
      workspaceFilesystemTargetEvidenceV1(read.observation.target),
    );
    expect(Object.isFrozen(read.observation.targetEvidence)).toBe(true);

    const files = await harness.local.observe({
      grant: issueSearchGrant(
        harness,
        observeOperation({ kind: 'search_files', path: '.', pattern: '*.ts' }),
      ),
    });
    if (!files.ok || files.observation.kind !== 'search_files') throw new Error('search failed');
    expect(files.observation.matches).toEqual(['src/a.ts']);

    const content = await harness.local.observe({
      grant: issueSearchGrant(
        harness,
        observeOperation({
          kind: 'search_content',
          path: '.',
          pattern: 'needle',
          glob: '**/*.ts',
        }),
      ),
    });
    if (!content.ok || content.observation.kind !== 'search_content') {
      throw new Error('content search failed');
    }
    expect(content.observation.matches).toEqual([{ path: 'src/a.ts', line: 2, text: 'needle' }]);
  });

  test('default file boundary searches protected-looking workspace files and directories', async () => {
    if (process.platform === 'win32') return;
    const harness = createHarness();
    const protectedDirectory = join(harness.workspace, '.kite-code');
    const protectedFile = join(harness.workspace, '.env');
    mkdirSync(protectedDirectory);
    writeFileSync(join(protectedDirectory, 'secret.txt'), 'needle-protected-directory', 'utf8');
    writeFileSync(protectedFile, 'needle-protected-file', 'utf8');
    writeFileSync(join(harness.workspace, 'visible.txt'), 'needle-visible', 'utf8');
    const content = await harness.local.observe({
      grant: issueSearchGrant(
        harness,
        observeOperation({ kind: 'search_content', path: '.', pattern: 'needle' }),
      ),
    });
    if (!content.ok || content.observation.kind !== 'search_content') {
      throw new Error('protected content pruning failed');
    }
    expect(content.observation.matches).toEqual([
      { path: 'visible.txt', line: 1, text: 'needle-visible' },
      {
        path: '.kite-code/secret.txt',
        line: 1,
        text: 'needle-protected-directory',
      },
      { path: '.env', line: 1, text: 'needle-protected-file' },
    ]);

    const files = await harness.local.observe({
      grant: issueSearchGrant(
        harness,
        observeOperation({ kind: 'search_files', path: '.', pattern: '*' }),
      ),
    });
    if (!files.ok || files.observation.kind !== 'search_files') {
      throw new Error('protected file pruning failed');
    }
    expect(files.observation.matches).toEqual(['.env', '.kite-code/secret.txt', 'visible.txt']);
  });

  test('file boundary does not turn execution-only deny or allow roots into read restrictions', async () => {
    const harness = createHarness();
    mkdirSync(join(harness.workspace, 'allowed', 'denied'), { recursive: true });
    mkdirSync(join(harness.workspace, 'outside'));
    writeFileSync(join(harness.workspace, 'allowed', 'visible.txt'), 'visible', 'utf8');
    writeFileSync(join(harness.workspace, 'allowed', 'denied', 'secret.txt'), 'secret', 'utf8');
    writeFileSync(join(harness.workspace, 'outside', 'outside.txt'), 'outside', 'utf8');
    const result = await harness.local.observe({
      grant: issueSearchGrant(
        harness,
        observeOperation({ kind: 'search_files', path: '.', pattern: '*' }),
        {
          additionalDeniedPaths: ['allowed/denied'],
          allowedPaths: ['allowed'],
        },
      ),
    });
    if (!result.ok || result.observation.kind !== 'search_files') {
      throw new Error('allow-root search pruning failed');
    }
    expect(result.observation.matches).toEqual([
      'allowed/denied/secret.txt',
      'allowed/visible.txt',
      'outside/outside.txt',
    ]);
  });

  test('search semantics still honor ancestor gitignore metadata independently of authorization', async () => {
    const harness = createHarness();
    mkdirSync(join(harness.workspace, 'allowed'));
    writeFileSync(join(harness.workspace, 'allowed', 'visible.txt'), 'visible', 'utf8');
    writeFileSync(join(harness.workspace, '.gitignore'), 'allowed/visible.txt\n', 'utf8');

    const result = await harness.local.observe({
      grant: issueSearchGrant(
        harness,
        observeOperation({ kind: 'search_files', path: 'allowed', pattern: '*' }),
        { allowedPaths: ['allowed'] },
      ),
    });

    if (!result.ok || result.observation.kind !== 'search_files') {
      throw new Error('nested allow-root search pruning failed');
    }
    expect(result.observation.matches).toEqual([]);
  });

  test('rejects tampered identity bindings, purpose confusion, and expiry before Fake I/O', async () => {
    const harness = createHarness();
    const operation = observeOperation({ kind: 'read_file', path: 'file.txt' });
    const original = harness.authority.issueObserveGrant({
      binding: harness.binding,
      operation,
      protectedBoundary: harness.protectedBoundary,
      ttlMs: 100,
    });
    const bindingFields = [
      'threadId',
      'turnId',
      'toolCallId',
      'invocationId',
      'attempt',
      'intentDigest',
      'searchBoundaryDigest',
      'capabilityRevision',
      'effectDigest',
      'canonicalWorkspace',
      'protectedPathRevision',
      'approvalSummary',
    ] as const;
    for (const field of bindingFields) {
      const fake = new ScriptableFakeWorkspaceFilesystemProviderV1(harness.authority.verifier());
      const tampered = { ...structuredClone(original), [field]: `${original[field]}-tampered` };
      expectFailure(await fake.observe({ grant: tampered }), 'invalid_grant');
      expect(fake.calls()).toEqual({ observe: 0, prepareMutation: 0, commitMutation: 0 });
    }

    const prepare = harness.authority.issuePrepareGrant({
      binding: harness.binding,
      operation: mutationOperation({ kind: 'write_file', path: 'file.txt', content: 'new' }),
      protectedBoundary: harness.protectedBoundary,
      ttlMs: 100,
    });
    const confused = new ScriptableFakeWorkspaceFilesystemProviderV1(harness.authority.verifier());
    expectFailure(
      await confused.observe({ grant: prepare as unknown as FilesystemObserveGrantV1 }),
      'invalid_grant',
    );
    expect(confused.calls().observe).toBe(0);

    const searchGrant = issueSearchGrant(
      harness,
      observeOperation({ kind: 'search_files', path: '.', pattern: '*' }),
    );
    const tamperedBoundary = new ScriptableFakeWorkspaceFilesystemProviderV1(
      harness.authority.verifier(),
    );
    expectFailure(
      await tamperedBoundary.observe({
        grant: {
          ...structuredClone(searchGrant),
          protectedBoundary: {
            ...structuredClone(searchGrant.protectedBoundary),
            excludedFiles: ['.env'],
          },
        },
      }),
      'invalid_grant',
    );
    expect(tamperedBoundary.calls().observe).toBe(0);

    const tamperedPrepare = new ScriptableFakeWorkspaceFilesystemProviderV1(
      harness.authority.verifier(),
    );
    expectFailure(
      await tamperedPrepare.prepareMutation({
        grant: { ...structuredClone(prepare), effectDigest: 'different-effect' },
      }),
      'invalid_grant',
    );
    expect(tamperedPrepare.calls().prepareMutation).toBe(0);

    const prepared = await prepareMutation(harness, prepare.operation);
    const commitGrant = issueCommitGrant(harness, prepare.operation, prepared, 100);
    const fakeCommit = new ScriptableFakeWorkspaceFilesystemProviderV1(
      harness.authority.verifier(),
    );
    expectFailure(
      await fakeCommit.commitMutation({
        grant: { ...structuredClone(commitGrant), approvalSummary: 'different-approval' },
      }),
      'invalid_grant',
    );
    expect(fakeCommit.calls().commitMutation).toBe(0);
    expectFailure(await fakeCommit.commitMutation({ grant: commitGrant }), 'fake_denied');
    expect(fakeCommit.calls().commitMutation).toBe(1);
    expectFailure(await fakeCommit.commitMutation({ grant: commitGrant }), 'consumed_grant');
    expect(fakeCommit.calls().commitMutation).toBe(1);

    harness.setNow(1_100);
    const expired = new ScriptableFakeWorkspaceFilesystemProviderV1(harness.authority.verifier());
    expectFailure(await expired.observe({ grant: original }), 'expired_grant');
    expect(expired.calls().observe).toBe(0);
  });

  test('enforces workspace path scope while permitting default external reads', async () => {
    const harness = createHarness();
    const external = mkdtempSync(join(tmpdir(), 'kite-workspace-provider-external-'));
    workspaces.push(external);
    const externalFile = join(external, 'external.txt');
    writeFileSync(externalFile, 'external', 'utf8');

    const denied = await harness.local.observe({
      grant: harness.authority.issueObserveGrant({
        binding: harness.binding,
        operation: { kind: 'read_file', path: externalFile, pathScope: 'workspace_only' },
        protectedBoundary: harness.protectedBoundary,
        ttlMs: 1_000,
      }),
    });
    expectFailure(denied, 'path_outside_workspace');

    const allowed = await harness.local.observe({
      grant: harness.authority.issueObserveGrant({
        binding: harness.binding,
        operation: { kind: 'read_file', path: externalFile, pathScope: 'external_read' },
        protectedBoundary: harness.protectedBoundary,
        ttlMs: 1_000,
      }),
    });
    if (!allowed.ok || allowed.observation.kind !== 'read_file') {
      throw new Error('external read failed');
    }
    expect(allowed.observation.rawContent).toBe('external');
  });

  test('expands home-relative paths for unrestricted external reads', async () => {
    const harness = createHarness();
    const homeFixture = mkdtempSync(join(homedir(), '.kite-workspace-provider-home-'));
    workspaces.push(homeFixture);
    writeFileSync(join(homeFixture, 'external.txt'), 'home external', 'utf8');

    const result = await harness.local.observe({
      grant: harness.authority.issueObserveGrant({
        binding: harness.binding,
        operation: {
          kind: 'read_file',
          path: join('~', basename(homeFixture), 'external.txt'),
          pathScope: 'external_read',
        },
        protectedBoundary: harness.protectedBoundary,
        ttlMs: 1_000,
      }),
    });

    if (!result.ok || result.observation.kind !== 'read_file') {
      throw new Error('home-relative external read failed');
    }
    expect(result.observation.rawContent).toBe('home external');
  });

  test('prepare is zero-write and returns immutable identity plus preimage', async () => {
    const harness = createHarness();
    const target = join(harness.workspace, 'file.txt');
    writeFileSync(target, 'before\n', 'utf8');
    const operation = mutationOperation({
      kind: 'write_file',
      path: 'file.txt',
      content: 'after\n',
    });

    const prepared = await harness.local.prepareMutation({
      grant: harness.authority.issuePrepareGrant({
        binding: harness.binding,
        operation,
        protectedBoundary: harness.protectedBoundary,
        ttlMs: 1_000,
      }),
    });
    if (!prepared.ok) throw new Error('prepare failed');
    expect(readFileSync(target, 'utf8')).toBe('before\n');
    expect(prepared.observation.preimage).toMatchObject({ existed: true, content: 'before\n' });
    expect(prepared.observation.targetIdentityDigest).toBe(
      prepared.observation.targetEvidence.targetIdentityDigest,
    );
    expect(Object.isFrozen(prepared.observation)).toBe(true);
    expect(Object.isFrozen(prepared.observation.target)).toBe(true);
    expect(() => JSON.stringify(prepared.observation)).not.toThrow();
  });

  test('commit writes atomically and consumes its grant before any second I/O', async () => {
    const harness = createHarness();
    const target = join(harness.workspace, 'new.txt');
    const operation = mutationOperation({
      kind: 'write_file',
      path: 'new.txt',
      content: 'created\n',
    });
    const prepared = await prepareMutation(harness, operation);
    const commitGrant = issueCommitGrant(harness, operation, prepared);

    const committed = await harness.local.commitMutation({ grant: commitGrant });
    if (!committed.ok) throw new Error(`commit failed: ${committed.failure.code}`);
    expect(readFileSync(target, 'utf8')).toBe('created\n');
    expect(committed.observation).toMatchObject({
      kind: 'committed_mutation',
      created: true,
      changed: true,
      beforeContentDigest: null,
    });
    expect(committed.observation.afterContentDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);

    expectFailure(await harness.local.commitMutation({ grant: commitGrant }), 'consumed_grant');
    expect(readFileSync(target, 'utf8')).toBe('created\n');
  });

  test('commit detects stale preimage and performs zero writes', async () => {
    const harness = createHarness();
    const target = join(harness.workspace, 'file.txt');
    writeFileSync(target, 'before', 'utf8');
    const operation = mutationOperation({
      kind: 'write_file',
      path: 'file.txt',
      content: 'planned',
    });
    const prepared = await prepareMutation(harness, operation);
    const grant = issueCommitGrant(harness, operation, prepared);
    writeFileSync(target, 'intervening', 'utf8');

    expectFailure(await harness.local.commitMutation({ grant }), 'stale_preimage');
    expect(readFileSync(target, 'utf8')).toBe('intervening');
  });

  test('commit detects a no-follow target identity swap before writing', async () => {
    if (process.platform === 'win32') return;
    const harness = createHarness();
    const target = join(harness.workspace, 'file.txt');
    const replacement = join(harness.workspace, 'replacement.txt');
    writeFileSync(target, 'before', 'utf8');
    writeFileSync(replacement, 'replacement', 'utf8');
    const operation = mutationOperation({
      kind: 'write_file',
      path: 'file.txt',
      content: 'planned',
    });
    const prepared = await prepareMutation(harness, operation);
    const grant = issueCommitGrant(harness, operation, prepared);
    unlinkSync(target);
    symlinkSync('replacement.txt', target);

    expectFailure(await harness.local.commitMutation({ grant }), 'stale_preimage');
    expect(readFileSync(replacement, 'utf8')).toBe('replacement');
  });

  test('edit parity covers unique, ambiguous, and replace-all mutations', async () => {
    const uniqueHarness = createHarness();
    const uniqueTarget = join(uniqueHarness.workspace, 'file.txt');
    writeFileSync(uniqueTarget, 'one\ntwo\n', 'utf8');
    const unique = mutationOperation({
      kind: 'edit_file',
      path: 'file.txt',
      oldString: 'two',
      newString: 'second',
    });
    const uniqueResult = await commitPrepared(uniqueHarness, unique);
    if (!uniqueResult.ok) throw new Error('unique edit failed');
    expect(readFileSync(uniqueTarget, 'utf8')).toBe('one\nsecond\n');
    expect(uniqueResult.observation).toMatchObject({ replacements: 1, fromLine: 2, toLine: 2 });

    const ambiguousHarness = createHarness();
    const ambiguousTarget = join(ambiguousHarness.workspace, 'file.txt');
    writeFileSync(ambiguousTarget, 'same same', 'utf8');
    const ambiguous = mutationOperation({
      kind: 'edit_file',
      path: 'file.txt',
      oldString: 'same',
      newString: 'new',
    });
    expectFailure(await commitPrepared(ambiguousHarness, ambiguous), 'edit_ambiguous');
    expect(readFileSync(ambiguousTarget, 'utf8')).toBe('same same');

    const allHarness = createHarness();
    const allTarget = join(allHarness.workspace, 'file.txt');
    writeFileSync(allTarget, 'same\nsame', 'utf8');
    const all = mutationOperation({
      kind: 'edit_file',
      path: 'file.txt',
      oldString: 'same',
      newString: 'new',
      replaceAll: true,
    });
    const allResult = await commitPrepared(allHarness, all);
    if (!allResult.ok) throw new Error('replace-all edit failed');
    expect(readFileSync(allTarget, 'utf8')).toBe('new\nnew');
    expect(allResult.observation.replacements).toBe(2);
    expect(allResult.observation.matchLines).toEqual([1, 2]);
  });

  test('cancellation and typed Fake denial have no filesystem fallback', async () => {
    const harness = createHarness();
    const target = join(harness.workspace, 'file.txt');
    writeFileSync(target, 'untouched', 'utf8');
    const grant = harness.authority.issueObserveGrant({
      binding: harness.binding,
      operation: observeOperation({ kind: 'read_file', path: 'file.txt' }),
      protectedBoundary: harness.protectedBoundary,
      ttlMs: 1_000,
    });
    const fake = new ScriptableFakeWorkspaceFilesystemProviderV1(harness.authority.verifier());
    const controller = new AbortController();
    controller.abort();
    expectFailure(await fake.observe({ grant, signal: controller.signal }), 'cancelled');
    expect(fake.calls().observe).toBe(0);

    expectFailure(await fake.observe({ grant }), 'fake_denied');
    expect(fake.calls().observe).toBe(1);
    expect(readFileSync(target, 'utf8')).toBe('untouched');
  });

  test('commit grant binds operation and prepared identity and is JSON-safe', async () => {
    const harness = createHarness();
    const operation = mutationOperation({ kind: 'write_file', path: 'bound.txt', content: 'a' });
    const prepared = await prepareMutation(harness, operation);
    const grant = issueCommitGrant(harness, operation, prepared);
    expect(grant.operationDigest).toBe(prepared.operationDigest);
    expect(grant.preparedTargetIdentityDigest).toBe(prepared.targetIdentityDigest);
    expect(grant.preimageDigest).toBe(prepared.preimage.contentDigest);
    expect(grant.preimageArtifact).toEqual(PREIMAGE_ARTIFACT);
    expect(grant.mutationReady.attempt).toBe(harness.binding.attempt);
    expect(grant.mutationReadyDigest).toBe(grant.mutationReady.readyDigest);
    expect(Object.isFrozen(grant)).toBe(true);
    expect(JSON.parse(JSON.stringify(grant))).toEqual(grant);

    const different = mutationOperation({ kind: 'write_file', path: 'bound.txt', content: 'b' });
    expect(() => issueCommitGrant(harness, different, prepared)).toThrow('does not match');
  });

  test('rejects attempt, ready, and Artifact tampering and cannot reuse old-attempt ready', async () => {
    const harness = createHarness();
    const operation = mutationOperation({
      kind: 'write_file',
      path: 'sealed.txt',
      content: 'sealed',
    });
    const prepared = await prepareMutation(harness, operation);
    const grant = issueCommitGrant(harness, operation, prepared);
    const mutations = [
      { ...structuredClone(grant), attempt: grant.attempt + 1 },
      {
        ...structuredClone(grant),
        mutationReady: {
          ...structuredClone(grant.mutationReady),
          readyDigest: `sha256:${'9'.repeat(64)}`,
        },
      },
      {
        ...structuredClone(grant),
        preimageArtifact: {
          ...structuredClone(grant.preimageArtifact),
          byteLength: grant.preimageArtifact.byteLength + 1,
        },
      },
    ];
    for (const tampered of mutations) {
      const fake = new ScriptableFakeWorkspaceFilesystemProviderV1(harness.authority.verifier());
      expectFailure(await fake.commitMutation({ grant: tampered }), 'invalid_grant');
      expect(fake.calls().commitMutation).toBe(0);
    }

    const oldReady = grant.mutationReady;
    expect(() =>
      harness.authority.acknowledgeMutationReady({
        binding: {
          ...harness.binding,
          attempt: harness.binding.attempt + 1,
          intentDigest: `sha256:${'2'.repeat(64)}`,
        },
        operation,
        protectedBoundary: harness.protectedBoundary,
        prepared,
        ready: oldReady,
      }),
    ).toThrow('does not match');

    expect(() =>
      harness.authority.issueCommitGrant({
        authorization: { schema: 'kite.workspace-filesystem-ready-authorization.v1' },
        ttlMs: 1_000,
      }),
    ).toThrow('not issued by this grant authority');
  });
});

function createHarness(): {
  workspace: string;
  binding: WorkspaceFilesystemGrantBindingV1;
  protectedBoundary: WorkspaceFilesystemProtectedBoundaryV1;
  authority: WorkspaceFilesystemGrantAuthorityV1;
  local: LocalWorkspaceFilesystemProviderV1;
  setNow(value: number): void;
} {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-workspace-provider-'));
  workspaces.push(workspace);
  let now = 1_000;
  let id = 0;
  const authority = new WorkspaceFilesystemGrantAuthorityV1({
    integrityKey: new Uint8Array(32).fill(7),
    now: () => now,
    idSource: () => `grant-${++id}`,
  });
  const protectedBoundary = createProtectedBoundary(workspace);
  const binding: WorkspaceFilesystemGrantBindingV1 = {
    threadId: 'thread-1',
    turnId: 'turn-1',
    toolCallId: 'tool-call-1',
    invocationId: 'invocation-1',
    attempt: 1,
    intentDigest: `sha256:${'1'.repeat(64)}`,
    searchBoundaryDigest: protectedBoundary.boundaryDigest,
    capabilityRevision: 'capability-revision-1',
    effectDigest: 'effect-digest-1',
    canonicalWorkspace: realpathSync(workspace),
    protectedPathRevision: 'protected-path-revision-1',
    approvalSummary: 'approval-summary-1',
  };
  return {
    workspace,
    binding,
    protectedBoundary,
    authority,
    local: new LocalWorkspaceFilesystemProviderV1(authority.verifier()),
    setNow: (value) => {
      now = value;
    },
  };
}

function observeOperation(
  operation: WithoutPathScope<WorkspaceFilesystemObserveOperationV1>,
): WorkspaceFilesystemObserveOperationV1 {
  return { ...operation, pathScope: 'workspace_only' } as WorkspaceFilesystemObserveOperationV1;
}

function mutationOperation(
  operation: WithoutPathScope<WorkspaceFilesystemMutationOperationV1>,
): WorkspaceFilesystemMutationOperationV1 {
  return { ...operation, pathScope: 'workspace_only' } as WorkspaceFilesystemMutationOperationV1;
}

async function prepareMutation(
  harness: ReturnType<typeof createHarness>,
  operation: WorkspaceFilesystemMutationOperationV1,
) {
  const result = await harness.local.prepareMutation({
    grant: harness.authority.issuePrepareGrant({
      binding: harness.binding,
      operation,
      protectedBoundary: harness.protectedBoundary,
      ttlMs: 1_000,
    }),
  });
  if (!result.ok) throw new Error(`prepare failed: ${result.failure.code}`);
  return result.observation;
}

async function commitPrepared(
  harness: ReturnType<typeof createHarness>,
  operation: WorkspaceFilesystemMutationOperationV1,
) {
  const prepared = await prepareMutation(harness, operation);
  return harness.local.commitMutation({
    grant: issueCommitGrant(harness, operation, prepared),
  });
}

function issueCommitGrant(
  harness: ReturnType<typeof createHarness>,
  operation: WorkspaceFilesystemMutationOperationV1,
  prepared: Awaited<ReturnType<typeof prepareMutation>>,
  ttlMs = 1_000,
) {
  const readyAt = '2026-08-17T00:00:00.000Z';
  const unsigned = {
    attempt: harness.binding.attempt,
    intentDigest: harness.binding.intentDigest,
    operationDigest: prepared.operationDigest,
    targetIdentityDigest: prepared.targetIdentityDigest,
    preimageDigest: prepared.preimage.contentDigest,
    preimageArtifact: PREIMAGE_ARTIFACT,
    readyAt,
  };
  const ready = {
    ...unsigned,
    readyDigest: workspaceFilesystemMutationReadyDigestV1(unsigned),
  };
  const authorization = harness.authority.acknowledgeMutationReady({
    binding: harness.binding,
    operation,
    protectedBoundary: harness.protectedBoundary,
    prepared,
    ready,
  });
  return harness.authority.issueCommitGrant({ authorization, ttlMs });
}

function issueSearchGrant(
  harness: ReturnType<typeof createHarness>,
  operation: WorkspaceFilesystemObserveOperationV1,
  policy: {
    additionalDeniedPaths?: readonly string[];
    allowedPaths?: readonly string[];
  } = {},
) {
  if (operation.kind !== 'search_files' && operation.kind !== 'search_content') {
    throw new Error('search operation required');
  }
  const protectedBoundary = createProtectedBoundary(harness.workspace, policy);
  return harness.authority.issueObserveGrant({
    binding: {
      ...harness.binding,
      searchBoundaryDigest: protectedBoundary.boundaryDigest,
    },
    operation,
    protectedBoundary,
    ttlMs: 1_000,
  });
}

function createProtectedBoundary(
  workspace: string,
  policy: {
    additionalDeniedPaths?: readonly string[];
    allowedPaths?: readonly string[];
  } = {},
): WorkspaceFilesystemProtectedBoundaryV1 {
  const projection = createProtectedPathEvaluatorV1({
    workspaceRoot: workspace,
    mode: 'deny',
    ...policy,
  }).projectFilesystemBoundary();
  const unsigned = {
    schema: 'kite.workspace-filesystem-protected-boundary.v1' as const,
    ...structuredClone(projection),
  };
  return {
    ...unsigned,
    boundaryDigest: workspaceFilesystemProtectedBoundaryDigestV1(unsigned),
  };
}

function expectFailure(
  result: WorkspaceFilesystemProviderResultV1<unknown>,
  code: WorkspaceFilesystemProviderFailureCodeV1,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected Provider failure');
  expect(result.failure.code).toBe(code);
}

type WithoutPathScope<Operation> = Operation extends unknown ? Omit<Operation, 'pathScope'> : never;
