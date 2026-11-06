import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { Json } from '../../extensions';
import { canonicalJson } from '../../json';
import { AgentError } from '../../storage/types';

export const limits = Object.freeze({
  payloadBytes: 32 * 1024,
  pathBytes: 4096,
  frameBytes: 256 * 1024,
  gitStdoutBytes: 16 * 1024 * 1024,
  gitStderrBytes: 256 * 1024,
  listItems: 256,
  listBytes: 64 * 1024,
  scanEntries: 100000,
  commits: 10000,
});
export type WorktreeAction = 'list' | 'create' | 'remove';
export type WorktreePhase = 'list' | 'prepare_create' | 'create' | 'prepare_remove' | 'remove';
export type Mutation = 'not_started' | 'completed' | 'partial' | 'unknown';
export type GitWorktreeInput =
  | { action: 'list' }
  | {
      action: 'create';
      key: string;
      path?: string;
      baseRef: string;
      newBranch?: string;
      timeoutMs: number;
      permissions: { filesystem: 'workspace_write' | 'full_access'; network: 'none' };
    }
  | {
      action: 'remove';
      key: string;
      path: string;
      timeoutMs: number;
      permissions: { filesystem: 'workspace_write' | 'full_access'; network: 'none' };
    };
export interface GitWorktreeConfiguration {
  configurationId: string;
  identity?: string;
  sourceCwd: string;
  bunPath: string;
  workerPath: string;
  configPath: string;
  git: { path: string; sha256: string };
  hooksPath: string;
  /** Trusted host location; never supplied by a model. Older explicit-path configurations omit it. */
  defaultRoot?: string;
  unavailable?: string;
}
export interface ResolvedWorktreeTarget {
  path: string;
  defaultRoot: string;
}
export function resolveDefaultWorktreeTarget(input: {
  defaultRoot: string;
  sourceCwd: string;
  sessionId: string;
  key: string;
}): string {
  const { defaultRoot, ...identity } = input;
  return resolve(defaultRoot, `worktree-${digest(identity)}`);
}
export function validateResolvedWorktreeTarget(value: unknown): value is ResolvedWorktreeTarget {
  return (
    jsonObject(value) &&
    closed(value, ['path', 'defaultRoot']) &&
    path(value.path) &&
    path(value.defaultRoot)
  );
}
export interface WorktreePlan {
  action: 'create' | 'remove';
  sourceCwd: string;
  sourceRoot: string;
  commonDir: string;
  targetPath: string;
  baseRef?: string;
  baseOid?: string;
  newBranch?: string;
  /** Closed, phase-specific filesystem evidence is verified by the worker before use. */
  evidence: Json;
}
export interface WorktreeRequest {
  schemaVersion: 1;
  configurationId: string;
  operationToken: string;
  phase: WorktreePhase;
  sourceCwd: string;
  git: { path: string; sha256: string };
  hooksPath: string;
  input?: GitWorktreeInput;
  resolvedTarget?: ResolvedWorktreeTarget;
  plan?: WorktreePlan;
  planDigest?: string;
}
export interface WorktreeFrame {
  protocolVersion: 1;
  operationToken: string;
  phase: WorktreePhase;
  businessOutcome: 'prepared' | 'succeeded' | 'failed';
  details: { [key: string]: Json };
  plan?: WorktreePlan;
  planDigest?: string;
}
export const gitWorktreeInputSchema: Json = {
  type: 'object',
  description:
    'For list, send exactly {"action":"list"}; omit key, path, baseRef, newBranch, timeoutMs and permissions. create requires key; omit path to use the trusted persistent ~/.kite-code/worktrees directory. remove requires key and absolute path. Only create accepts baseRef and newBranch. Temporary create targets are refused. Invalid arguments start no Git Job and require correcting the arguments, not broader permissions.',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      enum: ['list', 'create', 'remove'],
      description:
        'list accepts only action. create/remove require key; remove also requires path.',
    },
    key: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z0-9_.-]+$',
      description:
        'Required for create/remove; forbidden for list. Reuse only to observe the same original intent; never change keys to repeat a mutation with an unknown result.',
    },
    path: {
      type: 'string',
      minLength: 1,
      description:
        'Native absolute target path. Optional for create: omission selects a stable directory under ~/.kite-code/worktrees. Required for remove. Temporary create targets are refused. Forbidden for list.',
    },
    baseRef: {
      type: 'string',
      minLength: 1,
      description: 'create only; defaults to the source checkout HEAD. Forbidden for list/remove.',
    },
    newBranch: {
      type: 'string',
      minLength: 1,
      description:
        'create only; new local branch short name. Omit for detached creation. Forbidden for list/remove.',
    },
    timeoutMs: {
      type: 'integer',
      minimum: 1000,
      maximum: 600000,
      description: 'create/remove only; covers preparation and execution. Forbidden for list.',
    },
    permissions: {
      type: 'object',
      description:
        'create/remove only. A scope request still requires host authorization; omit this object for list.',
      additionalProperties: false,
      required: ['filesystem', 'network'],
      properties: {
        filesystem: { enum: ['workspace_write', 'full_access'] },
        network: { const: 'none' },
      },
    },
  },
  allOf: [
    {
      if: { properties: { action: { const: 'list' } }, required: ['action'] },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword contains data, not a Promise callback.
      then: { maxProperties: 1 },
    },
    {
      if: { properties: { action: { enum: ['create', 'remove'] } }, required: ['action'] },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword contains data, not a Promise callback.
      then: { required: ['key'] },
    },
    {
      if: { properties: { action: { const: 'remove' } }, required: ['action'] },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword contains data, not a Promise callback.
      then: {
        required: ['path'],
        not: { anyOf: [{ required: ['baseRef'] }, { required: ['newBranch'] }] },
      },
    },
  ],
};
export function jsonObject(value: unknown): value is Record<string, Json> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function closed(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}
export function strictText(value: unknown, maxBytes: number, nonempty = true): value is string {
  return (
    typeof value === 'string' &&
    (!nonempty || value.length > 0) &&
    !value.includes('\0') &&
    Buffer.byteLength(value) <= maxBytes &&
    Buffer.from(value).toString('utf8') === value
  );
}
function path(value: unknown): value is string {
  return strictText(value, limits.pathBytes) && isAbsolute(value);
}
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function parseGitWorktreeInput(input: unknown): GitWorktreeInput | null {
  if (
    !jsonObject(input) ||
    !closed(input, ['action', 'key', 'path', 'baseRef', 'newBranch', 'timeoutMs', 'permissions'])
  )
    return null;
  if (input.action === 'list') return Object.keys(input).length === 1 ? { action: 'list' } : null;
  if (input.action !== 'create' && input.action !== 'remove') return null;
  if (
    typeof input.key !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(input.key) ||
    (input.action === 'remove' ? !path(input.path) : 'path' in input && !path(input.path))
  )
    return null;
  if (input.action === 'remove' && ('baseRef' in input || 'newBranch' in input)) return null;
  if (input.baseRef !== undefined && !strictText(input.baseRef, 256)) return null;
  if (
    input.newBranch !== undefined &&
    (!strictText(input.newBranch, limits.payloadBytes) ||
      input.newBranch.startsWith('refs/') ||
      input.newBranch.startsWith('-') ||
      /@\{/.test(input.newBranch))
  )
    return null;
  if (
    'timeoutMs' in input &&
    (!Number.isInteger(input.timeoutMs) ||
      Number(input.timeoutMs) < 1000 ||
      Number(input.timeoutMs) > 600000)
  )
    return null;
  if (
    'permissions' in input &&
    (!jsonObject(input.permissions) ||
      !closed(input.permissions, ['filesystem', 'network']) ||
      !['workspace_write', 'full_access'].includes(String(input.permissions.filesystem)) ||
      input.permissions.network !== 'none')
  )
    return null;
  const common = {
    key: input.key,
    timeoutMs:
      typeof input.timeoutMs === 'number'
        ? input.timeoutMs
        : input.action === 'create'
          ? 120000
          : 60000,
    permissions: {
      filesystem: (jsonObject(input.permissions)
        ? input.permissions.filesystem
        : 'workspace_write') as 'workspace_write' | 'full_access',
      network: 'none' as const,
    },
  };
  return input.action === 'create'
    ? {
        action: 'create',
        ...common,
        ...(typeof input.path === 'string' ? { path: input.path } : {}),
        baseRef: (input.baseRef as string | undefined) ?? 'HEAD',
        ...(typeof input.newBranch === 'string' ? { newBranch: input.newBranch } : {}),
      }
    : { action: 'remove', ...common, path: input.path as string };
}
export function digest(value: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(value as Json))
    .digest('hex');
}
function identity(value: unknown): boolean {
  return (
    jsonObject(value) &&
    closed(value, ['dev', 'ino', 'ctimeNs', 'birthtimeNs']) &&
    ['dev', 'ino', 'ctimeNs', 'birthtimeNs'].every(
      (key) => typeof value[key] === 'string' && /^\d+$/.test(value[key] as string),
    )
  );
}
function validateEvidence(value: unknown, action: 'create' | 'remove'): boolean {
  if (!jsonObject(value) || !closed(value, ['repository', 'parent', 'target'])) return false;
  const repository = value.repository,
    parent = value.parent,
    target = value.target;
  if (
    !jsonObject(repository) ||
    !closed(repository, [
      'root',
      'gitDir',
      'commonDir',
      'bare',
      'rootIdentity',
      'commonIdentity',
    ]) ||
    !path(repository.root) ||
    !path(repository.gitDir) ||
    !path(repository.commonDir) ||
    typeof repository.bare !== 'boolean' ||
    !identity(repository.rootIdentity) ||
    !identity(repository.commonIdentity)
  )
    return false;
  if (
    !jsonObject(parent) ||
    !closed(parent, ['path', 'identity', 'defaultRoot', 'missingParents']) ||
    !path(parent.path) ||
    !identity(parent.identity)
  )
    return false;
  if (
    ('defaultRoot' in parent || 'missingParents' in parent) &&
    (action !== 'create' ||
      !path(parent.defaultRoot) ||
      !Array.isArray(parent.missingParents) ||
      parent.missingParents.length > 64 ||
      !parent.missingParents.every(path))
  )
    return false;
  if (action === 'create') return target === undefined;
  return (
    jsonObject(target) &&
    closed(target, [
      'identity',
      'pointerDigest',
      'adminGitDir',
      'adminIdentity',
      'head',
      'branch',
      'registrationDigest',
    ]) &&
    identity(target.identity) &&
    sha(target.pointerDigest) &&
    path(target.adminGitDir) &&
    identity(target.adminIdentity) &&
    typeof target.head === 'string' &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(target.head) &&
    (target.branch === null || strictText(target.branch, limits.payloadBytes)) &&
    sha(target.registrationDigest)
  );
}
export function validatePlan(value: unknown): value is WorktreePlan {
  if (
    !jsonObject(value) ||
    !closed(value, [
      'action',
      'sourceCwd',
      'sourceRoot',
      'commonDir',
      'targetPath',
      'baseRef',
      'baseOid',
      'newBranch',
      'evidence',
    ]) ||
    !['create', 'remove'].includes(String(value.action))
  )
    return false;
  if (
    !path(value.sourceCwd) ||
    !path(value.sourceRoot) ||
    !path(value.commonDir) ||
    !path(value.targetPath) ||
    !validateEvidence(value.evidence, value.action as 'create' | 'remove')
  )
    return false;
  if (value.baseRef !== undefined && !strictText(value.baseRef, 256)) return false;
  if (
    value.baseOid !== undefined &&
    (typeof value.baseOid !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.baseOid))
  )
    return false;
  if (value.newBranch !== undefined && !strictText(value.newBranch, limits.payloadBytes))
    return false;
  return (
    value.action !== 'create' ||
    (typeof value.baseRef === 'string' && typeof value.baseOid === 'string')
  );
}
export function validateRequest(value: unknown): value is WorktreeRequest {
  if (
    !jsonObject(value) ||
    !closed(value, [
      'schemaVersion',
      'configurationId',
      'operationToken',
      'phase',
      'sourceCwd',
      'git',
      'hooksPath',
      'input',
      'resolvedTarget',
      'plan',
      'planDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    !strictText(value.configurationId, 256) ||
    !sha(value.operationToken) ||
    !path(value.sourceCwd) ||
    !path(value.hooksPath)
  )
    return false;
  if (
    !jsonObject(value.git) ||
    !closed(value.git, ['path', 'sha256']) ||
    !path(value.git.path) ||
    !sha(value.git.sha256)
  )
    return false;
  if (
    !['list', 'prepare_create', 'create', 'prepare_remove', 'remove'].includes(String(value.phase))
  )
    return false;
  if (
    value.phase === 'list' ||
    value.phase === 'prepare_create' ||
    value.phase === 'prepare_remove'
  ) {
    const parsed = parseGitWorktreeInput(value.input);
    return (
      !!parsed &&
      canonicalJson(parsed as unknown as Json) === canonicalJson(value.input!) &&
      parsed.action ===
        (value.phase === 'list'
          ? 'list'
          : value.phase === 'prepare_create'
            ? 'create'
            : 'remove') &&
      (parsed.action === 'create' && parsed.path === undefined
        ? validateResolvedWorktreeTarget(value.resolvedTarget)
        : !('resolvedTarget' in value)) &&
      !('plan' in value) &&
      !('planDigest' in value)
    );
  }
  return (
    !('input' in value) &&
    !('resolvedTarget' in value) &&
    validatePlan(value.plan) &&
    value.plan.action === value.phase &&
    value.plan.sourceCwd === value.sourceCwd &&
    sha(value.planDigest) &&
    digest(value.plan) === value.planDigest
  );
}
export function decodeWorkerRequest(payload: string): WorktreeRequest {
  if (
    !/^[A-Za-z0-9_-]+$/.test(payload) ||
    payload.length > Math.ceil((limits.payloadBytes * 4) / 3)
  )
    throw new AgentError('worktree_protocol_error');
  const bytes = Buffer.from(payload, 'base64url');
  if (bytes.length > limits.payloadBytes || bytes.toString('base64url') !== payload)
    throw new AgentError('worktree_protocol_error');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new AgentError('worktree_protocol_error');
  }
  if (!validateRequest(value) || canonicalJson(value as unknown as Json) !== bytes.toString('utf8'))
    throw new AgentError('worktree_protocol_error');
  return value;
}
export function shellQuote(value: string): string {
  if (!strictText(value, Math.max(limits.pathBytes, limits.payloadBytes * 2)))
    throw new AgentError('worktree_protocol_error');
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
export function buildWorkerCommand(
  configuration: GitWorktreeConfiguration,
  request: WorktreeRequest,
): string {
  if (
    !validateRequest(request) ||
    request.configurationId !== configuration.configurationId ||
    request.sourceCwd !== configuration.sourceCwd ||
    request.git.path !== configuration.git.path ||
    request.git.sha256 !== configuration.git.sha256 ||
    request.hooksPath !== configuration.hooksPath ||
    (request.resolvedTarget !== undefined &&
      (!configuration.defaultRoot ||
        request.resolvedTarget.defaultRoot !== resolve(configuration.defaultRoot)))
  )
    throw new AgentError('worktree_protocol_error');
  const body = canonicalJson(request as unknown as Json);
  if (Buffer.byteLength(body) > limits.payloadBytes) throw new AgentError('inspection_limit');
  return [
    configuration.bunPath,
    '--no-env-file',
    `--config=${configuration.configPath}`,
    configuration.workerPath,
    Buffer.from(body).toString('base64url'),
  ]
    .map(shellQuote)
    .join(' ');
}
export function parseWorkerCommand(
  command: string,
  configuration: GitWorktreeConfiguration,
): WorktreeRequest | null {
  const prefix =
    [
      configuration.bunPath,
      '--no-env-file',
      `--config=${configuration.configPath}`,
      configuration.workerPath,
    ]
      .map(shellQuote)
      .join(' ') + ' ';
  if (!command.startsWith(prefix)) return null;
  const encoded = command.slice(prefix.length);
  if (!/^'[A-Za-z0-9_-]+'$/.test(encoded)) return null;
  try {
    const request = decodeWorkerRequest(encoded.slice(1, -1));
    return buildWorkerCommand(configuration, request) === command ? request : null;
  } catch {
    return null;
  }
}
function validateDetails(value: Record<string, Json>, phase: WorktreePhase): boolean {
  if (
    !closed(value, [
      'action',
      'observedAt',
      'cwdChanged',
      'mutation',
      'repository',
      'sourceWorktree',
      'worktrees',
      'path',
      'baseRef',
      'baseCommit',
      'head',
      'branch',
      'detached',
      'removed',
      'code',
      'message',
      'observed',
      'owner',
      'gitExitCode',
      'diagnostic',
    ])
  )
    return false;
  const action = phase === 'list' ? 'list' : phase.endsWith('create') ? 'create' : 'remove';
  if (
    value.action !== action ||
    value.cwdChanged !== false ||
    !strictText(value.observedAt, 128) ||
    !Number.isFinite(Date.parse(value.observedAt))
  )
    return false;
  for (const key of ['observedAt', 'baseRef', 'code', 'message', 'diagnostic'])
    if (value[key] !== undefined && !strictText(value[key], limits.frameBytes, false)) return false;
  for (const key of ['path', 'sourceWorktree'])
    if (value[key] !== undefined && !path(value[key])) return false;
  for (const key of ['baseCommit', 'head'])
    if (
      value[key] !== undefined &&
      value[key] !== null &&
      (typeof value[key] !== 'string' ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value[key] as string))
    )
      return false;
  if (
    value.branch !== undefined &&
    value.branch !== null &&
    !strictText(value.branch, limits.payloadBytes)
  )
    return false;
  for (const key of ['detached', 'removed'])
    if (value[key] !== undefined && typeof value[key] !== 'boolean') return false;
  if (value.gitExitCode !== undefined && !Number.isInteger(value.gitExitCode)) return false;
  if (
    value.repository !== undefined &&
    (!jsonObject(value.repository) ||
      !closed(value.repository, ['root', 'commonDir']) ||
      !path(value.repository.root) ||
      !path(value.repository.commonDir))
  )
    return false;
  if (
    value.observed !== undefined &&
    (!jsonObject(value.observed) ||
      !closed(value.observed, ['pathExists', 'registered', 'newBranchExists']) ||
      !['pathExists', 'registered'].every(
        (key) =>
          typeof value.observed === 'object' &&
          value.observed !== null &&
          !Array.isArray(value.observed) &&
          (typeof value.observed[key] === 'boolean' || value.observed[key] === 'unknown'),
      ) ||
      (value.observed.newBranchExists !== undefined &&
        typeof value.observed.newBranchExists !== 'boolean' &&
        value.observed.newBranchExists !== 'unknown'))
  )
    return false;
  if (
    value.owner !== undefined &&
    (!jsonObject(value.owner) ||
      !closed(value.owner, ['operationToken', 'nonce']) ||
      !sha(value.owner.operationToken) ||
      !strictText(value.owner.nonce, 128))
  )
    return false;
  if (value.worktrees !== undefined) {
    if (
      phase !== 'list' ||
      !Array.isArray(value.worktrees) ||
      value.worktrees.length > limits.listItems ||
      Buffer.byteLength(canonicalJson(value)) > limits.listBytes
    )
      return false;
    for (const tree of value.worktrees) {
      if (
        !jsonObject(tree) ||
        !closed(tree, [
          'path',
          'head',
          'branch',
          'detached',
          'bare',
          'isMain',
          'isCurrent',
          'locked',
          'lockReason',
          'prunable',
          'pruneReason',
        ]) ||
        !path(tree.path)
      )
        return false;
      if (
        tree.head !== null &&
        (typeof tree.head !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree.head))
      )
        return false;
      for (const key of ['branch', 'lockReason', 'pruneReason'])
        if (tree[key] !== null && !strictText(tree[key], limits.pathBytes, false)) return false;
      for (const key of ['detached', 'bare', 'isMain', 'isCurrent', 'locked', 'prunable'])
        if (typeof tree[key] !== 'boolean') return false;
    }
  }
  return true;
}
export function validateFrame(
  value: unknown,
  request: Pick<WorktreeRequest, 'operationToken' | 'phase'>,
): value is WorktreeFrame {
  if (
    !jsonObject(value) ||
    !closed(value, [
      'protocolVersion',
      'operationToken',
      'phase',
      'businessOutcome',
      'details',
      'plan',
      'planDigest',
    ]) ||
    value.protocolVersion !== 1 ||
    value.operationToken !== request.operationToken ||
    value.phase !== request.phase ||
    !jsonObject(value.details) ||
    !['prepared', 'succeeded', 'failed'].includes(String(value.businessOutcome))
  )
    return false;
  if (
    !['not_started', 'completed', 'partial', 'unknown'].includes(String(value.details.mutation)) ||
    !validateDetails(value.details, request.phase)
  )
    return false;
  if (
    (request.phase === 'list' || request.phase.startsWith('prepare_')) &&
    value.details.mutation !== 'not_started'
  )
    return false;
  if (value.businessOutcome === 'failed' && !strictText(value.details.code, 128)) return false;
  if (value.businessOutcome === 'succeeded') {
    const details = value.details;
    if (!jsonObject(details.repository)) return false;
    if (
      request.phase === 'list' &&
      (!path(details.sourceWorktree) || !Array.isArray(details.worktrees))
    )
      return false;
    if (
      request.phase === 'create' &&
      (!path(details.path) ||
        !strictText(details.baseRef, 256) ||
        typeof details.baseCommit !== 'string' ||
        typeof details.head !== 'string' ||
        details.baseCommit !== details.head ||
        typeof details.detached !== 'boolean' ||
        details.detached !== (details.branch === null) ||
        (details.branch !== null && typeof details.branch !== 'string') ||
        !jsonObject(details.observed) ||
        details.observed.pathExists !== true ||
        details.observed.registered !== true)
    )
      return false;
    if (
      request.phase === 'remove' &&
      (!path(details.path) ||
        typeof details.head !== 'string' ||
        details.removed !== true ||
        (details.branch !== null && typeof details.branch !== 'string') ||
        !jsonObject(details.observed) ||
        details.observed.pathExists !== false ||
        details.observed.registered !== false)
    )
      return false;
  }
  if (value.businessOutcome === 'prepared')
    return (
      (request.phase === 'prepare_create' || request.phase === 'prepare_remove') &&
      validatePlan(value.plan) &&
      value.plan.action === (request.phase === 'prepare_create' ? 'create' : 'remove') &&
      sha(value.planDigest) &&
      digest(value.plan) === value.planDigest
    );
  return (
    !('plan' in value) &&
    !('planDigest' in value) &&
    (value.businessOutcome !== 'succeeded' ||
      (request.phase === 'list'
        ? value.details.mutation === 'not_started'
        : !request.phase.startsWith('prepare_') && value.details.mutation === 'completed'))
  );
}
