import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentError, type AgentRuntime } from '@kite-ai/agent';
import type { Json } from '@kite-ai/agent/extensions';
import type { ProfileSelection } from '@kite-ai/agent/profile';
import type { HostMutationRecord, PermissionGrantPage } from '@kite-ai/agent/storage';
import type { PermissionMode } from './permissions';

interface Identity {
  expectedStoreId: string;
  subjectId: string;
}
export interface ModeState {
  storeId: string;
  sessionId: string;
  scopeSessionId: string;
  mode: PermissionMode;
  revision: string;
  defaultMode: PermissionMode;
  defaultRevision: string;
}
export interface TrustState {
  storeId: string;
  workspaceId: string;
  status: 'trusted' | 'untrusted' | 'scope_changed';
  trusted: boolean;
  revision: string;
  canonicalIdentity: string;
  externalReadScopeDigest: string;
  readScopes: { kind: string; description: string }[];
}
export interface PermissionMutation {
  commandId: string;
  kind: 'permission.mode' | 'workspace.trust' | 'permission.grants.clear';
  state: HostMutationRecord['state'];
  receipt: Json;
}
export interface PermissionManagementPort {
  readDefaultMode?(input: Identity): Promise<{ mode: PermissionMode; revision: string }>;
  readGrants(
    input: Identity & { sessionId: string; afterSeq?: string; upperSeq?: string; limit?: number },
  ): Promise<PermissionGrantPage>;
  clearGrants(
    input: Identity & { sessionId: string; commandId: string; ifRevision: string },
  ): Promise<PermissionMutation>;
  readMode(input: Identity & { sessionId: string }): Promise<ModeState>;
  readTrust(input: Identity & { workspaceId: string }): Promise<TrustState>;
  setMode(
    input: Identity & {
      commandId: string;
      sessionId: string;
      mode: PermissionMode;
      ifRevision: string;
      makeDefault: boolean;
      ifDefaultRevision: string;
    },
  ): Promise<PermissionMutation>;
  setTrust(
    input: Identity & {
      commandId: string;
      workspaceId: string;
      canonicalIdentity: string;
      externalReadScopeDigest: string;
      trusted: boolean;
      ifRevision: string;
    },
  ): Promise<PermissionMutation>;
  getMutation(input: Identity & { commandId: string }): Promise<PermissionMutation | null>;
}
const modes = new Set<PermissionMode>(['ask', 'accept_edits', 'auto', 'full']);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map(
            (key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
          )
          .join(',')}}`
      : (JSON.stringify(value) ?? 'null');
function object(value: Json): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AgentError('permission_control_invalid');
  return value;
}
function mode(value: Json | undefined): PermissionMode {
  if (typeof value !== 'string' || !modes.has(value as PermissionMode))
    throw new AgentError('permission_control_invalid');
  return value as PermissionMode;
}
function revision(value: string) {
  if (!/^(0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n)
    throw new AgentError('invalid_permission_revision');
}
function mutation(record: HostMutationRecord): PermissionMutation {
  if (
    record.kind !== 'permission.mode' &&
    record.kind !== 'workspace.trust' &&
    record.kind !== 'permission.grants.clear'
  )
    throw new AgentError('permission_mutation_kind_mismatch');
  return { commandId: record.id, kind: record.kind, state: record.state, receipt: record.receipt };
}

/** Host-selected scope only. No configuration text can provide path identities or grants. */
export function createPermissionManagement(options: {
  runtime?: AgentRuntime;
  profile: ProfileSelection;
  writable?: boolean;
  /** Qualified explicit native Shell has the host's broad readable filesystem view. */
  nativeShellRead?: boolean;
}): PermissionManagementPort {
  options = { ...options, profile: Object.freeze({ ...options.profile }) };
  async function runtime(input: Identity) {
    if (!options.runtime) throw new AgentError('store_unavailable');
    if ((await options.runtime.getMetadata()).storeId !== input.expectedStoreId)
      throw new AgentError('store_mismatch');
    if (!input.subjectId || input.subjectId.length > 256) throw new AgentError('invalid_subject');
    return options.runtime;
  }
  async function session(input: Identity & { sessionId: string }) {
    const host = await runtime(input),
      selected = await host.getSession(input.sessionId);
    if (!selected || selected.deletedAt !== null) throw new AgentError('session_not_found');
    return { host, session: selected };
  }
  async function scopes(input: Identity & { workspaceId: string }) {
    const host = await runtime(input),
      workspace = await host.getWorkspace(input.workspaceId);
    if (!workspace) throw new AgentError('workspace_missing');
    try {
      const uri = new URL(workspace.rootUri);
      if (uri.protocol !== 'file:' || (uri.hostname && uri.hostname !== 'localhost'))
        throw new Error();
      const path = fileURLToPath(uri),
        lexical = await lstat(path, { bigint: true }),
        root = await realpath(path);
      if (!lexical.isDirectory() || lexical.isSymbolicLink()) throw new Error();
      const actual = await lstat(root, { bigint: true });
      const canonicalIdentity = sha(
        canonical({ path: root, dev: String(actual.dev), ino: String(actual.ino) }),
      );
      const readScopes = [
        { kind: 'workspace', description: '当前工作区内的文件、项目指令与 Skill 资料' },
      ];
      const external: unknown[] = [];
      const skillPath = join(options.profile.profilePath, 'skills');
      try {
        const entry = await lstat(skillPath, { bigint: true });
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          const path = await realpath(skillPath);
          const identity = await lstat(path, { bigint: true });
          external.push({
            kind: 'profile_skills',
            path,
            dev: String(identity.dev),
            ino: String(identity.ino),
          });
          readScopes.push({
            kind: 'profile_skills',
            description: '当前 profile 的宿主限定 Skill 根目录资料',
          });
        }
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
      }
      if (options.nativeShellRead) {
        external.push({
          kind: 'native_shell_read',
          platform: 'darwin',
          uid: process.getuid?.() ?? null,
        });
        readScopes.push({
          kind: 'native_shell_read',
          description:
            '明确装配的 macOS Native Shell 在命令获准后可读取宿主权限允许的广泛文件视图；不是文件系统沙箱',
        });
      }
      return {
        host,
        canonicalIdentity,
        externalReadScopeDigest: sha(canonical(external)),
        readScopes,
      };
    } catch {
      throw new AgentError('workspace_identity_unavailable');
    }
  }
  async function write(
    input: Identity & { commandId: string },
    kind: PermissionMutation['kind'],
    scope: string,
    safeRequest: Json,
    check?: () => Promise<void>,
  ) {
    const host = await runtime(input);
    if (options.writable === false) throw new AgentError('permission_authority_external');
    const requestDigest = sha(canonical({ kind, scope, safeRequest }));
    const accepted = await host.beginHostMutation({
      ...input,
      kind,
      scope,
      requestDigest,
      safeRequest,
    });
    if (!accepted.created) {
      if (accepted.record.state === 'pending') throw new AgentError('mutation_incomplete');
      return mutation(accepted.record);
    }
    try {
      await check?.();
    } catch (error) {
      const code = error instanceof AgentError ? error.code : 'permission_control_unavailable';
      await host.finishHostMutation({
        ...input,
        requestDigest,
        state: 'failed',
        receipt: { status: 'failed', code },
      });
      throw error instanceof AgentError ? error : new AgentError(code);
    }
    try {
      return mutation(
        await host.finishHostMutation({
          ...input,
          requestDigest,
          state: 'applied',
          receipt: { status: 'applied' },
        }),
      );
    } catch (error) {
      if (
        !(error instanceof AgentError) ||
        ![
          'host_control_conflict',
          'host_control_scope_denied',
          'group_root_required',
          'session_deleted',
          'workspace_missing',
          'invalid_host_mutation',
        ].includes(error.code)
      )
        throw new AgentError('mutation_outcome_unknown');
      const code = error.code;
      // A known failed SQL CAS is durable failed; transport uncertainty is never called failed.
      await host.finishHostMutation({
        ...input,
        requestDigest,
        state: 'failed',
        receipt: { status: 'failed', code },
      });
      throw error instanceof AgentError ? error : new AgentError(code);
    }
  }
  return {
    async readGrants(input) {
      const host = await runtime(input);
      return host.listPermissionGrants(input);
    },
    async clearGrants(input) {
      if (options.writable === false) throw new AgentError('permission_management_readonly');
      revision(input.ifRevision);
      const host = await runtime(input);
      return mutation(await host.clearPermissionGrants(input));
    },
    async readDefaultMode(input) {
      const host = await runtime(input);
      const defaults = await host.readHostControl({
        ...input,
        kind: 'permission.mode',
        scope: 'user',
      });
      return {
        mode: defaults.record ? mode(object(defaults.record.safeRequest).mode) : 'auto',
        revision: defaults.revision,
      };
    },
    async readMode(input) {
      const { host, session: selected } = await session(input);
      const inherited = await host.readHostControl({
        expectedStoreId: input.expectedStoreId,
        subjectId: input.subjectId,
        kind: 'permission.mode',
        scope: `session:${selected.rootSessionId}`,
      });
      const defaults = await host.readHostControl({
        expectedStoreId: input.expectedStoreId,
        subjectId: input.subjectId,
        kind: 'permission.mode',
        scope: 'user',
      });
      const defaultMode = defaults.record ? mode(object(defaults.record.safeRequest).mode) : 'auto';
      return {
        storeId: input.expectedStoreId,
        sessionId: input.sessionId,
        scopeSessionId: selected.rootSessionId,
        mode: inherited.record ? mode(object(inherited.record.safeRequest).mode) : defaultMode,
        revision: inherited.revision,
        defaultMode,
        defaultRevision: defaults.revision,
      };
    },
    async readTrust(input) {
      const actual = await scopes(input);
      const control = await actual.host.readHostControl({
        expectedStoreId: input.expectedStoreId,
        subjectId: input.subjectId,
        kind: 'workspace.trust',
        scope: `workspace:${input.workspaceId}`,
      });
      const saved = control.record ? object(control.record.safeRequest) : null;
      const changed =
        saved !== null &&
        (saved.canonicalIdentity !== actual.canonicalIdentity ||
          saved.externalReadScopeDigest !== actual.externalReadScopeDigest);
      const trusted = !changed && saved?.trusted === true;
      return {
        storeId: input.expectedStoreId,
        workspaceId: input.workspaceId,
        status: changed ? 'scope_changed' : trusted ? 'trusted' : 'untrusted',
        trusted,
        revision: control.revision,
        canonicalIdentity: actual.canonicalIdentity,
        externalReadScopeDigest: actual.externalReadScopeDigest,
        readScopes: actual.readScopes,
      };
    },
    async setMode(input) {
      revision(input.ifRevision);
      revision(input.ifDefaultRevision);
      if (!modes.has(input.mode) || typeof input.makeDefault !== 'boolean')
        throw new AgentError('invalid_permission_request');
      const { session: selected } = await session(input);
      if (selected.id !== selected.rootSessionId) throw new AgentError('group_root_required');
      return write(input, 'permission.mode', `session:${input.sessionId}`, {
        scope: 'session',
        sessionId: input.sessionId,
        mode: input.mode,
        ifRevision: input.ifRevision,
        makeDefault: input.makeDefault,
        ifDefaultRevision: input.ifDefaultRevision,
      });
    },
    async setTrust(input) {
      revision(input.ifRevision);
      if (
        typeof input.trusted !== 'boolean' ||
        !/^[a-f0-9]{64}$/.test(input.canonicalIdentity) ||
        !/^[a-f0-9]{64}$/.test(input.externalReadScopeDigest)
      )
        throw new AgentError('invalid_permission_request');
      await runtime(input);
      return write(
        input,
        'workspace.trust',
        `workspace:${input.workspaceId}`,
        {
          scope: 'workspace',
          workspaceId: input.workspaceId,
          canonicalIdentity: input.canonicalIdentity,
          externalReadScopeDigest: input.externalReadScopeDigest,
          trusted: input.trusted,
          ifRevision: input.ifRevision,
        },
        async () => {
          const actual = await scopes(input);
          if (
            actual.canonicalIdentity !== input.canonicalIdentity ||
            actual.externalReadScopeDigest !== input.externalReadScopeDigest
          )
            throw new AgentError('workspace_scope_changed');
        },
      );
    },
    async getMutation(input) {
      const host = await runtime(input),
        record = await host.getHostMutation(input);
      return !record ||
        (record.kind !== 'permission.mode' &&
          record.kind !== 'workspace.trust' &&
          record.kind !== 'permission.grants.clear')
        ? null
        : mutation(record);
    },
  };
}
