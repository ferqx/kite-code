import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { Json } from '@kite-ai/agent/extensions';
import {
  collectProfileGarbage,
  createProfileBackup,
  inspectProfileBackup,
  restoreProfileBackup,
} from '@kite-ai/agent/maintenance';
import type { PermissionMode } from '@kite-ai/agent/permissions';
import { type PlanningOptions, planningExtensionId } from '@kite-ai/agent/planning';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { simplePdf } from '../../../../tests/fixtures/pdf';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { createPermissionManagement } from '../../src/permission-management';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

type Call = { name: string; input: Json } | null;
async function until<T>(read: () => Promise<T | null>) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const found = await read();
    if (found !== null) return found;
    if (Date.now() > deadline) throw new Error('planning_configuration_deadline');
    await Bun.sleep(5);
  }
}
async function fixture(
  planning: PlanningOptions,
  toolIds: string[],
  script: (step: number, f: Fixture) => Promise<Call>,
  policy?: { mode: PermissionMode; trusted?: boolean; exclude?: string[] },
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-default-planning-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  privateDirectory(profile.profilePath);
  const requests: Record<string, unknown>[] = [];
  const steps = new Map<string, number>();
  let currentCommand = 'work';
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request): Promise<Response> {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      let review = false;
      try {
        const messages = body.messages as { role: string; content: string }[];
        review = messages.some((message) => {
          if (message.role !== 'user') return false;
          try {
            return JSON.parse(message.content).purpose === 'authorization_check';
          } catch {
            return false;
          }
        });
      } catch {}
      const step = steps.get(currentCommand) ?? 0;
      if (!review) steps.set(currentCommand, step + 1);
      const call: Call = review ? null : await script(step, f);
      const chunk = {
        id: 'response',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'local',
        choices: [
          {
            index: 0,
            delta: call
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call-${requests.length}`,
                      type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.input) },
                    },
                  ],
                }
              : {
                  content: review
                    ? JSON.stringify({ decision: 'approve_once', reason: 'exact fixture call' })
                    : 'finished',
                },
            finish_reason: null,
          },
        ],
      };
      const finish = {
        ...chunk,
        choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const configurationPath = join(profile.profilePath, 'config.jsonc');
  const configuration = {
    modelId: 'local',
    models: [
      {
        id: 'local',
        provider: 'compatible',
        model: 'local',
        baseURL: `http://127.0.0.1:${provider.port}/v1`,
      },
    ],
    tools: toolIds.map((id) => ({
      id,
      definitionVersion:
        id === 'files.read' ? '5' : ['files.write', 'files.edit'].includes(id) ? '2' : '1',
    })),
    planning: { requirePlan: true },
  };
  writeFileSync(configurationPath, JSON.stringify(configuration));
  function createHost() {
    return createDefaultProcessConfiguration({
      userConfigurationPath: configurationPath,
      profile,
      planning,
      ...(policy
        ? {
            permissionPolicy: {
              readPolicy: () => ({
                mode: policy.mode,
                workspaceTrust: policy.trusted ?? true,
                revision: 'actual-business-host-1',
                allowed: [
                  { kind: 'model' as const, definitionId: 'local', definitionVersion: '1' },
                  ...toolIds
                    .filter((id) => !policy.exclude?.includes(id))
                    .map((id) => ({
                      kind: 'tool' as const,
                      definitionId: id,
                      definitionVersion:
                        id === 'files.read'
                          ? '5'
                          : ['files.write', 'files.edit'].includes(id)
                            ? '2'
                            : '1',
                    })),
                  ...['planning.write', 'planning.review', 'planning.update'].map((id) => ({
                    kind: 'job' as const,
                    definitionId: `${planningExtensionId}/${id}`,
                    definitionVersion: '1',
                  })),
                ],
              }),
            },
          }
        : {
            permissions: {
              async authorize() {
                return { allowed: true, revision: 'explicit-test-host' };
              },
            },
          }),
    });
  }
  let host = createHost();
  let store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  let expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'user' };
  let workspaceSerialLocks = createWorkspaceSerialLocks(profile);
  let runtime = createRuntime({
    store,
    artifacts: createArtifactStore({
      profile: { dataRoot: profile.dataRoot, profile: profile.profile },
      store,
    }),
    workspaceSerialLocks,
    permissions: host.permissions!,
    extensions: host.extensions,
    resolveRunConfiguration: host.resolveRunConfiguration,
  });
  host.permissionManagement?.(runtime);
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'private',
    rootUri: pathToFileURL(workspace).href,
  });
  await runtime.createSession({
    ...base,
    commandId: 'create',
    workspaceId: 'w',
    title: 'planning',
  });
  await initializeLivePermissionFixture({
    runtime,
    profile,
    ...base,
    workspaceId: 'w',
    mode: policy?.mode ?? 'full',
    trusted: policy?.trusted ?? true,
  });
  const f = {
    root,
    workspace,
    configurationPath,
    profile,
    get workspaceSerialLocks() {
      return workspaceSerialLocks;
    },
    configuration,
    get store() {
      return store;
    },
    get runtime() {
      return runtime;
    },
    requests,
    base,
    get commandId() {
      return currentCommand;
    },
    async runId() {
      const command = await store.getCommand(currentCommand);
      const receipt = command?.receipt as Record<string, Json> | null;
      return (await store.listExecutions('s')).find(
        (x) =>
          x.originCommandId === (receipt?.businessCommandId ?? currentCommand) && x.runId !== null,
      )!.runId!;
    },
    async record(key: string) {
      return store.getExtensionRecord({ sessionId: 's', extensionId: planningExtensionId, key });
    },
    async submit(commandId = 'work', sessionId = 's') {
      currentCommand = commandId;
      return runtime.submitCommand({
        ...base,
        sessionId,
        commandId,
        request: { kind: 'run.start', content: `New task: ${commandId}` },
      });
    },
    async done(commandId = currentCommand) {
      const command = await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
      const receipt = command.receipt as Record<string, Json> | null;
      return { command, run: receipt?.runId ? await store.getRun(String(receipt.runId)) : null };
    },
    async answer(kind: 'plan_review' | 'question') {
      const card = await until(
        async () =>
          (
            await store.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' })
          ).interactions.find((x) => x.kind === kind) ?? null,
      );
      await runtime.answerInteraction({
        ...base,
        commandId: `answer-${card.id}`,
        presentationSessionId: 's',
        interactionId: card.id,
        expectedRevision: card.revision,
        answer:
          kind === 'question'
            ? { kind, answers: { waive: true } }
            : { kind, decision: 'approve', mode: 'auto' },
      });
      return card;
    },
    async reopen() {
      await runtime.close();
      await workspaceSerialLocks.close();
      host = createHost();
      store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      expectedStoreId = (await store.getMetadata()).storeId;
      base.expectedStoreId = expectedStoreId;
      workspaceSerialLocks = createWorkspaceSerialLocks(profile);
      runtime = createRuntime({
        store,
        artifacts: createArtifactStore({
          profile: { dataRoot: profile.dataRoot, profile: profile.profile },
          store,
        }),
        workspaceSerialLocks,
        permissions: host.permissions!,
        extensions: host.extensions,
        resolveRunConfiguration: host.resolveRunConfiguration,
      });
      host.permissionManagement?.(runtime);
      const controls = createPermissionManagement({ runtime, profile });
      const mode = await controls.readMode(base);
      await controls.setMode({
        ...base,
        commandId: `restored-mode-${expectedStoreId}`,
        mode: policy?.mode ?? 'full',
        makeDefault: false,
        ifRevision: mode.revision,
        ifDefaultRevision: mode.defaultRevision,
      });
      const trust = await controls.readTrust({ ...base, workspaceId: 'w' });
      await controls.setTrust({
        ...base,
        workspaceId: 'w',
        commandId: `restored-trust-${expectedStoreId}`,
        trusted: policy?.trusted ?? true,
        ifRevision: trust.revision,
        canonicalIdentity: trust.canonicalIdentity,
        externalReadScopeDigest: trust.externalReadScopeDigest,
      });
    },
    async close() {
      try {
        await runtime.close();
      } finally {
        try {
          await workspaceSerialLocks.close();
        } finally {
          provider.stop(true);
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  };
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

test('external Plan drift during review rejects late approval and blocks workspace effects', async () => {
  const f = await fixture(
    { requirePlan: true },
    ['planning.write', 'planning.review', 'files.write'],
    async (step, f): Promise<Call> => {
      if (step === 0)
        return {
          name: 'write_plan',
          input: {
            plan_id: 'late',
            expected_version: null,
            title: 'Review race',
            body: 'Review these exact bytes',
            steps: [{ id: 'a', title: 'Write output' }],
          },
        };
      const current = (await f.record('plan.current'))!.value as Record<string, Json>;
      if (step === 1)
        return {
          name: 'request_plan_review',
          input: { plan_id: current.planId!, version: current.version!, digest: current.digest! },
        };
      if (step === 2)
        return {
          name: 'write_file',
          input: { path: 'must-not-exist.txt', content: 'forbidden stale effect', base: null },
        };
      return null;
    },
    { mode: 'full' },
  );
  try {
    await f.submit();
    await until(
      async () =>
        (
          await f.store.listInteractions({
            expectedStoreId: f.base.expectedStoreId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions.find((value) => value.kind === 'plan_review') ?? null,
    );
    const plan = (await f.record('plan/late/1'))!.value as Record<string, Json>;
    writeFileSync(
      join(f.profile.profilePath, String((plan.file as Record<string, Json>).path)),
      'Unreviewed external bytes',
    );
    await f.answer('plan_review');
    await until(
      async () =>
        (await f.store.listExecutions('s')).find(
          (value) =>
            value.definitionId === 'planning.review' &&
            ['failed', 'cancelled', 'outcome_unknown'].includes(value.status),
        ) ?? null,
    );
    await f.done();
    expect(
      (await f.store.listExecutions('s')).filter(
        (value) => value.definitionId === 'files.write' && value.status === 'succeeded',
      ),
    ).toHaveLength(0);
    expect(existsSync(join(f.workspace, 'must-not-exist.txt'))).toBe(false);
    const review = (await f.store.listExecutions('s')).find(
      (value) => value.definitionId === 'planning.review',
    )!;
    expect(review.status).not.toBe('succeeded');
  } finally {
    await f.close();
  }
}, 15000);

test('Fork materializes an independent output from the selected immutable delivery', async () => {
  let branch = false,
    sourcePath = '',
    forkPath = '';
  const f = await fixture(
    {},
    ['files.read', 'files.write'],
    async (step, f): Promise<Call> => {
      if (!branch) {
        const hash = (value: string) => createHash('sha256').update(value).digest('hex');
        sourcePath = join(
          f.profile.profilePath,
          'files',
          hash(f.base.expectedStoreId),
          hash('s'),
          'outputs',
          'fork.md',
        );
        return step === 0
          ? {
              name: 'write_file',
              input: { path: sourcePath, content: 'Selected delivery', base: null },
            }
          : null;
      }
      const views = await f.runtime.queryExtension({
        ...f.base,
        sessionId: 'fork',
        extensionId: 'builtin.files',
        queryId: 'files.outputs',
        input: {},
      });
      const files = views[0]!.payload as { value: { path: string } }[];
      forkPath = join(f.profile.profilePath, files[0]!.value.path);
      if (step === 0) return { name: 'read_file', input: { path: forkPath } };
      if (step === 1) {
        const read = (await f.store.listExecutions('fork')).find(
          (x) => x.definitionId === 'files.read',
        )!;
        expect({ status: read.status, result: read.result }).toMatchObject({ status: 'succeeded' });
        const value = JSON.parse(String((read.result as Record<string, Json>).content));
        expect(value.content).toBe('Selected delivery');
        return {
          name: 'write_file',
          input: { path: forkPath, content: 'Branch edit', base: value.baseline },
        };
      }
      return null;
    },
    { mode: 'full' },
  );
  try {
    await f.submit();
    expect((await f.done()).run?.status).toBe('completed');
    // A subsequent external source edit is not the selected historical delivery.
    writeFileSync(sourcePath, 'Later source bytes');
    await f.runtime.forkSession({
      expectedStoreId: f.base.expectedStoreId,
      subjectId: 'user',
      commandId: 'fork-files',
      sourceSessionId: 's',
      expectedContextSelectionId: (await f.store.getSession('s'))!.contextSelectionId,
      newSessionId: 'fork',
      title: 'Fork',
    });
    branch = true;
    await f.submit('branch', 'fork');
    expect((await f.done()).run?.status).toBe('completed');
    expect(forkPath).not.toBe(sourcePath);
    const write = (await f.store.listExecutions('fork')).find(
      (x) => x.definitionId === 'files.write',
    )!;
    expect({ status: write.status, result: write.result }).toMatchObject({ status: 'succeeded' });
    expect(readFileSync(forkPath, 'utf8')).toBe('Branch edit');
    expect(readFileSync(sourcePath, 'utf8')).toBe('Later source bytes');
  } finally {
    await f.close();
  }
}, 20000);

test('uploaded PDF pages flow through the exact file tool result to the next model input', async () => {
  let path = '';
  const f = await fixture(
    {},
    ['files.read'],
    async (step, f): Promise<Call> => {
      if (step === 0) return { name: 'read_file', input: { path, pages: '1', mode: 'text' } };
      if (step === 1) {
        const read = (await f.store.listExecutions('s')).find(
          (x) => x.definitionId === 'files.read',
        )!;
        expect({ status: read.status, result: read.result }).toMatchObject({ status: 'succeeded' });
        expect(JSON.stringify(f.requests.at(-1))).toContain('Hello PDF');
        return { name: 'read_file', input: { path, pages: '1', mode: 'image' } };
      }
      if (step === 2) {
        expect(JSON.stringify(f.requests.at(-1))).toContain('data:image/png;base64,');
        expect(JSON.stringify(f.requests.at(-1))).toContain('not a human request or approval');
      }
      return null;
    },
    { mode: 'full' },
  );
  try {
    const file = await f.runtime.uploadInputFile({
      ...f.base,
      id: 'pdf',
      name: 'report.pdf',
      mediaType: 'application/pdf',
      content: (async function* () {
        yield simplePdf();
      })(),
    });
    path = fileURLToPath(file.uri);
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'work',
      request: { kind: 'run.start', content: 'Read the text and page image.', files: [file] },
    });
    expect((await f.done()).run?.status).toBe('completed');
    const reads = (await f.store.listExecutions('s')).filter(
      (x) => x.definitionId === 'files.read',
    );
    expect(reads.map((read) => read.status)).toEqual(['succeeded', 'succeeded']);
    const result = reads[1]!.result as Record<string, Json>;
    expect(result.modelImages).toMatchObject([
      { mediaType: 'image/png', scope: { kind: 'execution', id: reads[1]!.id } },
    ]);
  } finally {
    await f.close();
  }
}, 20000);

test('session outputs persist current edits and immutable delivery snapshots through ordinary file tools', async () => {
  let outputPath = '';
  const f = await fixture(
    {},
    ['files.read', 'files.write', 'files.edit'],
    async (step, f): Promise<Call> => {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex');
      outputPath = join(
        f.profile.profilePath,
        'files',
        hash(f.base.expectedStoreId),
        hash('s'),
        'outputs',
        'report.md',
      );
      if (step === 0)
        return {
          name: 'write_file',
          input: { path: outputPath, base: null, content: 'First report 中文' },
        };
      if (step === 1) {
        const write = (await f.store.listExecutions('s')).find(
          (x) => x.definitionId === 'files.write',
        )!;
        expect({ status: write.status, result: write.result }).toMatchObject({
          status: 'succeeded',
        });
        return { name: 'read_file', input: { path: outputPath } };
      }
      if (step === 2) {
        const read = (await f.store.listExecutions('s')).find(
          (x) => x.definitionId === 'files.read',
        )!;
        expect({ status: read.status, result: read.result }).toMatchObject({ status: 'succeeded' });
        const result = JSON.parse(String((read.result as Record<string, Json>).content));
        return {
          name: 'edit_file',
          input: {
            path: outputPath,
            base: result.baseline,
            old_text: 'First',
            new_text: 'Updated',
            expected_matches: 1,
          },
        };
      }
      return null;
    },
    { mode: 'full' },
  );
  try {
    await f.submit();
    expect((await f.done()).run?.status).toBe('completed');
    const executions = (await f.store.listExecutions('s')).filter((x) =>
      ['files.write', 'files.edit'].includes(x.definitionId),
    );
    expect(executions.map((x) => x.status)).toEqual(['succeeded', 'succeeded']);
    expect(readFileSync(outputPath, 'utf8')).toBe('Updated report 中文');
    const first = executions[0]!.result as Record<string, Json>;
    const second = executions[1]!.result as Record<string, Json>;
    expect(first.artifactRefs).not.toEqual(second.artifactRefs);
    const firstRef = (
      first.artifactRefs as unknown as { id: string; scope: { kind: 'execution'; id: string } }[]
    )[0]!;
    const saved = await f.runtime.readArtifact({
      expectedStoreId: f.base.expectedStoreId,
      sessionId: 's',
      subjectId: 'user',
      refId: firstRef.id,
      scope: firstRef.scope,
    });
    expect(Buffer.from(saved.content).toString('utf8')).toBe('First report 中文');
    expect(first.details).toMatchObject({
      fileOutput: { path: outputPath },
      workspaceCheckpoint: false,
    });
    const views = await f.runtime.queryExtension({
      expectedStoreId: f.base.expectedStoreId,
      sessionId: 's',
      subjectId: 'user',
      extensionId: 'builtin.files',
      queryId: 'files.outputs',
      input: {},
    });
    expect(views[0]!.payload).toMatchObject([{ value: { state: 'saved', name: 'report.md' } }]);
    await f.runtime.close();
    await f.workspaceSerialLocks.close();
    const orphan = join(dirname(outputPath), 'orphan.md');
    writeFileSync(orphan, 'unregistered abandoned file');
    const cache = join(
      f.profile.profilePath,
      'cache/documents',
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
    );
    privateDirectory(cache);
    writeFileSync(join(cache, 'result.json'), '{}');
    const realNow = Date.now;
    try {
      const future = realNow() + 9 * 86400000;
      Date.now = () => future;
      const collected = await collectProfileGarbage({
        profile: { dataRoot: f.profile.dataRoot, profile: f.profile.profile },
        expectedStoreId: f.base.expectedStoreId,
      });
      expect(collected.removedFiles).toBe(2);
    } finally {
      Date.now = realNow;
    }
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(join(cache, 'result.json'))).toBe(false);
    expect(readFileSync(outputPath, 'utf8')).toBe('Updated report 中文');
    const backup = await createProfileBackup({
      profile: { dataRoot: f.profile.dataRoot, profile: f.profile.profile },
      destinationRoot: join(f.root, 'backups'),
    });
    expect(backup.manifest.version).toBe(20);
    await inspectProfileBackup({ directory: backup.directory });
    const backedOutput = join(backup.directory, relative(f.profile.profilePath, outputPath));
    const originalBackupBytes = readFileSync(backedOutput);
    writeFileSync(backedOutput, 'tampered current output');
    await expect(inspectProfileBackup({ directory: backup.directory })).rejects.toThrow(
      'backup_working_files_invalid',
    );
    writeFileSync(backedOutput, originalBackupBytes);
    const extra = join(dirname(backedOutput), 'not-registered.md');
    writeFileSync(extra, 'extra');
    await expect(inspectProfileBackup({ directory: backup.directory })).rejects.toThrow(
      'backup_working_files_invalid',
    );
    rmSync(extra);
    await inspectProfileBackup({ directory: backup.directory });
    writeFileSync(outputPath, 'Later');
    const restored = await restoreProfileBackup({
      profile: { dataRoot: f.profile.dataRoot, profile: f.profile.profile },
      expectedStoreId: f.base.expectedStoreId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(readFileSync(outputPath, 'utf8')).toBe('Updated report 中文');
    // A deleted registered working file stays absent across backup/restore; old snapshots
    // remain immutable evidence, never an implicit reconstruction of current bytes.
    rmSync(outputPath);
    const absent = await createProfileBackup({
      profile: { dataRoot: f.profile.dataRoot, profile: f.profile.profile },
      destinationRoot: join(f.root, 'backups'),
    });
    await inspectProfileBackup({ directory: absent.directory });
    writeFileSync(outputPath, 'outside modification after missing-file backup');
    await restoreProfileBackup({
      profile: { dataRoot: f.profile.dataRoot, profile: f.profile.profile },
      expectedStoreId: restored.storeId,
      backup: absent,
      intent: 'replace_with_selected_backup',
    });
    expect(existsSync(outputPath)).toBe(false);
  } finally {
    await f.close();
  }
}, 30000);

test('ordinary file tools edit the exact Plan before approval through its owner; backup restores the actual latest bytes', async () => {
  let path = '';
  const f = await fixture(
    { requirePlan: true },
    ['planning.write', 'planning.review', 'planning.update', 'files.read', 'files.write'],
    async (step, f): Promise<Call> => {
      if (step === 0)
        return {
          name: 'write_plan',
          input: {
            plan_id: 'file-plan',
            expected_version: null,
            title: 'Persisted plan',
            body: 'Original 中文 plan',
            steps: [{ id: 'a', title: 'Write result' }],
          },
        };
      const current = (await f.record('plan.current'))!.value as Record<string, Json>;
      const plan = (await f.record(String(current.key)))!.value as Record<string, Json>;
      path = join(dirname(f.configurationPath), String((plan.file as Record<string, Json>).path));
      if (step === 1) {
        writeFileSync(path, 'External changed 中文 plan');
        return { name: 'read_file', input: { path } };
      }
      if (step === 2) {
        const stale = (await f.store.listExecutions('s')).find(
          (x) => x.definitionId === 'files.read',
        )!;
        expect(stale.status).toBe('failed');
        return { name: 'read_file', input: { path } };
      }
      if (step === 3) {
        const read = (await f.store.listExecutions('s'))
          .filter((x) => x.definitionId === 'files.read')
          .at(-1)!;
        expect(read.status).toBe('succeeded');
        const value = JSON.parse(String((read.result as Record<string, Json>).content));
        expect(value.content).toBe('External changed 中文 plan');
        return {
          name: 'write_file',
          input: { path, base: value.baseline, content: 'Revised 中文 plan' },
        };
      }
      if (step === 4) {
        expect(current.version).toBe(2);
        expect(plan.body).toBe('Revised 中文 plan');
        expect(readFileSync(path, 'utf8')).toBe(String(plan.body));
        return {
          name: 'request_plan_review',
          input: { plan_id: current.planId!, version: current.version!, digest: current.digest! },
        };
      }
      if (step === 5)
        return {
          name: 'write_file',
          input: { path: 'result.txt', base: null, content: 'approved result' },
        };
      if (step === 6) {
        const effect = (await f.store.listExecutions('s'))
          .filter((x) => x.definitionId === 'files.write')
          .at(-1)!;
        return {
          name: 'update_plan_progress',
          input: {
            run_id: await f.runId(),
            plan_id: current.planId!,
            version: current.version!,
            digest: current.digest!,
            expected_progress_revision: null,
            step_id: 'a',
            status: 'completed',
            execution_id: effect.id,
            complete_plan: true,
          },
        };
      }
      return null;
    },
    { mode: 'full' },
  );
  try {
    await f.submit();
    const card = await f.answer('plan_review');
    expect(card.request).toMatchObject({
      version: '2',
      content: expect.stringContaining('Revised 中文 plan'),
    });
    expect((await f.done()).run?.status).toBe('completed');
    expect((await f.record('plan/file-plan/1'))?.value).toMatchObject({
      body: 'Original 中文 plan',
    });
    expect((await f.record('plan.file.publication'))?.value).toMatchObject({ state: 'committed' });
    await f.runtime.close();
    await f.workspaceSerialLocks.close();
    // Offline edits are backup data, not approval or permission facts.
    writeFileSync(path, 'Latest unreviewed modification');
    const backup = await createProfileBackup({
      profile: { dataRoot: f.profile.dataRoot, profile: f.profile.profile },
      destinationRoot: join(f.root, 'backups'),
    });
    expect(backup.manifest.version).toBe(20);
    await inspectProfileBackup({ directory: backup.directory });
    writeFileSync(path, 'After backup');
    const restored = await restoreProfileBackup({
      profile: { dataRoot: f.profile.dataRoot, profile: f.profile.profile },
      expectedStoreId: f.base.expectedStoreId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.storeId).not.toBe(f.base.expectedStoreId);
    expect(readFileSync(path, 'utf8')).toBe('Latest unreviewed modification');
  } finally {
    await f.close();
  }
}, 20000);

test('default business catalogue is installed once; no host flags leaves ordinary chat unconstrained and versions reject before Provider', async () => {
  const f = await fixture({}, [], async () => null);
  try {
    expect(
      f.runtime.getExtensionCatalogue().filter((x) => x.extensionId === planningExtensionId),
    ).toHaveLength(1);
    const before = (await f.store.getMetadata()).lastChangeCursor;
    await f.runtime.queryExtension({
      sessionId: 's',
      subjectId: 'user',
      extensionId: planningExtensionId,
      queryId: 'planning.status',
      input: {},
    });
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
    expect(f.requests).toHaveLength(0);
    await f.submit();
    const first = await f.done();
    expect(first.run?.status).toBe('completed');
    expect(first.run?.requirements).toEqual([]);
    expect(first.run?.configuration).toMatchObject({
      snapshot: { planning: { fileHashChecker: null, commandChecker: null, mcpCheckers: [] } },
    });
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'idle-action',
      request: {
        kind: 'extension.invoke',
        extensionId: planningExtensionId,
        actionId: 'planning.write',
        definitionVersion: '1',
        input: {
          planId: 'idle-plan',
          expectedVersion: null,
          title: 'Idle action',
          body: 'Pure local metadata',
          steps: [{ id: 'a', title: 'metadata' }],
        },
      },
    });
    const action = await f.runtime.waitForCommand('idle-action', { timeoutMs: 5000 });
    const actionReceipt = action.receipt as Record<string, Json>;
    const execution = await f.store.getExecution(String(actionReceipt.executionId));
    expect(execution?.kind).toBe('job');
    expect(execution?.runId).toBeNull();
    expect(execution?.status).toBe('succeeded');
    expect(f.requests).toHaveLength(1);
    const queryCursor = (await f.store.getMetadata()).lastChangeCursor;
    const views = await f.runtime.queryExtension({
      sessionId: 's',
      subjectId: 'user',
      extensionId: planningExtensionId,
      queryId: 'planning.status',
      input: {},
    });
    expect(JSON.stringify(views)).toContain('idle-plan');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(queryCursor);

    writeFileSync(
      f.configurationPath,
      JSON.stringify({
        ...f.configuration,
        tools: [{ id: 'planning.read', definitionVersion: 'wrong' }],
      }),
    );
    await f.submit('wrong-version');
    const rejected = await f.done();
    expect(rejected.command.status).toBe('rejected');
    expect((rejected.command.receipt as Record<string, Json>)?.reason).toBe(
      'tool_definition_version_unavailable',
    );
    expect(f.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 15000);

test('requirePlan initializes before first real Provider call; user review and actual file receipt complete the exact plan', async () => {
  const f = await fixture(
    { requirePlan: true },
    ['planning.write', 'planning.review', 'planning.update', 'files.write'],
    async (step, f): Promise<Call> => {
      const runId = await f.runId();
      if (step === 0) {
        const run = await f.store.getRun(runId);
        expect(run?.requirements[0]?.originStoreId).toBe(f.base.expectedStoreId);
        expect(await f.record(`run/${runId}/plan.required`)).not.toBeNull();
        return {
          name: 'write_plan',
          input: {
            plan_id: 'p',
            expected_version: null,
            title: 'Private plan',
            body: 'Write one harmless ledger',
            steps: [{ id: 'a', title: 'write' }],
          },
        };
      }
      const current = (await f.record('plan.current'))!.value as Record<string, Json>;
      if (step === 1)
        return {
          name: 'request_plan_review',
          input: { plan_id: current.planId!, version: current.version!, digest: current.digest! },
        };
      if (step === 2)
        return {
          name: 'write_file',
          input: { path: 'ledger.txt', content: 'one actual effect', base: null },
        };
      if (step === 3) {
        const actual = (await f.store.listExecutions('s')).find(
          (x) => x.runId === runId && x.definitionId === 'files.write',
        )!;
        return {
          name: 'update_plan_progress',
          input: {
            run_id: runId,
            plan_id: current.planId!,
            version: current.version!,
            digest: current.digest!,
            expected_progress_revision: null,
            step_id: 'a',
            status: 'completed',
            execution_id: actual.id,
            complete_plan: true,
          },
        };
      }
      return null;
    },
  );
  try {
    await f.submit();
    const card = await f.answer('plan_review');
    expect(card.definitionId).toBe('planning.review');
    const done = await f.done();
    const executions = await f.store.listExecutions('s');
    const file = executions.find(
      (row) => row.runId === done.run?.id && row.definitionId === 'files.write',
    )!;
    const progress = (await f.record('progress/p/1'))?.value as Record<string, Json> | undefined;
    console.log(
      JSON.stringify({
        planningEvidence: {
          storeId: f.base.expectedStoreId,
          commandId: 'work',
          runId: done.run?.id,
          runStatus: done.run?.status,
          review: { interactionId: card.id, executionId: card.executionId, source: card.source },
          file: {
            id: file.id,
            status: file.status,
            runId: file.runId,
            originStoreId: file.originStoreId,
            rootWorkCommandId: file.rootWorkCommandId,
            definitionVersion: file.definitionVersion,
            decisionSource: file.decisionSource,
            result: file.result,
          },
          progress,
        },
      }),
    );
    expect(done.run?.status).toBe('completed');
    expect(readFileSync(join(f.workspace, 'ledger.txt'), 'utf8')).toBe('one actual effect');
    expect(file).toMatchObject({
      status: 'succeeded',
      runId: done.run!.id,
      originStoreId: f.base.expectedStoreId,
      rootWorkCommandId: 'work',
      definitionVersion: '2',
    });
    expect(progress).toMatchObject({
      runId: done.run!.id,
      planId: 'p',
      version: 1,
      completePlan: true,
      steps: {
        a: {
          status: 'completed',
          receipt: { executionId: file.id, definitionId: 'files.write', definitionVersion: '2' },
        },
      },
    });

    expect(
      (await f.store.listExecutions('s')).filter((x) => x.definitionId === 'files.write'),
    ).toHaveLength(1);
    expect(JSON.stringify(f.requests)).toContain('current_plan');
  } finally {
    await f.close();
  }
}, 15000);

test('required validation saves an exact user waiver; a later Run cannot reuse it and missing receipt evidence fails completion', async () => {
  const f = await fixture(
    { requiredValidation: true, allowWaiver: true },
    ['validation.request_waiver', 'validation.define', 'validation.check'],
    async (step, f): Promise<Call> => {
      const runId = await f.runId();
      if (f.commandId === 'work')
        return step === 0
          ? {
              name: 'request_validation_waiver',
              input: {
                record_key: `run/${runId}/validation.required`,
                reason: 'Explicit local waiver',
              },
            }
          : null;
      if (step === 0)
        return {
          name: 'define_validation_checks',
          input: {
            run_id: runId,
            checks: [
              {
                kind: 'receipt',
                target: {
                  execution_id: 'nonexistent-target',
                  attempt: 1,
                  definition_id: 'files.write',
                  definition_version: '2',
                  input_digest: 'missing',
                  result_revision: '1',
                },
              },
            ],
          },
        };
      if (step === 1) return { name: 'run_validation_checks', input: { run_id: runId } };
      return null;
    },
  );
  try {
    await f.submit();
    const card = await f.answer('question');
    const first = await f.done();
    expect(first.run?.status).toBe('completed');
    const oldHead = (await f.record(`run/${first.run!.id}/validation.required/waiver.current`))!;
    const oldKey = String((oldHead.value as Record<string, Json>).key);
    expect(JSON.stringify((await f.record(oldKey))!.value)).toContain(card.id);
    await f.submit('next');
    const second = await f.done();
    expect(second.run?.status).toBe('failed');
    expect(second.run?.id).not.toBe(first.run?.id);
    expect(await f.record(`run/${second.run!.id}/validation.required/waiver.current`)).toBeNull();
    expect(
      (await f.store.listExecutions('s')).filter(
        (x) => x.definitionId === 'validation.request_waiver',
      ),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 15000);

test('global exact Planning Action uses trusted Request Approval/unqualified Auto record approval, Full bypass, and untrusted denial without any Model', async () => {
  for (const mode of ['auto', 'accept_edits', 'full'] as const) {
    const f = await fixture({}, [], async () => null, { mode });
    try {
      await f.runtime.submitCommand({
        ...f.base,
        commandId: 'idle-governance',
        request: {
          kind: 'extension.invoke',
          extensionId: planningExtensionId,
          actionId: 'planning.write',
          definitionVersion: '1',
          input: {
            planId: 'approved-record',
            expectedVersion: null,
            title: 'Record only',
            body: 'No workspace mutation',
            steps: [{ id: 'one', title: 'Record step' }],
          },
        },
      });
      if (mode !== 'full') {
        const card = await until(
          async () =>
            (
              await f.store.listInteractions({
                expectedStoreId: f.base.expectedStoreId,
                sessionId: 's',
                state: 'pending',
              })
            ).interactions.find((x) => x.kind === 'approval') ?? null,
        );
        expect(card.definitionId).toBe(`${planningExtensionId}/planning.write`);
        expect(card.request).toMatchObject({ policy: { effects: ['record_write'], mode } });
        expect(await f.record('plan.current')).toBeNull();
        expect(f.requests).toHaveLength(0);
        await f.runtime.answerInteraction({
          ...f.base,
          commandId: 'approve-idle',
          presentationSessionId: 's',
          interactionId: card.id,
          expectedRevision: card.revision,
          answer: { kind: 'approval', decision: 'approve' },
        });
      }
      const done = await f.runtime.waitForCommand('idle-governance', { timeoutMs: 5000 });
      const execution = await f.store.getExecution(
        String((done.receipt as Record<string, Json>).executionId),
      );
      expect(execution).toMatchObject({ kind: 'job', runId: null, status: 'succeeded' });
      expect(await f.record('plan.current')).not.toBeNull();
      expect(f.requests).toHaveLength(0);
      expect((await f.store.getView('s')).runs).toHaveLength(0);
    } finally {
      await f.close();
    }
  }
  const denied = await fixture({}, [], async () => null, { mode: 'full', trusted: false });
  try {
    await denied.runtime.submitCommand({
      ...denied.base,
      commandId: 'untrusted-action',
      request: {
        kind: 'extension.invoke',
        extensionId: planningExtensionId,
        actionId: 'planning.write',
        definitionVersion: '1',
        input: {
          planId: 'denied',
          expectedVersion: null,
          title: 'deny',
          body: 'deny',
          steps: [{ id: 'a', title: 'a' }],
        },
      },
    });
    const command = await denied.runtime.waitForCommand('untrusted-action', { timeoutMs: 5000 });
    expect(command.status).toBe('applied');
    expect(
      await denied.store.getExecution(
        String((command.receipt as Record<string, Json>).executionId),
      ),
    ).toMatchObject({ status: 'failed', result: { content: 'permission_denied' } });
    expect(await denied.record('plan.current')).toBeNull();
    expect(denied.requests).toHaveLength(0);
  } finally {
    await denied.close();
  }
}, 15000);

test('actual host checker identities are frozen in Run snapshot; parent record authorization cannot grant its nested file read', async () => {
  const host = {
    fileHashChecker: { definitionId: 'files.read', definitionVersion: '5' },
    commandChecker: { definitionId: 'shell.command', definitionVersion: '1' },
    mcpCheckers: [
      {
        id: 'read',
        definitionId: 'host.mcp.read',
        definitionVersion: 'host-v1',
        sourceDefinitionId: 'host.mcp.write',
        sourceDefinitionVersion: 'source-v1',
      },
    ],
  };
  const f = await fixture(
    host,
    ['validation.define', 'validation.check', 'files.read'],
    async (step, f): Promise<Call> => {
      if (step === 0)
        return {
          name: 'define_validation_checks',
          input: {
            run_id: await f.runId(),
            checks: [{ kind: 'file_hash', path: 'private.txt', sha256: '0'.repeat(64) }],
          },
        };
      if (step === 1) return { name: 'run_validation_checks', input: { run_id: await f.runId() } };
      return null;
    },
    { mode: 'full', exclude: ['files.read'] },
  );
  try {
    host.commandChecker.definitionVersion = 'later';
    host.mcpCheckers[0]!.sourceDefinitionVersion = 'later';
    writeFileSync(join(f.workspace, 'private.txt'), 'actual private fixture');
    writeFileSync(
      f.configurationPath,
      JSON.stringify({
        ...f.configuration,
        planning: {
          fileHashChecker: { definitionId: 'fake', definitionVersion: 'fake' },
          commandChecker: { definitionId: 'fake', definitionVersion: 'fake' },
          mcpCheckers: [{ id: 'fake' }],
        },
      }),
    );
    await f.submit();
    const done = await f.done();
    expect(done.run!.configuration).toMatchObject({
      snapshot: {
        planning: {
          fileHashChecker: { definitionId: 'files.read', definitionVersion: '5' },
          commandChecker: { definitionId: 'shell.command', definitionVersion: '1' },
          mcpCheckers: [
            {
              id: 'read',
              definitionId: 'host.mcp.read',
              definitionVersion: 'host-v1',
              sourceDefinitionId: 'host.mcp.write',
              sourceDefinitionVersion: 'source-v1',
            },
          ],
        },
      },
    });
    const executions = await f.store.listExecutions('s');
    expect(executions.find((x) => x.definitionId === 'validation.define')!.status).toBe(
      'succeeded',
    );
    const checker = executions.find((x) => x.definitionId === 'files.read')!;
    expect(checker.status).toBe('failed');
    expect(checker.parentExecutionId).toBe(
      executions.find((x) => x.definitionId === 'validation.check')!.id,
    );
    expect(checker.result).toMatchObject({ content: 'permission_denied' });
    expect(readFileSync(join(f.workspace, 'private.txt'), 'utf8')).toBe('actual private fixture');
  } finally {
    await f.close();
  }
}, 15000);

test('record-write permission approval does not answer the separate exact validation waiver question', async () => {
  const f = await fixture(
    { requiredValidation: true, allowWaiver: true },
    ['validation.request_waiver'],
    async (step, f) =>
      step === 0
        ? {
            name: 'request_validation_waiver',
            input: {
              record_key: `run/${await f.runId()}/validation.required`,
              reason: 'Explicit exception',
            },
          }
        : null,
    { mode: 'accept_edits' },
  );
  try {
    await f.submit();
    const approval = await until(
      async () =>
        (
          await f.store.listInteractions({
            expectedStoreId: f.base.expectedStoreId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions.find((x) => x.kind === 'approval') ?? null,
    );
    expect(approval.request).toMatchObject({ policy: { effects: ['record_write'] } });
    await f.runtime.answerInteraction({
      ...f.base,
      commandId: 'approve-waiver-tool',
      presentationSessionId: 's',
      interactionId: approval.id,
      expectedRevision: approval.revision,
      answer: { kind: 'approval', decision: 'approve' },
    });
    const question = await f.answer('question');
    expect(question.id).not.toBe(approval.id);
    expect(question.executionId).toBe(approval.executionId);
    expect(question.request).toMatchObject({ kind: 'validation_waiver' });
    const done = await f.done();
    expect(done.run!.status).toBe('completed');
    expect(
      (await f.store.getInteraction({
        expectedStoreId: f.base.expectedStoreId,
        sessionId: 's',
        interactionId: approval.id,
      }))!.kind,
    ).toBe('approval');
    expect(f.requests).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 15000);

test('new Store restore projects registered files and fresh ordinary tools edit both output and Plan', async () => {
  let restored = false;
  let outputPath = '',
    planPath = '';
  const f = await fixture(
    {},
    ['planning.write', 'files.read', 'files.write', 'files.edit'],
    async (step, f): Promise<Call> => {
      if (!restored) {
        if (step === 0) {
          const hash = (value: string) => createHash('sha256').update(value).digest('hex');
          outputPath = join(
            f.profile.profilePath,
            'files',
            hash(f.base.expectedStoreId),
            hash('s'),
            'outputs',
            'restored.md',
          );
          return {
            name: 'write_file',
            input: { path: outputPath, base: null, content: 'Original delivered report' },
          };
        }
        if (step === 1)
          return {
            name: 'write_plan',
            input: {
              plan_id: 'restored-plan',
              expected_version: null,
              title: 'Restorable plan',
              body: 'Original editable plan',
              steps: [{ id: 'a', title: 'Keep the real file' }],
            },
          };
        return null;
      }
      if (step === 0) {
        const sources = (f.requests.at(-1)!.messages as { role: string; content: string }[])
          .filter((message) => message.role === 'user')
          .flatMap((message) => {
            try {
              return [JSON.parse(message.content)];
            } catch {
              return [];
            }
          });
        expect(sources.find((source) => source.kind === 'session_files')).toMatchObject({
          files: [{ path: outputPath }],
        });
        expect(sources.find((source) => source.kind === 'current_plan')).toMatchObject({
          filePath: planPath,
          approval: null,
          fileState: 'matches_record',
        });
        return { name: 'read_file', input: { path: outputPath } };
      }
      if (step === 1 || step === 3) {
        const read = (await f.store.listExecutions('s'))
          .filter((e) => e.definitionId === 'files.read')
          .at(-1)!;
        expect({ status: read.status, result: read.result }).toMatchObject({ status: 'succeeded' });
        const value = JSON.parse(String((read.result as Record<string, Json>).content));
        expect(value.content).toBe(
          step === 1 ? 'Latest unsubmitted report' : 'Original editable plan',
        );
        return {
          name: 'edit_file',
          input: {
            path: step === 1 ? outputPath : planPath,
            base: value.baseline,
            old_text: step === 1 ? 'Latest unsubmitted' : 'Original editable',
            new_text: 'Edited after restore',
            expected_matches: 1,
          },
        };
      }
      if (step === 2) return { name: 'read_file', input: { path: planPath } };
      return null;
    },
    { mode: 'full' },
  );
  try {
    await f.submit();
    expect((await f.done()).run?.status).toBe('completed');
    const originalStoreId = f.base.expectedStoreId;
    const originalExecutions = (await f.store.listExecutions('s')).map((e) => ({
      id: e.id,
      status: e.status,
      resultRevision: e.resultRevision,
      originStoreId: e.originStoreId,
    }));
    const firstOutput = (await f.store.listExecutions('s')).find(
      (e) => e.definitionId === 'files.write',
    )!;
    const firstRef = (
      (firstOutput.result as Record<string, Json>).artifactRefs as unknown as {
        id: string;
        scope: { kind: 'execution'; id: string };
      }[]
    )[0]!;
    const plan = (await f.record('plan/restored-plan/1'))!.value as Record<string, Json>;
    planPath = join(f.profile.profilePath, String((plan.file as Record<string, Json>).path));
    await f.runtime.close();
    await f.workspaceSerialLocks.close();
    writeFileSync(outputPath, 'Latest unsubmitted report');
    const backup = await createProfileBackup({
      profile: { dataRoot: f.profile.dataRoot, profile: f.profile.profile },
      destinationRoot: join(f.root, 'backups'),
    });
    const replacement = await restoreProfileBackup({
      profile: { dataRoot: f.profile.dataRoot, profile: f.profile.profile },
      expectedStoreId: originalStoreId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(replacement.storeId).not.toBe(originalStoreId);
    const callsBeforeReopen = f.requests.length;
    await f.reopen();
    expect(f.base.expectedStoreId).toBe(replacement.storeId);
    expect(f.requests).toHaveLength(callsBeforeReopen);
    restored = true;
    await f.submit('after-restore');
    expect((await f.done()).run?.status).toBe('completed');
    expect(readFileSync(outputPath, 'utf8')).toBe('Edited after restore report');
    expect(readFileSync(planPath, 'utf8')).toBe('Edited after restore plan');
    expect((await f.record('plan.current'))!.value).toMatchObject({
      planId: 'restored-plan',
      version: 2,
    });
    expect((await f.record('plan/restored-plan/1'))!.value).toMatchObject({
      body: 'Original editable plan',
    });
    const all = await f.store.listExecutions('s');
    expect(
      all
        .filter((e) => !originalExecutions.some((old) => old.id === e.id))
        .every((e) => e.originStoreId === replacement.storeId),
    ).toBe(true);
    for (const original of originalExecutions)
      expect(all.find((e) => e.id === original.id)).toMatchObject(original);
    const saved = await f.runtime.readArtifact({
      ...f.base,
      refId: firstRef.id,
      scope: firstRef.scope,
    });
    expect(Buffer.from(saved.content).toString('utf8')).toBe('Original delivered report');
  } finally {
    await f.close();
  }
}, 30000);

test('ordinary Plan file edit after approval creates v2 and cannot spend the original approval on workspace effects', async () => {
  let planPath = '';
  const f = await fixture(
    { requirePlan: true },
    [
      'planning.write',
      'planning.review',
      'planning.update',
      'files.read',
      'files.edit',
      'files.write',
    ],
    async (step, f): Promise<Call> => {
      if (step === 0)
        return {
          name: 'write_plan',
          input: {
            plan_id: 'approved-file',
            expected_version: null,
            title: 'Approved current file',
            body: 'Original approved plan',
            steps: [{ id: 'a', title: 'A precise workspace write' }],
          },
        };
      const current = (await f.record('plan.current'))!.value as Record<string, Json>;
      const plan = (await f.record(String(current.key)))!.value as Record<string, Json>;
      planPath = join(f.profile.profilePath, String((plan.file as Record<string, Json>).path));
      if (step === 1 || step === 5)
        return {
          name: 'request_plan_review',
          input: {
            plan_id: current.planId!,
            version: current.version!,
            digest: current.digest!,
          },
        };
      if (step === 2) return { name: 'read_file', input: { path: planPath } };
      if (step === 3) {
        const read = (await f.store.listExecutions('s')).find(
          (e) => e.definitionId === 'files.read',
        )!;
        expect(read.status).toBe('succeeded');
        const value = JSON.parse(String((read.result as Record<string, Json>).content));
        return {
          name: 'edit_file',
          input: {
            path: planPath,
            base: value.baseline,
            old_text: 'Original approved',
            new_text: 'Changed unapproved',
            expected_matches: 1,
          },
        };
      }
      if (step === 4) {
        expect(current.version).toBe(2);
        expect(plan.body).toBe('Changed unapproved plan');
        return {
          name: 'write_file',
          input: { path: 'stale-approval.txt', base: null, content: 'Must never be written' },
        };
      }
      if (step === 6)
        return {
          name: 'write_file',
          input: {
            path: 'fresh-approval.txt',
            base: null,
            content: 'Written under the exact new approval',
          },
        };
      if (step === 7) {
        const written = (await f.store.listExecutions('s'))
          .filter((e) => e.definitionId === 'files.write' && e.status === 'succeeded')
          .at(-1)!;
        return {
          name: 'update_plan_progress',
          input: {
            run_id: await f.runId(),
            plan_id: current.planId!,
            version: current.version!,
            digest: current.digest!,
            expected_progress_revision: null,
            step_id: 'a',
            status: 'completed',
            execution_id: written.id,
            complete_plan: true,
          },
        };
      }
      return null;
    },
    { mode: 'full' },
  );
  try {
    await f.submit();
    const approved = await f.answer('plan_review');
    expect(approved.request).toMatchObject({ version: '1' });
    const fresh = await f.answer('plan_review');
    expect(fresh.request).toMatchObject({
      version: '2',
      content: expect.stringContaining('Changed unapproved plan'),
    });
    expect((await f.done()).run?.status).toBe('completed');
    expect(readFileSync(planPath, 'utf8')).toBe('Changed unapproved plan');
    expect((await f.record('plan.current'))!.value).toMatchObject({ version: 2 });
    expect(
      (await f.store.listExecutions('s'))
        .filter((e) => e.definitionId === 'files.edit')
        .map((e) => e.status),
    ).toEqual(['succeeded']);
    const writes = (await f.store.listExecutions('s')).filter(
      (e) => e.definitionId === 'files.write',
    );
    expect(writes.map((e) => e.status)).toEqual(['failed', 'succeeded']);
    expect(writes[0]!.result).toMatchObject({
      details: {
        adapterAttempted: false,
        dispatchCommitted: false,
        reason: 'plan_approval_required',
      },
    });
    expect(existsSync(join(f.workspace, 'stale-approval.txt'))).toBe(false);
    expect(readFileSync(join(f.workspace, 'fresh-approval.txt'), 'utf8')).toBe(
      'Written under the exact new approval',
    );
    expect(await f.record(`run/${await f.runId()}/approval/approved-file/1`)).not.toBeNull();
    expect(await f.record(`run/${await f.runId()}/approval/approved-file/2`)).not.toBeNull();
  } finally {
    await f.close();
  }
}, 20000);

test('Plan publication after physical write rejects pending approval and preserves bytes during exact recovery or external drift', async () => {
  for (const externalChange of [false, true]) {
    let planPath = '';
    let originalFile: { ino: number; size: number; mtimeMs: number } | undefined;
    let injected = 0;
    const planInput = {
      plan_id: 'publication-recovery',
      expected_version: null,
      title: 'Exact publication',
      body: 'Complete bytes before SQL commit',
      steps: [{ id: 'a', title: 'Write only after complete publication' }],
    };
    const f = await fixture(
      { requirePlan: true },
      ['planning.write', 'planning.review', 'planning.update', 'files.write'],
      async (step, f): Promise<Call> => {
        if (f.commandId === 'work')
          return step === 0 ? { name: 'write_plan', input: planInput } : null;
        const current = (await f.record('plan.current'))!.value as Record<string, Json>;
        if (f.commandId === 'pending-review')
          return step === 0
            ? {
                name: 'request_plan_review',
                input: {
                  plan_id: current.planId!,
                  version: current.version!,
                  digest: current.digest!,
                },
              }
            : null;
        if (f.commandId === 'pending-effect')
          return step === 0
            ? {
                name: 'write_file',
                input: {
                  path: 'pending-publication.txt',
                  base: null,
                  content: 'Must not be dispatched',
                },
              }
            : null;
        if (step === 0) return { name: 'write_plan', input: planInput };
        if (step === 1 && !externalChange)
          return {
            name: 'request_plan_review',
            input: { plan_id: current.planId!, version: current.version!, digest: current.digest! },
          };
        if (step === 2 && !externalChange)
          return {
            name: 'write_file',
            input: {
              path: 'recovered-publication.txt',
              base: null,
              content: 'Publication is complete and approved',
            },
          };
        if (step === 3 && !externalChange) {
          const written = (await f.store.listExecutions('s'))
            .filter((e) => e.definitionId === 'files.write' && e.status === 'succeeded')
            .at(-1)!;
          return {
            name: 'update_plan_progress',
            input: {
              run_id: await f.runId(),
              plan_id: current.planId!,
              version: current.version!,
              digest: current.digest!,
              expected_progress_revision: null,
              step_id: 'a',
              status: 'completed',
              execution_id: written.id,
              complete_plan: true,
            },
          };
        }
        return null;
      },
      { mode: 'full' },
    );
    const originalWrite = f.store.writeExtensionRecord.bind(f.store);
    f.store.writeExtensionRecord = async (input) => {
      const value = input.write.value as Record<string, Json>;
      if (
        input.extensionId === planningExtensionId &&
        input.write.key === 'plan.file.publication' &&
        value.state === 'committed' &&
        injected === 0
      ) {
        injected++;
        planPath = join(f.profile.profilePath, String((value.file as Record<string, Json>).path));
        expect(readFileSync(planPath, 'utf8')).toBe(planInput.body);
        originalFile = statSync(planPath);
        throw new Error('injected_plan_publication_commit_failure');
      }
      return originalWrite(input);
    };
    try {
      await f.submit();
      await f.done();
      const first = (await f.store.listExecutions('s')).find(
        (e) => e.definitionId === 'planning.write',
      )!;
      expect(first.status).toBe('outcome_unknown');
      expect((await f.record('plan.file.publication'))!.value).toMatchObject({ state: 'pending' });
      await f.submit('pending-review');
      const rejectedReview = await until(
        async () =>
          (await f.store.listExecutions('s')).find(
            (e) =>
              e.definitionId === 'planning.review' &&
              ['failed', 'outcome_unknown'].includes(e.status),
          ) ?? null,
      );
      await f.runtime.cancelCommand({
        ...f.base,
        commandId: 'cancel-pending-review',
        targetCommandId: 'pending-review',
      });
      await f.done();
      expect(rejectedReview.status).not.toBe('succeeded');
      expect(
        (await f.store.listInteractions({ ...f.base, state: 'pending' })).interactions,
      ).toHaveLength(0);
      await f.submit('pending-effect');
      const blocked = await until(
        async () =>
          (await f.store.listExecutions('s')).find(
            (e) => e.definitionId === 'files.write' && e.status === 'failed',
          ) ?? null,
      );
      expect(blocked.result).toMatchObject({
        details: {
          adapterAttempted: false,
          dispatchCommitted: false,
          reason: 'plan_approval_required',
        },
      });
      expect(existsSync(join(f.workspace, 'pending-publication.txt'))).toBe(false);
      await f.runtime.cancelCommand({
        ...f.base,
        commandId: 'cancel-pending-effect',
        targetCommandId: 'pending-effect',
      });
      await f.done();
      if (externalChange) writeFileSync(planPath, 'External edit must survive failed recovery');
      await f.submit('explicit-recovery');
      if (externalChange) {
        await until(async () =>
          (await f.store.listExecutions('s')).filter(
            (e) =>
              e.definitionId === 'planning.write' &&
              ['failed', 'outcome_unknown'].includes(e.status),
          ).length === 2
            ? true
            : null,
        );
        await f.runtime.cancelCommand({
          ...f.base,
          commandId: 'cancel-drifted-recovery',
          targetCommandId: 'explicit-recovery',
        });
        await f.done();
        expect((await f.record('plan.file.publication'))!.value).toMatchObject({
          state: 'pending',
        });
        expect(readFileSync(planPath, 'utf8')).toBe('External edit must survive failed recovery');
        expect(
          (await f.store.listInteractions({ ...f.base, state: 'pending' })).interactions,
        ).toHaveLength(0);
      } else {
        const reviewed = await f.answer('plan_review');
        expect(reviewed.request).toMatchObject({
          version: '1',
          content: expect.stringContaining(planInput.body),
        });
        expect((await f.done()).run?.status).toBe('completed');
        expect((await f.record('plan.file.publication'))!.value).toMatchObject({
          state: 'committed',
        });
        expect(readFileSync(planPath, 'utf8')).toBe(planInput.body);
        const after = statSync(planPath);
        expect({ ino: after.ino, size: after.size, mtimeMs: after.mtimeMs }).toEqual({
          ino: originalFile!.ino,
          size: originalFile!.size,
          mtimeMs: originalFile!.mtimeMs,
        });
        expect(readFileSync(join(f.workspace, 'recovered-publication.txt'), 'utf8')).toBe(
          'Publication is complete and approved',
        );
      }
      expect(injected).toBe(1);
      expect((await f.record('plan.current'))!.value).toMatchObject({
        planId: 'publication-recovery',
        version: 1,
      });
      expect((await f.record('plan/publication-recovery/1'))!.value).toMatchObject({
        body: planInput.body,
      });
      expect(await f.record('plan/publication-recovery/2')).toBeNull();
      const writes = (await f.store.listExecutions('s')).filter(
        (e) => e.definitionId === 'planning.write',
      );
      expect(writes.map((e) => e.status)).toEqual(
        externalChange ? ['outcome_unknown', 'failed'] : ['outcome_unknown', 'succeeded'],
      );
      expect((await f.store.getExecution(first.id))!.result).toEqual(first.result);
    } finally {
      f.store.writeExtensionRecord = originalWrite;
      await f.close();
    }
  }
}, 45000);

test('session output publication failures preserve the actual file and original unknown; cold queries never replay and new work requires recovery', async () => {
  for (const fault of ['artifact', 'record'] as const) {
    let outputPath = '';
    let injected = 0;
    const originalBody = `Actual bytes before ${fault} publication failure`;
    const f = await fixture(
      {},
      ['files.read', 'files.write', 'files.edit'],
      async (step, f): Promise<Call> => {
        const hash = (value: string) => createHash('sha256').update(value).digest('hex');
        outputPath = join(
          f.profile.profilePath,
          'files',
          hash(f.base.expectedStoreId),
          hash('s'),
          'outputs',
          `${fault}-failure.md`,
        );
        if (f.commandId === 'work')
          return step === 0
            ? { name: 'write_file', input: { path: outputPath, base: null, content: originalBody } }
            : null;
        if (step === 0) return { name: 'read_file', input: { path: outputPath } };
        return null;
      },
      { mode: 'full' },
    );
    const hookedStore = f.store;
    const originalRegister = hookedStore.registerArtifact.bind(hookedStore);
    const originalWrite = hookedStore.writeExtensionRecord.bind(hookedStore);
    hookedStore.registerArtifact = async (input) => {
      if (
        fault === 'artifact' &&
        injected === 0 &&
        input.scope.kind === 'execution' &&
        input.mediaType === 'text/plain' &&
        input.hash === createHash('sha256').update(originalBody).digest('hex')
      ) {
        injected++;
        expect(readFileSync(outputPath, 'utf8')).toBe(originalBody);
        throw new Error('injected_output_artifact_registration_failure');
      }
      return originalRegister(input);
    };
    hookedStore.writeExtensionRecord = async (input) => {
      const value = input.write.value as Record<string, Json>;
      if (
        fault === 'record' &&
        injected === 0 &&
        input.extensionId === 'builtin.files' &&
        input.write.contentType === 'builtin.files.output' &&
        input.write.key.startsWith('output/') &&
        value.state === 'saved'
      ) {
        injected++;
        expect(readFileSync(outputPath, 'utf8')).toBe(originalBody);
        const reference = value.snapshot as unknown as {
          id: string;
          scope: { kind: 'execution'; id: string };
        };
        const published = await f.runtime.readArtifact({
          ...f.base,
          refId: reference.id,
          scope: reference.scope,
        });
        expect(Buffer.from(published.content).toString('utf8')).toBe(originalBody);
        throw new Error('injected_output_saved_record_failure');
      }
      return originalWrite(input);
    };
    async function currentOutput() {
      const views = await f.runtime.queryExtension({
        ...f.base,
        extensionId: 'builtin.files',
        queryId: 'files.outputs',
        input: { path: outputPath },
      });
      return (
        views[0]!.payload as unknown as {
          key: string;
          revision: string;
          value: { state: string; executionId: string; snapshot: Json };
        }[]
      )[0]!;
    }
    try {
      await f.submit();
      await f.done();
      const failed = (await f.store.listExecutions('s')).find(
        (execution) => execution.definitionId === 'files.write',
      )!;
      expect(injected).toBe(1);
      expect(failed.status).toBe('outcome_unknown');
      expect(readFileSync(outputPath, 'utf8')).toBe(originalBody);
      const failedResult = failed.result as Record<string, Json>;
      expect(failedResult.artifactRefs).toBeUndefined();
      expect(
        (failedResult.details as Record<string, Json> | undefined)?.fileOutput,
      ).toBeUndefined();
      const pending = await currentOutput();
      expect(pending.value).toMatchObject({
        state: 'pending',
        executionId: failed.id,
        snapshot: null,
      });
      const operation = await f.store.getExtensionRecord({
        sessionId: 's',
        extensionId: 'builtin.files',
        key: `output-operation/${failed.id}`,
      });
      expect(operation!.value).toMatchObject({ state: 'pending', executionId: failed.id });
      const before = statSync(outputPath);
      const calls = f.requests.length;
      const executionCount = (await f.store.listExecutions('s')).length;
      await f.submit();
      await f.done();
      expect(f.requests).toHaveLength(calls);
      expect(await f.store.listExecutions('s')).toHaveLength(executionCount);
      expect(await currentOutput()).toEqual(pending);
      const afterDuplicate = statSync(outputPath);
      expect({
        ino: afterDuplicate.ino,
        size: afterDuplicate.size,
        mtimeMs: afterDuplicate.mtimeMs,
      }).toEqual({ ino: before.ino, size: before.size, mtimeMs: before.mtimeMs });

      hookedStore.registerArtifact = originalRegister;
      hookedStore.writeExtensionRecord = originalWrite;
      await f.reopen();
      expect(f.requests).toHaveLength(calls);
      expect(await currentOutput()).toEqual(pending);
      await f.submit();
      expect(await f.runtime.getCommand('work')).toMatchObject({
        id: 'work',
        status: 'applied',
        receipt: { runId: failed.runId },
      });
      expect(f.requests).toHaveLength(calls);
      expect(await f.store.listExecutions('s')).toHaveLength(executionCount);
      expect(await f.store.getExecution(failed.id)).toMatchObject({
        status: 'outcome_unknown',
        resultRevision: failed.resultRevision,
        result: failed.result,
      });

      await f.submit('explicit-fresh-read');
      let denied: unknown;
      try {
        await f.done();
      } catch (error) {
        denied = error;
      }
      expect(denied).toMatchObject({ code: 'recovery_required' });
      expect(f.requests).toHaveLength(calls);
      expect(await f.store.listExecutions('s')).toHaveLength(executionCount);
      expect(readFileSync(outputPath, 'utf8')).toBe(originalBody);
      expect(await currentOutput()).toEqual(pending);
      expect(
        (await f.store.getExtensionRecord({
          sessionId: 's',
          extensionId: 'builtin.files',
          key: `output-operation/${failed.id}`,
        }))!.value,
      ).toEqual(operation!.value);
      expect(await f.store.getExecution(failed.id)).toMatchObject({
        status: 'outcome_unknown',
        resultRevision: failed.resultRevision,
        result: failed.result,
      });

      const interrupted = await f.runtime.recoverSession({
        ...f.base,
        commandId: 'explicit-interrupt-unknown',
        expectedOwnerGeneration: (await f.store.getSession('s'))!.ownerGeneration,
        decision: 'interrupt',
      });
      expect(interrupted.unknownExecutionIds).toContain(failed.id);
      expect(f.requests).toHaveLength(calls);
      await f.submit('after-explicit-interrupt');
      let stillDenied: unknown;
      try {
        await f.done();
      } catch (error) {
        stillDenied = error;
      }
      expect(stillDenied).toMatchObject({ code: 'recovery_required' });
      expect(f.requests).toHaveLength(calls);
      expect(await f.store.listExecutions('s')).toHaveLength(executionCount);
      expect(await currentOutput()).toEqual(pending);
      expect(readFileSync(outputPath, 'utf8')).toBe(originalBody);
      expect(await f.store.getExecution(failed.id)).toMatchObject({
        status: 'outcome_unknown',
        resultRevision: failed.resultRevision,
        result: failed.result,
      });
    } finally {
      hookedStore.registerArtifact = originalRegister;
      hookedStore.writeExtensionRecord = originalWrite;
      await f.close();
    }
  }
}, 30000);
