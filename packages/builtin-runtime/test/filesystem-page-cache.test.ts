import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalWorkspaceFilesystemProvider } from '../src/filesystem/local-provider';

test('read_file pages keep complete evidence and observe same-size content rewrites', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-file-pages-')));
  try {
    const file = join(directory, 'sample.txt');
    const provider = new LocalWorkspaceFilesystemProvider({
      verifyObserve: (grant) => grant,
      verifyPrepare: () => {
        throw new Error('unused');
      },
      verifyAndConsumeCommit: () => {
        throw new Error('unused');
      },
    });
    const protectedBoundary = {
      schema: 'kite.workspace-filesystem-protected-boundary.v1' as const,
      canonicalWorkspace: directory,
      policyMode: 'deny' as const,
      excludedSubtrees: [],
      excludedFiles: [],
      excludedFilePrefixes: [],
      additionalDeniedCanonicalPaths: [],
      allowedCanonicalPaths: [],
      boundaryDigest: 'fixture',
    };
    const read = async (offset: number, limit: number) => {
      const result = await provider.observe({
        grant: {
          operation: { kind: 'read_file', path: file, pathScope: 'workspace_only', offset, limit },
          canonicalWorkspace: directory,
          protectedBoundary,
        } as never,
      });
      if (!result.ok || result.observation.kind !== 'read_file') throw new Error('read failed');
      return result.observation;
    };
    writeFileSync(file, 'first\n\nthird\n');
    const first = await read(1, 2);
    expect(first.content).toBe('1|first\n2|');
    expect(first.totalLines).toBe(3);
    expect(first.rawContent).toBe('first\n\nthird\n');
    const second = await read(3, 2);
    expect(second.content).toBe('3|third');
    expect(second.contentDigest).toBe(first.contentDigest);

    writeFileSync(file, 'first\n\nTHIRD\n');
    const changed = await read(3, 2);
    expect(changed.content).toBe('3|THIRD');
    expect(changed.contentDigest).not.toBe(first.contentDigest);
    expect(changed.rawContent).toBe('first\n\nTHIRD\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
