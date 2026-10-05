import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { applyEdits, modify, type ParseError, parse, visit } from 'jsonc-parser';
import {
  acquireFileLock,
  assertLiveLock,
  LockBusyError,
  type WindowsPathSecurity,
} from '../platform/locks';
import { defaultWindowsPathSecurity, privateDirectory } from '../platform/windows-path-security';
import { mcpCanonical } from './mcp-selection';
import { ConfigurationError, type Json, type JsonObject } from './types';

const hash = (value: unknown) => createHash('sha256').update(mcpCanonical(value)).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const credential = /^credential:[0-9a-f-]{36}$/;
const absent = hash({ kind: 'mcp-source-absent', version: 1 });
function fail(code: string): never {
  throw new ConfigurationError(code);
}
const record = (value: unknown): value is JsonObject =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const closed = (value: JsonObject, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const string = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 8192 && !value.includes('\0');
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export interface McpSourceScope {
  profileId: string;
  storeId: string;
  sessionId: string;
  workspaceId: string | null;
}
export interface McpSourceOptions {
  /** Trusted host roots, not client supplied paths. No home discovery. */
  profilePath: string;
  workspacePath?: string;
  scope: McpSourceScope;
  /** Explicit finite non-secret variable supply; never process.env. */
  variables?: Readonly<Record<string, string>>;
  maxBytes?: number;
  now?: () => number;
  windowsPathSecurity?: WindowsPathSecurity;
}
export interface McpSourceIdentity {
  kind: 'user' | 'workspace';
  pathDigest: string;
  rootIdentity: string;
}
export interface McpSourceDocument {
  path: string;
  identity: McpSourceIdentity;
  exists: boolean;
  etag: string | null;
  value: JsonObject | null;
  error: string | null;
}
export interface McpSourceReadSet {
  scopeDigest: string;
  user: { identity: McpSourceIdentity; etag: string | null; error: string | null };
  workspace: { identity: McpSourceIdentity; etag: string | null; error: string | null } | null;
  approvalEtag: string | null;
  bindingEtag: string | null;
  variablesDigest: string;
}

export type McpSourceEntryMutation =
  | {
      kind: 'add';
      scope: 'user' | 'workspace';
      name: string;
      entry: { type: 'http'; url: string } | { type: 'stdio'; command: string };
    }
  | {
      kind: 'remove';
      scope: 'user' | 'workspace';
      serverId: string;
      expectedRawEntryDigest: string;
    };

export interface McpSourceEntryDeclaration {
  serverId: string;
  name: string;
  source: McpSourceIdentity;
  rawEntryDigest: string;
  transport: 'http' | 'stdio' | null;
  enabled: boolean;
  reason: string | null;
}
export interface McpSourceEntryPreview {
  target: McpSourceEntryDeclaration;
  /** Revealed user declaration only; never connection, credential or Tool authority. */
  fallback: McpSourceEntryDeclaration | null;
}
export interface McpSourceEntryReceipt extends McpSourceEntryPreview {
  operationId: string;
  kind: 'add' | 'remove';
  oldEtag: string;
  newEtag: string;
}

/** Host-only derivation after the caller has verified an actual child activation.
 * Both Session digests are produced by complete reads. The original parent read-set is
 * never retagged, and every persistent source/approval/auth observation must agree.
 */
export function deriveMcpSourceReadSet(
  parent: McpSourceOptions,
  expectedParent: McpSourceReadSet,
  child: McpSourceOptions,
) {
  if (
    parent.scope.sessionId === child.scope.sessionId ||
    parent.scope.profileId !== child.scope.profileId ||
    parent.scope.storeId !== child.scope.storeId ||
    parent.scope.workspaceId !== child.scope.workspaceId
  )
    fail('mcp_source_scope_invalid');
  const original = readMcpSources(parent);
  if (mcpCanonical(original.readSet) !== mcpCanonical(expectedParent)) fail('mcp_source_stale');
  const derived = readMcpSources(child);
  const a = original.readSet,
    b = derived.readSet;
  if (
    mcpCanonical(a.user) !== mcpCanonical(b.user) ||
    mcpCanonical(a.workspace) !== mcpCanonical(b.workspace) ||
    a.approvalEtag !== b.approvalEtag ||
    a.bindingEtag !== b.bindingEtag ||
    a.variablesDigest !== b.variablesDigest ||
    mcpCanonical(original.registry.servers) !== mcpCanonical(derived.registry.servers)
  )
    fail('mcp_source_stale');
  return derived;
}
export interface McpSourceBinding {
  scopeDigest: string;
  sourceDigest: string;
  serverId: string;
  rawEntryDigest: string;
  transportDigest: string;
}
export interface McpSourceDecisionProof {
  decisionId: string;
  storeId: string;
  sessionId: string;
  interactionId: string;
  acceptedRevision: string;
  subjectId: string;
  requestDigest: string;
  recordedAt: number;
}
export interface McpSourceApproval extends McpSourceBinding {
  kind: 'mcp_source_approval';
  decision: 'approved' | 'rejected';
  proof: McpSourceDecisionProof;
}
export interface McpSourceCredentialBinding extends McpSourceBinding {
  kind: 'mcp_credential_binding';
  authProfile: string;
  purpose: 'mcp.http';
  vaultRef: string;
  expiresAt: number;
  revoked: boolean;
  proof: McpSourceDecisionProof;
}
export interface McpSourceServer {
  id: string;
  name: string;
  source: McpSourceIdentity;
  rawEntryDigest: string;
  transportDigest: string | null;
  transport: 'http' | 'stdio' | null;
  enabled: boolean;
  admitted: boolean;
  reason: string | null;
}
export interface McpPrivateSourceEntry {
  server: McpSourceServer;
  raw: Json;
  /** Private normalized transport only; never project this to Query or Run snapshot. */
  transport: JsonObject | null;
  binding: McpSourceBinding | null;
  credentialBinding: McpSourceCredentialBinding | null;
}

function root(path: string, security?: WindowsPathSecurity, privateRoot = true) {
  const requested = resolve(path);
  const stat = lstatSync(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(requested) !== requested)
    fail('mcp_source_root_unsafe');
  if (process.platform === 'win32') {
    if (!security) fail('mcp_source_unavailable');
    const native = defaultWindowsPathSecurity()!;
    if (privateRoot) native.verifyDirectory(requested);
    else native.verifyScopeDirectory(requested);
    if (security !== native) security.verifyDirectory(requested);
  }
  return { path: requested, identity: hash({ path: requested, dev: stat.dev, ino: stat.ino }) };
}
function json(text: string): JsonObject {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  let duplicate = false;
  const stack: Set<string>[] = [];
  visit(
    text,
    {
      onObjectBegin: () => {
        stack.push(new Set());
      },
      onObjectProperty: (key) => {
        const keys = stack.at(-1)!;
        if (keys.has(key)) duplicate = true;
        keys.add(key);
      },
      onObjectEnd: () => {
        stack.pop();
      },
    },
    { allowTrailingComma: true },
  );
  const check = (entry: unknown, depth: number) => {
    if (depth > 32) fail('mcp_source_limit');
    if (
      entry === null ||
      typeof entry === 'string' ||
      typeof entry === 'boolean' ||
      (typeof entry === 'number' && Number.isFinite(entry))
    )
      return;
    if (Array.isArray(entry)) {
      for (const child of entry) check(child, depth + 1);
      return;
    }
    if (!record(entry)) fail('mcp_source_invalid');
    for (const [key, child] of Object.entries(entry)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('mcp_source_invalid');
      check(child, depth + 1);
    }
  };
  if (errors.length || duplicate || !record(value)) fail('mcp_source_invalid');
  check(value, 0);
  return value;
}
function bytes(path: string, options: McpSourceOptions, privateFile = true) {
  const max = options.maxBytes ?? 1048576;
  if (!Number.isSafeInteger(max) || max < 1 || max > 8388608) fail('mcp_source_limit');
  let fd: number | undefined;
  try {
    if (process.platform === 'win32') {
      const native = defaultWindowsPathSecurity()!;
      if (existsSync(dirname(path))) {
        if (privateFile) native.verifyDirectory(dirname(path));
        else native.verifyScopeDirectory(dirname(path));
      }
      let content: Uint8Array | null;
      try {
        content = native.readScopeFile(path, max, privateFile);
      } catch (error) {
        if (error instanceof Error && error.message === 'windows_path_size_limit')
          fail('mcp_source_limit');
        throw error;
      }
      if (content === null) return { exists: false, text: '{}', etag: absent };
      if (options.windowsPathSecurity && options.windowsPathSecurity !== native)
        options.windowsPathSecurity.verifyFile(path);
      const etag = createHash('sha256').update(content).digest('hex');
      let text: string | null;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(content);
      } catch {
        text = null;
      }
      return { exists: true, text, etag };
    }
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { exists: false, text: '{}', etag: absent };
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('mcp_source_path_unsafe');
    if (stat.size > max) fail('mcp_source_limit');
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      opened.nlink !== 1 ||
      !opened.isFile()
    )
      fail('mcp_source_path_unsafe');
    const buffer = Buffer.alloc(max + 1);
    let count = 0;
    while (count <= max) {
      const size = readSync(fd, buffer, count, buffer.length - count, null);
      if (!size) break;
      count += size;
    }
    if (count > max) fail('mcp_source_limit');
    const content = buffer.subarray(0, count);
    const etag = createHash('sha256').update(content).digest('hex');
    let text: string | null;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      text = null;
    }
    return { exists: true, text, etag };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function inspect(
  path: string,
  identity: McpSourceIdentity,
  options: McpSourceOptions,
): McpSourceDocument {
  let exists = false;
  let etag: string | null = null;
  try {
    // A project directory symlink must not redirect either source or lock authority.
    if (existsSync(dirname(path)) && realpathSync(dirname(path)) !== dirname(path))
      fail('mcp_source_path_unsafe');
    const raw = bytes(path, options, identity.kind !== 'workspace');
    exists = raw.exists;
    etag = raw.etag;
    if (raw.text === null) fail('mcp_source_invalid_utf8');
    return { path, identity, exists, etag, value: json(raw.text), error: null };
  } catch (error) {
    return {
      path,
      identity,
      exists,
      etag,
      value: null,
      error: error instanceof ConfigurationError ? error.code : 'mcp_source_unavailable',
    };
  }
}
function proof(value: unknown): value is McpSourceDecisionProof {
  return (
    record(value) &&
    closed(value, [
      'decisionId',
      'storeId',
      'sessionId',
      'interactionId',
      'acceptedRevision',
      'subjectId',
      'requestDigest',
      'recordedAt',
    ]) &&
    [value.decisionId, value.storeId, value.sessionId, value.interactionId, value.subjectId].every(
      string,
    ) &&
    typeof value.acceptedRevision === 'string' &&
    /^[1-9][0-9]{0,255}$/.test(value.acceptedRevision) &&
    typeof value.requestDigest === 'string' &&
    digest.test(value.requestDigest) &&
    typeof value.recordedAt === 'number' &&
    Number.isSafeInteger(value.recordedAt) &&
    value.recordedAt >= 0
  );
}
function binding(value: JsonObject) {
  return (
    ['scopeDigest', 'sourceDigest', 'rawEntryDigest', 'transportDigest'].every(
      (key) => typeof value[key] === 'string' && digest.test(value[key] as string),
    ) &&
    typeof value.serverId === 'string' &&
    /^mcp-[a-f0-9]{64}$/.test(value.serverId)
  );
}
function metadata(document: McpSourceDocument, kind: 'approval' | 'binding') {
  const values = document.value?.records;
  if (document.error || !document.value || (values !== undefined && !record(values))) return null;
  const result: Record<string, McpSourceApproval | McpSourceCredentialBinding> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (!digest.test(key) || !record(value) || !binding(value) || !proof(value.proof)) return null;
    const base = [
      'kind',
      'scopeDigest',
      'sourceDigest',
      'serverId',
      'rawEntryDigest',
      'transportDigest',
      'proof',
    ];
    if (kind === 'approval') {
      if (
        !closed(value, [...base, 'decision']) ||
        value.kind !== 'mcp_source_approval' ||
        !['approved', 'rejected'].includes(value.decision as string)
      )
        return null;
    } else if (
      !closed(value, [...base, 'authProfile', 'purpose', 'vaultRef', 'expiresAt', 'revoked']) ||
      value.kind !== 'mcp_credential_binding' ||
      !string(value.authProfile) ||
      value.purpose !== 'mcp.http' ||
      typeof value.vaultRef !== 'string' ||
      !credential.test(value.vaultRef) ||
      typeof value.expiresAt !== 'number' ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt < 0 ||
      typeof value.revoked !== 'boolean'
    )
      return null;
    if (
      key !==
      hash({
        ...pickBinding(value),
        ...(kind === 'binding' ? { authProfile: value.authProfile } : {}),
      })
    )
      return null;
    result[key] = value as unknown as McpSourceApproval | McpSourceCredentialBinding;
  }
  return result;
}
function pickBinding(value: JsonObject | McpSourceBinding): McpSourceBinding {
  return {
    scopeDigest: value.scopeDigest as string,
    sourceDigest: value.sourceDigest as string,
    serverId: value.serverId as string,
    rawEntryDigest: value.rawEntryDigest as string,
    transportDigest: value.transportDigest as string,
  };
}
function normalize(raw: Json, variables: Readonly<Record<string, string>>) {
  if (!record(raw)) fail('mcp_server_invalid');
  const expand = (value: unknown) => {
    if (!string(value)) fail('mcp_server_invalid');
    const text = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
      if (!Object.hasOwn(variables, key)) fail('mcp_variable_unavailable');
      return variables[key]!;
    });
    if (text.includes('${') || !string(text)) fail('mcp_variable_unavailable');
    return text;
  };
  const type = raw.type ?? 'stdio';
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') fail('mcp_server_invalid');
  if (raw.required !== undefined && typeof raw.required !== 'boolean') fail('mcp_server_invalid');
  if (
    raw.timeout !== undefined &&
    (typeof raw.timeout !== 'number' || !Number.isFinite(raw.timeout) || raw.timeout <= 0)
  )
    fail('mcp_server_invalid');
  let transport: JsonObject;
  if (type === 'http') {
    const url = new URL(expand(raw.url));
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      fail('mcp_transport_unavailable');
    if (raw.headers !== undefined && (!record(raw.headers) || Object.keys(raw.headers).length))
      fail('mcp_headers_unavailable');
    transport = { type, url: url.href };
  } else if (type === 'stdio') {
    const command = expand(raw.command);
    const cwd = raw.cwd === undefined ? undefined : expand(raw.cwd);
    if (!command.startsWith('/') || (cwd !== undefined && !cwd.startsWith('/')))
      fail('mcp_transport_unavailable');
    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.length > 128))
      fail('mcp_server_invalid');
    const args = ((raw.args as Json[] | undefined) ?? []).map(expand);
    if (raw.env !== undefined && !record(raw.env)) fail('mcp_server_invalid');
    const env: JsonObject = {};
    for (const [key, value] of Object.entries(raw.env ?? {})) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
        /secret|token|api.?key|password|credential|proxy|^LD_|^DYLD_|^NODE_|^BUN_/i.test(key)
      )
        fail('mcp_environment_unavailable');
      env[key] = expand(value);
    }
    if (Object.keys(env).length > 128) fail('mcp_environment_unavailable');
    transport = { type, command, args, env, ...(cwd ? { cwd } : {}) };
  } else fail('mcp_transport_unavailable');
  const auth = raw.auth ?? { type: 'none' };
  if (!record(auth)) fail('mcp_auth_unavailable');
  if (auth.type === 'none' && closed(auth, ['type'])) transport.auth = { type: 'none' };
  else if (
    type === 'http' &&
    auth.type === 'credential' &&
    closed(auth, ['type', 'credentialRef', 'profile', 'header', 'scheme']) &&
    typeof auth.credentialRef === 'string' &&
    credential.test(auth.credentialRef) &&
    (auth.profile === undefined || string(auth.profile)) &&
    (auth.header === undefined || auth.header === 'Authorization') &&
    (auth.scheme === undefined || auth.scheme === 'Bearer')
  ) {
    transport.auth = {
      type: 'credential',
      credentialRef: auth.credentialRef,
      profile: auth.profile ?? 'default',
    };
  } else fail(auth.type === 'oauth' ? 'mcp_oauth_unavailable' : 'mcp_auth_unavailable');
  if (raw.timeout !== undefined) transport.timeout = raw.timeout;
  // No declaration may self-assert Tool effects, annotation trust or retry authority.
  for (const key of ['trust', 'enabledTools', 'disabledTools', 'tools'])
    if (raw[key] !== undefined) fail('mcp_policy_unavailable');
  return transport;
}

/** Pure filesystem/catalogue observation: no connection, Model or vault API exists here. */
export function readMcpSources(options: McpSourceOptions) {
  options = {
    ...options,
    windowsPathSecurity: options.windowsPathSecurity ?? defaultWindowsPathSecurity(),
  };
  if (
    !closed(options.scope as unknown as JsonObject, [
      'profileId',
      'storeId',
      'sessionId',
      'workspaceId',
    ]) ||
    ![options.scope.profileId, options.scope.storeId, options.scope.sessionId].every(string) ||
    (options.scope.workspaceId !== null && !string(options.scope.workspaceId)) ||
    !!options.workspacePath !== (options.scope.workspaceId !== null)
  )
    fail('mcp_source_scope_invalid');
  const profile = root(options.profilePath, options.windowsPathSecurity);
  const workspace = options.workspacePath
    ? root(options.workspacePath, options.windowsPathSecurity, false)
    : null;
  const persistentScopeDigest = hash({
    profileId: options.scope.profileId,
    storeId: options.scope.storeId,
    workspaceId: options.scope.workspaceId,
    profile: profile.identity,
    workspace: workspace?.identity ?? null,
  });
  const scopeDigest = hash({ persistentScopeDigest, sessionId: options.scope.sessionId });
  const variables = structuredClone(options.variables ?? {});
  if (Object.keys(variables).length > 128) fail('mcp_variables_invalid');
  for (const [key, value] of Object.entries(variables)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      !string(value) ||
      /secret|token|api.?key|password|credential/i.test(key)
    )
      fail('mcp_variables_invalid');
  }
  const identity = (kind: McpSourceIdentity['kind'], path: string, rootIdentity: string) => ({
    kind,
    pathDigest: hash(path),
    rootIdentity,
  });
  const userPath = join(profile.path, 'mcp.json');
  const workspacePath = workspace ? join(workspace.path, '.kite-code', 'mcp.json') : null;
  const user = inspect(userPath, identity('user', userPath, profile.identity), options);
  const project =
    workspace && workspacePath
      ? inspect(workspacePath, identity('workspace', workspacePath, workspace.identity), options)
      : null;
  const approvalPath = join(profile.path, 'mcp-approvals.json');
  const bindingPath = join(profile.path, 'mcp-auth-bindings.json');
  const approvals = inspect(
    approvalPath,
    identity('user', approvalPath, profile.identity),
    options,
  );
  const bindings = inspect(bindingPath, identity('user', bindingPath, profile.identity), options);
  const approvalRecords = metadata(approvals, 'approval');
  const bindingRecords = metadata(bindings, 'binding');
  const readSet: McpSourceReadSet = {
    scopeDigest,
    user: { identity: user.identity, etag: user.etag, error: user.error },
    workspace: project
      ? { identity: project.identity, etag: project.etag, error: project.error }
      : null,
    approvalEtag: approvals.etag,
    bindingEtag: bindings.etag,
    variablesDigest: hash(variables),
  };
  const names = (document: McpSourceDocument | null) => {
    if (!document || document.error) return null;
    const servers = document.value?.mcpServers;
    return servers === undefined ? {} : record(servers) ? servers : null;
  };
  const userServers = names(user);
  const projectServers = names(project);
  const entries: McpPrivateSourceEntry[] = [];
  const allNames = new Set([
    ...Object.keys(userServers ?? {}),
    ...Object.keys(projectServers ?? {}),
  ]);
  for (const name of allNames) {
    const document = projectServers && Object.hasOwn(projectServers, name) ? project! : user;
    const raw = document === project ? projectServers![name]! : userServers![name]!;
    const server: McpSourceServer = {
      id: `mcp-${hash({ name })}`,
      name: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) ? name : `invalid-${hash(name)}`,
      source: document.identity,
      rawEntryDigest: hash({ version: 1, name, raw }),
      transportDigest: null,
      transport: null,
      enabled: record(raw) && raw.enabled !== false,
      admitted: false,
      reason: null,
    };
    let transport: JsonObject | null = null;
    let exactBinding: McpSourceBinding | null = null;
    let authBinding: McpSourceCredentialBinding | null = null;
    try {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) fail('mcp_server_invalid');
      transport = normalize(raw, variables);
      server.transport = transport.type as 'http' | 'stdio';
      server.transportDigest = hash({ version: 1, transport });
      exactBinding = {
        scopeDigest: persistentScopeDigest,
        sourceDigest: hash(document.identity),
        serverId: server.id,
        rawEntryDigest: server.rawEntryDigest,
        transportDigest: server.transportDigest,
      };
      if (project && !projectServers) fail('mcp_project_source_unavailable');
      if (!server.enabled) fail('mcp_server_disabled');
      if (document === project) {
        if (!approvalRecords) fail('mcp_approval_unavailable');
        const saved = approvalRecords[hash(exactBinding)] as McpSourceApproval | undefined;
        if (!saved) fail('mcp_project_approval_pending');
        if (saved.proof.storeId !== options.scope.storeId) fail('mcp_approval_unavailable');
        if (saved.decision !== 'approved') fail('mcp_project_approval_rejected');
      }
      const auth = transport.auth as JsonObject;
      if (auth.type === 'credential') {
        if (!bindingRecords) fail('mcp_credential_binding_unavailable');
        const saved = bindingRecords[hash({ ...exactBinding, authProfile: auth.profile })] as
          | McpSourceCredentialBinding
          | undefined;
        if (!saved || saved.vaultRef !== auth.credentialRef)
          fail('mcp_credential_binding_required');
        if (saved.proof.storeId !== options.scope.storeId)
          fail('mcp_credential_binding_unavailable');
        if (saved.revoked) fail('mcp_credential_binding_revoked');
        const now = options.now?.() ?? Date.now();
        if (!Number.isSafeInteger(now) || now < 0) fail('mcp_credential_clock_unavailable');
        if (now >= saved.expiresAt) fail('mcp_credential_binding_expired');
        authBinding = saved;
      }
      server.admitted = true;
    } catch (error) {
      server.reason = error instanceof ConfigurationError ? error.code : 'mcp_server_invalid';
    }
    entries.push({ server, raw, transport, binding: exactBinding, credentialBinding: authBinding });
  }
  const servers = entries.map((entry) => entry.server);
  const registry = {
    revision: hash({ version: 1, readSet, servers }),
    servers,
    errors: {
      user: user.error ?? (!userServers ? 'mcp_source_invalid' : null),
      workspace: project?.error ?? (project && !projectServers ? 'mcp_source_invalid' : null),
      approval: approvalRecords ? null : 'mcp_approval_unavailable',
      binding: bindingRecords ? null : 'mcp_credential_binding_unavailable',
    },
  };
  return freeze({ user, workspace: project, approvals, bindings, readSet, registry, entries });
}

/** Exact host-approved metadata only. Never accepts a config ref as credential authority. */
export function writeMcpSourceMetadata(
  options: McpSourceOptions & {
    expectedReadSet: McpSourceReadSet;
    value: McpSourceApproval | McpSourceCredentialBinding;
    /** Caller verifies the actual accepted ordinary user decision; policy allow is insufficient. */
    validateDecision: (proof: McpSourceDecisionProof, binding: McpSourceBinding) => boolean;
    /** Host notification after durable publication. Failure is publication_unknown, never retry. */
    afterPublication?: (receipt: { etag: string; recordKey: string }) => void;
  },
) {
  options = {
    ...options,
    windowsPathSecurity: options.windowsPathSecurity ?? defaultWindowsPathSecurity(),
  };
  const original = readMcpSources(options);
  const value = freeze(structuredClone(options.value));
  const check = () => {
    const current = readMcpSources(options);
    if (mcpCanonical(current.readSet) !== mcpCanonical(options.expectedReadSet))
      fail('mcp_source_conflict');
    const entry = current.entries.find((candidate) => candidate.server.id === value.serverId);
    if (!entry?.binding || mcpCanonical(entry.binding) !== mcpCanonical(pickBinding(value)))
      fail('mcp_source_binding_conflict');
    if (
      value.proof.storeId !== options.scope.storeId ||
      value.proof.sessionId !== options.scope.sessionId ||
      options.validateDecision(value.proof, entry.binding) !== true
    )
      fail('mcp_source_decision_invalid');
    if (value.kind === 'mcp_source_approval' && entry.server.source.kind !== 'workspace')
      fail('mcp_source_approval_not_required');
    if (value.kind === 'mcp_credential_binding') {
      const auth = entry.transport?.auth as JsonObject | undefined;
      if (
        auth?.type !== 'credential' ||
        auth.profile !== value.authProfile ||
        auth.credentialRef !== value.vaultRef
      )
        fail('mcp_source_binding_conflict');
    }
    if (mcpCanonical(readMcpSources(options).readSet) !== mcpCanonical(current.readSet))
      fail('mcp_source_conflict');
    return current;
  };
  const isApproval = value.kind === 'mcp_source_approval';
  const recordKey = hash({
    ...pickBinding(value),
    ...(!isApproval ? { authProfile: value.authProfile } : {}),
  });
  const probe: McpSourceDocument = {
    ...(isApproval ? original.approvals : original.bindings),
    error: null,
    value: { records: { [recordKey]: value as unknown as Json } },
  };
  if (!metadata(probe, isApproval ? 'approval' : 'binding')) fail('mcp_source_metadata_invalid');
  check();
  const target = isApproval ? original.approvals : original.bindings;
  const paths = [
    ...new Set(
      [
        original.user.path,
        original.workspace?.path,
        original.approvals.path,
        original.bindings.path,
      ].filter((path): path is string => !!path),
    ),
  ].sort();
  const locks: ReturnType<typeof acquireFileLock>[] = [];
  let temporary: string | undefined;
  let published = false;
  try {
    for (const path of paths) {
      if (
        process.platform === 'win32' &&
        path === original.workspace?.path &&
        existsSync(dirname(path))
      )
        defaultWindowsPathSecurity()!.verifyScopeDirectory(dirname(path));
      else privateDirectory(dirname(path), options.windowsPathSecurity);
      if (realpathSync(dirname(path)) !== dirname(path)) fail('mcp_source_path_unsafe');
      locks.push(acquireFileLock(`${path}.lock`, 'exclusive', options.windowsPathSecurity));
    }
    const current = check();
    const document = isApproval ? current.approvals : current.bindings;
    if (
      document.error ||
      !document.value ||
      !metadata(document, isApproval ? 'approval' : 'binding')
    )
      fail('mcp_source_metadata_invalid');
    const old = bytes(target.path, options);
    if (old.text === null) fail('mcp_source_metadata_invalid');
    const text = applyEdits(
      old.text,
      modify(old.text, ['records', recordKey], value, {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
          eol: old.text.includes('\r\n') ? '\r\n' : '\n',
        },
      }),
    );
    if (Buffer.byteLength(text) > (options.maxBytes ?? 1048576)) fail('mcp_source_limit');
    json(text);
    temporary = join(dirname(target.path), `.${basename(target.path)}.${randomUUID()}.tmp`);
    if (process.platform === 'win32')
      defaultWindowsPathSecurity()!.writePrivateFile(temporary, Buffer.from(text, 'utf8'));
    else {
      const fd = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        writeFileSync(fd, text, 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    check(); // final original read-set/decision while every canonical lock remains held
    if (bytes(target.path, options).etag !== old.etag) fail('mcp_source_conflict');
    options.windowsPathSecurity?.secureFile(temporary);
    renameSync(temporary, target.path);
    published = true;
    temporary = undefined;
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(target.path), constants.O_RDONLY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
    const receipt = { etag: bytes(target.path, options).etag, recordKey };
    options.afterPublication?.(receipt);
    return freeze(receipt);
  } catch (error) {
    if (published) fail('mcp_source_publication_unknown');
    if (error instanceof ConfigurationError) throw error;
    if (error instanceof LockBusyError) fail('mcp_source_busy');
    throw new ConfigurationError('mcp_source_unavailable');
  } finally {
    if (temporary)
      try {
        unlinkSync(temporary);
      } catch {
        /* preserve original */
      }
    for (const lock of locks.reverse()) lock.release();
  }
}

function sourceEntryState(options: McpSourceOptions, expectedReadSet: McpSourceReadSet) {
  const state = readMcpSources(options);
  if (mcpCanonical(state.readSet) !== mcpCanonical(expectedReadSet)) fail('mcp_source_conflict');
  if ([state.user, state.workspace, state.approvals, state.bindings].some((v) => v?.error))
    fail('mcp_source_unavailable');
  for (const document of [state.user, state.workspace]) {
    if (document?.value?.mcpServers !== undefined && !record(document.value.mcpServers))
      fail('mcp_source_invalid');
  }
  return state;
}

function entryDeclaration(
  document: McpSourceDocument,
  name: string,
  raw: Json,
  variables: Readonly<Record<string, string>>,
): McpSourceEntryDeclaration {
  let transport: 'http' | 'stdio' | null = null;
  let reason: string | null = null;
  try {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) fail('mcp_server_invalid');
    transport = normalize(raw, variables).type as 'http' | 'stdio';
  } catch (error) {
    reason = error instanceof ConfigurationError ? error.message : 'mcp_server_invalid';
  }
  return {
    serverId: `mcp-${hash({ name })}`,
    name,
    source: document.identity,
    rawEntryDigest: hash({ version: 1, name, raw }),
    transport,
    enabled: record(raw) && raw.enabled !== false,
    reason,
  };
}

function sourceEntryPreview(
  state: ReturnType<typeof readMcpSources>,
  input: { scope: 'user' | 'workspace'; serverId: string },
  variables: Readonly<Record<string, string>>,
): McpSourceEntryPreview {
  if (!['user', 'workspace'].includes(input.scope)) fail('mcp_source_scope_invalid');
  const entry = state.entries.find((v) => v.server.id === input.serverId);
  if (!entry || entry.server.source.kind !== input.scope) fail('mcp_source_entry_conflict');
  const document = input.scope === 'workspace' ? state.workspace : state.user;
  if (!document) fail('mcp_source_scope_invalid');
  const originalName = originalEntryName(document, input.serverId);
  const target = {
    ...entryDeclaration(document, originalName, entry.raw, variables),
    name: entry.server.name,
    transport: entry.server.transport,
    reason: entry.server.reason,
  };
  const users = state.user.value?.mcpServers;
  const fallback =
    input.scope === 'workspace' && record(users) && Object.hasOwn(users, originalName)
      ? {
          ...entryDeclaration(state.user, originalName, users[originalName]!, variables),
          name: entry.server.name,
        }
      : null;
  return { target, fallback };
}

function originalEntryName(document: McpSourceDocument, serverId: string): string {
  const names = document.value?.mcpServers;
  const matches = record(names)
    ? Object.keys(names).filter((name) => `mcp-${hash({ name })}` === serverId)
    : [];
  if (matches.length !== 1) fail('mcp_source_entry_conflict');
  return matches[0]!;
}

/** Safe removal impact only. No raw entry, filesystem path, credential or connection access. */
export function readMcpSourceEntryPreview(
  options: McpSourceOptions,
  input: { scope: 'user' | 'workspace'; serverId: string; expectedReadSet: McpSourceReadSet },
): McpSourceEntryPreview {
  const state = sourceEntryState(options, input.expectedReadSet);
  return freeze(sourceEntryPreview(state, input, options.variables ?? {}));
}

/** One source declaration, with complete original Source CAS. Never modifies approval or vault. */
export function writeMcpSourceEntry(
  options: McpSourceOptions & {
    expectedReadSet: McpSourceReadSet;
    mutation: McpSourceEntryMutation;
    /** Trusted actual Action Execution ID; not a caller's declaration field. */
    operationId: string;
    validatePublication: () => void;
    afterPublication?: (receipt: McpSourceEntryReceipt) => void;
  },
): McpSourceEntryReceipt {
  options = {
    ...options,
    windowsPathSecurity: options.windowsPathSecurity ?? defaultWindowsPathSecurity(),
  };
  if (
    typeof options.operationId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(options.operationId)
  )
    fail('mcp_source_operation_invalid');
  const mutation = freeze(structuredClone(options.mutation));
  if (!record(mutation)) fail('mcp_source_mutation_invalid');
  if (!['user', 'workspace'].includes(mutation.scope)) fail('mcp_source_scope_invalid');
  const exact = (v: unknown, keys: string[]) => {
    if (!record(v) || Object.keys(v).length !== keys.length || !closed(v, keys))
      fail('mcp_source_mutation_invalid');
  };
  if (mutation.kind === 'add') {
    exact(mutation, ['kind', 'scope', 'name', 'entry']);
    if (
      typeof mutation.name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(mutation.name) ||
      ['constructor', 'prototype'].includes(mutation.name)
    )
      fail('mcp_server_invalid');
    if (!record(mutation.entry)) fail('mcp_source_mutation_invalid');
    const basicText = (value: unknown, max: number, whitespace: boolean): value is string =>
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= max &&
      !value.includes('${') &&
      !Array.from(value).some((character) => {
        const point = character.codePointAt(0)!;
        return point < (whitespace ? 33 : 32) || point === 127;
      });
    if (mutation.entry.type === 'http') {
      exact(mutation.entry, ['type', 'url']);
      const value = mutation.entry.url;
      if (!basicText(value, 8192, true) || value.includes('?') || value.includes('#'))
        fail('mcp_transport_unavailable');
      try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          fail('mcp_transport_unavailable');
      } catch {
        fail('mcp_transport_unavailable');
      }
    } else if (mutation.entry.type === 'stdio') {
      exact(mutation.entry, ['type', 'command']);
      if (
        !basicText(mutation.entry.command, 4096, false) ||
        !mutation.entry.command.startsWith('/')
      )
        fail('mcp_transport_unavailable');
    } else fail('mcp_source_mutation_invalid');
    try {
      normalize(mutation.entry, {});
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      fail('mcp_server_invalid');
    }
  } else if (mutation.kind === 'remove') {
    exact(mutation, ['kind', 'scope', 'serverId', 'expectedRawEntryDigest']);
    if (
      !/^mcp-[a-f0-9]{64}$/.test(mutation.serverId) ||
      !digest.test(mutation.expectedRawEntryDigest)
    )
      fail('mcp_source_mutation_invalid');
  } else fail('mcp_source_mutation_invalid');
  const original = sourceEntryState(options, options.expectedReadSet);
  const target = mutation.scope === 'user' ? original.user : original.workspace;
  if (!target) fail('mcp_source_scope_invalid');
  const added =
    mutation.kind === 'add'
      ? { ...mutation.entry, _kiteSourceCreation: { version: 1, operationId: options.operationId } }
      : null;
  const preview = (state: ReturnType<typeof readMcpSources>): McpSourceEntryPreview => {
    const document = mutation.scope === 'user' ? state.user : state.workspace;
    if (!document) fail('mcp_source_scope_invalid');
    if (mutation.kind === 'remove') {
      const impact = sourceEntryPreview(state, mutation, options.variables ?? {});
      if (impact.target.rawEntryDigest !== mutation.expectedRawEntryDigest)
        fail('mcp_source_entry_conflict');
      return impact;
    }
    const entries = document.value?.mcpServers;
    if (record(entries) && Object.hasOwn(entries, mutation.name)) fail('mcp_source_entry_exists');
    return { target: entryDeclaration(document, mutation.name, added!, {}), fallback: null };
  };
  const originalPreview = preview(original);
  // Original JSONC key stays private; sanitized display labels are never used to locate a write.
  const editName =
    mutation.kind === 'add' ? mutation.name : originalEntryName(target, mutation.serverId);
  const paths = [
    ...new Set(
      [
        original.user.path,
        original.workspace?.path,
        original.approvals.path,
        original.bindings.path,
      ].filter((v): v is string => !!v),
    ),
  ].sort();
  const locks: ReturnType<typeof acquireFileLock>[] = [];
  let temporary: string | undefined;
  let published = false;
  try {
    for (const path of paths) {
      if (
        process.platform === 'win32' &&
        path === original.workspace?.path &&
        existsSync(dirname(path))
      )
        defaultWindowsPathSecurity()!.verifyScopeDirectory(dirname(path));
      else privateDirectory(dirname(path), options.windowsPathSecurity);
      if (realpathSync(dirname(path)) !== dirname(path)) fail('mcp_source_path_unsafe');
      locks.push(acquireFileLock(`${path}.lock`, 'exclusive', options.windowsPathSecurity));
    }
    const current = sourceEntryState(options, options.expectedReadSet);
    if (mcpCanonical(preview(current)) !== mcpCanonical(originalPreview))
      fail('mcp_source_conflict');
    const old = bytes(target.path, options, mutation.scope !== 'workspace');
    if (old.text === null || old.etag !== target.etag) fail('mcp_source_conflict');
    const text = applyEdits(
      old.text,
      modify(
        old.text,
        ['mcpServers', editName],
        mutation.kind === 'add' ? added : undefined,
        {}, // Minimal syntax edit: do not reformat unrelated declarations or their raw env.
      ),
    );
    if (Buffer.byteLength(text) > (options.maxBytes ?? 1048576)) fail('mcp_source_limit');
    json(text);
    temporary = join(dirname(target.path), `.${basename(target.path)}.${randomUUID()}.tmp`);
    if (process.platform === 'win32')
      defaultWindowsPathSecurity()!.writePrivateFile(temporary, Buffer.from(text, 'utf8'));
    else {
      const fd = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        writeFileSync(fd, text, 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    options.validatePublication();
    sourceEntryState(options, options.expectedReadSet);
    for (let i = 0; i < paths.length; i++)
      assertLiveLock(locks[i]!, `${paths[i]!}.lock`, 'exclusive');
    if (bytes(target.path, options, mutation.scope !== 'workspace').etag !== old.etag)
      fail('mcp_source_conflict');
    options.windowsPathSecurity?.secureFile(temporary);
    renameSync(temporary, target.path);
    published = true;
    temporary = undefined;
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(target.path), constants.O_RDONLY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
    const actual = bytes(target.path, options, mutation.scope !== 'workspace');
    const expectedEtag = createHash('sha256').update(text, 'utf8').digest('hex');
    if (actual.etag !== expectedEtag) fail('mcp_source_publication_unknown');
    const receipt: McpSourceEntryReceipt = freeze({
      ...originalPreview,
      operationId: options.operationId,
      kind: mutation.kind,
      oldEtag: old.etag,
      newEtag: actual.etag,
    });
    options.afterPublication?.(receipt);
    return receipt;
  } catch (error) {
    if (published) fail('mcp_source_publication_unknown');
    if (error instanceof ConfigurationError) throw error;
    if (error instanceof LockBusyError) fail('mcp_source_busy');
    return fail('mcp_source_unavailable');
  } finally {
    if (temporary)
      try {
        unlinkSync(temporary);
      } catch {
        /* preserve original failure */
      }
    let releaseFailed = false;
    for (const lock of locks.reverse())
      try {
        lock.release();
      } catch {
        releaseFailed = true;
      }
    // A release failure cannot turn a published declaration into a known zero-effect failure.
    // Before publication the original finite error remains authoritative.
    if (releaseFailed && published) fail('mcp_source_publication_unknown');
  }
}
