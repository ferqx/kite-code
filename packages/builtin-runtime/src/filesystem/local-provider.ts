import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  type Stats,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  FilesystemCommitGrant,
  FilesystemObserveGrant,
  FilesystemPrepareGrant,
  WorkspaceFilesystemCommittedMutation,
  WorkspaceFilesystemMutationOperation,
  WorkspaceFilesystemObserveObservation,
  WorkspaceFilesystemPathScope,
  WorkspaceFilesystemPreimageObservation,
  WorkspaceFilesystemPreparedMutation,
  WorkspaceFilesystemProtectedBoundary,
  WorkspaceFilesystemProvider,
  WorkspaceFilesystemProviderFailureCode,
  WorkspaceFilesystemProviderResult,
  WorkspaceFilesystemStatIdentity,
  WorkspaceFilesystemTargetIdentity,
} from '@kite-ai/runtime-spi';
import { WORKSPACE_FILESYSTEM_PROVIDER_SCHEMA_ } from '@kite-ai/runtime-spi';
import {
  assertDescriptorRelativeMutationSupported,
  atomicReplaceInLockedWindowsDirectory,
  closeOpenedDirectoryChain,
  openExclusiveFileAt,
  openOrCreateDirectoryChainAt,
  renameAt,
  unlinkAt,
} from './descriptor-relative';
import {
  WorkspaceFilesystemGrantError,
  type WorkspaceFilesystemGrantVerifier,
  workspaceFilesystemStringDigest,
  workspaceFilesystemTargetEvidence,
  workspaceFilesystemTargetIdentityDigest,
} from './grant-authority';

const DEFAULT_MAX_OBSERVATION_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_SEARCH_MATCHES = 10_000;
const DEFAULT_READ_LINE_LIMIT = 2_000;
const MAXIMUM_IGNORE_FILE_BYTES = 1024 * 1024;

function msys2ToWindowsPath(filePath: string): string {
  if (process.platform !== 'win32') return filePath;
  const match = filePath.match(/^\/([a-zA-Z])(?:\/|$)(.*)$/u);
  if (!match) return filePath;
  return `${match[1]!.toUpperCase()}:\\${match[2]!.replaceAll('/', '\\')}`;
}

export interface LocalWorkspaceFilesystemProviderOptions {
  readonly maximumObservationBytes?: number;
  readonly maximumSearchMatches?: number;
}

/** The sole Node-fs owner for governed workspace capability execution. */
export class LocalWorkspaceFilesystemProvider implements WorkspaceFilesystemProvider {
  readonly #verifier: WorkspaceFilesystemGrantVerifier;
  readonly #maximumObservationBytes: number;
  readonly #maximumSearchMatches: number;

  constructor(
    verifier: WorkspaceFilesystemGrantVerifier,
    options: LocalWorkspaceFilesystemProviderOptions = {},
  ) {
    this.#verifier = verifier;
    this.#maximumObservationBytes = positiveInteger(
      options.maximumObservationBytes ?? DEFAULT_MAX_OBSERVATION_BYTES,
      'maximumObservationBytes',
    );
    this.#maximumSearchMatches = positiveInteger(
      options.maximumSearchMatches ?? DEFAULT_MAX_SEARCH_MATCHES,
      'maximumSearchMatches',
    );
  }

  async observe(input: {
    readonly grant: FilesystemObserveGrant;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceFilesystemProviderResult<WorkspaceFilesystemObserveObservation>> {
    try {
      throwIfAborted(input.signal);
      // Integrity, purpose, operation, identity and expiry are checked before the first fs call.
      const grant = this.#verifier.verifyObserve(input.grant);
      throwIfAborted(input.signal);
      const workspace = verifiedWorkspace(grant.canonicalWorkspace);
      const target = captureTargetIdentity(workspace, grant.operation.path);
      admitTarget(
        workspace,
        target,
        grant.operation.pathScope,
        grant.protectedBoundary,
        grant.operation.kind === 'search_files' || grant.operation.kind === 'search_content',
      );
      switch (grant.operation.kind) {
        case 'read_file':
          return success(this.#readFile(target, grant.operation.offset, grant.operation.limit));
        case 'search_files':
          return success(
            await this.#searchFiles(
              workspace,
              target,
              grant.operation.pattern,
              grant.protectedBoundary,
              input.signal,
            ),
          );
        case 'search_content':
          return success(
            await this.#searchContent(
              workspace,
              target,
              grant.operation.pattern,
              grant.operation.glob,
              grant.protectedBoundary,
              input.signal,
            ),
          );
      }
    } catch (error) {
      return failureFrom(error);
    }
  }

  async prepareMutation(input: {
    readonly grant: FilesystemPrepareGrant;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceFilesystemProviderResult<WorkspaceFilesystemPreparedMutation>> {
    try {
      throwIfAborted(input.signal);
      const grant = this.#verifier.verifyPrepare(input.grant);
      throwIfAborted(input.signal);
      if (grant.operation.pathScope === 'external_read') {
        throw providerError('invalid_grant', 'Read-only external scope cannot authorize mutation.');
      }
      const workspace = verifiedWorkspace(grant.canonicalWorkspace);
      const target = captureAdmittedMutationTargetIdentity(
        workspace,
        grant.operation.path,
        grant.operation.pathScope,
        grant.protectedBoundary,
      );
      const preimage = this.#preimage(target);
      const targetIdentityDigest = workspaceFilesystemTargetIdentityDigest(target);
      return success(
        deepFreeze({
          kind: 'prepared_mutation',
          operationKind: grant.operation.kind,
          operationDigest: grant.operationDigest,
          target,
          targetEvidence: workspaceFilesystemTargetEvidence(target),
          targetIdentityDigest,
          preimage,
        }),
      );
    } catch (error) {
      return failureFrom(error);
    }
  }

  async commitMutation(input: {
    readonly grant: FilesystemCommitGrant;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceFilesystemProviderResult<WorkspaceFilesystemCommittedMutation>> {
    let commitCompleted = false;
    try {
      throwIfAborted(input.signal);
      // Consumption happens with successful validation and before any fs call.
      const grant = this.#verifier.verifyAndConsumeCommit(input.grant);
      throwIfAborted(input.signal);
      if (grant.operation.pathScope === 'external_read') {
        throw providerError('invalid_grant', 'Read-only external scope cannot authorize mutation.');
      }
      const workspace = verifiedWorkspace(grant.canonicalWorkspace);
      const currentTarget = captureTargetIdentity(workspace, grant.operation.path);
      this.#assertPreparedIdentity(grant, currentTarget);
      admitMutationTarget(
        workspace,
        currentTarget,
        grant.operation.pathScope,
        grant.protectedBoundary,
      );
      const preimage = this.#preimage(currentTarget);
      if (preimage.contentDigest !== grant.preimageDigest) {
        throw providerError(
          'stale_preimage',
          'Filesystem target content changed after mutation preparation.',
        );
      }
      throwIfAborted(input.signal);
      const mutation = buildMutation(grant.operation, preimage);
      // All stale/edit checks complete before the target or a temporary file is written.
      atomicWrite(
        workspace,
        currentTarget.canonicalPath,
        mutation.content,
        currentTarget,
        grant.operation.pathScope,
        grant.protectedBoundary,
        input.signal,
      );
      commitCompleted = true;
      const committedTarget = captureAdmittedMutationTargetIdentity(
        workspace,
        grant.operation.path,
        grant.operation.pathScope,
        grant.protectedBoundary,
      );
      const afterContentDigest = workspaceFilesystemStringDigest(normalizeEol(mutation.content));
      return success(
        deepFreeze({
          kind: 'committed_mutation',
          operationKind: grant.operation.kind,
          operationDigest: grant.operationDigest,
          target: committedTarget,
          targetEvidence: workspaceFilesystemTargetEvidence(committedTarget),
          beforeContentDigest: preimage.contentDigest,
          afterContentDigest,
          changed: preimage.content !== mutation.content,
          created: !preimage.existed,
          content: mutation.content,
          lines: lineCount(mutation.content),
          ...(mutation.fromLine === undefined ? {} : { fromLine: mutation.fromLine }),
          ...(mutation.toLine === undefined ? {} : { toLine: mutation.toLine }),
          ...(mutation.replacements === undefined ? {} : { replacements: mutation.replacements }),
          ...(mutation.matchLines === undefined ? {} : { matchLines: mutation.matchLines }),
        }),
      );
    } catch (error) {
      // Once rename returned, losing terminal evidence is commit-unknown, not a definite failure.
      if (commitCompleted) throw error;
      return failureFrom(error);
    }
  }

  #readFile(
    target: WorkspaceFilesystemTargetIdentity,
    offset?: number,
    limit?: number,
  ): WorkspaceFilesystemObserveObservation {
    assertRegularFile(target);
    const decoded = this.#readText(target.canonicalPath, target.canonicalPath, target.followed);
    const lines = sourceLines(decoded);
    const fromLine = Math.max(1, offset ?? 1);
    const pageLimit = limit ?? DEFAULT_READ_LINE_LIMIT;
    const toLine = Math.min(lines.length, fromLine + pageLimit - 1);
    const content = lines
      .slice(fromLine - 1, toLine)
      .map((line, index) => {
        const lineNumber = String(fromLine + index).padStart(String(toLine).length, ' ');
        return `${lineNumber}|${line}`;
      })
      .join('\n');
    return deepFreeze({
      kind: 'read_file',
      target,
      targetEvidence: workspaceFilesystemTargetEvidence(target),
      content,
      rawContent: decoded,
      contentDigest: workspaceFilesystemStringDigest(decoded),
      totalLines: lines.length,
      fromLine,
      toLine,
    });
  }

  async #searchFiles(
    workspace: string,
    target: WorkspaceFilesystemTargetIdentity,
    pattern: string,
    boundary: WorkspaceFilesystemProtectedBoundary,
    signal?: AbortSignal,
  ): Promise<WorkspaceFilesystemObserveObservation> {
    const files = await this.#walk(workspace, target, boundary, signal);
    const matches = files
      .map((file) => toPosix(relative(workspace, file)))
      .filter((path) => matchesFilePattern(path, pattern))
      .sort();
    if (matches.length > this.#maximumSearchMatches) {
      throw providerError('observation_too_large', 'Filesystem search result exceeded its bound.');
    }
    assertBound(matches.join('\n'), this.#maximumObservationBytes);
    return deepFreeze({
      kind: 'search_files',
      target,
      targetEvidence: workspaceFilesystemTargetEvidence(target),
      matches,
      contentDigest: workspaceFilesystemStringDigest(matches.join('\n')),
    });
  }

  async #searchContent(
    workspace: string,
    target: WorkspaceFilesystemTargetIdentity,
    pattern: string,
    glob: string | undefined,
    boundary: WorkspaceFilesystemProtectedBoundary,
    signal?: AbortSignal,
  ): Promise<WorkspaceFilesystemObserveObservation> {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      throw providerError('path_invalid', 'Filesystem content search pattern is invalid.');
    }
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let observedBytes = 0;
    for (const file of await this.#walk(workspace, target, boundary, signal)) {
      await yieldToEventLoop();
      throwIfAborted(signal);
      const path = toPosix(relative(workspace, file));
      if (glob && !matchesFilePattern(path, glob)) continue;
      let content: string;
      try {
        content = this.#readText(file, target.canonicalPath);
      } catch (error) {
        if (isProviderError(error, 'binary_file')) continue;
        throw error;
      }
      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index++) {
        regex.lastIndex = 0;
        const text = lines[index]!;
        if (!regex.test(text)) continue;
        observedBytes += Buffer.byteLength(path) + Buffer.byteLength(text) + 32;
        if (
          matches.length >= this.#maximumSearchMatches ||
          observedBytes > this.#maximumObservationBytes
        ) {
          throw providerError(
            'observation_too_large',
            'Filesystem search result exceeded its bound.',
          );
        }
        matches.push({ path, line: index + 1, text });
      }
    }
    return deepFreeze({
      kind: 'search_content',
      target,
      targetEvidence: workspaceFilesystemTargetEvidence(target),
      matches,
      contentDigest: workspaceFilesystemStringDigest(JSON.stringify(matches)),
    });
  }

  async #walk(
    workspace: string,
    target: WorkspaceFilesystemTargetIdentity,
    boundary: WorkspaceFilesystemProtectedBoundary,
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (!target.exists) throw providerError('not_found', 'Filesystem search target was not found.');
    if (!searchTargetMayBeObserved(workspace, target, boundary)) return [];
    if (target.followed?.type === 'file') return [target.canonicalPath];
    if (target.followed?.type !== 'directory') {
      throw providerError('not_a_directory', 'Filesystem search target is not a directory.');
    }
    const output: string[] = [];
    const walk = async (directory: string, rules: readonly IgnoreRule[]): Promise<void> => {
      await yieldToEventLoop();
      throwIfAborted(signal);
      if (!searchDirectoryMayBeTraversed(workspace, directory, boundary)) return;
      const ignorePath = join(directory, '.gitignore');
      const ignoreRelativePath = toPosix(relative(workspace, ignorePath));
      const localRules = [
        ...rules,
        ...(inside(workspace, directory) &&
        searchFileMayBeObserved(workspace, ignorePath, ignoreRelativePath, boundary)
          ? loadIgnoreRules(workspace, directory, toPosix(relative(workspace, directory)), boundary)
          : []),
      ];
      const before = stableDirectoryIdentity(directory, target.canonicalPath);
      const entries = readdirSync(directory, { withFileTypes: true });
      const after = stableDirectoryIdentity(directory, target.canonicalPath);
      if (!sameStatIdentity(before, after)) {
        throw providerError(
          'path_invalid',
          'Filesystem search directory changed during traversal.',
        );
      }
      for (const entry of entries) {
        await yieldToEventLoop();
        throwIfAborted(signal);
        const path = join(directory, entry.name);
        const rel = toPosix(relative(workspace, path));
        if (searchPathExcluded(workspace, path, rel, boundary)) continue;
        if (ignored(rel, entry.isDirectory(), localRules)) continue;
        if (entry.isDirectory()) {
          if (!searchDirectoryMayBeTraversed(workspace, path, boundary)) continue;
          const identity = lstatSync(path);
          if (!identity.isDirectory() || identity.isSymbolicLink()) continue;
          await walk(path, localRules);
        } else if (
          entry.isFile() &&
          searchFileMayBeObserved(workspace, path, rel, boundary) &&
          stableRegularFilePath(path, target.canonicalPath)
        )
          output.push(path);
        // Directory-entry symlinks are deliberately not followed.
      }
    };
    await walk(
      target.canonicalPath,
      ancestorIgnoreRules(workspace, target.canonicalPath, boundary),
    );
    return output;
  }

  #preimage(target: WorkspaceFilesystemTargetIdentity): WorkspaceFilesystemPreimageObservation {
    if (!target.exists) {
      return deepFreeze({ existed: false, content: null, contentDigest: null, byteLength: 0 });
    }
    assertRegularFile(target);
    if (target.noFollow?.type === 'symlink') {
      throw providerError('path_invalid', 'Mutation targets cannot be symbolic links.');
    }
    const content = this.#readText(target.canonicalPath, target.canonicalPath, target.followed);
    return deepFreeze({
      existed: true,
      content,
      contentDigest: workspaceFilesystemStringDigest(content),
      byteLength: Buffer.byteLength(content),
    });
  }

  #readText(
    path: string,
    admittedRoot: string,
    expectedIdentity?: WorkspaceFilesystemStatIdentity | null,
  ): string {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = statIdentity(fstatSync(descriptor));
      if (before.type !== 'file') {
        throw providerError('not_a_file', 'Filesystem target is not a regular file.');
      }
      if (expectedIdentity && !sameStatIdentity(before, expectedIdentity)) {
        throw providerError('path_invalid', 'Filesystem target identity changed before read.');
      }
      const canonical = normalizePathCase(realpathSync(path));
      const admitted = normalizePathCase(admittedRoot);
      if (!inside(admitted, canonical)) {
        throw providerError('path_outside_workspace', 'Filesystem read escaped its admitted root.');
      }
      const current = statIdentity(statSync(canonical));
      if (!sameStatIdentity(before, current)) {
        throw providerError('path_invalid', 'Filesystem target changed while opening.');
      }
      const raw = readFileSync(descriptor);
      const after = statIdentity(fstatSync(descriptor));
      if (!sameStatIdentity(before, after)) {
        throw providerError('path_invalid', 'Filesystem target changed during read.');
      }
      if (raw.byteLength > this.#maximumObservationBytes) {
        throw providerError('observation_too_large', 'Filesystem observation exceeded its bound.');
      }
      return decodeText(raw);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  #assertPreparedIdentity(
    grant: Readonly<FilesystemCommitGrant>,
    current: WorkspaceFilesystemTargetIdentity,
  ): void {
    const digest = workspaceFilesystemTargetIdentityDigest(current);
    if (
      digest !== grant.preparedTargetIdentityDigest ||
      current.lexicalPath !== grant.preparedTargetIdentity.lexicalPath ||
      current.resolvedPath !== grant.preparedTargetIdentity.resolvedPath ||
      current.canonicalPath !== grant.preparedTargetIdentity.canonicalPath
    ) {
      throw providerError(
        'stale_preimage',
        'Filesystem target identity changed after mutation preparation.',
      );
    }
  }
}

interface MutationContent {
  content: string;
  fromLine?: number;
  toLine?: number;
  replacements?: number;
  matchLines?: readonly number[];
}

function buildMutation(
  operation: WorkspaceFilesystemMutationOperation,
  preimage: WorkspaceFilesystemPreimageObservation,
): MutationContent {
  if (operation.kind === 'write_file') return { content: operation.content };
  if (!preimage.existed || preimage.content === null) {
    throw providerError('not_found', 'Filesystem edit target was not found.');
  }
  const content = normalizeEol(preimage.content);
  const oldString = normalizeEol(operation.oldString);
  const newString = normalizeEol(operation.newString);
  if (oldString.length === 0) {
    throw providerError('edit_not_found', 'Filesystem edit oldString must not be empty.');
  }
  const first = content.indexOf(oldString);
  if (first < 0) throw providerError('edit_not_found', 'Filesystem edit text was not found.');
  const count = content.split(oldString).length - 1;
  if (count > 1 && operation.replaceAll !== true) {
    throw providerError('edit_ambiguous', 'Filesystem edit text matched more than once.');
  }
  const matchLines: number[] = [];
  let cursor = first;
  while (cursor >= 0) {
    matchLines.push(content.slice(0, cursor).split('\n').length);
    cursor = content.indexOf(oldString, cursor + oldString.length);
  }
  const next = operation.replaceAll
    ? content.split(oldString).join(newString)
    : `${content.slice(0, first)}${newString}${content.slice(first + oldString.length)}`;
  const fromLine = matchLines[0]!;
  return {
    content: next,
    fromLine,
    toLine: fromLine + newString.split('\n').length - 1,
    replacements: operation.replaceAll ? count : 1,
    ...(operation.replaceAll && matchLines.length > 1 ? { matchLines } : {}),
  };
}

function searchTargetMayBeObserved(
  workspace: string,
  target: WorkspaceFilesystemTargetIdentity,
  boundary: WorkspaceFilesystemProtectedBoundary,
): boolean {
  const lexicalRelative = toPosix(relative(workspace, target.resolvedPath));
  const canonicalRelative = toPosix(relative(workspace, target.canonicalPath));
  if (
    searchPathExcluded(workspace, target.resolvedPath, lexicalRelative, boundary) ||
    searchPathExcluded(workspace, target.canonicalPath, canonicalRelative, boundary)
  ) {
    return false;
  }
  return target.followed?.type === 'directory'
    ? searchDirectoryMayBeTraversed(workspace, target.canonicalPath, boundary)
    : searchFileMayBeObserved(workspace, target.canonicalPath, canonicalRelative, boundary);
}

function protectedTargetMayBeAccessed(
  workspace: string,
  target: WorkspaceFilesystemTargetIdentity,
  boundary: WorkspaceFilesystemProtectedBoundary,
  allowTraversalAncestor: boolean,
): boolean {
  if (normalizePathCase(boundary.canonicalWorkspace) !== normalizePathCase(workspace)) return false;
  const lexicalRelative = toPosix(relative(workspace, target.resolvedPath));
  const canonicalRelative = toPosix(relative(workspace, target.canonicalPath));
  if (
    searchPathExcluded(workspace, target.resolvedPath, lexicalRelative, boundary) ||
    searchPathExcluded(workspace, target.canonicalPath, canonicalRelative, boundary)
  ) {
    return false;
  }
  if (boundary.allowedCanonicalPaths.length === 0) return true;
  const canonical = normalizePathCase(target.canonicalPath);
  return boundary.allowedCanonicalPaths.some((allowed) => {
    const normalizedAllowed = normalizePathCase(allowed);
    return (
      inside(normalizedAllowed, canonical) ||
      (allowTraversalAncestor &&
        target.followed?.type === 'directory' &&
        inside(canonical, normalizedAllowed))
    );
  });
}

function searchPathExcluded(
  workspace: string,
  path: string,
  relativePath: string,
  boundary: WorkspaceFilesystemProtectedBoundary,
): boolean {
  if (normalizePathCase(boundary.canonicalWorkspace) !== normalizePathCase(workspace)) return true;
  const relativeIdentity = relativePath.toLowerCase();
  if (
    boundary.excludedSubtrees.some((rule) =>
      sameOrDescendantIdentity(relativeIdentity, rule.toLowerCase()),
    ) ||
    boundary.excludedFiles.some((rule) => relativeIdentity === rule.toLowerCase()) ||
    boundary.excludedFilePrefixes.some((rule) => relativeIdentity.startsWith(rule.toLowerCase()))
  ) {
    return true;
  }
  const canonical = normalizePathCase(path);
  return boundary.additionalDeniedCanonicalPaths.some((denied) =>
    inside(normalizePathCase(denied), canonical),
  );
}

function searchDirectoryMayBeTraversed(
  workspace: string,
  directory: string,
  boundary: WorkspaceFilesystemProtectedBoundary,
): boolean {
  const relativePath = toPosix(relative(workspace, directory));
  if (searchPathExcluded(workspace, directory, relativePath, boundary)) return false;
  if (boundary.allowedCanonicalPaths.length === 0) return true;
  const canonical = normalizePathCase(directory);
  return boundary.allowedCanonicalPaths.some((allowed) => {
    const normalizedAllowed = normalizePathCase(allowed);
    return inside(canonical, normalizedAllowed) || inside(normalizedAllowed, canonical);
  });
}

function searchFileMayBeObserved(
  workspace: string,
  file: string,
  relativePath: string,
  boundary: WorkspaceFilesystemProtectedBoundary,
): boolean {
  if (searchPathExcluded(workspace, file, relativePath, boundary)) return false;
  if (boundary.allowedCanonicalPaths.length === 0) return true;
  const canonical = normalizePathCase(file);
  return boundary.allowedCanonicalPaths.some((allowed) =>
    inside(normalizePathCase(allowed), canonical),
  );
}

function sameOrDescendantIdentity(candidate: string, rule: string): boolean {
  return candidate === rule || candidate.startsWith(`${rule}/`);
}

function verifiedWorkspace(expected: string): string {
  let actual: string;
  try {
    actual = normalizePathCase(realpathSync(resolve(expected)));
  } catch {
    throw providerError('workspace_mismatch', 'Canonical workspace is unavailable.');
  }
  if (actual !== normalizePathCase(expected)) {
    throw providerError('workspace_mismatch', 'Canonical workspace identity does not match grant.');
  }
  return actual;
}

function captureTargetIdentity(
  workspace: string,
  lexicalPath: string,
): WorkspaceFilesystemTargetIdentity {
  const normalized = msys2ToWindowsPath(lexicalPath).replace(/[\\/]+/g, sep);
  if (!normalized) {
    throw providerError('path_invalid', 'Filesystem target path is invalid.');
  }
  const expanded =
    normalized === '~'
      ? homedir()
      : normalized.startsWith(`~${sep}`)
        ? resolve(homedir(), normalized.slice(2))
        : normalized;
  const resolvedPath = resolve(workspace, expanded);
  // A mutation replaces a directory entry, so target identity alone is not
  // sufficient: an attacker can preserve the target inode through a hard link
  // while replacing its parent directory. Always bind the nearest existing
  // parent directory as part of the prepared target identity.
  let nearest = dirname(resolvedPath);
  while (!existsNoFollow(nearest)) {
    const parent = dirname(nearest);
    if (parent === nearest) break;
    nearest = parent;
  }
  if (!existsNoFollow(nearest))
    throw providerError('path_invalid', 'Filesystem target has no existing root.');
  let canonicalNearest: string;
  try {
    canonicalNearest = normalizePathCase(realpathSync(nearest));
  } catch {
    throw providerError('path_invalid', 'Filesystem target identity could not be resolved.');
  }
  const suffix = relative(nearest, resolvedPath);
  const canonicalPath = normalizePathCase(resolve(canonicalNearest, suffix));
  const exists = existsNoFollow(resolvedPath);
  let noFollow: WorkspaceFilesystemStatIdentity | null = null;
  let followed: WorkspaceFilesystemStatIdentity | null = null;
  if (exists) {
    try {
      noFollow = statIdentity(lstatSync(resolvedPath));
      followed = statIdentity(statSync(resolvedPath));
    } catch {
      throw providerError('path_invalid', 'Filesystem target identity could not be inspected.');
    }
  }
  return deepFreeze({
    schema: WORKSPACE_FILESYSTEM_PROVIDER_SCHEMA_,
    lexicalPath,
    resolvedPath: normalizePathCase(resolvedPath),
    canonicalPath: exists ? normalizePathCase(realpathSync(resolvedPath)) : canonicalPath,
    exists,
    noFollow,
    followed,
    nearestExistingCanonicalPath: canonicalNearest,
    nearestExistingNoFollow: statIdentity(lstatSync(canonicalNearest)),
  });
}

function captureAdmittedMutationTargetIdentity(
  workspace: string,
  lexicalPath: string,
  scope: WorkspaceFilesystemPathScope,
  boundary: WorkspaceFilesystemProtectedBoundary,
): WorkspaceFilesystemTargetIdentity {
  const target = captureTargetIdentity(workspace, lexicalPath);
  admitMutationTarget(workspace, target, scope, boundary);
  return target;
}

function admitTarget(
  workspace: string,
  target: WorkspaceFilesystemTargetIdentity,
  scope: WorkspaceFilesystemPathScope,
  boundary: WorkspaceFilesystemProtectedBoundary,
  allowTraversalAncestor = false,
): void {
  if (scope === 'workspace_only' && !inside(workspace, target.canonicalPath)) {
    throw providerError(
      'path_outside_workspace',
      'Filesystem target is outside the canonical workspace.',
    );
  }
  if (!protectedTargetMayBeAccessed(workspace, target, boundary, allowTraversalAncestor)) {
    throw providerError('path_invalid', 'Filesystem target is denied by its sealed path boundary.');
  }
}

function admitMutationTarget(
  workspace: string,
  target: WorkspaceFilesystemTargetIdentity,
  scope: WorkspaceFilesystemPathScope,
  boundary: WorkspaceFilesystemProtectedBoundary,
): void {
  admitTarget(workspace, target, scope, boundary);
  if (target.exists && target.followed?.type !== 'file') {
    throw providerError('not_a_file', 'Filesystem mutation target is not a regular file.');
  }
  if (target.noFollow?.type === 'symlink') {
    throw providerError('path_invalid', 'Filesystem mutation target cannot be a symbolic link.');
  }
}

function assertRegularFile(target: WorkspaceFilesystemTargetIdentity): void {
  if (!target.exists) throw providerError('not_found', 'Filesystem target was not found.');
  if (target.followed?.type !== 'file') {
    throw providerError('not_a_file', 'Filesystem target is not a regular file.');
  }
}

function atomicWrite(
  workspace: string,
  target: string,
  content: string,
  identity: WorkspaceFilesystemTargetIdentity,
  scope: WorkspaceFilesystemPathScope,
  boundary: WorkspaceFilesystemProtectedBoundary,
  signal?: AbortSignal,
): void {
  // The support check precedes every directory, temporary-file or target write.
  // A path-based fallback would recreate the parent-swap vulnerability.
  assertMutationPathStable(workspace, identity, scope, boundary, false);
  const targetDirectory = dirname(target);
  const targetName = basename(target);
  const relativeDirectory = relative(identity.nearestExistingCanonicalPath, targetDirectory);
  if (!inside(identity.nearestExistingCanonicalPath, targetDirectory)) {
    throw providerError('stale_preimage', 'Filesystem mutation parent escaped its prepared root.');
  }
  const directorySegments =
    relativeDirectory === '' ? [] : relativeDirectory.split(sep).filter(Boolean);
  const temporaryName = `.${targetName}.kite-${randomUUID()}.tmp`;
  if (process.platform === 'win32') {
    atomicReplaceInLockedWindowsDirectory({
      ancestorDirectory: identity.nearestExistingCanonicalPath,
      directorySegments,
      targetName,
      temporaryName,
      content,
      beforePublish: () => {
        throwIfAborted(signal);
        assertMutationPathStable(workspace, identity, scope, boundary, true);
        runBeforeDescriptorRelativePublishTestHook();
      },
    });
    return;
  }
  assertDescriptorRelativeMutationSupported();
  let descriptor: number | undefined;
  let ancestorDescriptor: number | undefined;
  let directoryChain: ReturnType<typeof openOrCreateDirectoryChainAt> | undefined;
  let published = false;
  try {
    ancestorDescriptor = openSync(
      identity.nearestExistingCanonicalPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    if (
      !sameDirectoryObjectIdentity(
        identity.nearestExistingNoFollow,
        statIdentity(fstatSync(ancestorDescriptor)),
      )
    ) {
      throw providerError('stale_preimage', 'Prepared filesystem ancestor changed before commit.');
    }
    directoryChain = openOrCreateDirectoryChainAt(ancestorDescriptor, directorySegments);
    const parentDescriptor = directoryChain.descriptor;
    const pinnedParent = stableMutationDirectory(targetDirectory, identity);
    if (!sameDirectoryObjectIdentity(pinnedParent, statIdentity(fstatSync(parentDescriptor)))) {
      throw providerError('stale_preimage', 'Filesystem mutation parent changed before commit.');
    }
    const finalMode =
      identity.noFollow?.mode === undefined ? 0o644 : identity.noFollow.mode & 0o777;
    descriptor = openExclusiveFileAt(parentDescriptor, temporaryName, finalMode);
    // Normalize the final mode before content is written so ambient umask and
    // platform create-mode details cannot alter the Provider contract.
    fchmodSync(descriptor, finalMode);
    const temporaryStat = fstatSync(descriptor);
    if (!temporaryStat.isFile() || temporaryStat.nlink !== 1) {
      throw providerError('path_invalid', 'Filesystem mutation temporary file is not private.');
    }
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    throwIfAborted(signal);
    assertMutationPathStable(workspace, identity, scope, boundary, true);
    if (!sameDirectoryObjectIdentity(pinnedParent, statIdentity(fstatSync(parentDescriptor)))) {
      throw providerError('stale_preimage', 'Filesystem mutation parent changed before publish.');
    }
    if (
      !sameDirectoryObjectIdentity(
        stableMutationDirectory(targetDirectory, identity),
        statIdentity(fstatSync(parentDescriptor)),
      )
    ) {
      throw providerError('stale_preimage', 'Filesystem mutation parent changed before publish.');
    }
    runBeforeDescriptorRelativePublishTestHook();
    renameAt(parentDescriptor, temporaryName, targetName);
    published = true;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the primary failure.
      }
    }
    if (directoryChain !== undefined) {
      unlinkAt(directoryChain.descriptor, temporaryName);
    }
    throw error;
  } finally {
    if (directoryChain !== undefined) {
      closeOpenedDirectoryChain(directoryChain.openedDirectories, !published);
    }
    if (ancestorDescriptor !== undefined) {
      try {
        closeSync(ancestorDescriptor);
      } catch {
        // A close failure cannot turn a completed rename into a definite failure.
      }
    }
  }
}

const BEFORE_DESCRIPTOR_RELATIVE_PUBLISH_TEST_HOOK = Symbol.for(
  'kite.tests.workspace-filesystem.before-descriptor-relative-publish.v1',
);

function runBeforeDescriptorRelativePublishTestHook(): void {
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.KITE_WORKSPACE_FILESYSTEM_TEST_HOOKS !== '1'
  )
    return;
  const hook = (
    globalThis as typeof globalThis & {
      [BEFORE_DESCRIPTOR_RELATIVE_PUBLISH_TEST_HOOK]?: () => void;
    }
  )[BEFORE_DESCRIPTOR_RELATIVE_PUBLISH_TEST_HOOK];
  hook?.();
}

function stableMutationDirectory(
  directory: string,
  prepared: WorkspaceFilesystemTargetIdentity,
): WorkspaceFilesystemStatIdentity {
  let noFollow: Stats;
  let canonical: string;
  try {
    noFollow = lstatSync(directory);
    canonical = normalizePathCase(realpathSync(directory));
  } catch {
    throw providerError('stale_preimage', 'Filesystem mutation parent is unavailable.');
  }
  if (!noFollow.isDirectory() || noFollow.isSymbolicLink()) {
    throw providerError('stale_preimage', 'Filesystem mutation parent is not a stable directory.');
  }
  if (canonical !== normalizePathCase(dirname(prepared.canonicalPath))) {
    throw providerError('stale_preimage', 'Filesystem mutation parent changed after preparation.');
  }
  const identity = statIdentity(noFollow);
  const followed = statIdentity(statSync(canonical));
  if (!sameStatIdentity(identity, followed)) {
    throw providerError('stale_preimage', 'Filesystem mutation parent identity is unstable.');
  }
  return identity;
}

function assertMutationPathStable(
  workspace: string,
  prepared: WorkspaceFilesystemTargetIdentity,
  scope: WorkspaceFilesystemPathScope,
  boundary: WorkspaceFilesystemProtectedBoundary,
  allowCreatedParents: boolean,
): void {
  const current = captureAdmittedMutationTargetIdentity(
    workspace,
    prepared.lexicalPath,
    scope,
    boundary,
  );
  if (
    current.lexicalPath !== prepared.lexicalPath ||
    current.resolvedPath !== prepared.resolvedPath ||
    current.canonicalPath !== prepared.canonicalPath ||
    current.exists !== prepared.exists ||
    JSON.stringify(current.noFollow) !== JSON.stringify(prepared.noFollow) ||
    JSON.stringify(current.followed) !== JSON.stringify(prepared.followed)
  ) {
    throw providerError('stale_preimage', 'Filesystem target changed before atomic publish.');
  }
  if (!allowCreatedParents) {
    if (
      workspaceFilesystemTargetIdentityDigest(current) !==
      workspaceFilesystemTargetIdentityDigest(prepared)
    ) {
      throw providerError(
        'stale_preimage',
        'Filesystem mutation parent changed after preparation.',
      );
    }
    return;
  }
  const preparedAncestor = prepared.nearestExistingCanonicalPath;
  let ancestorIdentity: WorkspaceFilesystemStatIdentity;
  try {
    ancestorIdentity = statIdentity(lstatSync(preparedAncestor));
  } catch {
    throw providerError('stale_preimage', 'Prepared filesystem ancestor is unavailable.');
  }
  if (!sameDirectoryObjectIdentity(ancestorIdentity, prepared.nearestExistingNoFollow)) {
    throw providerError('stale_preimage', 'Prepared filesystem ancestor changed before publish.');
  }
  assertNoFollowDirectoryChain(preparedAncestor, dirname(prepared.canonicalPath));
}

function assertNoFollowDirectoryChain(ancestor: string, directory: string): void {
  if (!inside(ancestor, directory)) {
    throw providerError(
      'stale_preimage',
      'Filesystem mutation parent escaped its prepared ancestor.',
    );
  }
  const relativeDirectory = relative(ancestor, directory);
  let cursor = ancestor;
  for (const segment of relativeDirectory === '' ? [] : relativeDirectory.split(sep)) {
    cursor = join(cursor, segment);
    const identity = lstatSync(cursor);
    if (!identity.isDirectory() || identity.isSymbolicLink()) {
      throw providerError('stale_preimage', 'Filesystem mutation directory chain changed.');
    }
  }
}

function statIdentity(stat: Stats): WorkspaceFilesystemStatIdentity {
  return deepFreeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: stat.mode,
    size: stat.size,
    modifiedAtMs: stat.mtimeMs,
    type: stat.isFile()
      ? 'file'
      : stat.isDirectory()
        ? 'directory'
        : stat.isSymbolicLink()
          ? 'symlink'
          : 'other',
  });
}

function stableDirectoryIdentity(
  directory: string,
  admittedRoot: string,
): WorkspaceFilesystemStatIdentity {
  const noFollow = lstatSync(directory);
  if (!noFollow.isDirectory() || noFollow.isSymbolicLink()) {
    throw providerError('path_invalid', 'Filesystem search directory is not a stable directory.');
  }
  const canonical = normalizePathCase(realpathSync(directory));
  if (!inside(normalizePathCase(admittedRoot), canonical)) {
    throw providerError('path_outside_workspace', 'Filesystem search escaped its admitted root.');
  }
  const followed = statSync(canonical);
  const noFollowIdentity = statIdentity(noFollow);
  const followedIdentity = statIdentity(followed);
  if (!sameStatIdentity(noFollowIdentity, followedIdentity)) {
    throw providerError('path_invalid', 'Filesystem search directory identity is unstable.');
  }
  return noFollowIdentity;
}

function stableRegularFilePath(path: string, admittedRoot: string): boolean {
  try {
    const noFollow = lstatSync(path);
    if (!noFollow.isFile() || noFollow.isSymbolicLink()) return false;
    const canonical = normalizePathCase(realpathSync(path));
    if (!inside(normalizePathCase(admittedRoot), canonical)) return false;
    return sameStatIdentity(statIdentity(noFollow), statIdentity(statSync(canonical)));
  } catch {
    return false;
  }
}

function sameStatIdentity(
  left: WorkspaceFilesystemStatIdentity,
  right: WorkspaceFilesystemStatIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.modifiedAtMs === right.modifiedAtMs &&
    left.type === right.type
  );
}

function sameDirectoryObjectIdentity(
  left: WorkspaceFilesystemStatIdentity,
  right: WorkspaceFilesystemStatIdentity,
): boolean {
  return (
    left.type === 'directory' &&
    right.type === 'directory' &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode
  );
}

function decodeText(raw: Buffer): string {
  let content: string;
  let bom = false;
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    bom = true;
    content = raw.toString('utf16le');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  } else if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    bom = true;
    const swapped = Buffer.alloc(raw.length);
    for (let index = 0; index + 1 < raw.length; index += 2) {
      swapped[index] = raw[index + 1]!;
      swapped[index + 1] = raw[index]!;
    }
    content = swapped.toString('utf16le');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  } else {
    content = raw.toString('utf8');
    if (content.charCodeAt(0) === 0xfeff) {
      bom = true;
      content = content.slice(1);
    }
  }
  if (!bom) {
    const sample = Math.min(raw.length, 8_192);
    let nonText = 0;
    for (let index = 0; index < sample; index++) {
      const byte = raw[index]!;
      const text =
        byte === 0x09 ||
        byte === 0x0a ||
        byte === 0x0d ||
        (byte >= 0x20 && byte <= 0x7e) ||
        (byte >= 0x80 && byte <= 0xfd);
      if (!text) nonText++;
    }
    if (nonText > sample * 0.3) throw providerError('binary_file', 'Binary filesystem target.');
  }
  return normalizeEol(content);
}

interface IgnoreRule {
  base: string;
  pattern: RegExp;
  negate: boolean;
  directoryOnly: boolean;
}

function ancestorIgnoreRules(
  workspace: string,
  searchRoot: string,
  boundary: WorkspaceFilesystemProtectedBoundary,
): IgnoreRule[] {
  if (!inside(workspace, searchRoot)) return [];
  const relativeRoot = toPosix(relative(workspace, searchRoot));
  if (relativeRoot === '') return [];
  const segments = relativeRoot.split('/');
  segments.pop();
  const rules: IgnoreRule[] = [];
  let directory = workspace;
  let base = '';
  appendAdmittedIgnoreRules(rules, workspace, directory, base, boundary);
  for (const segment of segments) {
    directory = join(directory, segment);
    base = base === '' ? segment : `${base}/${segment}`;
    appendAdmittedIgnoreRules(rules, workspace, directory, base, boundary);
  }
  return rules;
}

function appendAdmittedIgnoreRules(
  rules: IgnoreRule[],
  workspace: string,
  directory: string,
  base: string,
  boundary: WorkspaceFilesystemProtectedBoundary,
): void {
  const ignorePath = join(directory, '.gitignore');
  const relativePath = toPosix(relative(workspace, ignorePath));
  if (!searchFileMayBeObserved(workspace, ignorePath, relativePath, boundary)) return;
  rules.push(...loadIgnoreRules(workspace, directory, base, boundary));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function loadIgnoreRules(
  workspace: string,
  directory: string,
  base: string,
  boundary: WorkspaceFilesystemProtectedBoundary,
): IgnoreRule[] {
  const ignorePath = join(directory, '.gitignore');
  let lexicalIdentity: WorkspaceFilesystemStatIdentity;
  try {
    const lexical = lstatSync(ignorePath);
    if (!lexical.isFile() || lexical.isSymbolicLink()) {
      throw providerError('path_invalid', 'Filesystem ignore metadata is not a regular file.');
    }
    lexicalIdentity = statIdentity(lexical);
  } catch (error) {
    if (isProviderError(error)) throw error;
    if (isMissingFilesystemEntry(error)) return [];
    throw providerError('path_invalid', 'Filesystem ignore metadata could not be inspected.');
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(ignorePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = statIdentity(fstatSync(descriptor));
    if (before.type !== 'file' || !sameStatIdentity(before, lexicalIdentity)) {
      throw providerError('path_invalid', 'Filesystem ignore metadata identity changed.');
    }
    const canonical = normalizePathCase(realpathSync(ignorePath));
    const relativePath = toPosix(relative(workspace, ignorePath));
    if (
      !inside(workspace, canonical) ||
      !searchFileMayBeObserved(workspace, canonical, relativePath, boundary)
    ) {
      throw providerError(
        'path_outside_workspace',
        'Filesystem ignore metadata escaped its admitted boundary.',
      );
    }
    if (before.size > MAXIMUM_IGNORE_FILE_BYTES) {
      throw providerError(
        'observation_too_large',
        'Filesystem ignore metadata exceeded its bound.',
      );
    }
    const buffer = Buffer.alloc(MAXIMUM_IGNORE_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const read = readSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
      if (read === 0) break;
      offset += read;
    }
    if (offset > MAXIMUM_IGNORE_FILE_BYTES) {
      throw providerError(
        'observation_too_large',
        'Filesystem ignore metadata exceeded its bound.',
      );
    }
    const after = statIdentity(fstatSync(descriptor));
    if (!sameStatIdentity(before, after)) {
      throw providerError('path_invalid', 'Filesystem ignore metadata changed during read.');
    }
    let content = buffer.subarray(0, offset).toString('utf8');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    return content.split(/\r?\n/u).flatMap((line): IgnoreRule[] => {
      const rule = parseIgnoreRule(line, base);
      return rule ? [rule] : [];
    });
  } catch (error) {
    if (isProviderError(error)) throw error;
    throw providerError('path_invalid', 'Filesystem ignore metadata could not be read safely.');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function isMissingFilesystemEntry(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { readonly code?: string }).code === 'ENOENT'
  );
}

function parseIgnoreRule(line: string, base: string): IgnoreRule | null {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  let backslashes = 0;
  for (let index = end - 1; index >= 0 && line[index] === '\\'; index--) backslashes++;
  if (backslashes % 2 === 1 && end < line.length) end++;
  let text = line.slice(0, end);
  if (!text || text.startsWith('#')) return null;
  const negate = text.startsWith('!');
  if (negate) text = text.slice(1);
  const directoryOnly = text.endsWith('/');
  if (directoryOnly) text = text.slice(0, -1);
  if (!text) return null;
  const anchored = text.startsWith('/') || text.includes('/');
  if (text.startsWith('/')) text = text.slice(1);
  const pattern = ignorePatternRegex(text, anchored);
  return pattern ? { base, pattern, negate, directoryOnly } : null;
}

function ignored(path: string, directory: boolean, rules: readonly IgnoreRule[]): boolean {
  let result = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !directory) continue;
    const relativePath = rule.base
      ? path.startsWith(`${rule.base}/`)
        ? path.slice(rule.base.length + 1)
        : null
      : path;
    if (relativePath !== null && rule.pattern.test(relativePath)) result = !rule.negate;
  }
  return result;
}

function matchesFilePattern(path: string, pattern: string): boolean {
  const normalized = toPosix(pattern || '*');
  return filePatternRegex(normalized).test(normalized.includes('/') ? path : basename(path));
}

function ignorePatternRegex(pattern: string, anchored: boolean): RegExp | null {
  let body = '';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    const previous = pattern[index - 1];
    const next = pattern[index + 1];
    if (character === '*' && pattern[index + 1] === '*') {
      const after = pattern[index + 2];
      const atSegmentStart = previous === undefined || previous === '/';
      if (atSegmentStart && after === '/') {
        body += '(?:.*/)?';
        index += 2;
      } else if (atSegmentStart && after === undefined) {
        body += '.*';
        index++;
      } else {
        body += '[^/]*[^/]*';
        index++;
      }
    } else if (character === '*') body += '[^/]*';
    else if (character === '?') body += '[^/]';
    else if (character === '[') {
      const parsed = parseCharacterClass(pattern, index);
      if (!parsed) return null;
      body += parsed.negated ? `(?:(?![${parsed.body}])[^/])` : `[${parsed.body}]`;
      index = parsed.end;
    } else if (character === '\\') {
      if (next === undefined) return null;
      body += escapeRegex(next);
      index++;
    } else body += escapeRegex(character);
  }
  try {
    return new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`, 'u');
  } catch {
    return null;
  }
}

interface ParsedCharacterClass {
  body: string;
  negated: boolean;
  end: number;
}

function parseCharacterClass(pattern: string, start: number): ParsedCharacterClass | null {
  let index = start + 1;
  let negated = false;
  if (pattern[index] === '!') {
    negated = true;
    index++;
  }
  let body = '';
  let first = true;
  for (; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === ']' && !first) return { body, negated, end: index };
    first = false;
    if (character === '\\' && pattern[index + 1] !== undefined) {
      body += escapeRegex(pattern[index + 1]!);
      index++;
    } else if (character !== '/') {
      body +=
        character === ']' || character === '\\' || character === '^' ? `\\${character}` : character;
    }
  }
  return null;
}

function filePatternRegex(pattern: string): RegExp {
  let body = '^';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    const next = pattern[index + 1];
    if (character === '*') {
      if (next === '*') {
        body += '.*';
        index++;
      } else body += '[^/]*';
    } else if (character === '?') body += '[^/]';
    else if (character === '{') {
      const close = pattern.indexOf('}', index + 1);
      if (close === -1) body += '\\{';
      else {
        const alternatives = pattern
          .slice(index + 1, close)
          .split(',')
          .map(escapeRegex)
          .join('|');
        body += `(?:${alternatives})`;
        index = close;
      }
    } else body += escapeRegex(character);
  }
  return new RegExp(`${body}$`, 'u');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function sourceLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function normalizeEol(content: string): string {
  return content.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
}

function lineCount(content: string): number {
  return content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
}

function inside(workspace: string, target: string): boolean {
  const path = relative(workspace, target);
  return (
    path === '' || (!!path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

function existsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function normalizePathCase(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function assertBound(content: string, maximum: number): void {
  if (Buffer.byteLength(content) > maximum) {
    throw providerError('observation_too_large', 'Filesystem observation exceeded its bound.');
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw providerError('cancelled', 'Filesystem operation was cancelled.');
}

interface ProviderError extends Error {
  readonly providerCode: WorkspaceFilesystemProviderFailureCode;
}

function providerError(
  code: WorkspaceFilesystemProviderFailureCode,
  message: string,
): ProviderError {
  const error = new Error(message) as ProviderError;
  Object.defineProperty(error, 'providerCode', { value: code, enumerable: true });
  return error;
}

function isProviderError(
  error: unknown,
  code?: WorkspaceFilesystemProviderFailureCode,
): error is ProviderError {
  return (
    error instanceof Error &&
    'providerCode' in error &&
    (code === undefined || (error as ProviderError).providerCode === code)
  );
}

function failureFrom<Observation>(error: unknown): WorkspaceFilesystemProviderResult<Observation> {
  if (error instanceof WorkspaceFilesystemGrantError) {
    return deepFreeze({ ok: false, failure: { code: error.code, message: error.message } });
  }
  if (isProviderError(error)) {
    return deepFreeze({
      ok: false,
      failure: { code: error.providerCode, message: error.message },
    });
  }
  return deepFreeze({
    ok: false,
    failure: { code: 'operation_failed', message: 'Workspace filesystem operation failed.' },
  });
}

function success<Observation>(
  observation: Observation,
): WorkspaceFilesystemProviderResult<Observation> {
  return deepFreeze({ ok: true, observation });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}.`);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
