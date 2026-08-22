import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  canonicalIdentityJson,
  type ProjectHandleV1,
  type ProjectIdentityV1,
} from '@kite/runtime-spi';

interface ProjectRecordV1 {
  readonly installationId: string;
  readonly projects: Record<string, ProjectIdentityV1>;
}

export interface ProjectIdentityStoreV1 {
  resolveOrCreate(workspace: string): Promise<ProjectIdentityV1>;
  issueHandle(input: {
    workspace: string;
    bootstrapIdentity: string;
    ttlMs?: number;
  }): Promise<ProjectHandleV1>;
  verifyHandle(input: {
    handle: ProjectHandleV1;
    workspace: string;
    now?: Date;
  }): Promise<ProjectIdentityV1>;
}

export function createProjectIdentityStoreV1(input: {
  path: string;
  installationId?: string;
}): ProjectIdentityStoreV1 {
  const installationId = input.installationId ?? `install_${randomUUID()}`;
  const digest = (workspace: string) =>
    `sha256:${createHash('sha256').update(workspace).digest('hex')}` as const;
  const read = async (): Promise<ProjectRecordV1> => {
    try {
      return JSON.parse(await readFile(input.path, 'utf8')) as ProjectRecordV1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { installationId, projects: {} };
    }
  };
  const write = async (record: ProjectRecordV1) => {
    await mkdir(dirname(input.path), { recursive: true });
    const temporary = `${input.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${canonicalIdentityJson(record)}\n`, { mode: 0o600 });
    await rename(temporary, input.path);
  };
  const withStoreLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const lockPath = `${input.path}.lock`;
    for (;;) {
      try {
        await mkdir(lockPath);
        try {
          return await operation();
        } finally {
          await rm(lockPath, { recursive: true, force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    }
  };
  const resolveOrCreate = async (workspace: string) => {
    if (!workspace) throw new Error('Workspace must be non-empty.');
    return withStoreLock(async () => {
      const workspaceDigest = digest(workspace);
      const record = await read();
      if (record.installationId !== installationId)
        throw new Error('Project identity installation mismatch.');
      const existing = record.projects[workspaceDigest];
      if (existing) return Object.freeze(existing);
      const project = Object.freeze({
        projectId: `project_${randomUUID()}`,
        revision: 1,
        workspaceDigest,
      }) as ProjectIdentityV1;
      await write({ ...record, projects: { ...record.projects, [workspaceDigest]: project } });
      return project;
    });
  };
  const issueHandle = async ({
    workspace,
    bootstrapIdentity,
    ttlMs = 300_000,
  }: {
    workspace: string;
    bootstrapIdentity: string;
    ttlMs?: number;
  }) => {
    const project = await resolveOrCreate(workspace);
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + ttlMs).toISOString();
    const unsigned = {
      version: 1 as const,
      installationId,
      project,
      canonicalWorkspaceDigest: digest(workspace),
      bootstrapIdentity,
      issuedAt: issuedAt.toISOString(),
      expiresAt,
      nonce: randomUUID(),
    };
    const authenticator =
      `sha256:${createHash('sha256').update(canonicalIdentityJson(unsigned)).digest('hex')}` as const;
    return Object.freeze({ ...unsigned, authenticator });
  };
  const verifyHandle = async ({
    handle,
    workspace,
    now = new Date(),
  }: {
    handle: ProjectHandleV1;
    workspace: string;
    now?: Date;
  }): Promise<ProjectIdentityV1> => {
    const expected = await resolveOrCreate(workspace);
    const unsigned = { ...handle, authenticator: undefined };
    delete (unsigned as { authenticator?: unknown }).authenticator;
    const auth = `sha256:${createHash('sha256').update(canonicalIdentityJson(unsigned)).digest('hex')}`;
    if (
      handle.installationId !== installationId ||
      handle.canonicalWorkspaceDigest !== digest(workspace) ||
      handle.authenticator !== auth ||
      new Date(handle.expiresAt) <= now ||
      handle.project.projectId !== expected.projectId
    )
      throw new Error('Invalid or stale ProjectHandle.');
    return expected;
  };
  return { resolveOrCreate, issueHandle, verifyHandle };
}
