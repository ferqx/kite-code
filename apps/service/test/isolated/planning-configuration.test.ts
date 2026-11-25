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
import { createWorkingInputFiles } from '@kite-ai/agent/files';
import {
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
  const referenceReads = new Set<string>();
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
      let call: Call;
      try {
        call = review ? null : await script(step, f);
      } catch (error) {
        const key = `${currentCommand}/${step}`;
        if (
          !(error instanceof Error) ||
          error.message !== 'fixture_exact_plan_reference_missing' ||
          referenceReads.has(key)
        )
          throw error;
        // Model scripts must read a plan that a separate Files operation revised.
        referenceReads.add(key);
        steps.set(currentCommand, step);
        call = { name: 'read_plan', input: {} };
      }
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
    tools: [
      ...new Set([
        ...toolIds,
        ...(toolIds.some((id) => id.startsWith('planning.')) ? ['planning.read'] : []),
      ]),
    ].map((id) => ({
      id,
      definitionVersion:
        id === 'files.read' ? '5' : id === 'files.write' ? '3' : id === 'files.edit' ? '2' : '1',
    })),
    planning: { requirePlan: true },
  };
  writeFileSync(configurationPath, JSON.stringify(configuration), { mode: 0o600 });
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
                  ...configuration.tools
                    .map((tool) => tool.id)
                    .filter((id) => !policy.exclude?.includes(id))
                    .map((id) => ({
                      kind: 'tool' as const,
                      definitionId: id,
                      definitionVersion:
                        id === 'files.read'
                          ? '5'
                          : id === 'files.write'
                            ? '3'
                            : id === 'files.edit'
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
    workingInputFiles: createWorkingInputFiles(),
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
    async planRef(plan: Record<string, Json>): Promise<string> {
      for (const row of (await store.listExecutions('s')).reverse()) {
        const data = (row.result as { details?: Record<string, Json> } | null)?.details;
        const original = (data?.current ?? data) as Record<string, Json> | undefined;
        if (
          row.status === 'succeeded' &&
          typeof data?.plan_ref === 'string' &&
          original?.planId === plan.planId &&
          original?.version === plan.version &&
          original?.digest === plan.digest
        )
          return data.plan_ref;
      }
      throw Error('fixture_exact_plan_reference_missing');
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
          kind === 'question' ? { kind, answers: { waive: true } } : { kind, decision: 'approve' },
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
        workingInputFiles: createWorkingInputFiles(),
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

async function askAfterFailure(f: Fixture, cause: string, question: string): Promise<Call> {
  const messages = f.requests.at(-1)!.messages as {
    role: string;
    content: string;
    tool_call_id?: string;
  }[];
  const receipt = messages.filter((message) => message.role === 'tool').at(-1)!;
  expect(receipt).toBeDefined();
  expect(typeof receipt.tool_call_id).toBe('string');
  const tool = (await f.store.listExecutions('s')).find(
    (execution) => execution.kind === 'tool' && execution.callId === receipt.tool_call_id,
  )!;
  expect(tool).toBeDefined();
  expect(['failed', 'cancelled', 'outcome_unknown']).toContain(tool.status);
  const raw = tool.result as { content: string; details?: { code?: string; reason?: string } };
  expect([raw.content, raw.details?.code, raw.details?.reason]).toContain(cause);
  const nextModel = (await f.store.listExecutions('s'))
    .filter((execution) => execution.kind === 'model' && execution.runId === tool.runId)
    .at(-1)!;
  const canonical = await f.runtime.readModelInput({
    ...f.base,
    executionId: nextModel.id,
  });
  expect(
    canonical.request.messages.find((message) => message.toolCallId === tool.callId),
  ).toMatchObject({ sourceIds: [tool.id], content: receipt.content });
  const publicCauses: Record<string, string> = {
    plan_approval_required: 'The current plan requires approval before this action can run.',
    plan_file_recovery_required:
      'The plan file and saved plan state require reconciliation. Check the original update before further plan changes.',
    plan_file_changed:
      'The plan file changed from its expected contents or identity. Inspect the current file and original update before further plan changes.',
  };
  expect(receipt.content).toContain(publicCauses[cause] ?? cause);
  return {
    name: 'ask_user',
    input: {
      questions: [
        {
          question,
          options: [
            {
              label: '核实后恢复',
              description: '读取当前原件并重新取得准确批准。',
            },
            { label: '停止任务', description: '保留当前文件和失败证据，停止本次执行。' },
            { label: '仅查看证据', description: '只读核对当前文件和失败原因。' },
          ],
        },
      ],
    },
  };
}
async function pendingQuestion(f: Fixture) {
  return until(
    async () =>
      (await f.store.listInteractions({ ...f.base, state: 'pending' })).interactions.find(
        (value) => value.kind === 'question',
      ) ?? null,
  );
}

test('external Plan drift during review rejects late approval and blocks workspace effects', async () => {
  const f = await fixture(
    { requirePlan: true },
    ['planning.write', 'planning.review', 'files.write', 'ask_user'],
    async (step, f): Promise<Call> => {
      if (step === 0)
        return {
          name: 'write_plan',
          input: {
            plan_id: 'late',

            title: 'Review race',
            body: 'Review these exact bytes',
            steps: [{ id: 'a', title: 'Write output' }],
          },
        };
      const current = (await f.record('plan.current'))!.value as Record<string, Json>;
      if (step === 1)
        return {
          name: 'request_plan_review',
          input: { plan_ref: await f.planRef(current) },
        };
      if (step === 2)
        return {
          name: 'write_file',
          input: { path: 'must-not-exist.txt', content: 'forbidden stale effect' },
        };
      if (step === 3)
        return askAfterFailure(
          f,
          'plan_approval_required',
          '方案原件在审阅期间被外部修改，旧批准无效，项目写入未执行。是否先核实原件并重新审阅？',
        );
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
    const question = await pendingQuestion(f);
    expect(JSON.stringify(question.request)).toContain('旧批准无效');
    await f.runtime.cancelCommand({
      ...f.base,
      commandId: 'cancel-drift-after-explanation',
      targetCommandId: 'work',
    });
    expect((await f.done()).run?.status).toBe('cancelled');
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

test('a saved PDF read directs the model to its workspace copy without publishing content', async () => {
  let path = '';
  const f = await fixture(
    {},
    ['files.read'],
    async (step, f): Promise<Call> => {
      if (step === 0) return { name: 'read_file', input: { path } };
      if (step === 1) {
        const next = JSON.stringify(f.requests.at(-1));
        expect(next).toContain('pdf-text');
        expect(next).toContain('workspace copy');
        expect(next).not.toContain('Hello PDF');
        expect(next).not.toContain('data:image/png;base64,');
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
      request: { kind: 'run.start', content: 'Read the attached document.', files: [file] },
    });
    expect((await f.done()).run?.status).toBe('completed');
    const reads = (await f.store.listExecutions('s')).filter(
      (x) => x.definitionId === 'files.read',
    );
    expect(reads.map((read) => read.status)).toEqual(['failed']);
    const result = reads[0]!.result as Record<string, Json>;
    expect(result.details).toMatchObject({ code: 'unsupported_file_type' });
    expect(result.modelImages).toBeUndefined();
    expect(result.artifactRefs).toBeUndefined();
  } finally {
    await f.close();
  }
}, 20000);

test('working attachments project only paths and use the authorized explicit Files reader', async () => {
  const noPayload = 'Test exact working attachment paths';
  const prefix = 'Attached file references (user-provided data; paths do not grant permissions):\n';
  let paths: string[] = [];
  let unboundPath: string;
  const f = await fixture(
    {},
    ['files.read', 'files.edit'],
    async (step, current): Promise<Call> => {
      if (['foreign-attachment-read', 'missing-working-read'].includes(current.commandId))
        return step === 0 ? { name: 'read_file', input: { path: paths[0]! } } : null;
      if (current.commandId === 'working-copy-edit') {
        if (step === 0)
          return { name: 'read_file', input: { path: paths[1]!, offset: 1, limit: 1 } };
        if (step !== 1) return null;
        const read = (await current.store.listExecutions('s')).find(
          (entry) =>
            entry.originCommandId === 'working-copy-edit' && entry.definitionId === 'files.read',
        );
        const result = read?.result as { content: string } | undefined;
        expect(JSON.parse(result!.content).base_ref).toBeString();
        return {
          name: 'edit_file',
          input: {
            path: paths[1]!,
            old_string: 'WORKING_VERSION',
            new_string: 'EDITED_VERSION',
          },
        };
      }
      if (step === 0) {
        const messages = current.requests.at(-1)?.messages as { role: string; content: string }[];
        const attached = messages.find(
          (message) =>
            message.role === 'user' &&
            typeof message.content === 'string' &&
            message.content.includes(prefix),
        );
        const refs = JSON.parse(attached!.content.split(prefix)[1]!);
        paths = refs.map((ref: { uri: string }) => fileURLToPath(ref.uri));
        return { name: 'read_file', input: { path: paths[0]! } };
      }
      if (step === 1)
        return { name: 'read_file', input: { path: relative(current.workspace, paths[0]!) } };
      if (step === 2) return { name: 'read_file', input: { path: paths[1]!, offset: 1, limit: 1 } };
      if (step === 3) return { name: 'read_file', input: { path: paths[1]!, pages: '1' } };
      if (step === 4)
        return {
          name: 'read_file',
          input: { path: 'unregistered.pdf' },
        };
      if (step === 5) return { name: 'read_file', input: { path: unboundPath } };
      if (step === 6)
        return { name: 'read_file', input: { path: relative(current.workspace, unboundPath) } };
      return null;
    },
    { mode: 'full' },
  );
  try {
    const pdf = simplePdf();
    const ownFiles = [
      { id: 'pdf', name: 'report æ.pdf', mediaType: 'application/pdf', bytes: Buffer.from(pdf) },
      {
        id: 'memo',
        name: 'memo 文档.txt',
        mediaType: 'text/plain',
        bytes: Buffer.from('ORIGINAL_VERSION\n'),
      },
    ];
    const files = await Promise.all(
      ownFiles.map(async ({ bytes, ...input }) =>
        f.runtime.uploadInputFile({
          ...f.base,
          ...input,
          content: (async function* () {
            yield bytes;
          })(),
        }),
      ),
    );
    const commandId = 'work';
    await f.runtime.prepareWorkingInputs({
      expectedStoreId: f.base.expectedStoreId,
      targetSessionId: 's',
      subjectId: f.base.subjectId,
      commandId,
      files,
    });
    const working = await Promise.all(
      ownFiles.map(({ id }) => f.store.getWorkingInput({ ...f.base, commandId, importId: id })),
    );
    const workingPaths = working.map((item) => join(f.workspace, item!.workingRelativePath));
    const unpublished = await f.runtime.uploadInputFile({
      ...f.base,
      id: 'unbound',
      name: ownFiles[0]!.name,
      mediaType: 'application/pdf',
      content: (async function* () {
        yield pdf;
      })(),
    });
    await f.runtime.prepareWorkingInputs({
      expectedStoreId: f.base.expectedStoreId,
      targetSessionId: 's',
      subjectId: f.base.subjectId,
      commandId: 'never-submitted',
      files: [unpublished],
    });
    const unbound = await f.store.getWorkingInput({
      ...f.base,
      commandId: 'never-submitted',
      importId: 'unbound',
    });
    expect(unbound?.state).toBe('ready');
    unboundPath = join(f.workspace, unbound!.workingRelativePath);
    expect(readFileSync(unboundPath)).toEqual(Buffer.from(pdf));
    writeFileSync(workingPaths[1]!, 'WORKING_VERSION\n');
    writeFileSync(join(f.workspace, 'unregistered.pdf'), pdf);
    await f.runtime.submitCommand({
      ...f.base,
      commandId,
      request: { kind: 'run.start', content: noPayload, files },
    });
    expect((await f.done()).run?.status).toBe('completed');
    expect(paths).toEqual(workingPaths);
    const first = JSON.stringify(f.requests[0]);
    for (const file of files) {
      expect(first).not.toContain(file.uri);
      expect(first).not.toContain(file.reference!.hash);
    }
    expect(first).not.toContain('Hello PDF');
    expect(first).not.toContain('ORIGINAL_VERSION');
    expect(first).not.toContain('data:image/png;base64,');
    expect(first).not.toContain(Buffer.from(pdf).toString('base64'));
    const rows = (await f.store.listExecutions('s')).filter((entry) => entry.kind === 'tool');
    expect(rows.map((entry) => [entry.definitionId, entry.status])).toEqual([
      ['files.read', 'failed'],
      ['files.read', 'failed'],
      ['files.read', 'succeeded'],
      ['files.read', 'failed'],
      ['files.read', 'failed'],
      ['files.read', 'failed'],
      ['files.read', 'failed'],
    ]);
    for (const index of [0, 1, 4]) {
      const result = rows[index]!.result as Record<string, Json>;
      expect(result.details).toMatchObject({ code: 'unsupported_file_type' });
      expect(result.content).toContain('pdf-text');
      expect(result.artifactRefs).toBeUndefined();
      expect(result.modelImages).toBeUndefined();
    }
    expect(JSON.stringify(f.requests)).not.toContain('Hello PDF');
    expect(JSON.stringify(f.requests)).not.toContain('data:image/png;base64,');
    expect(JSON.stringify(rows[2]!.result)).toContain('WORKING_VERSION');
    expect(rows[3]!.result).toMatchObject({ details: { code: 'invalid_tool_arguments' } });
    expect(
      rows.slice(5).map((row) => ({
        path: (row.input as Record<string, Json>).path,
        dispatched: row.authorization?.dispatched,
        reason: (row.result as { details?: { reason?: string } }).details?.reason,
      })),
    ).toEqual(
      [unboundPath, relative(f.workspace, unboundPath)].map((path) => ({
        path,
        dispatched: false,
        reason: 'input_file_scope_denied',
      })),
    );
    await f.submit('working-copy-edit');
    expect((await f.done('working-copy-edit')).run?.status).toBe('completed');
    const editRows = (await f.store.listExecutions('s')).filter(
      (entry) => entry.kind === 'tool' && entry.originCommandId === 'working-copy-edit',
    );
    expect(editRows.map((entry) => [entry.definitionId, entry.status])).toEqual([
      ['files.read', 'succeeded'],
      ['files.edit', 'succeeded'],
    ]);
    expect(readFileSync(workingPaths[1]!, 'utf8')).toBe('EDITED_VERSION\n');
    expect(readFileSync(fileURLToPath(files[1]!.uri), 'utf8')).toBe('ORIGINAL_VERSION\n');
    await f.runtime.createSession({
      ...f.base,
      sessionId: 'other',
      commandId: 'create-other',
      workspaceId: 'w',
      title: 'foreign',
    });
    await initializeLivePermissionFixture({
      runtime: f.runtime,
      profile: f.profile,
      ...f.base,
      sessionId: 'other',
      workspaceId: 'w',
      mode: 'full',
      trusted: true,
    });
    expect(readFileSync(paths[0]!)).toEqual(Buffer.from(pdf));
    await f.submit('foreign-attachment-read', 'other');
    expect((await f.done('foreign-attachment-read')).run?.status).toBe('completed');
    const foreign = (await f.store.listExecutions('other')).filter(
      (entry) => entry.kind === 'tool',
    );
    expect(foreign).toHaveLength(1);
    expect(foreign[0]).toMatchObject({
      status: 'failed',
      result: { details: { reason: 'input_file_scope_denied' } },
    });
    rmSync(paths[0]!);
    expect(readFileSync(fileURLToPath(files[0]!.uri))).toEqual(Buffer.from(pdf));
    await f.submit('missing-working-read');
    expect((await f.done('missing-working-read')).run?.status).toBe('completed');
    const missing = (await f.store.listExecutions('s')).filter(
      (entry) => entry.kind === 'tool' && entry.originCommandId === 'missing-working-read',
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ status: 'failed' });
    expect((missing[0]?.result as Record<string, Json>).modelImages).toBeUndefined();
    for (const recorded of f.requests)
      expect(JSON.stringify(recorded)).not.toContain(fileURLToPath(files[0]!.uri));
  } finally {
    await f.close();
  }
}, 25000);

test('mixed PDF, TXT and Office files are path-only while a direct PNG is inline', async () => {
  // Minimal synthetic Open XML packages, frozen from offline ZIP+XML fixtures.
  const docx = Buffer.from(
    'UEsDBBQAAAAIAAAAIVz3S4B1wgAAAHYBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QuQ7CMAyGX6XKiqgRAwOiLMAKDLyAlbpt' +
      'RC7FLsfbk3INCBjt//gsLw7XSFxcnPVcqU4kzgFYd+SQyxDJZ6UJyaHkMbUQUR+xJZhOJjPQwQt5GcvQoZaLNTXYWyk2l7xmE3yl' +
      'EllWxephHFiVwhit0ShZh5OvPyjjJ6HMybuHOxN5lA0KvhIG5TfgmdudKCVTU7HHJFt02QXnkGqog+5dTpb/a77cGZrGaHrnh7aY' +
      'giZm41tny7fi0PjX/XB/9/IGUEsDBBQAAAAIAAAAIVxhey9DiQAAAPIAAAALAAAAX3JlbHMvLnJlbHONzzsOAiEQBuCrEA6ws1pY' +
      'GKCy2dZ4AQLDIy6PDBj19lJYrMbCcuaffH9GnHHVPZbcQqyNPdKam+Sh93oEaCZg0m0qFfNIXKGk+xjJQ9Xmqj3Cfp4PQFuDK7E1' +
      '2WIlp8XuOLs8K/5jF+eiwVMxt4S5/6j4uhiyJo9d8nshC/a9ngbLQQn4eFG9AFBLAwQUAAAACAAAACFcNOlZ2oUAAACkAAAAEQAA' +
      'AHdvcmQvZG9jdW1lbnQueG1ssym3SslPLs1NzStRqMjNySu2KrdVyigpKbDS1y9OzkjNTSzWyy9IzQPKpeUX5SaWALlF6frl+UUp' +
      'BUX5yanFxZl56bk5+kYGBmb6uYmZeUp2NuVWSfkplSC6AEQUgYgSOxd/54h4/3A/V5d4N8+IkNAgVxt9kDiILAKTBWASolcf4S47' +
      'AFBLAQIUAxQAAAAIAAAAIVz3S4B1wgAAAHYBAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAA' +
      'AAgAAAAhXGF7L0OJAAAA8gAAAAsAAAAAAAAAAAAAAIAB8wAAAF9yZWxzLy5yZWxzUEsBAhQDFAAAAAgAAAAhXDTpWdqFAAAApAAA' +
      'ABEAAAAAAAAAAAAAAIABpQEAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAADAAMAuQAAAFkCAAAAAA==',
    'base64',
  );
  const xlsx = Buffer.from(
    'UEsDBBQAAAAIAAAAIVwcdPw42AAAAPYBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbK2RvU4DMQzHX+WUtWpcGDqgXhfKCgy8gJvz' +
      '9aLLl2K3XN++uVAYUIGFyUr+Hz9L3rydE3EzeRe4VYNIegBgM5BH1jFRKEofs0cpz3yAhGbEA8H9arUGE4NQkKXMHWq72VGPRyfN' +
      '01S+2cbQqkyOVfP4YZxZrcKUnDUoRYdT6L5RlleCLsnq4cEmXhSDgpuEWfkZcM29nChn21Hzilme0RcXTA7eYx73MY7695IbW8a+' +
      't4a6aI6+RDSnTNjxQCTe6Tq1RxsWf/OrmaGOu39e5Kv/cw+o595eAFBLAwQUAAAACAAAACFc/luGcooAAADwAAAACwAAAF9yZWxz' +
      'Ly5yZWxzjc8xDsIwDAXQq1Q+QF0YGFDaiaUr4gImddqqTRw5QZTbk7EgBkbrf70vmyuvlGcJaZpjqja/htTClHM8IyY7sadUS+RQ' +
      'EifqKZdTR4xkFxoZj01zQt0b0Jm9WfVDC9oPB6hur8j/2OLcbPki9uE55B8TX40ik46cW9hWfIoud5GlLihgZ/Djwe4NUEsDBBQA' +
      'AAAIAAAAIVwkJiyBkgAAAOMAAAAPAAAAeGwvd29ya2Jvb2sueG1sjY8xDoMwDEWvEvkANXTogICpC1PPkBLTRJA4slPR4xdB2TvZ' +
      '/3/5fbldWeYn82w+cUnagS8lN4g6eopWL5wpbcnEEm3ZpLxQs5B16olKXPBaVTeMNiQ4CI38w+BpCiPdeXxHSuWACC22BE7qQ1bo' +
      '271Bf9MkG6mDx5rIgdmtwXVQg5EmbIsMrgbsWzyv8Hys/wJQSwMEFAAAAAgAAAAhXLZUqs+OAAAA8QAAABoAAAB4bC9fcmVscy93' +
      'b3JrYm9vay54bWwucmVsc43PPQ7CMAwF4KtUOUDdMjCgJhNLV8QFotRtojY/so2A2xMxoCIxMFl+lr4nDxfcrISc2IfCzSNuibXy' +
      'IuUEwM5jtNzmgqle5kzRSl1pgWLdaheEQ9cdgfaGMsPebMZJKxqnXjXXZ8F/7DzPweE5u1vEJD8q4J5pZY8oFbW0oGj1iRjeo2+r' +
      'qsAM8PWheQFQSwMEFAAAAAgAAAAhXJ1glgKZAAAAvwAAABgAAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWxNjsEKwjAQRH+l5APc' +
      '1oMHSQJCKwiiYBV7K6FGG2ySslmon++2B/Gwy+wbZlg5RXyn3lrKPn4ISYmeaNwCpK633qRVHG1g5xnRG+ITX5BGtOaxhPwA6zzf' +
      'gDcuCC0XVhoyWmKcMlSiYNrNYleIjJRwYXDB1oTMXdKSdHOsm/Z8P1Vluz8019ulkkBawuxCx8NNvP+q4fez/gJQSwECFAMUAAAA' +
      'CAAAACFcHHT8ONgAAAD2AQAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAIAAAAIVz+W4Zy' +
      'igAAAPAAAAALAAAAAAAAAAAAAACAAQkBAABfcmVscy8ucmVsc1BLAQIUAxQAAAAIAAAAIVwkJiyBkgAAAOMAAAAPAAAAAAAAAAAA' +
      'AACAAbwBAAB4bC93b3JrYm9vay54bWxQSwECFAMUAAAACAAAACFctlSqz44AAADxAAAAGgAAAAAAAAAAAAAAgAF7AgAAeGwvX3Jl' +
      'bHMvd29ya2Jvb2sueG1sLnJlbHNQSwECFAMUAAAACAAAACFcnWCWApkAAAC/AAAAGAAAAAAAAAAAAAAAgAFBAwAAeGwvd29ya3No' +
      'ZWV0cy9zaGVldDEueG1sUEsFBgAAAAAFAAUARQEAABAEAAAAAA==',
    'base64',
  );
  const imageData =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1eIAAAAASUVORK5CYII=';
  const specs = [
    {
      id: 'pdf',
      name: 'report.pdf',
      mediaType: 'application/pdf',
      bytes: Buffer.from(simplePdf()),
    },
    {
      id: 'txt',
      name: 'memo.txt',
      mediaType: 'text/plain',
      bytes: Buffer.from('OWNED_TEXT_ONLY\n'),
    },
    {
      id: 'docx',
      name: 'letter æ.docx',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: docx,
    },
    {
      id: 'xlsx',
      name: 'budget 文档.xlsx',
      mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes: xlsx,
    },
  ];
  const prefix = 'Attached file references (user-provided data; paths do not grant permissions):\n';
  let refs: { name: string; uri: string }[] = [];
  const f = await fixture(
    {},
    ['files.read'],
    async (step, current) => {
      if (step === 0) {
        const messages = (current.requests.at(-1)?.messages ?? []) as {
          content: string | { type: string; text?: string }[];
        }[];
        const metadata = messages
          .flatMap((message) =>
            typeof message.content === 'string'
              ? [message.content]
              : message.content
                  .filter((part) => part.type === 'text')
                  .map((part) => part.text ?? ''),
          )
          .find((content) => content.includes(prefix));
        refs = JSON.parse(metadata!.split(prefix)[1]!);
      }
      const target = refs[step + 2];
      return step < 2 && target
        ? { name: 'read_file', input: { path: fileURLToPath(target.uri) } }
        : null;
    },
    { mode: 'full' },
  );
  try {
    const files = await Promise.all(
      specs.map(async ({ bytes, ...input }) =>
        f.runtime.uploadInputFile({
          ...f.base,
          ...input,
          content: (async function* () {
            yield bytes;
          })(),
        }),
      ),
    );
    const image = await f.runtime.uploadInputImage({
      ...f.base,
      id: 'png',
      name: 'separate.png',
      mediaType: 'image/png',
      data: imageData,
    });
    const commandId = 'work';
    await f.runtime.prepareWorkingInputs({
      expectedStoreId: f.base.expectedStoreId,
      targetSessionId: 's',
      subjectId: f.base.subjectId,
      commandId,
      files,
    });
    await f.runtime.submitCommand({
      ...f.base,
      commandId,
      request: {
        kind: 'run.start',
        content: 'Use existing Files for two binary files only',
        files,
        images: [image],
      },
    });
    expect((await f.done()).run?.status).toBe('completed');
    expect(refs).toHaveLength(specs.length);
    const first = JSON.stringify(f.requests[0]);
    expect(first.split('data:image/png;base64,').length - 1).toBe(1);
    expect(first).toContain(`data:image/png;base64,${imageData}`);
    for (const [i, fixture] of specs.entries()) {
      const bound = await f.store.getWorkingInput({ ...f.base, commandId, importId: fixture.id });
      expect(bound?.state).toBe('bound');
      expect(Object.keys(refs[i]!).sort()).toEqual(['name', 'uri']);
      expect(refs[i]!.name).toBe(fixture.name);
      expect(fileURLToPath(refs[i]!.uri)).toBe(join(f.workspace, bound!.workingRelativePath));
      const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
      expect(sha(readFileSync(fileURLToPath(refs[i]!.uri)))).toBe(sha(fixture.bytes));
      expect(first).not.toContain(files[i]!.uri);
      expect(first).not.toContain(fixture.bytes.toString('base64'));
    }
    for (const sourceText of [
      'Hello PDF',
      'OWNED_TEXT_ONLY',
      'DOCX_OWNED_FIXTURE',
      'XLSX_OWNED_FIXTURE',
    ])
      expect(first).not.toContain(sourceText);
    const ordinaryReads = (await f.store.listExecutions('s')).filter(
      (entry) => entry.kind === 'tool',
    );
    expect(ordinaryReads).toHaveLength(2);
    for (const row of ordinaryReads) {
      expect(row).toMatchObject({
        definitionId: 'files.read',
        status: 'failed',
        authorization: { dispatched: true },
      });
      expect(row.result).toMatchObject({
        details: { code: 'unsupported_file_type' },
      });
    }
  } finally {
    await f.close();
  }
}, 20000);

test('final model input offers only same-call Shell delivery without Files outputDirectory', async () => {
  const f = await fixture({}, ['files.write', 'files.edit'], async () => null, { mode: 'full' });
  try {
    await f.submit();
    expect((await f.done()).run?.status).toBe('completed');
    const request = f.requests[0]!;
    const messages = request.messages as { content: string }[];
    const session = messages
      .flatMap((m) => {
        try {
          return [JSON.parse(m.content)];
        } catch {
          return [];
        }
      })
      .find((m) => m.kind === 'session_files');
    expect(session).toBeUndefined();
    const tools = request.tools as {
      function: {
        name: string;
        description: string;
        parameters: { properties: Record<string, unknown> };
      };
    }[];
    for (const name of ['write_file', 'edit_file']) {
      const tool = tools.find((t) => t.function.name === name)!.function;
      expect(tool.description).not.toContain('outputDirectory');
      expect(tool.description).toContain(
        'Files read/write/edit operations do not collect attachments',
      );
      expect(tool.description).toContain('Do not use Files to write a previous Shell staging path');
      expect(tool.description).toContain('Preserve user-specified locations and permissions');
      expect(tool.parameters.properties).not.toHaveProperty('outputDirectory');
      expect(tool.parameters.properties).not.toHaveProperty('register_output');
    }
  } finally {
    await f.close();
  }
}, 20000);

test('ordinary workspace write and edit keep snapshots without becoming turn attachments', async () => {
  const f = await fixture(
    {},
    ['files.write', 'files.read', 'files.edit'],
    async (step, f): Promise<Call> => {
      if (step === 0)
        return { name: 'write_file', input: { path: 'working.md', content: 'Draft notes' } };
      if (step === 1) {
        expect(
          (await f.runtime.queryOutputFiles({ ...f.base, runId: await f.runId() })).items,
        ).toEqual([]);
        return { name: 'read_file', input: { path: 'working.md' } };
      }
      if (step === 2) {
        const read = (await f.store.listExecutions('s')).find(
          (e) => e.definitionId === 'files.read',
        )!;
        expect(read.status).toBe('succeeded');
        return {
          name: 'edit_file',
          input: {
            path: 'working.md',
            old_string: 'Draft',
            new_string: 'Final',
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
    expect(readFileSync(join(f.workspace, 'working.md'), 'utf8')).toBe('Final notes');
    const writes = (await f.store.listExecutions('s')).filter((e) =>
      ['files.write', 'files.edit'].includes(e.definitionId),
    );
    expect(writes.map((e) => e.status)).toEqual(['succeeded', 'succeeded']);
    for (const execution of writes)
      expect((execution.result as Record<string, Json>).artifactRefs).not.toEqual([]);
    expect((await f.runtime.queryOutputFiles({ ...f.base, runId: await f.runId() })).items).toEqual(
      [],
    );
    expect(
      (
        await f.store.listExtensionRecords({
          sessionId: 's',
          extensionId: 'builtin.files',
          limit: 100,
        })
      ).filter((r) => r.key.startsWith('output-operation/') || r.key.startsWith('delivery/')),
    ).toEqual([]);
  } finally {
    await f.close();
  }
}, 20000);

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
          input: { path, content: 'Revised 中文 plan' },
        };
      }
      if (step === 4) {
        expect(current.version).toBe(2);
        expect(plan.body).toBe('Revised 中文 plan');
        expect(readFileSync(path, 'utf8')).toBe(String(plan.body));
        return {
          name: 'request_plan_review',
          input: { plan_ref: await f.planRef(current) },
        };
      }
      if (step === 5)
        return {
          name: 'write_file',
          input: { path: 'result.txt', content: 'approved result' },
        };
      if (step === 6) {
        const effect = (await f.store.listExecutions('s'))
          .filter((x) => x.definitionId === 'files.write')
          .at(-1)!;
        return {
          name: 'update_plan_progress',
          input: {
            plan_ref: await f.planRef(current),
            progress_ref: null,
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
      snapshot: {
        planning: { requirePlan: false, binding: { policy: { completionGuidance: true } } },
      },
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
          input: { plan_ref: await f.planRef(current) },
        };
      if (step === 2)
        return {
          name: 'write_file',
          input: { path: 'ledger.txt', content: 'one actual effect' },
        };
      if (step === 3) {
        const actual = (await f.store.listExecutions('s')).find(
          (x) => x.runId === runId && x.definitionId === 'files.write',
        )!;
        return {
          name: 'update_plan_progress',
          input: {
            plan_ref: await f.planRef(current),
            progress_ref: null,
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
      definitionVersion: '3',
    });
    expect(progress).toMatchObject({
      runId: done.run!.id,
      planId: 'p',
      version: 1,
      completePlan: true,
      steps: {
        a: {
          status: 'completed',
          receipt: { executionId: file.id, definitionId: 'files.write', definitionVersion: '3' },
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

test('global exact Planning Action requests approval in Request Approval, allows trusted Auto/Full, and denies untrusted work without any Model', async () => {
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
      if (mode === 'accept_edits') {
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
          answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
        });
      }
      const done = await f.runtime.waitForCommand('idle-governance', { timeoutMs: 5000 });
      const execution = await f.store.getExecution(
        String((done.receipt as Record<string, Json>).executionId),
      );
      expect(execution).toMatchObject({ kind: 'job', runId: null, status: 'succeeded' });
      expect(execution?.authorization?.check).toBeUndefined();
      if (mode !== 'accept_edits') {
        expect(execution?.authorization?.human).toBeUndefined();
        expect((await f.store.listInteractions({ ...f.base })).interactions).toHaveLength(0);
      }
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
    ).toMatchObject({
      status: 'failed',
      authorization: { dispatched: false },
      result: {
        content: expect.stringContaining('workspace_untrusted'),
        details: {
          code: 'permission_denied',
          reason: 'workspace_untrusted',
          adapterAttempted: false,
        },
      },
    });
    expect(await denied.record('plan.current')).toBeNull();
    expect(denied.requests).toHaveLength(0);
  } finally {
    await denied.close();
  }
}, 15000);

test('reusing an earlier Plan ID keeps old reviews historical and requires a new exact approval before effects', async () => {
  const f = await fixture(
    { requirePlan: true },
    ['planning.write', 'planning.review', 'planning.update', 'files.write'],
    async (step, f): Promise<Call> => {
      if ([0, 2, 3].includes(step)) {
        const planId = step === 2 ? 'B' : 'A';
        return {
          name: 'write_plan',
          input: {
            plan_id: planId,
            ...(step === 0
              ? {}
              : {
                  expected_plan_ref: await f.planRef(
                    (await f.record('plan.current'))!.value as Record<string, Json>,
                  ),
                }),
            title: `Plan ${planId}`,
            body: step === 3 ? 'Reused A requires a new review' : `Original ${planId}`,
            steps: [{ id: 'a', title: 'One precise workspace write' }],
          },
        };
      }
      const current = (await f.record('plan.current'))!.value as Record<string, Json>;
      if (step === 1 || step === 5)
        return {
          name: 'request_plan_review',
          input: { plan_ref: await f.planRef(current) },
        };
      if (step === 4 || step === 6)
        return {
          name: 'write_file',
          input: {
            path: step === 4 ? 'old-a-approval.txt' : 'new-a-approval.txt',
            content: 'Exact A version only',
          },
        };
      if (step === 7) {
        const written = (await f.store.listExecutions('s')).find(
          (execution) =>
            execution.definitionId === 'files.write' && execution.status === 'succeeded',
        )!;
        return {
          name: 'update_plan_progress',
          input: {
            plan_ref: await f.planRef(current),
            progress_ref: null,
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
    const old = await f.answer('plan_review');
    expect(old.request).toMatchObject({
      version: '1',
      content: expect.stringContaining('Original A'),
    });
    const reviewed = await f.answer('plan_review');
    expect(reviewed.request).toMatchObject({
      version: '3',
      content: expect.stringContaining('Reused A requires a new review'),
    });
    expect((await f.done()).run?.status).toBe('completed');
    expect((await f.record('plan.current'))!.value).toMatchObject({ planId: 'A', version: 3 });
    expect((await f.record('plan/A/1'))!.value).toMatchObject({ body: 'Original A' });
    expect((await f.record('plan/B/2'))!.value).toMatchObject({ body: 'Original B' });
    const oldInteraction = (
      await f.store.listInteractions({ ...f.base, state: 'answered' })
    ).interactions.find((interaction) => interaction.id === old.id);
    expect(oldInteraction?.request).toEqual(old.request);
    expect(await f.record(`run/${await f.runId()}/approval/A/1`)).not.toBeNull();
    expect(await f.record(`run/${await f.runId()}/approval/A/3`)).not.toBeNull();
    const writes = (await f.store.listExecutions('s')).filter(
      (execution) => execution.definitionId === 'files.write',
    );
    expect(writes.map((execution) => execution.status)).toEqual(['failed', 'succeeded']);
    expect(writes[0]!.result).toMatchObject({
      details: {
        adapterAttempted: false,
        dispatchCommitted: false,
        reason: 'plan_approval_required',
      },
    });
    expect(existsSync(join(f.workspace, 'old-a-approval.txt'))).toBe(false);
    expect(readFileSync(join(f.workspace, 'new-a-approval.txt'), 'utf8')).toBe(
      'Exact A version only',
    );
  } finally {
    await f.close();
  }
}, 20000);

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
            plan_ref: await f.planRef(current),
          },
        };
      if (step === 2) return { name: 'read_file', input: { path: planPath } };
      if (step === 3) {
        const read = (await f.store.listExecutions('s')).find(
          (e) => e.definitionId === 'files.read',
        )!;
        expect(read.status).toBe('succeeded');
        return {
          name: 'edit_file',
          input: {
            path: planPath,
            old_string: 'Original approved',
            new_string: 'Changed unapproved',
          },
        };
      }
      if (step === 4) {
        expect(current.version).toBe(2);
        expect(plan.body).toBe('Changed unapproved plan');
        return {
          name: 'write_file',
          input: { path: 'stale-approval.txt', content: 'Must never be written' },
        };
      }
      if (step === 6)
        return {
          name: 'write_file',
          input: {
            path: 'fresh-approval.txt',
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
            plan_ref: await f.planRef(current),
            progress_ref: null,
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

      title: 'Exact publication',
      body: 'Complete bytes before SQL commit',
      steps: [{ id: 'a', title: 'Write only after complete publication' }],
    };
    const f = await fixture(
      { requirePlan: true },
      ['planning.write', 'planning.review', 'planning.update', 'files.write', 'ask_user'],
      async (step, f): Promise<Call> => {
        if (f.commandId === 'work') {
          if (step === 0) return { name: 'write_plan', input: planInput };
          if (step === 1)
            return askAfterFailure(
              f,
              'plan_file_publish_unknown',
              '方案文件可能已经发布，但记录尚未提交，不能直接重投。是否先核实原操作后恢复发布？',
            );
          return null;
        }
        const current = (await f.record('plan.current'))!.value as Record<string, Json>;
        if (f.commandId === 'pending-review')
          return step === 0
            ? {
                name: 'request_plan_review',
                input: {
                  plan_ref: await f.planRef(current),
                },
              }
            : step === 1
              ? askAfterFailure(
                  f,
                  'plan_file_recovery_required',
                  '方案发布尚未完成，不能请求批准。是否先核实并恢复原发布？',
                )
              : null;
        if (f.commandId === 'pending-effect')
          return step === 0
            ? {
                name: 'write_file',
                input: {
                  path: 'pending-publication.txt',
                  content: 'Must not be dispatched',
                },
              }
            : step === 1
              ? askAfterFailure(
                  f,
                  'plan_approval_required',
                  '方案发布及批准尚未完成，项目写入未执行。是否先恢复方案并审阅？',
                )
              : null;
        if (step === 0) return { name: 'write_plan', input: planInput };
        if (step === 1 && externalChange)
          return askAfterFailure(
            f,
            'plan_file_changed',
            '外部方案字节已变化，同内容恢复失败。是否先核实外部原件，保留现有字节？',
          );
        if (step === 1 && !externalChange)
          return {
            name: 'request_plan_review',
            input: { plan_ref: await f.planRef(current) },
          };
        if (step === 2 && !externalChange)
          return {
            name: 'write_file',
            input: {
              path: 'recovered-publication.txt',
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
              plan_ref: await f.planRef(current),
              progress_ref: null,
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
      await pendingQuestion(f);
      await f.runtime.cancelCommand({
        ...f.base,
        commandId: 'cancel-unknown-after-explanation',
        targetCommandId: 'work',
      });
      expect((await f.done()).run?.status).toBe('cancelled');
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
      await pendingQuestion(f);
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
      await pendingQuestion(f);
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
        await pendingQuestion(f);
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

test.each([
  'read_file',
  'write_file',
  'edit_file',
])('retired Files output directory is not an authorized delivery target: %s', async (name) => {
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
      if (step !== 0) return null;
      return {
        name,
        input:
          name === 'read_file'
            ? { path: outputPath }
            : name === 'write_file'
              ? { path: outputPath, content: 'not a delivery' }
              : { path: outputPath, old_string: 'a', new_string: 'b' },
      };
    },
    { mode: 'full' },
  );
  try {
    await f.submit();
    await f.done();
    const executions = (await f.store.listExecutions('s')).filter((e) =>
      ['files.read', 'files.write', 'files.edit'].includes(e.definitionId),
    );
    expect(executions).toHaveLength(1);
    expect(executions[0]!.status).not.toBe('succeeded');
    expect(existsSync(outputPath)).toBe(false);
    const outputs = await f.runtime.queryOutputFiles({ ...f.base, runId: await f.runId() });
    expect(outputs.items).toEqual([]);
    const views = await f.runtime.queryExtension({
      ...f.base,
      extensionId: 'builtin.files',
      queryId: 'files.outputs',
      input: {},
    });
    expect(views[0]!.payload).toEqual([]);
  } finally {
    await f.close();
  }
}, 20000);
