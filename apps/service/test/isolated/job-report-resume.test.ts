import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { AgentError, createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};

test('real cold SQLite Job report resumes only through authenticated original HTTP command; physical lost response is queried without resubmit', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-http-report-resume-')),
    profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  const warmStore = await openSqliteStore(profile),
    expectedStoreId = (await warmStore.getMetadata()).storeId;
  const pendingStore = new Proxy(warmStore, {
    get(target, key) {
      if (key === 'applyJobReport')
        return async () => {
          throw new AgentError('report_recovery_required');
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const task = createTaskExtension({
    roles: [{ id: 'reader', configurationId: 'child', description: 'original fixed role' }],
    afterTurn: { enabled: true },
  });
  const policy = {
    async authorize() {
      return { allowed: true, revision: 'sealed-report-policy' };
    },
  };
  const manifest = { sealed: 'original', nested: { b: 2, a: 1 } };
  const permissions = {
    async authorize() {
      return { allowed: true, revision: 'owned' };
    },
  };
  const model = createFixedModel([
    [
      {
        type: 'tool_call',
        id: 'delegate',
        name: 'task',
        arguments: JSON.stringify({
          key: 'child',
          role: 'reader',
          resultDisposition: 'after_turn',
          cancellation: 'detached',
          input: { content: 'original child' },
        }),
      },
      { ...finish, reason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: 'parent completed' }, finish],
  ]);
  const warm = createRuntime({
    store: pendingStore,
    artifacts: createArtifactStore({ profile, store: warmStore }),
    permissions,
    extensions: [task],
    modelConcurrency: 2,
    childConfigurations: [
      {
        id: 'child',
        version: '1',
        model: createFixedModel([
          [{ type: 'text_delta', text: 'actual original child result' }, finish],
        ]),
        modelId: 'child',
        toolIds: [],
        snapshot: { child: true },
      },
    ],
    resolveRunConfiguration: async () => ({
      model,
      modelId: 'fixed',
      snapshot: manifest,
      extensions: [],
      afterTurn: policy,
    }),
  });
  let coldStore: Awaited<ReturnType<typeof openSqliteStore>> | undefined,
    cold: ReturnType<typeof createRuntime> | undefined,
    service: Awaited<ReturnType<typeof startService>> | undefined,
    foreign: Awaited<ReturnType<typeof startService>> | undefined,
    proxy: ReturnType<typeof createServer> | undefined,
    client: ReturnType<typeof createClient> | undefined;
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let configurationChanged = true;
  let modelCalls = 0,
    resolverCalls = 0,
    posts = 0,
    gets = 0;
  try {
    await warm.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: `file://${root}`,
      name: 'owned',
    });
    await warm.createSession({
      expectedStoreId,
      sessionId: 'root',
      subjectId: 'owner',
      workspaceId: 'w',
      commandId: 'create',
      title: 'root',
    });
    await warm.submitCommand({
      expectedStoreId,
      sessionId: 'root',
      subjectId: 'owner',
      commandId: 'work',
      request: { kind: 'run.start', content: 'delegate original job' },
    });
    await warm.waitForCommand('work', { timeoutMs: 5000 });
    const carrier = (await warmStore.getView('root')).executions.find((e) => e.childSessionId)!;
    await warm.waitForCommand(carrier.originCommandId, { timeoutMs: 5000 });
    const execution = (await warmStore.getExecution(carrier.id))!,
      reportId = `report-${createHash('sha256')
        .update(JSON.stringify([expectedStoreId, execution.id, execution.resultRevision]))
        .digest('hex')}`;
    await warm.waitForCommand(reportId, { timeoutMs: 5000 });
    expect((await warmStore.getCommand(reportId))!.receipt).toEqual({
      reason: 'report_recovery_required',
    });
    const parent = (await warmStore.getRun(
      (execution.afterTurn as { parentRunId: string }).parentRunId,
    ))!;
    expect(parent.status).toBe('completed');
    await warm.close();
    coldStore = await openSqliteStore(profile);
    const recoveryModel: ModelAdapter = {
      async *stream() {
        modelCalls++;
        await held;
        yield { type: 'text_delta', text: 'actual recovered report' };
        yield finish;
      },
    };
    cold = createRuntime({
      store: coldStore,
      artifacts: createArtifactStore({ profile, store: coldStore }),
      permissions,
      extensions: [task],
      resolveRecoveryRunConfiguration: async (input) => {
        resolverCalls++;
        expect(input.run.id).toBe(parent.id);
        expect(input.run.configuration).toMatchObject({ snapshot: manifest });
        return {
          model: recoveryModel,
          modelId: 'fixed',
          snapshot: configurationChanged ? { ...manifest, sealed: 'changed' } : manifest,
          extensions: [],
          afterTurn: policy,
        };
      },
    });
    const publicProfile = { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'owned' };
    service = await startService({
      runtime: cold,
      profile: publicProfile,
      subjectId: 'owner',
      buildId: 'owned',
    });
    proxy = createServer(async (req, res) => {
      try {
        const parts: Buffer[] = [];
        for await (const part of req) parts.push(Buffer.from(part));
        const body = parts.length ? Buffer.concat(parts) : undefined;
        const response = await fetch(service!.endpoint + req.url, {
          method: req.method,
          headers: {
            authorization: req.headers.authorization ?? '',
            'content-type': 'application/json',
          },
          ...(body ? { body } : {}),
        });
        if (req.method === 'POST' && req.url?.endsWith('/resume') && response.ok) {
          posts++;
          req.socket.destroy();
          await response.body?.cancel();
          return;
        }
        if (req.method === 'GET' && req.url?.startsWith('/v1/commands/')) gets++;
        res.statusCode = response.status;
        res.setHeader('content-type', 'application/json');
        res.end(await response.text());
      } catch {
        req.socket.destroy();
      }
    });
    await new Promise<void>((r) => proxy!.listen(0, '127.0.0.1', r));
    const address = proxy.address() as { port: number };
    client = createClient({
      endpoint: `http://127.0.0.1:${address.port}`,
      token: service.bootstrap.token,
      expected: {
        profile: publicProfile,
        apiMajor: 1,
        requiredCapabilities: ['job_report_resume'],
      },
    });
    await client.connect();
    expect(modelCalls).toBe(0);
    expect(resolverCalls).toBe(0);
    expect((await client.getCommand(reportId)).status).toBe('needs_review');
    const conflict = await fetch(
      `${service.endpoint}/v1/sessions/root/job-reports/${reportId}/resume`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${service.bootstrap.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ expectedStoreId, commandId: 'configuration-conflict' }),
      },
    );
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe('report_configuration_mismatch');
    expect(await coldStore.getCommand('configuration-conflict')).toBeNull();
    expect((await coldStore.getCommand(reportId))!.status).toBe('needs_review');
    expect((await coldStore.getExecution(execution.id))!.delivery).toBe('pending');
    expect(modelCalls).toBe(0);
    const releaseDeadline = Date.now() + 5000;
    while ((await coldStore.getSession('root'))!.ownerInstanceId !== null) {
      if (Date.now() > releaseDeadline) throw Error('report_failed_prepare_release_deadline');
      await Bun.sleep(1);
    }
    configurationChanged = false;
    const intent = { expectedStoreId, commandId: 'resume-original' };
    const error = await client
      .resumeJobReport('root', reportId, intent)
      .catch((error) => error as unknown);
    expect((error as { code: string }).code).toBe('network_outcome_unknown');
    expect(posts).toBe(1);
    const resumed = await client.getCommand(intent.commandId);
    expect(resumed.kind).toBe('job.report.resume');
    expect(resumed.status).toBe('applied');
    expect(resumed.sessionId).toBe('root');
    expect(resumed.originStoreId).toBe(expectedStoreId);
    expect(resumed.receipt).toMatchObject({ reportCommandId: reportId, outcome: 'report_resumed' });
    expect(gets).toBe(2);
    expect(posts).toBe(1);
    expect(resolverCalls).toBe(2);
    const runId = (resumed.receipt as { runId: string }).runId;
    expect((await coldStore.getRun(runId))!.configuration).toEqual(parent.configuration);
    expect((await coldStore.getRun(runId))!.originCommandId).toBe(reportId);
    expect((await coldStore.getExecution(execution.id))!.delivery).toBe('consumed');
    expect((await coldStore.getExecution(execution.id))!.resultRevision).toBe(
      execution.resultRevision,
    );
    const post = async (
      sessionId: string,
      body: unknown,
      token = service!.bootstrap.token,
      endpoint = service!.endpoint,
    ) =>
      fetch(`${endpoint}/v1/sessions/${sessionId}/job-reports/${reportId}/resume`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post('root', { ...intent, subjectId: 'spoof' })).status).toBe(400);
    expect((await post('root', { ...intent, commandId: 'bad-auth' }, 'wrong')).status).toBe(401);
    expect(
      (await post(carrier.childSessionId!, { expectedStoreId, commandId: 'child-resume' })).ok,
    ).toBe(false);
    expect(await coldStore.getCommand('child-resume')).toBeNull();
    foreign = await startService({
      runtime: cold,
      profile: publicProfile,
      subjectId: 'foreign',
      buildId: 'owned',
    });
    expect(
      (
        await post(
          'root',
          { expectedStoreId, commandId: 'foreign-resume' },
          foreign.bootstrap.token,
          foreign.endpoint,
        )
      ).ok,
    ).toBe(false);
    expect(await coldStore.getCommand('foreign-resume')).toBeNull();
    const again = await post('root', intent);
    expect(again.status).toBe(202);
    expect((await again.json()).receipt).toEqual(resumed.receipt);
    expect(resolverCalls).toBe(2);
    expect(modelCalls).toBeLessThanOrEqual(1);
    release();
    await cold.waitForCommand(reportId, { timeoutMs: 5000 });
    expect(modelCalls).toBe(1);
    expect(
      (await coldStore.getView('root')).messages.some(
        (m) => m.content === 'actual recovered report',
      ),
    ).toBe(true);
    expect((await coldStore.getRun(parent.id))!.status).toBe('completed');
  } finally {
    release();
    client?.disposeNetwork();
    if (proxy) await new Promise<void>((r, j) => proxy!.close((e) => (e ? j(e) : r())));
    await foreign?.close();
    await service?.close();
    await cold?.close();
    await warm.close();
    if (!cold) await coldStore?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
