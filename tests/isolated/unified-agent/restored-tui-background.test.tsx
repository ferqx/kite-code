import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createProfileBackup, restoreProfileBackup } from '@kite-ai/agent/maintenance';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { type AgentClient, createClient, type Message } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { TuiController, type TuiPort, TuiSession } from '@kite-ai/ui/tui';
import { render } from 'ink-testing-library';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const unavailable = async (): Promise<never> => {
  throw Error('restored_reader_must_not_write');
};

async function readMessages(
  client: AgentClient,
  sessionId: string,
  upperSeq: string,
  signal?: AbortSignal,
): Promise<Message[]> {
  const messages: Message[] = [];
  let afterSeq = '0';
  for (;;) {
    const page = await client.listMessages(sessionId, { afterSeq, upperSeq, limit: 200, signal });
    for (const message of page) {
      if (
        message.sessionId !== sessionId ||
        BigInt(message.seq) <= BigInt(afterSeq) ||
        BigInt(message.seq) > BigInt(upperSeq)
      )
        throw Error('history_identity_mismatch');
      messages.push(message);
      afterSeq = message.seq;
    }
    if (page.length < 200) return messages;
  }
}

test('restored TUI background directory and complete output/child readers preserve original identities through cold GET-only reads', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-restored-tui-background-')));
  const selected = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(selected);
  const originalStoreId = (await store.getMetadata()).storeId;
  const profile = {
    dataRoot: realpathSync(selected.dataRoot),
    name: selected.profile,
    accessKey: resolveProfile(selected).profileAccessKey,
  };
  const childContent = `Original child\n${'完整子正文🌿'.repeat(4096)}\nTUI_RESTORED_CHILD_COMPLETE_TAIL`;
  const childReasoning = 'Original child reasoning 雪🙂';
  const childModel = createFixedModel([
    [
      { type: 'text_delta', text: childContent },
      { type: 'reasoning_delta', text: childReasoning },
      finish,
    ],
  ]);
  const parentModel = createFixedModel([
    [
      { type: 'tool_call', id: 'spawn-original', name: 'fixture.spawn', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: 'Original parent completed' }, finish],
  ]);
  const chunks = Array.from({ length: 220 }, (_, i) => `Original output ${i} 原🙂e\u0301\n`);
  const result = { outcome: 'succeeded' as const, content: 'ORIGINAL_JOB_RESULT_COMPLETE' };
  let starts = 0;
  let jobId = '';
  let childJobId = '';
  let childSessionId = '';
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile: selected, store }),
    model: parentModel,
    modelId: 'parent',
    modelConcurrency: 1,
    maxConcurrentSubagents: 1,
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
    childConfigurations: [
      {
        id: 'original-child',
        version: '1',
        snapshot: { fixture: 'original-child' },
        model: childModel,
        modelId: 'child',
        toolIds: [],
        maxConcurrentSubagents: 1,
      },
    ],
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.spawn',
            version: '1',
            description: 'Create original output and child once',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              const job = await context.operations.ensure({
                key: 'original-output',
                request: {
                  kind: 'job',
                  definitionId: 'fixture.output',
                  definitionVersion: '1',
                  input: {},
                },
              });
              const child = await context.operations.ensure({
                key: 'original-child',
                request: {
                  kind: 'agent',
                  configurationId: 'original-child',
                  input: { content: 'Original child input' },
                },
              });
              jobId = job.executionId!;
              childJobId = child.executionId!;
              childSessionId = child.childSessionId!;
              await Promise.all([
                context.operations.wait(job, { signal: context.signal, timeoutMs: 5000 }),
                context.operations.wait(child, { signal: context.signal, timeoutMs: 5000 }),
              ]);
              return { outcome: 'succeeded', content: 'Original children completed' };
            },
          },
        ],
        jobs: [
          {
            id: 'fixture.output',
            version: '1',
            description: 'Original paged output',
            inputSchema: { type: 'object' },
            async start() {
              starts++;
              return { reference: { id: 'original-output' } };
            },
            async *observe() {
              for (const [i, content] of chunks.entries())
                yield { type: 'output', stream: i % 2 ? 'stderr' : 'stdout', content };
              yield { type: 'output_dropped', stream: 'stderr', bytes: '17' };
              yield { type: 'output', stream: 'stdout', content: 'ORIGINAL_AFTER_GAP_TAIL' };
              yield { type: 'terminal', result, supervision: 'ended' };
            },
            async cancel() {
              return { status: 'already_finished' };
            },
            async dispose() {},
          },
        ],
      },
    ],
  });
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let controller: TuiController | undefined;
  let app: ReturnType<typeof render> | undefined;
  const originalFetch = globalThis.fetch;
  try {
    service = await startService({ runtime, profile, buildId: 'original', subjectId: 'owner' });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: {
        profile,
        apiMajor: 1,
        requiredCapabilities: ['sessions', 'commands', 'history', 'events', 'interactions'],
      },
    });
    await client.connect();
    await client.createWorkspace({
      expectedStoreId: originalStoreId,
      id: 'workspace',
      rootUri: pathToFileURL(root).href,
      name: 'Owned',
    });
    await client.createSession({
      expectedStoreId: originalStoreId,
      sessionId: 'session',
      commandId: 'original-create',
      workspaceId: 'workspace',
      title: 'Original parent',
    });
    await client.startRun('session', {
      expectedStoreId: originalStoreId,
      commandId: 'original-work',
      kind: 'run.start',
      content: 'Create original background histories',
    });
    await runtime.waitForCommand('original-work', { timeoutMs: 5000 });
    const savedJob = await client.getExecution(jobId);
    const savedCarrier = await client.getExecution(childJobId);
    const savedCommand = await client.getCommand('original-work');
    const savedChildView = await client.getView(childSessionId);
    const savedChildMessages = await readMessages(
      client,
      childSessionId,
      savedChildView.session.nextSeq,
    );
    const savedChildModels = savedChildMessages.filter((message) => message.outputBody);
    expect(savedJob.status).toBe('succeeded');
    expect(savedJob.result).toEqual(result);
    expect(savedCarrier.childSessionId).toBe(childSessionId);
    expect(savedChildModels).toHaveLength(1);
    const savedOutput = await client.getModelOutput(
      childSessionId,
      savedChildModels[0]!.outputBody!.executionId,
    );
    expect(savedOutput.output.content).toBe(childContent);
    expect(savedOutput.output.reasoning).toBe(childReasoning);
    expect(starts).toBe(1);
    expect(parentModel.requests).toHaveLength(2);
    expect(childModel.requests).toHaveLength(1);
    client.disposeNetwork();
    client = undefined;
    await service.close();
    service = undefined;
    const backup = await createProfileBackup({
      profile: selected,
      destinationRoot: join(root, 'backups'),
    });
    const restored = await restoreProfileBackup({
      profile: selected,
      expectedStoreId: originalStoreId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.storeId).not.toBe(originalStoreId);
    let coldModelCalls = 0;
    for (let cold = 0; cold < 2; cold++) {
      const currentStore = await openSqliteStore(selected);
      const currentRuntime = createRuntime({
        store: currentStore,
        artifacts: createArtifactStore({ profile: selected, store: currentStore }),
        model: {
          async *stream() {
            coldModelCalls++;
            yield finish;
          },
        },
        modelId: 'readonly',
        permissions: {
          async authorize() {
            return { allowed: false, revision: 'readonly' };
          },
        },
      });
      service = await startService({
        runtime: currentRuntime,
        profile,
        buildId: 'restored',
        subjectId: 'owner',
      });
      const methods: string[] = [];
      globalThis.fetch = Object.assign(
        async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          methods.push(init?.method ?? (url instanceof Request ? url.method : 'GET'));
          return originalFetch(url, init);
        },
        { preconnect: originalFetch.preconnect },
      );
      const admitted = createClient({
        endpoint: service.endpoint,
        token: service.bootstrap.token,
        bootstrap: service.bootstrap,
        expected: {
          profile,
          apiMajor: 1,
          requiredCapabilities: ['sessions', 'commands', 'history', 'events', 'interactions'],
        },
      });
      client = admitted;
      await admitted.connect();
      const storeId = restored.storeId;
      const metadata = await currentStore.getMetadata();
      const port: TuiPort = {
        storeId,
        nextCommandId: () => {
          throw Error('restored_reader_must_not_create_intent');
        },
        listSessions: async (signal) =>
          (await admitted.listAllSessions({ signal })).map(({ id, title }) => ({ id, title })),
        async readSession(id, signal) {
          const view = await admitted.getView(id, { signal });
          return {
            storeId,
            view,
            messages: await readMessages(admitted, id, view.session.nextSeq, signal),
            interactions: [],
          };
        },
        submit: unavailable,
        answer: unavailable,
        cancel: unavailable,
        getCommand: (id) => admitted.getCommand(id),
        executions: {
          getExecution: (id, signal) => admitted.getExecution(id, { signal }),
          getRun: (id, signal) => admitted.getRun(id, { signal }),
          output: (id, query, signal) => admitted.listExecutionOutput(id, { ...query, signal }),
          getView: (id, signal) => admitted.getView(id, { signal }),
          messages: (id, query, signal) => admitted.listMessages(id, { ...query, signal }),
          modelOutput: (id, executionId, signal) =>
            admitted.getModelOutput(id, executionId, { expectedStoreId: storeId, signal }),
          stop: unavailable,
          getCommand: (id, signal) => admitted.getCommand(id, { signal }),
        },
      };
      controller = new TuiController(port);
      await controller.select('session');
      await controller.routeCommand('/background');
      app = render(<TuiSession controller={controller} />);
      await Bun.sleep(50);
      console.log('restored-tui-directory', {
        currentStore: controller.state.snapshot?.storeId,
        jobOrigins: controller.state.snapshot?.view.executions
          .filter((execution) => execution.kind === 'job')
          .map((execution) => execution.originStoreId),
        listed: app.lastFrame().includes(savedJob.definitionId),
      });
      expect(app.lastFrame()).toContain(savedJob.definitionId);
      expect(app.lastFrame()).toContain(savedCarrier.definitionId);
      const directory = app.lastFrame().split('Original background Jobs · Session')[1] ?? '';
      expect(directory).toContain(savedJob.definitionId);
      expect(directory).toContain(savedCarrier.definitionId);
      expect(directory).toContain(jobId);
      expect(directory).toContain(childJobId);
      expect(directory.match(/restored\s+history;\s+read\s+only/g)).toHaveLength(2);
      await controller.routeCommand(`/background output ${jobId}`);
      const output = controller.state.executionReading;
      expect(output?.phase).toBe('ready');
      expect(output?.target).toMatchObject({
        storeId,
        originStoreId: originalStoreId,
        sessionId: 'session',
        executionId: jobId,
        definitionId: savedJob.definitionId,
        definitionVersion: savedJob.definitionVersion,
      });
      expect(
        output!
          .output!.items.slice(0, 220)
          .map((item) => item.content)
          .join(''),
      ).toBe(chunks.join(''));
      expect(output!.output!.items.at(-2)).toMatchObject({
        stream: 'stderr',
        content: '',
        droppedBytes: '17',
      });
      expect(output!.output!.items.at(-1)?.content).toBe('ORIGINAL_AFTER_GAP_TAIL');
      await controller.routeCommand(`/background child ${childJobId}`);
      const child = controller.state.executionReading;
      expect(child?.phase).toBe('ready');
      expect(child?.child?.carrier).toEqual(savedCarrier);
      expect(child?.child?.messages).toEqual(savedChildMessages);
      const full = child!.child!.modelOutputs.get(savedChildModels[0]!.id)!;
      expect(full).toEqual({ ...savedOutput, storeId, snapshotCursor: full.snapshotCursor });
      expect(full.output.content).toBe(childContent);
      await Bun.sleep(50);
      expect(app.lastFrame()).toContain('TUI_RESTORED_CHILD_COMPLETE_TAIL');
      const beforeStop = methods.length;
      await controller.routeCommand(`/background stop ${jobId}`);
      await controller.routeCommand(`/background stop ${childJobId}`);
      expect(controller.state.jobStops.size).toBe(0);
      expect(methods).toHaveLength(beforeStop);
      controller.closePanel();
      app.unmount();
      app.cleanup();
      app = undefined;
      controller.dispose();
      controller = undefined;
      expect(await currentStore.getMetadata()).toEqual(metadata);
      expect(await admitted.getExecution(jobId)).toEqual(savedJob);
      expect(await admitted.getExecution(childJobId)).toEqual(savedCarrier);
      expect(await admitted.getCommand('original-work')).toEqual(savedCommand);
      expect(methods.every((method) => method === 'GET')).toBe(true);
      expect(coldModelCalls).toBe(0);
      expect(starts).toBe(1);
      expect(parentModel.requests).toHaveLength(2);
      expect(childModel.requests).toHaveLength(1);
      admitted.disposeNetwork();
      client = undefined;
      await service.close();
      service = undefined;
      globalThis.fetch = originalFetch;
    }
  } finally {
    app?.unmount();
    app?.cleanup();
    controller?.dispose();
    client?.disposeNetwork();
    globalThis.fetch = originalFetch;
    if (service) await service.close();
    else await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
