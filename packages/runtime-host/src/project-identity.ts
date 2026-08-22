import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  canonicalIdentityJson,
  type ProjectHandleV1,
  type ProjectIdentityV1,
} from '@kite/runtime-spi';

const PROJECT_IDENTITY_STORE_SCHEMA_V1 = 'kite.project-identity-store.v1' as const;
const PROJECT_HANDLE_DOMAIN_V1 = 'kite.project-handle.v1\0';
const PROJECT_IDENTITY_STORE_DOMAIN_V1 = 'kite.project-identity-store.v1\0';

interface ProjectRecordV1 {
  readonly schema: typeof PROJECT_IDENTITY_STORE_SCHEMA_V1;
  readonly installationId: string;
  readonly projects: Record<string, ProjectIdentityV1>;
  readonly revokedHandleNonces: readonly string[];
  readonly authenticator: `hmac-sha256:${string}`;
}

export interface ProjectIdentityStoreV1 {
  resolveOrCreate(workspace: string): Promise<ProjectIdentityV1>;
  resolveOrCreateSync(workspace: string): ProjectIdentityV1;
  issueHandle(input: {
    workspace: string;
    bootstrapIdentity: string;
    ttlMs?: number;
  }): Promise<ProjectHandleV1>;
  issueHandleSync(input: {
    workspace: string;
    bootstrapIdentity: string;
    ttlMs?: number;
  }): ProjectHandleV1;
  verifyHandle(input: {
    handle: ProjectHandleV1;
    workspace: string;
    now?: Date;
  }): Promise<ProjectIdentityV1>;
  verifyHandleSync(input: {
    handle: ProjectHandleV1;
    workspace: string;
    now?: Date;
  }): ProjectIdentityV1;
  revokeHandle(nonce: string): Promise<void>;
  revokeHandleSync(nonce: string): void;
}

export function createProjectIdentityStoreV1(input: {
  path: string;
  installationId: string;
  keyId: `sha256:${string}`;
  authenticatorKey: Uint8Array;
  platform?: NodeJS.Platform;
  secureWindowsPath?: (path: string) => void;
}): ProjectIdentityStoreV1 {
  const platform = input.platform ?? process.platform;
  if (!input.path || !input.installationId || input.authenticatorKey.byteLength !== 32) {
    throw new Error('Project identity authority configuration is invalid.');
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.keyId)) {
    throw new Error('Project identity key id is invalid.');
  }
  if (platform === 'win32' && !input.secureWindowsPath) {
    throw new Error('Project identity authority requires an owner-only Windows ACL mechanism.');
  }
  const storePath = resolve(input.path);
  const installationId = input.installationId;
  const emptyRecord = (): ProjectRecordV1 =>
    signRecord({
      schema: PROJECT_IDENTITY_STORE_SCHEMA_V1,
      installationId,
      projects: {},
      revokedHandleNonces: [],
    });

  const canonicalWorkspace = (workspace: string): string => {
    if (!workspace) throw new Error('Workspace must be non-empty.');
    return realpathSync.native(resolve(workspace));
  };
  const workspaceDigest = (workspace: string) =>
    `sha256:${createHash('sha256').update(canonicalWorkspace(workspace)).digest('hex')}` as const;
  const authenticate = (value: unknown): `hmac-sha256:${string}` =>
    `hmac-sha256:${createHmac('sha256', input.authenticatorKey)
      .update(PROJECT_HANDLE_DOMAIN_V1)
      .update(canonicalIdentityJson(value))
      .digest('hex')}`;
  const signRecord = (
    record: Omit<ProjectRecordV1, 'authenticator'> | ProjectRecordV1,
  ): ProjectRecordV1 => {
    const unsigned = Object.fromEntries(
      Object.entries(record).filter(([field]) => field !== 'authenticator'),
    ) as Omit<ProjectRecordV1, 'authenticator'>;
    const authenticator = `hmac-sha256:${createHmac('sha256', input.authenticatorKey)
      .update(PROJECT_IDENTITY_STORE_DOMAIN_V1)
      .update(canonicalIdentityJson(unsigned))
      .digest('hex')}` as const;
    return { ...unsigned, authenticator };
  };

  const read = (): ProjectRecordV1 => {
    if (!existsSync(storePath)) return emptyRecord();
    if (platform === 'win32') input.secureWindowsPath!(storePath);
    assertPrivateRegularFile(storePath, platform);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(storePath, 'utf8'));
    } catch (error) {
      throw new Error('Project identity store is corrupted.', { cause: error });
    }
    const record = parseProjectRecord(parsed);
    if (record.installationId !== installationId) {
      throw new Error('Project identity installation mismatch.');
    }
    if (!constantTimeEqual(record.authenticator, signRecord(record).authenticator)) {
      throw new Error('Project identity store authenticator mismatch.');
    }
    return record;
  };

  const write = (record: ProjectRecordV1): void => {
    bindPrivateDirectory(dirname(storePath), platform, input.secureWindowsPath);
    const temporary = `${storePath}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0)),
        0o600,
      );
      writeFileSync(descriptor, `${canonicalIdentityJson(record)}\n`, 'utf8');
      fsyncSync(descriptor);
      if (platform !== 'win32') chmodSync(temporary, 0o600);
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.nlink !== 1) {
        throw new Error('Project identity temporary file is unsafe.');
      }
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, storePath);
      if (platform === 'win32') input.secureWindowsPath!(storePath);
      fsyncDirectory(dirname(storePath), platform);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporary, { force: true });
    }
    assertPrivateRegularFile(storePath, platform);
  };

  const withStoreLock = <T>(operation: () => T): T => {
    bindPrivateDirectory(dirname(storePath), platform, input.secureWindowsPath);
    const lockPath = `${storePath}.lock`;
    let acquired = false;
    for (let attempt = 0; attempt < 2_500; attempt += 1) {
      try {
        mkdirSync(lockPath, { mode: 0o700 });
        acquired = true;
        break;
      } catch (error) {
        if (!isFsError(error, 'EEXIST')) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
    }
    if (!acquired) throw new Error('Project identity store lock did not settle; failing closed.');
    try {
      if (platform !== 'win32') chmodSync(lockPath, 0o700);
      else input.secureWindowsPath!(lockPath);
      return operation();
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
  };

  const resolveOrCreateSync = (workspace: string): ProjectIdentityV1 =>
    withStoreLock(() => {
      const digest = workspaceDigest(workspace);
      const record = read();
      const existing = record.projects[digest];
      if (existing) return Object.freeze(existing);
      const project = Object.freeze({
        projectId: `project_${randomUUID()}`,
        revision: 1,
        workspaceDigest: digest,
      }) satisfies ProjectIdentityV1;
      write(signRecord({ ...record, projects: { ...record.projects, [digest]: project } }));
      return project;
    });

  const issueHandleSync = ({
    workspace,
    bootstrapIdentity,
    ttlMs = 300_000,
  }: {
    workspace: string;
    bootstrapIdentity: string;
    ttlMs?: number;
  }): ProjectHandleV1 => {
    if (!bootstrapIdentity || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 300_000) {
      throw new Error('ProjectHandle issuance input is invalid.');
    }
    const project = resolveOrCreateSync(workspace);
    const issuedAt = new Date();
    const unsigned = {
      version: 1 as const,
      installationId,
      keyId: input.keyId,
      project,
      canonicalWorkspaceDigest: workspaceDigest(workspace),
      bootstrapIdentity,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString(),
      nonce: randomUUID(),
    };
    return Object.freeze({ ...unsigned, authenticator: authenticate(unsigned) });
  };

  const verifyHandleSync = ({
    handle,
    workspace,
    now = new Date(),
  }: {
    handle: ProjectHandleV1;
    workspace: string;
    now?: Date;
  }): ProjectIdentityV1 => {
    assertExactProjectHandle(handle);
    const digest = workspaceDigest(workspace);
    const record = read();
    const expected = record.projects[digest];
    if (!expected) throw new Error('Project identity is unknown; verification cannot create it.');
    const issuedAt = Date.parse(handle.issuedAt);
    const expiresAt = Date.parse(handle.expiresAt);
    const unsigned = Object.fromEntries(
      Object.entries(handle).filter(([field]) => field !== 'authenticator'),
    );
    const expectedAuthenticator = authenticate(unsigned);
    if (
      handle.installationId !== installationId ||
      handle.keyId !== input.keyId ||
      handle.canonicalWorkspaceDigest !== digest ||
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > 300_000 ||
      expiresAt <= now.getTime() ||
      record.revokedHandleNonces.includes(handle.nonce) ||
      handle.project.projectId !== expected.projectId ||
      handle.project.revision !== expected.revision ||
      handle.project.workspaceDigest !== expected.workspaceDigest ||
      !constantTimeEqual(handle.authenticator, expectedAuthenticator)
    ) {
      throw new Error('Invalid, expired, revoked, or stale ProjectHandle.');
    }
    return Object.freeze(expected);
  };

  const revokeHandleSync = (nonce: string): void => {
    if (!nonce) throw new Error('ProjectHandle nonce must be non-empty.');
    withStoreLock(() => {
      const record = read();
      if (record.revokedHandleNonces.includes(nonce)) return;
      write(signRecord({ ...record, revokedHandleNonces: [...record.revokedHandleNonces, nonce] }));
    });
  };

  return Object.freeze({
    resolveOrCreate: async (workspace: string) => resolveOrCreateSync(workspace),
    resolveOrCreateSync,
    issueHandle: async (handleInput: Parameters<ProjectIdentityStoreV1['issueHandle']>[0]) =>
      issueHandleSync(handleInput),
    issueHandleSync,
    verifyHandle: async (handleInput: Parameters<ProjectIdentityStoreV1['verifyHandle']>[0]) =>
      verifyHandleSync(handleInput),
    verifyHandleSync,
    revokeHandle: async (nonce: string) => revokeHandleSync(nonce),
    revokeHandleSync,
  });
}

function parseProjectRecord(value: unknown): ProjectRecordV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'authenticator',
      'installationId',
      'projects',
      'revokedHandleNonces',
      'schema',
    ])
  ) {
    throw new Error('Project identity store has an invalid shape.');
  }
  if (
    value.schema !== PROJECT_IDENTITY_STORE_SCHEMA_V1 ||
    typeof value.installationId !== 'string' ||
    !value.installationId ||
    !isRecord(value.projects) ||
    !Array.isArray(value.revokedHandleNonces) ||
    value.revokedHandleNonces.some((nonce) => typeof nonce !== 'string' || !nonce) ||
    typeof value.authenticator !== 'string' ||
    !/^hmac-sha256:[a-f0-9]{64}$/u.test(value.authenticator)
  ) {
    throw new Error('Project identity store has invalid fields.');
  }
  const projects: Record<string, ProjectIdentityV1> = {};
  for (const [digest, project] of Object.entries(value.projects)) {
    if (
      !/^sha256:[a-f0-9]{64}$/u.test(digest) ||
      !isProjectIdentity(project) ||
      project.workspaceDigest !== digest
    ) {
      throw new Error('Project identity store contains an invalid project.');
    }
    projects[digest] = project;
  }
  return {
    schema: PROJECT_IDENTITY_STORE_SCHEMA_V1,
    installationId: value.installationId,
    projects,
    revokedHandleNonces: [...new Set(value.revokedHandleNonces as string[])],
    authenticator: value.authenticator as `hmac-sha256:${string}`,
  };
}

function assertExactProjectHandle(value: ProjectHandleV1): void {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'authenticator',
      'bootstrapIdentity',
      'canonicalWorkspaceDigest',
      'expiresAt',
      'installationId',
      'issuedAt',
      'keyId',
      'nonce',
      'project',
      'version',
    ]) ||
    value.version !== 1 ||
    typeof value.installationId !== 'string' ||
    typeof value.keyId !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.keyId) ||
    !isProjectIdentity(value.project) ||
    typeof value.canonicalWorkspaceDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.canonicalWorkspaceDigest) ||
    typeof value.bootstrapIdentity !== 'string' ||
    !value.bootstrapIdentity ||
    typeof value.issuedAt !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    typeof value.nonce !== 'string' ||
    !value.nonce ||
    typeof value.authenticator !== 'string' ||
    !/^hmac-sha256:[a-f0-9]{64}$/u.test(value.authenticator)
  ) {
    throw new Error('ProjectHandle has an invalid shape.');
  }
}

function isProjectIdentity(value: unknown): value is ProjectIdentityV1 {
  return (
    isRecord(value) &&
    exactKeys(value, ['projectId', 'revision', 'workspaceDigest']) &&
    typeof value.projectId === 'string' &&
    value.projectId.startsWith('project_') &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) > 0 &&
    typeof value.workspaceDigest === 'string' &&
    /^sha256:[a-f0-9]{64}$/u.test(value.workspaceDigest)
  );
}

function bindPrivateDirectory(
  path: string,
  platform: NodeJS.Platform,
  secureWindowsPath?: (path: string) => void,
): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Project identity store directory is unsafe.');
  }
  if (platform !== 'win32') {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('Project identity store directory has another owner.');
    }
    chmodSync(path, 0o700);
  } else secureWindowsPath!(path);
}

function assertPrivateRegularFile(path: string, platform: NodeJS.Platform): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error('Project identity store file is unsafe.');
  }
  if (platform !== 'win32') {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('Project identity store file has another owner.');
    }
    if ((stat.mode & 0o777) !== 0o600) {
      throw new Error('Project identity store file is not owner-only.');
    }
  }
}

function fsyncDirectory(path: string, platform: NodeJS.Platform): void {
  if (platform === 'win32') return;
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
