import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  WorkspaceFilesystemObserveObservation,
  WorkspaceFilesystemObserveOperation,
} from '@kite-ai/runtime-spi';
import {
  WorkspaceFilesystemGrantAuthority,
  workspaceFilesystemProtectedBoundaryDigest,
} from '../src/filesystem/grant-authority';
import { LocalWorkspaceFilesystemProvider } from '../src/filesystem/local-provider';
import { createProtectedPathEvaluator } from '../src/sandbox/protected-path';

async function withFixture(
  run: (
    observe: (
      operation: WorkspaceFilesystemObserveOperation,
    ) => Promise<WorkspaceFilesystemObserveObservation>,
  ) => Promise<void>,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-search-glob-')));
  try {
    for (const path of ['root.ts', 'one/child.ts', 'one/two/deep.ts', 'root.js']) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), 'needle\n');
    }
    const grants = new WorkspaceFilesystemGrantAuthority();
    const provider = new LocalWorkspaceFilesystemProvider(grants.verifier());
    const unsignedBoundary = {
      schema: 'kite.workspace-filesystem-protected-boundary.v1' as const,
      ...createProtectedPathEvaluator({
        workspaceRoot: root,
        mode: 'deny',
      }).projectFilesystemBoundary(),
    };
    const protectedBoundary = {
      ...unsignedBoundary,
      boundaryDigest: workspaceFilesystemProtectedBoundaryDigest(unsignedBoundary),
    };
    const observe = async (operation: WorkspaceFilesystemObserveOperation) => {
      const grant = grants.issueObserveGrant({
        binding: {
          threadId: 'thread',
          turnId: 'turn',
          toolCallId: 'search',
          invocationId: 'invocation',
          attempt: 1,
          intentDigest: 'intent',
          searchBoundaryDigest: protectedBoundary.boundaryDigest,
          capabilityRevision: 'revision',
          effectDigest: 'effects',
          canonicalWorkspace: root,
          protectedPathRevision: 'protected-revision',
          approvalSummary: 'Workspace search',
        },
        operation,
        protectedBoundary,
        ttlMs: 30_000,
      });
      const result = await provider.observe({ grant });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.failure.message);
      return result.observation;
    };
    await run(observe);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('filesystem recursive glob', () => {
  test('search_files includes zero, one, and multiple directory levels', async () => {
    await withFixture(async (observe) => {
      expect(
        await observe({
          kind: 'search_files',
          path: '.',
          pathScope: 'workspace_only',
          pattern: '**/*.ts',
        }),
      ).toMatchObject({
        matches: ['one/child.ts', 'one/two/deep.ts', 'root.ts'],
      });
      expect(
        await observe({
          kind: 'search_files',
          path: '.',
          pathScope: 'workspace_only',
          pattern: 'one/**/*.ts',
        }),
      ).toMatchObject({
        matches: ['one/child.ts', 'one/two/deep.ts'],
      });
    });
  });

  test('search_content glob includes the same directory levels', async () => {
    await withFixture(async (observe) => {
      const result = await observe({
        kind: 'search_content',
        path: '.',
        pathScope: 'workspace_only',
        pattern: 'needle',
        glob: '**/*.ts',
      });
      if (result.kind !== 'search_content') throw new Error('Unexpected observation');
      expect(
        [...result.matches].sort((left, right) => left.path.localeCompare(right.path)),
      ).toEqual([
        { path: 'one/child.ts', line: 1, text: 'needle' },
        { path: 'one/two/deep.ts', line: 1, text: 'needle' },
        { path: 'root.ts', line: 1, text: 'needle' },
      ]);
      const nested = await observe({
        kind: 'search_content',
        path: '.',
        pathScope: 'workspace_only',
        pattern: 'needle',
        glob: 'one/**/*.ts',
      });
      if (nested.kind !== 'search_content') throw new Error('Unexpected observation');
      expect(nested.matches.map((match) => match.path).sort()).toEqual([
        'one/child.ts',
        'one/two/deep.ts',
      ]);
    });
  });

  test('keeps single-star, filename braces and non-segment double-star behavior', async () => {
    await withFixture(async (observe) => {
      expect(
        await observe({
          kind: 'search_files',
          path: '.',
          pathScope: 'workspace_only',
          pattern: 'one/*.ts',
        }),
      ).toMatchObject({ matches: ['one/child.ts'] });
      expect(
        await observe({
          kind: 'search_files',
          path: '.',
          pathScope: 'workspace_only',
          pattern: '*.{ts,js}',
        }),
      ).toMatchObject({ matches: ['one/child.ts', 'one/two/deep.ts', 'root.js', 'root.ts'] });
      expect(
        await observe({
          kind: 'search_files',
          path: '.',
          pathScope: 'workspace_only',
          pattern: 'o**/*.ts',
        }),
      ).toMatchObject({ matches: ['one/child.ts', 'one/two/deep.ts'] });
    });
  });
});
