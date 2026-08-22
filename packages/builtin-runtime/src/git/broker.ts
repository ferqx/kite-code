import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  GitBrokerFailureCodeV1,
  GitBrokerResultV1,
  GitCapabilityEvidenceV1,
  GitInspectRequestV1,
  GitInvocationReceiptV1,
  GitShellDenyEvidenceV1,
} from '@kite/runtime-spi';
import {
  BROKERED_GIT_FEATURE_REVISION_V1,
  GIT_BROKER_REVISION_V1,
  GIT_OPERATION_SCHEMA_REVISION_V1,
} from '@kite/runtime-spi';
import { qualifyBrokeredGitNativeDenyV1 } from './qualification';

export interface BuiltinProtectedPathEvaluatorV1 {
  evaluate(access: Readonly<{ path: string; operation: 'read' | 'write' | 'execute' }>): Readonly<{
    outcome: 'allow' | 'deny' | 'prompt';
  }>;
}

const MAX_PATHS = 128;
const MAX_STATUS_PATHS = 2_048;
const MAX_PATH_LENGTH = 512;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const REVISION_PATTERN = /^(?:HEAD|[0-9a-f]{7,40}|refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+)$/;
const PROTECTED_SEGMENTS = new Set([
  '.git',
  '.agents',
  '.codex',
  '.env',
  '.ssh',
  '.aws',
  '.gnupg',
  '.gitmodules',
  '.git-credentials',
]);

export interface GitProcessRequestV1 {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  /** Hard adapter-side ceilings. The adapter must stop the process on overflow. */
  maxStdoutBytes: number;
  maxStderrBytes: number;
  signal?: AbortSignal;
}

export interface GitProcessResultV1 {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  cancelled?: boolean;
  cleanupConfirmed?: boolean;
  adapterErrorCode?: 'spawn_failed' | 'io_failed' | 'cleanup_unconfirmed' | 'output_limit_exceeded';
}

/** Canonical revision grammar shared by Provider schema, Registry and broker. */
export function isGitRevisionV1(value: string): boolean {
  return REVISION_PATTERN.test(value);
}

export interface GitProcessAdapterV1 {
  run(request: GitProcessRequestV1): Promise<GitProcessResultV1>;
}

export interface GitBrokerV1 {
  readonly featureRevision: typeof BROKERED_GIT_FEATURE_REVISION_V1;
  inspect(request: GitInspectRequestV1, signal?: AbortSignal): Promise<GitBrokerResultV1>;
}

interface RepositoryBinding {
  workspace: string;
  gitDir: string;
  commonDir: string;
  repositoryBinding: string;
  executable: string;
  executableIdentity: string;
}

function failure(
  failureCode: GitBrokerFailureCodeV1,
  output: string,
  nextCapability?: GitBrokerResultV1['nextCapability'],
): GitBrokerResultV1 {
  return { ok: false, output, failureCode, ...(nextCapability ? { nextCapability } : {}) };
}

function preflightFailureCode(message: string): GitBrokerFailureCodeV1 {
  if (message.startsWith('binary_')) return 'binary_untrusted';
  if (
    message.startsWith('hostile_') ||
    message === 'replace_refs' ||
    message === 'grafts' ||
    message === 'alternates'
  ) {
    return 'repository_hostile';
  }
  if (
    message.includes('gitdir') ||
    message.includes('repository_') ||
    message.includes('common_dir') ||
    message.includes('metadata_') ||
    message.includes('linked_worktree') ||
    message.includes('index_') ||
    message === 'head_invalid'
  ) {
    return 'repository_invalid';
  }
  return 'git_operation_unsupported';
}

function digest(label: string, value: string): string {
  return `sha256:${createHash('sha256').update(label).update('\0').update(value).digest('hex')}`;
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function isProtectedRelativePath(path: string): boolean {
  return path
    .split(/[\\/]+/)
    .filter(Boolean)
    .some(
      (segment) => PROTECTED_SEGMENTS.has(segment.toLowerCase()) || /^\.env(?:\.|$)/i.test(segment),
    );
}

function isLiteralGitPath(path: string): boolean {
  return (
    !path.startsWith(':') &&
    ![...path].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    }) &&
    !/[*?[\]{}]/u.test(path) &&
    !path.includes('\\')
  );
}

function validatePaths(
  workspace: string,
  paths: readonly string[],
  evaluator: BuiltinProtectedPathEvaluatorV1,
): string[] {
  if (paths.length < 1 || paths.length > MAX_PATHS) throw new Error('path_count');
  const normalized = paths.map((path) => {
    if (
      !path ||
      path.length > MAX_PATH_LENGTH ||
      path.includes('\0') ||
      isAbsolute(path) ||
      !isLiteralGitPath(path)
    ) {
      throw new Error('path_invalid');
    }
    const absolute = resolve(workspace, path);
    if (!pathInside(workspace, absolute)) throw new Error('path_outside');
    const relativePath = relative(workspace, absolute).replaceAll(sep, '/');
    if (
      !relativePath ||
      relativePath === '.' ||
      isProtectedRelativePath(relativePath) ||
      evaluator.evaluate({ path: relativePath, operation: 'read' }).outcome !== 'allow'
    ) {
      throw new Error('path_protected');
    }
    return relativePath;
  });
  return [...new Set(normalized)].sort();
}

function enumerateSafeWorkspacePaths(
  workspace: string,
  evaluator: BuiltinProtectedPathEvaluatorV1,
  maximum = MAX_STATUS_PATHS,
): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const rel = relative(workspace, absolute).replaceAll(sep, '/');
      if (
        isProtectedRelativePath(rel) ||
        evaluator.evaluate({ path: rel, operation: 'read' }).outcome !== 'allow'
      ) {
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) result.push(rel);
      if (result.length > maximum) throw new Error('workspace_inventory_too_large');
    }
  };
  visit(workspace);
  return result.sort();
}

function readIndexPaths(indexPath: string): string[] {
  if (!existsSync(indexPath)) return [];
  const stat = lstatSync(indexPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('index_invalid');
  const bytes = readFileSync(indexPath);
  if (bytes.length < 12 || bytes.subarray(0, 4).toString('ascii') !== 'DIRC') {
    throw new Error('index_invalid');
  }
  const version = bytes.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('index_version_unsupported');
  const count = bytes.readUInt32BE(8);
  if (count > MAX_STATUS_PATHS * 4) throw new Error('index_too_large');
  let offset = 12;
  const paths = new Set<string>();
  for (let index = 0; index < count; index++) {
    const entryStart = offset;
    if (offset + 62 > bytes.length) throw new Error('index_invalid');
    const flags = bytes.readUInt16BE(offset + 60);
    offset += 62;
    const declaredLength = flags & 0x0fff;
    let end = offset;
    while (end < bytes.length && bytes[end] !== 0) end += 1;
    if (end >= bytes.length) throw new Error('index_invalid');
    const pathBytes = bytes.subarray(offset, end);
    if (declaredLength !== 0x0fff && declaredLength !== pathBytes.length) {
      throw new Error('index_invalid');
    }
    const path = pathBytes.toString('utf8');
    if (Buffer.from(path, 'utf8').compare(pathBytes) !== 0) throw new Error('index_invalid');
    paths.add(path);
    const entryLength = end + 1 - entryStart;
    offset = entryStart + entryLength + ((8 - (entryLength % 8)) % 8);
  }
  return [...paths].sort();
}

function assertRegularMetadataFile(path: string, optional = true): void {
  if (!existsSync(path)) {
    if (optional) return;
    throw new Error('metadata_missing');
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('metadata_symlink');
}

function assertNoSymlinkPath(root: string, target: string): void {
  if (!pathInside(root, target)) throw new Error('metadata_outside');
  const rel = relative(root, target);
  let cursor = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('metadata_symlink');
  }
}

function assertSafeMetadataFile(root: string, path: string, optional = true): void {
  assertNoSymlinkPath(root, path);
  assertRegularMetadataFile(path, optional);
}

function assertMetadataTree(gitDir: string, commonDir: string): void {
  for (const file of [
    join(commonDir, 'config'),
    join(gitDir, 'config.worktree'),
    join(gitDir, 'HEAD'),
    join(gitDir, 'index'),
    join(commonDir, 'packed-refs'),
    join(commonDir, 'info', 'alternates'),
    join(commonDir, 'objects', 'info', 'alternates'),
  ]) {
    assertSafeMetadataFile(pathInside(gitDir, file) ? gitDir : commonDir, file);
  }
  for (const directory of [join(commonDir, 'objects'), join(commonDir, 'refs')]) {
    if (!existsSync(directory)) continue;
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('metadata_symlink');
  }
  for (const alternates of [
    join(commonDir, 'info', 'alternates'),
    join(commonDir, 'objects', 'info', 'alternates'),
  ]) {
    if (existsSync(alternates) && readFileSync(alternates, 'utf8').trim() !== '') {
      throw new Error('alternates');
    }
  }
}

function readGitDirectory(
  workspace: string,
  authorizedRepositoryRoot: string,
): { gitDir: string; commonDir: string } {
  const marker = join(workspace, '.git');
  const markerStat = lstatSync(marker);
  let gitDir: string;
  let linked = false;
  if (markerStat.isDirectory() && !markerStat.isSymbolicLink()) {
    gitDir = realpathSync.native(marker);
    if (gitDir !== realpathSync.native(join(workspace, '.git'))) throw new Error('gitdir_invalid');
  } else if (markerStat.isFile() && !markerStat.isSymbolicLink()) {
    linked = true;
    const match = /^gitdir:\s*(.+)\s*$/i.exec(readFileSync(marker, 'utf8'));
    if (!match?.[1]) throw new Error('gitdir_file_invalid');
    gitDir = realpathSync.native(resolve(workspace, match[1]));
  } else {
    throw new Error('gitdir_invalid');
  }
  const authorizedMarker = join(authorizedRepositoryRoot, '.git');
  const authorizedMarkerStat = lstatSync(authorizedMarker);
  if (!authorizedMarkerStat.isDirectory() || authorizedMarkerStat.isSymbolicLink()) {
    throw new Error('repository_authority_mismatch');
  }
  const authorizedCommonDir = realpathSync.native(authorizedMarker);
  // Reject an arbitrary external gitfile before opening any file beneath its
  // target. An admitted linked worktree must live under the authorized
  // primary repository's own worktrees metadata namespace.
  if (linked && !pathInside(join(authorizedCommonDir, 'worktrees'), gitDir)) {
    throw new Error('linked_worktree_outside_authority');
  }
  if (!statSync(gitDir).isDirectory()) throw new Error('gitdir_invalid');
  const commonDirFile = join(gitDir, 'commondir');
  assertRegularMetadataFile(commonDirFile);
  const commonDir = existsSync(commonDirFile)
    ? realpathSync.native(resolve(gitDir, readFileSync(commonDirFile, 'utf8').trim()))
    : gitDir;
  if (!statSync(commonDir).isDirectory()) throw new Error('common_dir_invalid');
  if (linked) {
    if (commonDir !== authorizedCommonDir || !pathInside(join(commonDir, 'worktrees'), gitDir)) {
      throw new Error('linked_worktree_outside_authority');
    }
    const backlink = join(gitDir, 'gitdir');
    assertRegularMetadataFile(backlink, false);
    const backlinkTarget = resolve(dirname(backlink), readFileSync(backlink, 'utf8').trim());
    if (resolve(backlinkTarget) !== resolve(marker)) throw new Error('linked_worktree_backlink');
  } else if (workspace !== authorizedRepositoryRoot || commonDir !== gitDir) {
    throw new Error('repository_authority_mismatch');
  }
  assertMetadataTree(gitDir, commonDir);
  return { gitDir, commonDir };
}

function hasHostileGitConfig(content: string): boolean {
  let section = '';
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = /^\[\s*([^\s\]"]+)/u.exec(line);
    if (sectionMatch?.[1]) {
      section = sectionMatch[1].toLowerCase();
      if (
        [
          'include',
          'includeif',
          'alias',
          'filter',
          'credential',
          'url',
          'protocol',
          'remote',
          'submodule',
          'http',
          'https',
          'ssh',
          'gpg',
        ].includes(section)
      )
        return true;
      continue;
    }
    const keyMatch = /^([^=\s]+)\s*=\s*(.*)$/u.exec(line);
    if (!keyMatch?.[1]) continue;
    const key = keyMatch[1].toLowerCase();
    const value = keyMatch[2]?.trim().toLowerCase() ?? '';
    const qualifiedKey = key.includes('.') || !section ? key : `${section}.${key}`;
    if (
      /^(?:include\.|includeif\.|alias\.|filter\.|credential\.|url\.|protocol\.|remote\.|submodule\.|https?\.|ssh\.|gpg\.)/u.test(
        qualifiedKey,
      ) ||
      /^core\.(?:attributesfile|excludesfile|fscache|fsmonitor|hookspath|sshcommand|pager|editor|askpass)$/u.test(
        qualifiedKey,
      ) ||
      qualifiedKey === 'core.worktree' ||
      (qualifiedKey === 'core.bare' && value !== 'false') ||
      /^diff\.(?:external|[^.]+\.(?:command|textconv))$/u.test(qualifiedKey) ||
      /^merge\.[^.]+\.driver$/u.test(qualifiedKey)
    ) {
      return true;
    }
  }
  return false;
}

function assertBenignMetadata(gitDir: string, commonDir: string, workspace: string): void {
  const configFiles = [...new Set([join(commonDir, 'config'), join(gitDir, 'config.worktree')])];
  for (const file of configFiles) {
    if (existsSync(file) && hasHostileGitConfig(readFileSync(file, 'utf8'))) {
      throw new Error('hostile_config');
    }
  }
  for (const attributes of [
    join(workspace, '.gitattributes'),
    join(commonDir, 'info', 'attributes'),
  ]) {
    assertNoSymlinkPath(pathInside(workspace, attributes) ? workspace : commonDir, attributes);
    if (existsSync(attributes) && readFileSync(attributes, 'utf8').trim() !== '') {
      throw new Error('hostile_attributes');
    }
  }
  const replace = join(commonDir, 'refs', 'replace');
  assertNoSymlinkPath(commonDir, replace);
  if (existsSync(replace) && readdirSync(replace).length > 0) throw new Error('replace_refs');
  const grafts = join(commonDir, 'info', 'grafts');
  assertNoSymlinkPath(commonDir, grafts);
  if (existsSync(grafts) && readFileSync(grafts, 'utf8').trim() !== '') throw new Error('grafts');
  const packedRefs = join(commonDir, 'packed-refs');
  assertNoSymlinkPath(commonDir, packedRefs);
  if (
    existsSync(packedRefs) &&
    readFileSync(packedRefs, 'utf8')
      .split(/\r?\n/u)
      .some((line) => /^[a-f0-9]{40,64}\s+refs\/replace\//u.test(line.trim()))
  ) {
    throw new Error('replace_refs');
  }
}

function executableIdentity(
  executable: string,
  workspace: string,
): { path: string; identity: string } {
  const path = realpathSync.native(resolve(executable));
  if (pathInside(workspace, path)) throw new Error('binary_inside_workspace');
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o022) !== 0) throw new Error('binary_permissions');
  if (typeof process.getuid === 'function' && stat.uid !== 0 && stat.uid !== process.getuid()) {
    throw new Error('binary_owner');
  }
  return {
    path,
    identity: digest(
      'kite.git.binary.v1',
      JSON.stringify({
        path,
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      }),
    ),
  };
}

function bindRepository(
  workspaceInput: string,
  executableInput: string,
  authorizedRepositoryRootInput: string,
): RepositoryBinding {
  const workspace = realpathSync.native(resolve(workspaceInput));
  const authorizedRepositoryRoot = realpathSync.native(resolve(authorizedRepositoryRootInput));
  const { gitDir, commonDir } = readGitDirectory(workspace, authorizedRepositoryRoot);
  assertBenignMetadata(gitDir, commonDir, workspace);
  const executable = executableIdentity(executableInput, workspace);
  return {
    workspace,
    gitDir,
    commonDir,
    executable: executable.path,
    executableIdentity: executable.identity,
    repositoryBinding: digest(
      'kite.git.repository.v1',
      JSON.stringify({ workspace, gitDir, commonDir }),
    ),
  };
}

function gitEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze({
    HOME: '/nonexistent',
    XDG_CONFIG_HOME: '/nonexistent',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    GIT_SSH_COMMAND: '/bin/false',
    GIT_PAGER: 'cat',
    GIT_EXTERNAL_DIFF: '',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    LANG: 'C',
  });
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error('bound_invalid');
  return value;
}

function truncateOutput(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.byteLength <= maxBytes) return value;
  const suffix = '\n[truncated]';
  const suffixBytes = Buffer.byteLength(suffix);
  if (maxBytes <= suffixBytes) return suffix.slice(0, maxBytes);
  let end = maxBytes - suffixBytes;
  while (end > 0) {
    try {
      return `${new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end))}${suffix}`;
    } catch {
      end -= 1;
    }
  }
  return suffix.slice(0, maxBytes);
}

function limitStatusRecords(value: string, maximum: number): string {
  const fields = value.split('\0');
  const selected: string[] = [];
  let records = 0;
  for (let index = 0; index < fields.length && records < maximum; index++) {
    const field = fields[index];
    if (!field) continue;
    selected.push(field);
    records += 1;
    const code = field.slice(0, 2);
    if ((code.includes('R') || code.includes('C')) && fields[index + 1]) {
      selected.push(fields[++index]!);
    }
  }
  return selected.length > 0 ? `${selected.join('\0')}\0` : '';
}

function fixedRepositoryArgs(binding: RepositoryBinding, args: readonly string[]): string[] {
  return [
    `--git-dir=${binding.gitDir}`,
    `--work-tree=${binding.workspace}`,
    '--literal-pathspecs',
    ...args,
  ];
}

async function assertDiffHistoryIsSafe(
  binding: RepositoryBinding,
  adapter: GitProcessAdapterV1,
  paths: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const run = async (args: readonly string[]) => {
    if (signal?.aborted) throw new Error('cancelled');
    const result = await adapter.run({
      executable: binding.executable,
      args: fixedRepositoryArgs(binding, args),
      cwd: binding.workspace,
      env: gitEnvironment(),
      timeoutMs,
      maxStdoutBytes: MAX_OUTPUT_BYTES,
      maxStderrBytes: DEFAULT_OUTPUT_BYTES,
      signal,
    });
    if (signal?.aborted) throw new Error('cancelled');
    if (result.adapterErrorCode === 'output_limit_exceeded') throw new Error('history_unbounded');
    if (result.exitCode !== 0 || result.timedOut || result.cancelled)
      throw new Error('history_unproven');
    return result.stdout;
  };
  const objects = await run(['rev-list', '--objects', '--all']);
  const protectedObjects = new Set<string>();
  const requestedObjects = new Set<string>();
  for (const line of objects.split('\n')) {
    const separator = line.indexOf(' ');
    if (separator < 1) continue;
    const objectId = line.slice(0, separator);
    const path = line.slice(separator + 1);
    if (isProtectedRelativePath(path)) protectedObjects.add(objectId);
    if (paths.includes(path)) requestedObjects.add(objectId);
  }
  if ([...requestedObjects].some((objectId) => protectedObjects.has(objectId))) {
    throw new Error('history_protected');
  }
  for (const path of paths) {
    const history = await run([
      'log',
      '--follow',
      '--find-renames',
      '--find-copies',
      '--format=',
      '--name-status',
      '--',
      path,
    ]);
    for (const field of history.split(/[\t\r\n]+/u)) {
      if (field && !/^[ACDMRTUXB][0-9]*$/u.test(field) && isProtectedRelativePath(field)) {
        throw new Error('history_protected');
      }
    }
  }
}

export function createGitBrokerV1(input: {
  workspace: string;
  /** Root that owns the primary repository metadata; defaults to workspace. */
  authorizedRepositoryRoot?: string;
  executable: string;
  processAdapter: GitProcessAdapterV1;
  protectedPathEvaluator: BuiltinProtectedPathEvaluatorV1;
  featureRevision?: typeof BROKERED_GIT_FEATURE_REVISION_V1;
  shellDenyEvidence?: GitShellDenyEvidenceV1;
}): GitBrokerV1 {
  const featureRevision = input.featureRevision ?? BROKERED_GIT_FEATURE_REVISION_V1;
  const authorizedRepositoryRoot = input.authorizedRepositoryRoot ?? input.workspace;

  const denyEvidenceIdentity = (): string | undefined => {
    const evidence = input.shellDenyEvidence;
    if (
      !evidence ||
      evidence.featureRevision !== featureRevision ||
      evidence.platform !== process.platform
    ) {
      return undefined;
    }
    if (qualifyBrokeredGitNativeDenyV1(evidence).outcome !== 'qualified') return undefined;
    return digest('kite.git.native-deny.v1', JSON.stringify(evidence));
  };

  const invoke = async (request: {
    operation: GitInvocationReceiptV1['operation'];
    args: readonly string[];
    maxOutputBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    maxRecords?: number;
  }): Promise<GitBrokerResultV1> => {
    if (request.signal?.aborted) {
      return failure('cancelled', 'Git broker invocation cancelled before dispatch.');
    }
    const nativeDenyEvidenceIdentity = denyEvidenceIdentity();
    if (!nativeDenyEvidenceIdentity) {
      return failure(
        'sandbox_capability_missing',
        'Brokered Git is excluded because native shell metadata read/write denial is not qualified.',
      );
    }
    let before: RepositoryBinding;
    try {
      before = bindRepository(input.workspace, input.executable, authorizedRepositoryRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'repository preflight failed';
      const code = preflightFailureCode(message);
      return failure(code, `Git broker denied before dispatch (${message}).`);
    }
    if (existsSync(join(before.gitDir, 'index.lock'))) {
      return failure('lock', 'Git broker denied because index.lock is present.');
    }
    const timeoutMs = boundedInteger(request.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    let dispatchBinding: RepositoryBinding;
    try {
      dispatchBinding = bindRepository(input.workspace, input.executable, authorizedRepositoryRoot);
    } catch {
      return failure('receipt_invalid', 'Git broker identity changed before dispatch.');
    }
    if (
      before.repositoryBinding !== dispatchBinding.repositoryBinding ||
      before.executableIdentity !== dispatchBinding.executableIdentity
    ) {
      return failure('receipt_invalid', 'Git broker identity changed before dispatch.');
    }
    if (request.signal?.aborted) {
      return failure('cancelled', 'Git broker invocation cancelled before dispatch.');
    }
    const startedAtMs = Date.now();
    const maxOutput = boundedInteger(
      request.maxOutputBytes,
      DEFAULT_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES,
    );
    let processResult: GitProcessResultV1;
    try {
      processResult = await input.processAdapter.run({
        executable: before.executable,
        args: fixedRepositoryArgs(before, request.args),
        cwd: before.workspace,
        env: gitEnvironment(),
        timeoutMs,
        maxStdoutBytes: maxOutput,
        maxStderrBytes: maxOutput,
        signal: request.signal,
      });
    } catch {
      return failure(
        request.signal?.aborted ? 'cancelled' : 'process_failed',
        request.signal?.aborted
          ? 'Git broker invocation cancelled.'
          : 'Git process adapter failed.',
      );
    }
    const finishedAtMs = Date.now();
    let after: RepositoryBinding;
    try {
      after = bindRepository(input.workspace, input.executable, authorizedRepositoryRoot);
    } catch {
      return failure('receipt_invalid', 'Git broker identity changed during invocation.');
    }
    if (
      before.repositoryBinding !== after.repositoryBinding ||
      before.executableIdentity !== after.executableIdentity
    ) {
      return failure('receipt_invalid', 'Git broker identity changed during invocation.');
    }
    const evidence: GitCapabilityEvidenceV1 = {
      featureRevision,
      brokerRevision: GIT_BROKER_REVISION_V1,
      operationSchemaRevision: GIT_OPERATION_SCHEMA_REVISION_V1,
      repositoryBinding: before.repositoryBinding,
      executableIdentity: before.executableIdentity,
      nativeDenyEvidenceIdentity,
    };
    const receipt: GitInvocationReceiptV1 = {
      ...evidence,
      invocationId: randomUUID(),
      operation: request.operation,
      effect: 'git_inspect',
      startedAtMs,
      finishedAtMs,
      exitCode: processResult.exitCode,
    };
    const rawOutput =
      processResult.exitCode === 0
        ? processResult.stdout
        : processResult.stderr || processResult.stdout;
    const output = truncateOutput(
      request.operation === 'status' && request.maxRecords
        ? limitStatusRecords(rawOutput, request.maxRecords)
        : rawOutput,
      maxOutput,
    );
    if (
      processResult.cleanupConfirmed === false ||
      processResult.adapterErrorCode === 'cleanup_unconfirmed'
    ) {
      return {
        ...failure('receipt_invalid', 'Git process cleanup could not be confirmed.'),
        receipt,
      };
    }
    if (processResult.adapterErrorCode === 'output_limit_exceeded') {
      return {
        ...failure('process_failed', 'Git process output exceeded its byte ceiling.'),
        receipt,
      };
    }
    if (processResult.cancelled || request.signal?.aborted) {
      return { ...failure('cancelled', 'Git broker invocation cancelled.'), receipt };
    }
    if (processResult.timedOut) {
      return { ...failure('timed_out', 'Git broker invocation timed out.'), receipt };
    }
    if (processResult.exitCode !== 0) {
      return {
        ...failure('process_failed', 'Git broker process failed.'),
        receipt,
      };
    }
    return { ok: true, output, receipt };
  };

  return {
    featureRevision,
    async inspect(request, signal) {
      if (signal?.aborted) {
        return failure('cancelled', 'Git broker invocation cancelled before preflight.');
      }
      let paths: string[];
      let maxRecords: number;
      try {
        const workspace = realpathSync.native(resolve(input.workspace));
        if (!denyEvidenceIdentity()) throw new Error('sandbox_capability_missing');
        const binding = bindRepository(input.workspace, input.executable, authorizedRepositoryRoot);
        paths = request.paths
          ? validatePaths(workspace, request.paths, input.protectedPathEvaluator)
          : request.operation === 'status'
            ? [
                ...new Set([
                  ...readIndexPaths(join(binding.gitDir, 'index')),
                  ...enumerateSafeWorkspacePaths(
                    workspace,
                    input.protectedPathEvaluator,
                    MAX_STATUS_PATHS,
                  ),
                ]),
              ]
                .filter(
                  (path) =>
                    isLiteralGitPath(path) &&
                    !isProtectedRelativePath(path) &&
                    input.protectedPathEvaluator.evaluate({ path, operation: 'read' }).outcome ===
                      'allow',
                )
                .sort()
            : [];
        maxRecords = boundedInteger(request.maxRecords, 50, 200);
        boundedInteger(request.maxOutputBytes, DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
        boundedInteger(request.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
        if (request.operation !== 'branch_list' && paths.length === 0)
          throw new Error('paths_required');
        if (request.revision && !isGitRevisionV1(request.revision)) throw new Error('revision');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'invalid request';
        return failure(
          message.includes('protected') || message.includes('path_invalid')
            ? 'protected_path_denied'
            : message === 'sandbox_capability_missing'
              ? 'sandbox_capability_missing'
              : preflightFailureCode(message),
          `Git inspect request denied (${message}).`,
          'git_inspect',
        );
      }
      const pathspec = paths.length > 0 ? ['--', ...paths] : [];
      if (request.operation === 'diff') {
        try {
          const binding = bindRepository(
            input.workspace,
            input.executable,
            authorizedRepositoryRoot,
          );
          await assertDiffHistoryIsSafe(
            binding,
            input.processAdapter,
            paths,
            boundedInteger(request.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
            signal,
          );
        } catch (error) {
          return failure(
            error instanceof Error && error.message === 'cancelled'
              ? 'cancelled'
              : 'protected_path_denied',
            'Git diff denied because safe historical provenance could not be proven.',
            'git_inspect',
          );
        }
      }
      const args =
        request.operation === 'status'
          ? ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...pathspec]
          : request.operation === 'diff'
            ? ['diff', '--no-ext-diff', '--no-textconv', '--patch', ...pathspec]
            : request.operation === 'log'
              ? [
                  'log',
                  `--max-count=${maxRecords}`,
                  '--no-decorate',
                  // Commit subjects are arbitrary repository text and cannot be
                  // proven free of protected names/content. Keep log metadata-only.
                  '--format=%H%x09%ct',
                  request.revision ?? 'HEAD',
                  ...pathspec,
                ]
              : [
                  'for-each-ref',
                  `--count=${maxRecords}`,
                  '--format=%(refname:short)%09%(objectname)',
                  'refs/heads',
                ];
      return invoke({
        operation: request.operation,
        args,
        maxOutputBytes: request.maxOutputBytes,
        timeoutMs: request.timeoutMs,
        signal,
        maxRecords,
      });
    },
  };
}
