import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import type { AuthorizationRequest, ToolContext } from '../extensions';
import { AgentError, type Json } from '../storage/types';
import { createWorkspaceFiles, type WorkspaceFiles } from '../tools/files';
import { dispatchScopeLeaves } from './dispatch-scope';
import type { CapabilityDescription } from './index';

export const pathFileToolIds = ['files.read_path', 'files.write_path', 'files.edit_path'] as const;
export interface PathFileBoundary {
  /** Actual packaged backend qualifications selected by trusted assembly, never Model input. */
  readonly qualifiedPlatforms: readonly NodeJS.Platform[];
  /** Private profile, credentials and runtime control assets, denied even in Full mode. */
  readonly protectedRoots: readonly string[];
}
export interface PathFileTarget {
  path: string;
  root: string;
  name: string;
  revision: string;
  identity: { device: string; inode: string } | null;
}
const within = (target: string, root: string) =>
  target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
function guardedPath(value: Json, boundary: PathFileBoundary, write: boolean) {
  if (!boundary.qualifiedPlatforms.includes(process.platform))
    throw new AgentError('file_platform_unqualified');
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AgentError('file_input_invalid');
  const path = value.path;
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path.length > 4096 ||
    path.includes('\0') ||
    Buffer.from(path).toString('utf8') !== path ||
    dirname(path) === path ||
    (process.platform !== 'win32' && path.includes('\\'))
  )
    throw new AgentError('file_path_invalid');
  const normalized = (value: string) =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  if (boundary.protectedRoots.some((root) => within(normalized(path), normalized(resolve(root)))))
    throw new AgentError('file_path_protected');
  // Text tools never modify OS/runtime installation objects. Full mode keeps this hard floor.
  const systemRoots =
    process.platform === 'win32'
      ? [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(
          (p): p is string => !!p,
        )
      : [
          '/System',
          '/Library',
          '/usr',
          '/bin',
          '/sbin',
          '/etc',
          '/private/etc',
          '/private/var/db',
          '/private/var/root',
          '/Applications',
          '/dev',
          '/proc',
          '/sys',
          '/boot',
        ];
  if (
    (write ? systemRoots : ['/dev', '/proc', '/sys']).some((root) =>
      within(normalized(path), normalized(resolve(root))),
    )
  )
    throw new AgentError('file_system_target_denied');
  return path;
}
/** Classify with the same native identities used by actual file baselines, never Node stat IDs. */
export async function inspectPathFileTarget(
  definitionId: string,
  input: Json,
  boundary: PathFileBoundary,
  /** Actual dispatch can recheck its already anchored parent rather than reopen the path. */
  anchoredFiles?: WorkspaceFiles,
): Promise<PathFileTarget> {
  if (!pathFileToolIds.includes(definitionId as (typeof pathFileToolIds)[number]))
    throw new AgentError('file_input_invalid');
  const path = guardedPath(input, boundary, definitionId !== 'files.read_path');
  const root = dirname(path);
  const files = anchoredFiles ?? createWorkspaceFiles({ root, strictReads: true });
  try {
    const { parent, file: identity } = await files.inspectIdentity(basename(path));
    const revision = createHash('sha256')
      .update(
        JSON.stringify({
          namespace: 'builtin.files.path',
          version: 1,
          definitionId,
          input,
          root: { path: root, ...parent },
          identity,
          boundary,
        }),
      )
      .digest('hex');
    return { path, root, name: basename(path), identity, revision: `path-files:1:${revision}` };
  } finally {
    if (!anchoredFiles) await files.close();
  }
}
export async function describePathFileRequest(
  request: AuthorizationRequest,
  boundary: PathFileBoundary,
): Promise<CapabilityDescription | null> {
  if (
    request.kind !== 'tool' ||
    !pathFileToolIds.includes(request.definitionId as (typeof pathFileToolIds)[number])
  )
    return null;
  const identity = {
    kind: request.kind,
    definitionId: request.definitionId,
    definitionVersion: request.definitionVersion,
  };
  try {
    if (request.definitionVersion !== (request.definitionId === 'files.read_path' ? '2' : '1'))
      throw new AgentError('file_input_invalid');
    const target = await inspectPathFileTarget(request.definitionId, request.input, boundary);
    request.signal.throwIfAborted();
    const read = request.definitionId === 'files.read_path';
    return {
      ...identity,
      revision: target.revision,
      effects: [read ? 'read' : 'external'],
      safeRead: read,
      hardAllowed: true,
    };
  } catch (error) {
    request.signal.throwIfAborted();
    return {
      ...identity,
      revision: 'path-files:unavailable',
      effects: ['external'],
      safeRead: false,
      hardAllowed: false,
      denialReason: error instanceof AgentError ? error.code : 'file_target_unavailable',
    };
  }
}
/** Accepted final dispatch metadata is evidence, never an independent grant or user-input token. */
export function verifyPathFileDispatch(
  context: ToolContext,
  definitionId: string,
  revision: string,
) {
  const authorization = context.dispatchAuthorization;
  if (!authorization?.revision) throw new AgentError('file_dispatch_scope_unavailable');
  for (const { namespace, data } of dispatchScopeLeaves(
    authorization.snapshot,
    'file_dispatch_scope_unavailable',
  )) {
    const capability = data.capability;
    if (
      namespace !== 'builtin.permissions' ||
      data.workspaceTrust !== true ||
      !['accept_edits', 'auto', 'full'].includes(String(data.mode)) ||
      !capability ||
      typeof capability !== 'object' ||
      Array.isArray(capability) ||
      capability.kind !== 'tool' ||
      capability.definitionId !== definitionId ||
      capability.definitionVersion !== (definitionId === 'files.read_path' ? '2' : '1') ||
      capability.hardAllowed !== true ||
      capability.revision !== revision
    )
      throw new AgentError('file_dispatch_scope_changed');
  }
}
