import { afterEach, describe, expect, test } from 'bun:test';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalWorkspaceFilesystemProviderV1,
  WorkspaceFilesystemGrantAuthorityV1,
} from '@/core/execution/workspace-filesystem';
import {
  workspaceFilesystemMutationReadyDigestV1,
  workspaceFilesystemProtectedBoundaryDigestV1,
} from '@/core/execution/workspace-filesystem/grant-authority';
import { createProtectedPathEvaluatorV1 } from '@/core/policies/protected-path';
import type {
  WorkspaceFilesystemGrantBindingV1,
  WorkspaceFilesystemMutationOperationV1,
  WorkspaceFilesystemObserveOperationV1,
  WorkspaceFilesystemPreparedMutationV1,
  WorkspaceFilesystemProtectedBoundaryV1,
  WorkspaceFilesystemProviderResultV1,
} from '@/protocol/workspace-filesystem-provider';

const PREIMAGE_ARTIFACT = Object.freeze({
  artifactId: `pa_${'a'.repeat(64)}`,
  kind: 'filesystem_preimage' as const,
  integrityIdentifier: `hmac-sha256:${'b'.repeat(64)}`,
  byteLength: 42,
});

const workspaces: string[] = [];
const BEFORE_DESCRIPTOR_RELATIVE_PUBLISH_TEST_HOOK = Symbol.for(
  'kite.tests.workspace-filesystem.before-descriptor-relative-publish.v1',
);

afterEach(() => {
  delete process.env.KITE_WORKSPACE_FILESYSTEM_TEST_HOOKS;
  delete (
    globalThis as typeof globalThis & {
      [BEFORE_DESCRIPTOR_RELATIVE_PUBLISH_TEST_HOOK]?: () => void;
    }
  )[BEFORE_DESCRIPTOR_RELATIVE_PUBLISH_TEST_HOOK];
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe('LocalWorkspaceFilesystemProviderV1 race and search parity', () => {
  test('rejects a replaced parent directory even when the target inode and preimage are unchanged', async () => {
    if (process.platform === 'win32') return;
    const harness = createHarness();
    const parent = join(harness.workspace, 'parent');
    const displacedParent = join(harness.workspace, 'parent-before');
    mkdirSync(parent);
    writeFileSync(join(parent, 'file.txt'), 'before\n', 'utf8');
    const operation: WorkspaceFilesystemMutationOperationV1 = {
      kind: 'write_file',
      path: 'parent/file.txt',
      pathScope: 'workspace_only',
      content: 'after\n',
    };
    const prepared = await prepareMutation(harness, operation);
    const grant = issueCommitGrant(harness, operation, prepared);

    renameSync(parent, displacedParent);
    mkdirSync(parent);
    // Preserve the target inode and bytes so a target-only identity check cannot detect the swap.
    linkSync(join(displacedParent, 'file.txt'), join(parent, 'file.txt'));

    const result = await harness.local.commitMutation({ grant });
    expectFailure(result, 'stale_preimage');
    expect(readFileSync(join(displacedParent, 'file.txt'), 'utf8')).toBe('before\n');
    expect(readFileSync(join(parent, 'file.txt'), 'utf8')).toBe('before\n');
  });

  test('final-check parent swap cannot redirect descriptor-relative publish outside the workspace', async () => {
    const harness = createHarness();
    const parent = join(harness.workspace, 'parent');
    const displacedParent = join(harness.workspace, 'parent-before-publish');
    const external = mkdtempSync(join(tmpdir(), 'kite-workspace-provider-race-external-'));
    workspaces.push(external);
    mkdirSync(parent);
    writeFileSync(join(parent, 'file.txt'), 'before\n', 'utf8');
    writeFileSync(join(external, 'file.txt'), 'outside\n', 'utf8');
    const operation: WorkspaceFilesystemMutationOperationV1 = {
      kind: 'write_file',
      path: 'parent/file.txt',
      pathScope: 'workspace_only',
      content: 'after\n',
    };
    const prepared = await prepareMutation(harness, operation);
    const grant = issueCommitGrant(harness, operation, prepared);
    let hookCalled = false;
    process.env.KITE_WORKSPACE_FILESYSTEM_TEST_HOOKS = '1';
    (
      globalThis as typeof globalThis & {
        [BEFORE_DESCRIPTOR_RELATIVE_PUBLISH_TEST_HOOK]?: () => void;
      }
    )[BEFORE_DESCRIPTOR_RELATIVE_PUBLISH_TEST_HOOK] = () => {
      hookCalled = true;
      if (process.platform === 'win32') {
        // The parent is held without FILE_SHARE_DELETE until MoveFileExW has
        // published the temporary sibling, so the replacement is refused.
        expect(() => renameSync(parent, displacedParent)).toThrow();
        return;
      }
      renameSync(parent, displacedParent);
      symlinkSync(external, parent, 'dir');
    };

    if (process.platform === 'win32') {
      const result = await harness.local.commitMutation({ grant });
      if (!result.ok)
        throw new Error(`Windows locked-directory commit failed: ${result.failure.code}`);
      expect(hookCalled).toBe(true);
      expect(readFileSync(join(parent, 'file.txt'), 'utf8')).toBe('after\n');
      return;
    }

    // renameat completes in the already-pinned directory, then lexical terminal
    // evidence fails closed as commit-unknown. It never resolves the new symlink.
    await expect(harness.local.commitMutation({ grant })).rejects.toThrow(
      'outside the canonical workspace',
    );
    expect(hookCalled).toBe(true);
    expect(readFileSync(join(external, 'file.txt'), 'utf8')).toBe('outside\n');
    expect(readFileSync(join(displacedParent, 'file.txt'), 'utf8')).toBe('after\n');
  });

  test('retains recursive parent creation while pinning the prepared existing ancestor', async () => {
    const harness = createHarness();
    const operation: WorkspaceFilesystemMutationOperationV1 = {
      kind: 'write_file',
      path: 'new/deep/file.txt',
      pathScope: 'workspace_only',
      content: 'created\n',
    };
    const prepared = await prepareMutation(harness, operation);
    const grant = issueCommitGrant(harness, operation, prepared);

    const result = await harness.local.commitMutation({ grant });
    if (!result.ok) throw new Error(`nested commit failed: ${result.failure.code}`);
    expect(readFileSync(join(harness.workspace, 'new/deep/file.txt'), 'utf8')).toBe('created\n');
    // Windows ACLs, not POSIX mode bits, are the authority for the new file.
    if (process.platform !== 'win32') {
      expect(statSync(join(harness.workspace, 'new/deep/file.txt')).mode & 0o777).toBe(0o644);
    }
  });

  test('descriptor-relative replacement preserves the existing readable file mode', async () => {
    if (process.platform === 'win32') return;
    const harness = createHarness();
    put(harness.workspace, 'mode.txt', 'before\n');
    const target = join(harness.workspace, 'mode.txt');
    const operation: WorkspaceFilesystemMutationOperationV1 = {
      kind: 'write_file',
      path: 'mode.txt',
      pathScope: 'workspace_only',
      content: 'after\n',
    };
    const prepared = await prepareMutation(harness, operation);
    const grant = issueCommitGrant(harness, operation, prepared);

    const result = await harness.local.commitMutation({ grant });
    if (!result.ok) throw new Error(`mode-preserving commit failed: ${result.failure.code}`);
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(readFileSync(target, 'utf8')).toBe('after\n');
  });

  test('applies ancestor and nested gitignore rules with documented wildmatch syntax', async () => {
    const harness = createHarness();
    put(
      harness.workspace,
      '.gitignore',
      ['*.log', 'x[!1]', 'mid/**/target/', '\\!important', ''].join('\n'),
    );
    put(harness.workspace, 'src/.gitignore', 'gen/\n');
    put(harness.workspace, 'src/a.ts');
    put(harness.workspace, 'src/err.log');
    put(harness.workspace, 'src/gen/generated.ts');
    put(harness.workspace, 'x1');
    put(harness.workspace, 'x2');
    put(harness.workspace, '!important');
    put(harness.workspace, 'mid/target/hidden.ts');
    put(harness.workspace, 'mid/deep/target/hidden.ts');

    const nested = await observe(harness, {
      kind: 'search_files',
      path: 'src',
      pathScope: 'workspace_only',
      pattern: '*',
    });
    if (!nested.ok || nested.observation.kind !== 'search_files') {
      throw new Error('nested production search failed');
    }
    expect(nested.observation.matches).toEqual(['src/.gitignore', 'src/a.ts']);

    const root = await observe(harness, {
      kind: 'search_files',
      path: '.',
      pathScope: 'workspace_only',
      pattern: '*',
    });
    if (!root.ok || root.observation.kind !== 'search_files') {
      throw new Error('root production search failed');
    }
    expect(root.observation.matches).toContain('x1');
    expect(root.observation.matches).not.toContain('x2');
    expect(root.observation.matches).not.toContain('!important');
    expect(root.observation.matches).not.toContain('mid/target/hidden.ts');
    expect(root.observation.matches).not.toContain('mid/deep/target/hidden.ts');
  });

  test('supports brace alternatives in the production content-search glob', async () => {
    const harness = createHarness();
    put(harness.workspace, 'keep.log');
    put(harness.workspace, 'keep.txt');
    put(harness.workspace, 'skip.ts');

    const result = await observe(harness, {
      kind: 'search_content',
      path: '.',
      pathScope: 'workspace_only',
      pattern: 'needle',
      glob: '*.{log,txt}',
    });
    if (!result.ok || result.observation.kind !== 'search_content') {
      throw new Error('production content search failed');
    }
    expect(result.observation.matches.map((match) => match.path).sort()).toEqual([
      'keep.log',
      'keep.txt',
    ]);
  });

  for (const ignoreLocation of ['ancestor', 'local'] as const) {
    test(`${ignoreLocation} symlinked ignore metadata fails closed without following external content`, async () => {
      if (process.platform === 'win32') return;
      const harness = createHarness();
      const external = mkdtempSync(join(tmpdir(), 'kite-workspace-provider-ignore-external-'));
      workspaces.push(external);
      const externalIgnore = join(external, '.gitignore');
      writeFileSync(externalIgnore, 'visible.txt\n', 'utf8');
      put(harness.workspace, 'nested/visible.txt');
      const ignorePath =
        ignoreLocation === 'ancestor'
          ? join(harness.workspace, '.gitignore')
          : join(harness.workspace, 'nested/.gitignore');
      symlinkSync(externalIgnore, ignorePath);

      const result = await observe(harness, {
        kind: 'search_files',
        path: 'nested',
        pathScope: 'workspace_only',
        pattern: '*',
      });
      expectFailure(result, 'path_invalid');
    });
  }
});

function createHarness(): {
  workspace: string;
  binding: WorkspaceFilesystemGrantBindingV1;
  protectedBoundary: WorkspaceFilesystemProtectedBoundaryV1;
  authority: WorkspaceFilesystemGrantAuthorityV1;
  local: LocalWorkspaceFilesystemProviderV1;
} {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-workspace-provider-race-'));
  workspaces.push(workspace);
  let id = 0;
  const authority = new WorkspaceFilesystemGrantAuthorityV1({
    integrityKey: new Uint8Array(32).fill(11),
    now: () => 1_000,
    idSource: () => `race-grant-${++id}`,
  });
  const projection = createProtectedPathEvaluatorV1({
    workspaceRoot: workspace,
    mode: 'deny',
  }).projectFilesystemBoundary();
  const unsignedBoundary = {
    schema: 'kite.workspace-filesystem-protected-boundary.v1' as const,
    ...structuredClone(projection),
  };
  const protectedBoundary = {
    ...unsignedBoundary,
    boundaryDigest: workspaceFilesystemProtectedBoundaryDigestV1(unsignedBoundary),
  };
  const binding: WorkspaceFilesystemGrantBindingV1 = {
    threadId: 'thread-race',
    turnId: 'turn-race',
    toolCallId: 'tool-call-race',
    invocationId: 'invocation-race',
    attempt: 1,
    intentDigest: `sha256:${'1'.repeat(64)}`,
    searchBoundaryDigest: protectedBoundary.boundaryDigest,
    capabilityRevision: 'capability-revision-race',
    effectDigest: 'effect-digest-race',
    // The protected-boundary projection is the canonical authority. On
    // Windows it normalizes path case, while realpathSync preserves display
    // casing, so bind to the projection rather than a second spelling.
    canonicalWorkspace: protectedBoundary.canonicalWorkspace,
    protectedPathRevision: 'protected-path-revision-race',
    approvalSummary: 'approval-summary-race',
  };
  return {
    workspace,
    binding,
    protectedBoundary,
    authority,
    local: new LocalWorkspaceFilesystemProviderV1(authority.verifier()),
  };
}

async function observe(
  harness: ReturnType<typeof createHarness>,
  operation: WorkspaceFilesystemObserveOperationV1,
) {
  return harness.local.observe({
    grant: harness.authority.issueObserveGrant({
      binding: harness.binding,
      operation,
      protectedBoundary: harness.protectedBoundary,
      ttlMs: 1_000,
    }),
  });
}

async function prepareMutation(
  harness: ReturnType<typeof createHarness>,
  operation: WorkspaceFilesystemMutationOperationV1,
): Promise<WorkspaceFilesystemPreparedMutationV1> {
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

function issueCommitGrant(
  harness: ReturnType<typeof createHarness>,
  operation: WorkspaceFilesystemMutationOperationV1,
  prepared: WorkspaceFilesystemPreparedMutationV1,
) {
  const unsigned = {
    attempt: harness.binding.attempt,
    intentDigest: harness.binding.intentDigest,
    operationDigest: prepared.operationDigest,
    targetIdentityDigest: prepared.targetIdentityDigest,
    preimageDigest: prepared.preimage.contentDigest,
    preimageArtifact: PREIMAGE_ARTIFACT,
    readyAt: '2026-08-17T00:00:00.000Z',
  };
  const authorization = harness.authority.acknowledgeMutationReady({
    binding: harness.binding,
    operation,
    protectedBoundary: harness.protectedBoundary,
    prepared,
    ready: {
      ...unsigned,
      readyDigest: workspaceFilesystemMutationReadyDigestV1(unsigned),
    },
  });
  return harness.authority.issueCommitGrant({ authorization, ttlMs: 1_000 });
}

function put(workspace: string, path: string, content = 'needle\n'): void {
  const target = join(workspace, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function expectFailure(
  result: WorkspaceFilesystemProviderResultV1<unknown>,
  code: 'path_invalid' | 'stale_preimage',
): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected Provider failure');
  expect(result.failure.code).toBe(code);
}
