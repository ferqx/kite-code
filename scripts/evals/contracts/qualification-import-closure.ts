import { lstatSync, readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { canonicalJsonBytes, sha256Digest } from '../../release/canonical-json';

export const MODEL_REPLAY_IMPORT_CLOSURE_ALGORITHM_V1 =
  'typescript-preprocess-local-import-closure-v1' as const;

export const MODEL_REPLAY_IMPORT_CLOSURE_ENTRYPOINTS_V1 = Object.freeze([
  'scripts/evals/model-replay-subagent-journey.ts',
  'tests/evals/agent-tasks/replay-subagent-journey.test.ts',
] as const);

export interface ModelReplayImportClosureV1 {
  readonly algorithm: typeof MODEL_REPLAY_IMPORT_CLOSURE_ALGORITHM_V1;
  readonly entrypoints: readonly string[];
  readonly paths: readonly string[];
  readonly digest: `sha256:${string}`;
}

/**
 * Compute the complete repository-local static import closure for the PS-03
 * journey. Package imports are covered by bun.lock; every local source byte is
 * covered by this aggregate digest so a transitive Runtime change invalidates
 * qualification before the journey can run as approved evidence.
 */
export function computeModelReplayImportClosureV1(input: {
  readonly repositoryRoot: string;
  readonly entrypoints?: readonly string[];
}): ModelReplayImportClosureV1 {
  const root = resolve(input.repositoryRoot);
  const entrypoints = [...(input.entrypoints ?? MODEL_REPLAY_IMPORT_CLOSURE_ENTRYPOINTS_V1)];
  const pending = [...entrypoints];
  const paths = new Set<string>();

  while (pending.length > 0) {
    const path = pending.shift();
    if (!path || paths.has(path)) continue;
    assertRepositoryRelativePath(path);
    const absolute = resolve(root, path);
    assertInsideRoot(root, absolute);
    assertRegularFile(absolute);
    paths.add(path);

    const source = readFileSync(absolute, 'utf8');
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      const target = resolveLocalImport(root, absolute, imported.fileName);
      if (target == null) continue;
      const relativeTarget = normalizedRelative(root, target);
      if (!paths.has(relativeTarget)) pending.push(relativeTarget);
    }
    if (paths.size > 1_024) throw new Error('Model replay import closure exceeds its bound.');
  }

  const sorted = [...paths].sort();
  const digest = sha256Digest(
    canonicalJsonBytes({
      algorithm: MODEL_REPLAY_IMPORT_CLOSURE_ALGORITHM_V1,
      entrypoints,
      files: sorted.map((path) => ({
        path,
        sha256: qualificationFileDigest(resolve(root, path)),
      })),
    }),
  );
  return Object.freeze({
    algorithm: MODEL_REPLAY_IMPORT_CLOSURE_ALGORITHM_V1,
    entrypoints: Object.freeze(entrypoints),
    paths: Object.freeze(sorted),
    digest,
  });
}

/**
 * Qualification sources are repository text, whose Git identity is LF even
 * when a Windows checkout materializes CRLF through autocrlf. Bind semantic
 * source bytes rather than the checkout-specific line ending representation
 * so the same approved closure is reproducible on every required runner.
 */
function qualificationFileDigest(path: string): `sha256:${string}` {
  const text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  return sha256Digest(new TextEncoder().encode(text));
}

function resolveLocalImport(root: string, importer: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) {
    base = resolve(root, 'src', specifier.slice(2));
  } else if (specifier.startsWith('.')) {
    base = resolve(dirname(importer), specifier);
  } else {
    return null;
  }
  assertInsideRoot(root, base);
  const extension = extname(base);
  const withoutJavaScriptExtension = /\.(?:c|m)?js$/u.test(extension)
    ? base.slice(0, -extension.length)
    : base;
  const candidates =
    extension && withoutJavaScriptExtension === base
      ? [base]
      : [
          withoutJavaScriptExtension,
          `${withoutJavaScriptExtension}.ts`,
          `${withoutJavaScriptExtension}.tsx`,
          `${withoutJavaScriptExtension}.json`,
          `${withoutJavaScriptExtension}.txt`,
          resolve(withoutJavaScriptExtension, 'index.ts'),
          resolve(withoutJavaScriptExtension, 'index.tsx'),
        ];
  const target = candidates.find(isRegularFile);
  if (!target) throw new Error(`Unresolved repository-local import: ${specifier}`);
  assertInsideRoot(root, target);
  return target;
}

function normalizedRelative(root: string, target: string): string {
  const path = relative(root, target).replaceAll('\\', '/');
  assertRepositoryRelativePath(path);
  return path;
}

function assertInsideRoot(root: string, target: string): void {
  const path = relative(root, target);
  if (
    path === '' ||
    path === '..' ||
    path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error('Model replay import closure escaped the repository root.');
  }
}

function assertRepositoryRelativePath(path: string): void {
  if (!/^[A-Za-z0-9.][A-Za-z0-9._/-]{0,511}$/u.test(path) || path.split('/').includes('..')) {
    throw new Error('Invalid model replay import-closure path.');
  }
}

function isRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function assertRegularFile(path: string): void {
  if (!isRegularFile(path)) throw new Error('Model replay import closure contains a non-file.');
}
