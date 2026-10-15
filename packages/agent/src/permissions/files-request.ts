import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import type { AuthorizationRequest, ToolContext } from '../extensions';
import { AgentError, type Json } from '../storage/types';
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
/** Select a concrete physical parent; the existing native engine separately anchors/no-follows it. */
export async function inspectPathFileTarget(
  definitionId: string,
  input: Json,
  boundary: PathFileBoundary,
): Promise<PathFileTarget> {
  if (!pathFileToolIds.includes(definitionId as (typeof pathFileToolIds)[number]))
    throw new AgentError('file_input_invalid');
  const path = guardedPath(input, boundary, definitionId !== 'files.read_path');
  const root = dirname(path);
  if ((await realpath(root)) !== root) throw new AgentError('file_symlink');
  const stat = await lstat(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AgentError('file_root_invalid');
  if (process.getuid && stat.uid !== BigInt(process.getuid()))
    throw new AgentError('file_owner_invalid');
  let identity: PathFileTarget['identity'] = null;
  try {
    const target = await lstat(path, { bigint: true });
    if (target.isSymbolicLink()) throw new AgentError('file_symlink');
    if (!target.isFile()) throw new AgentError('file_not_regular');
    if (target.nlink !== 1n || (process.getuid && target.uid !== BigInt(process.getuid())))
      throw new AgentError('file_owner_invalid');
    identity = { device: String(target.dev), inode: String(target.ino) };
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
  const revision = createHash('sha256')
    .update(
      JSON.stringify({
        namespace: 'builtin.files.path',
        version: 1,
        definitionId,
        input,
        root: { path: root, device: String(stat.dev), inode: String(stat.ino) },
        identity,
        boundary,
      }),
    )
    .digest('hex');
  return { path, root, name: basename(path), identity, revision: `path-files:1:${revision}` };
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
    if (request.definitionVersion !== '1') throw new AgentError('file_input_invalid');
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
  const pending = [authorization.snapshot];
  let count = 0;
  while (pending.length) {
    const snapshot = pending.pop();
    if (
      snapshot?.version !== '1' ||
      ++count > 8192 ||
      !snapshot.data ||
      typeof snapshot.data !== 'object' ||
      Array.isArray(snapshot.data)
    )
      throw new AgentError('file_dispatch_scope_unavailable');
    const data = snapshot.data;
    if (snapshot.namespace === 'agent.permission-intersection') {
      if (!Array.isArray(data.policies) || !data.policies.length || data.policies.length > 2)
        throw new AgentError('file_dispatch_scope_unavailable');
      for (const [index, policy] of data.policies.entries()) {
        if (
          !policy ||
          typeof policy !== 'object' ||
          Array.isArray(policy) ||
          policy.scope !== (index === 0 ? 'parent' : 'child') ||
          typeof policy.revision !== 'string' ||
          !policy.revision ||
          typeof policy.allowed !== 'boolean' ||
          !policy.snapshot ||
          typeof policy.snapshot !== 'object' ||
          Array.isArray(policy.snapshot) ||
          typeof policy.snapshot.namespace !== 'string' ||
          typeof policy.snapshot.version !== 'string' ||
          !Object.hasOwn(policy.snapshot, 'data')
        )
          throw new AgentError('file_dispatch_scope_unavailable');
        pending.push(policy.snapshot as NonNullable<typeof authorization.snapshot>);
      }
      continue;
    }
    const capability = data.capability;
    if (
      snapshot.namespace !== 'builtin.permissions' ||
      data.workspaceTrust !== true ||
      !['accept_edits', 'auto', 'full'].includes(String(data.mode)) ||
      !capability ||
      typeof capability !== 'object' ||
      Array.isArray(capability) ||
      capability.kind !== 'tool' ||
      capability.definitionId !== definitionId ||
      capability.definitionVersion !== '1' ||
      capability.hardAllowed !== true ||
      capability.revision !== revision
    )
      throw new AgentError('file_dispatch_scope_changed');
  }
}
