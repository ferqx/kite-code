import { mock } from 'bun:test';
import * as fs from 'node:fs';
import {
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as promises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalOpen = promises.open;
const originalClose = closeSync;
const originalOpenSync = openSync;
const originalFS = { ...fs };
const originalPromises = { ...promises };
const root = mkdtempSync(join(tmpdir(), 'kite-knowledge-custody-'));
const handles: { handle: promises.FileHandle; close(): Promise<void>; attempts: number }[] = [];
const descriptors: { fd: number; attempts: number }[] = [];
const cleanupError = Error('original acquired knowledge close rejected');
mock.module('node:fs/promises', () => ({
  ...originalPromises,
  async open(path: string, flags: number) {
    const handle = await originalOpen(path, flags);
    const entry = { handle, close: handle.close.bind(handle), attempts: 0 };
    handles.push(entry);
    handle.close = async () => {
      entry.attempts++;
      throw cleanupError;
    };
    return handle;
  },
}));
mock.module('node:fs', () => ({
  ...originalFS,
  openSync(path: string, flags: number) {
    const fd = originalOpenSync(path, flags);
    descriptors.push({ fd, attempts: 0 });
    return fd;
  },
  closeSync(fd: number) {
    const entry = descriptors.find((value) => value.fd === fd);
    if (!entry) return originalClose(fd);
    entry.attempts++;
    throw cleanupError;
  },
}));
const { createKnowledgeReadScope, KnowledgeReadCleanupError } = await import('../../src/sources');
const { createProjectSources } = await import('../../src/sources');
const { createSkillSource } = await import('../../src/skills');
const { compileSkillWorkflow } = await import('../../src/skills/workflow-contract');
const originalError = Error('original read failure after actual bytes');
try {
  writeFileSync(join(root, 'AGENTS.md'), 'Original instruction 中🙂');
  writeFileSync(
    join(root, 'SKILL.md'),
    '---\nname: real-knowledge\ndescription: complete body\n---\nActual Skill body 中🙂',
  );
  const scope = createKnowledgeReadScope();
  const firstPending = scope
    .run((files) =>
      files.read(join(root, 'AGENTS.md'), constants.O_RDONLY, async (handle) => {
        const bytes = Buffer.alloc(100);
        await handle.read(bytes, 0, bytes.length, 0);
        throw originalError;
      }),
    )
    .catch((error: unknown) => error);
  const secondPending = scope
    .run((files) =>
      files.read(join(root, 'AGENTS.md'), constants.O_RDONLY, async (handle) => {
        const bytes = Buffer.alloc(100);
        await handle.read(bytes, 0, bytes.length, 0);
        throw originalError;
      }),
    )
    .catch((error: unknown) => error);
  const [first, second] = await Promise.all([firstPending, secondPending]);
  const syncScope = createKnowledgeReadScope();
  let syncError: unknown;
  try {
    syncScope.runSync((files) =>
      files.readSync(join(root, 'AGENTS.md'), constants.O_RDONLY, (fd) => {
        readSync(fd, Buffer.alloc(100), 0, 100, 0);
        throw originalError;
      }),
    );
  } catch (error) {
    syncError = error;
  }
  const project = createProjectSources({ workspaceRoot: async () => root });
  const projectError = await project
    .capture({ sessionId: 's', workspaceId: 'w', definitionId: 'files.read', input: {} })
    .catch((error: unknown) => error);
  const skills = createSkillSource({ trustedRoots: [root], locations: [root] });
  const skillError = await skills.list().catch((error: unknown) => error);
  const workflowScope = createKnowledgeReadScope();
  let workflowError: unknown;
  try {
    compileSkillWorkflow({ skillDir: root, source: 'project', origin: '.agents' }, workflowScope);
  } catch (error) {
    workflowError = error;
  }
  const closing = scope.dispose();
  const closedError = await closing.catch((error: unknown) => error);
  const syncClosedError = await syncScope.dispose().catch((error: unknown) => error);
  const originalHandle = handles[0]!.handle;
  const buffer = Buffer.alloc(100);
  const read = await originalHandle.read(buffer, 0, buffer.length, 0);
  const syncBytes = Buffer.alloc(100);
  const syncRead = readSync(descriptors[0]!.fd, syncBytes, 0, syncBytes.length, 0);
  const details = (error: unknown) =>
    error instanceof KnowledgeReadCleanupError ? error.cause : undefined;
  console.log(
    JSON.stringify({
      asyncTyped: first instanceof KnowledgeReadCleanupError,
      asyncOriginal: details(first)?.originalError === originalError,
      asyncCleanup: details(first)?.cleanupError === cleanupError,
      asyncResource: handles.some(
        (entry) => entry.handle === (details(first)?.resources as { resource?: unknown })?.resource,
      ),
      syncTyped: syncError instanceof KnowledgeReadCleanupError,
      syncOriginal: details(syncError)?.originalError === originalError,
      syncCleanup: details(syncError)?.cleanupError === cleanupError,
      syncResource:
        (details(syncError)?.resources as { resource?: unknown })?.resource === descriptors[0]!.fd,
      firstFailurePreserved:
        (closedError === first || closedError === second) && syncClosedError === syncError,
      concurrentCustody:
        first instanceof KnowledgeReadCleanupError &&
        second instanceof KnowledgeReadCleanupError &&
        first !== second &&
        (details(first)?.resources as { scope?: unknown })?.scope === scope &&
        (details(second)?.resources as { scope?: unknown })?.scope === scope,
      cachedDisposal: scope.dispose() === closing,
      privateCause: !Object.keys(first as object).includes('cause'),
      projectTyped: projectError instanceof KnowledgeReadCleanupError,
      skillTyped: skillError instanceof KnowledgeReadCleanupError,
      workflowTyped: workflowError instanceof KnowledgeReadCleanupError,
      retainedText: buffer.subarray(0, read.bytesRead).toString('utf8'),
      retainedSyncText: syncBytes.subarray(0, syncRead).toString('utf8'),
      asyncAttempts: handles.map((entry) => entry.attempts),
      syncAttempts: descriptors.map((entry) => entry.attempts),
    }),
  );
} finally {
  // Fixture-only custody cleanup after reporting. The production scopes remain rejected.
  await Promise.all(handles.map((entry) => entry.close()));
  for (const entry of descriptors) originalClose(entry.fd);
  rmSync(root, { recursive: true, force: true });
}
