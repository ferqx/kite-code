import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import type { Extension } from '@kite-ai/agent/extensions';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createClient, decodeJobReconcileCommand, type ReconcileJobRequest } from '@kite-ai/client';
import { startService } from '../../src';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};

test('real cold Job reconcile queries original external ledger once; physical lost HTTP reply only queries original command and preserves original unknown result', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-http-job-reconcile-'));
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  const ledger = join(root, 'ledger.json');
  let releaseQuery!: () => void, queryEntered!: () => void;
  const queryGate = new Promise<void>((resolve) => {
    releaseQuery = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    queryEntered = resolve;
  });
  let starts = 0,
    queries = 0;
  const extension: Extension = {
    id: 'fixture.ledger',
    version: '1',
    apiMajor: 1,
    jobs: [
      {
        id: 'ledger.job',
        version: '1',
        description: 'one owned ledger effect',
        inputSchema: { type: 'object', additionalProperties: false },
        recovery: { version: '1', configuration: { ledger } },
        async start(_input, context) {
          starts++;
          writeFileSync(
            ledger,
            JSON.stringify({ operation: context.executionId, outcome: 'succeeded' }),
          );
          return { reference: { operation: context.executionId } };
        },
        async *observe() {
          yield {
            type: 'terminal',
            result: { outcome: 'outcome_unknown', content: 'original_reply_lost' },
            supervision: 'ended',
          };
        },
        async cancel() {
          return { status: 'already_finished' };
        },
        async dispose() {},
        async reconcile(reference, context) {
          queries++;
          queryEntered();
          await queryGate;
          const actual = JSON.parse(readFileSync(ledger, 'utf8')) as { operation: string };
          expect(reference).toEqual({ operation: context.executionId });
          expect(actual.operation).toBe(context.executionId);
          return {
            status: 'observed',
            supervision: 'ended',
            result: { outcome: 'succeeded', content: 'one real effect verified' },
            evidence: { operation: actual.operation, source: 'external_ledger' },
          };
        },
      },
    ],
    tools: [
      {
        id: 'ledger.launch',
        version: '1',
        description: 'launch controlled ledger job',
        inputSchema: { type: 'object', additionalProperties: false },
        async execute(_input, context) {
          const ref = await context.operations.ensure({
            key: 'once',
            cancellation: 'detached',
            request: { kind: 'job', definitionId: 'ledger.job', definitionVersion: '1', input: {} },
          });
          return { outcome: 'succeeded', content: ref.executionId! };
        },
      },
    ],
  };
  const warmStore = await openSqliteStore(profile);
  const storeId = (await warmStore.getMetadata()).storeId;
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'launch', name: 'ledger.launch', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: 'original parent ended' }, finish],
  ]);
  const permissions = { authorize: async () => ({ allowed: true, revision: 'owned' }) };
  const warm = createRuntime({
    store: warmStore,
    model,
    modelId: 'fixed',
    permissions,
    extensions: [extension],
  });
  let coldStore: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let cold: ReturnType<typeof createRuntime> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let relay: ReturnType<typeof createServer> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let closedWarm = false;
  let posts = 0,
    gets = 0;
  async function until(predicate: () => Promise<boolean>) {
    const end = Date.now() + 5000;
    while (!(await predicate())) {
      if (Date.now() > end) throw Error('job_reconcile_fixture_timeout');
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  try {
    await warm.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'owned',
      rootUri: `file://${root}`,
    });
    await warm.createSession({
      expectedStoreId: storeId,
      subjectId: 'owner',
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'original',
    });
    await warm.submitCommand({
      expectedStoreId: storeId,
      subjectId: 'owner',
      commandId: 'work',
      sessionId: 's',
      request: { kind: 'run.start', content: 'one real effect' },
    });
    await until(
      async () =>
        (await warm.getView('s')).executions.some(
          (item) => item.kind === 'job' && item.status === 'outcome_unknown',
        ) && (await warm.getCommand('work'))?.status === 'applied',
    );
    await until(async () => !(await warm.getView('s')).runs.some((run) => run.isActive));
    const original = (await warm.getView('s')).executions.find((item) => item.kind === 'job')!;
    expect(starts).toBe(1);
    expect(queries).toBe(0);
    await warm.close();
    await warmStore.close();
    closedWarm = true;
    coldStore = await openSqliteStore(profile);
    cold = createRuntime({
      store: coldStore,
      model: createFixedModel([]),
      modelId: 'fixed',
      permissions,
      extensions: [extension],
      authorizeJobReconcile: async () => ({ allowed: true, revision: 'explicit-recovery' }),
    });
    service = await startService({
      runtime: cold,
      profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'owned' },
      subjectId: 'owner',
      buildId: 'reconcile',
    });
    const actual = service;
    relay = createServer(async (req, res) => {
      const body: Buffer[] = [];
      for await (const part of req) body.push(Buffer.from(part));
      const response = await fetch(`${actual.endpoint}${req.url}`, {
        method: req.method,
        headers: {
          authorization: `Bearer ${actual.bootstrap.token}`,
          'content-type': 'application/json',
        },
        ...(req.method === 'POST' ? { body: Buffer.concat(body) } : {}),
      });
      const data = await response.arrayBuffer();
      if (req.method === 'POST') {
        posts++;
        if (response.status === 202) {
          req.socket.destroy();
          return;
        }
      }
      if (req.url?.startsWith('/v1/commands/')) gets++;
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(Buffer.from(data));
    });
    await new Promise<void>((resolve) => relay!.listen(0, '127.0.0.1', resolve));
    const address = relay.address() as { port: number };
    client = createClient({
      endpoint: `http://127.0.0.1:${address.port}`,
      token: actual.bootstrap.token,
      expected: {
        profile: actual.bootstrap.profile,
        apiMajor: 1,
        instanceId: actual.bootstrap.instanceId,
        buildId: actual.bootstrap.buildId,
        requiredCapabilities: ['commands', 'job_reconcile'],
      },
    });
    await client.connect();
    await client.getView('s');
    expect(queries).toBe(0);
    const coldOriginal = await cold.getExecution(original.id);
    expect(coldOriginal?.delivery).toBe('pending');
    const input: ReconcileJobRequest = {
      kind: 'job.reconcile',
      expectedStoreId: storeId,
      commandId: 'reconcile-original',
      executionId: original.id,
      expectedResultRevision: original.resultRevision,
    };
    const stale = await fetch(`${actual.endpoint}/v1/sessions/s/commands`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${actual.bootstrap.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...input,
        commandId: 'stale',
        expectedResultRevision: String(BigInt(original.resultRevision) + 1n),
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'result_revision_conflict' });
    expect(await cold.getCommand('stale')).toBeNull();
    expect((await cold.getExecution(original.id))?.delivery).toBe('pending');
    expect(queries).toBe(0);
    const pending = client
      .reconcileJob('s', input)
      .catch((error) => error as Error & { code: string });
    await entered;
    const accepted = decodeJobReconcileCommand(await client.getCommand(input.commandId));
    expect(accepted).toMatchObject({
      status: 'accepted',
      receipt: null,
      kind: 'job.reconcile',
      id: input.commandId,
    });
    const inFlight = await fetch(`${actual.endpoint}/v1/sessions/s/commands`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${actual.bootstrap.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    expect(inFlight.status).toBe(202);
    expect(decodeJobReconcileCommand(await inFlight.json())).toEqual(accepted);
    expect(queries).toBe(1);
    releaseQuery();
    const rejection = await pending;
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as { code: string }).code).toBe('network_outcome_unknown');
    expect(posts).toBe(1);
    expect(gets).toBe(1);
    const command = decodeJobReconcileCommand(await client.getCommand(input.commandId));
    expect(command).toMatchObject({
      id: input.commandId,
      kind: 'job.reconcile',
      status: 'applied',
      sessionId: 's',
      originStoreId: storeId,
      receipt: {
        executionId: original.id,
        resultRevision: original.resultRevision,
        outcome: 'verified',
        supervision: 'ended',
        result: { outcome: 'succeeded', content: 'one real effect verified' },
        evidenceSource: 'adapter_reconcile',
      },
    });
    expect(queries).toBe(1);
    expect(starts).toBe(1);
    expect(posts).toBe(1);
    expect(gets).toBe(2);
    const unchanged = await cold.getExecution(original.id);
    expect(unchanged?.status).toBe('outcome_unknown');
    expect(unchanged?.resultRevision).toBe(original.resultRevision);
    expect(unchanged?.result).toEqual(original.result);
    expect(unchanged?.reference).toEqual(coldOriginal?.reference);
    expect(unchanged?.originCommandId).toBe(coldOriginal?.originCommandId);
    expect(unchanged?.delivery).toBe('suppressed');
    expect(unchanged?.deliveryReason).toBe('explicit_reconciliation');
    const repeat = await fetch(`${actual.endpoint}/v1/sessions/s/commands`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${actual.bootstrap.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    expect(repeat.status).toBe(202);
    expect(await repeat.json()).toEqual(command);
    expect(queries).toBe(1);
    const spoof = await fetch(`${actual.endpoint}/v1/sessions/s/commands`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${actual.bootstrap.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...input, commandId: 'spoof', reference: { operation: 'spoof' } }),
    });
    expect(spoof.status).toBe(400);
    expect(await cold.getCommand('spoof')).toBeNull();
  } finally {
    releaseQuery();
    client?.disposeNetwork();
    if (relay) await new Promise<void>((resolve) => relay!.close(() => resolve()));
    await service?.close();
    await cold?.close();
    await coldStore?.close();
    if (!closedWarm) {
      await warm.close();
      await warmStore.close();
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('diagnostic Service cannot advertise Job reconcile from host-supplied capability without its actual Runtime', async () => {
  const service = await startService({
    profile: { dataRoot: '/owned-unopened', name: 'owned', accessKey: 'owned' },
    buildId: 'diagnostic',
    capabilities: ['job_reconcile', 'job_report_resume'],
  });
  try {
    const response = await fetch(`${service.endpoint}/v1/server`, {
      headers: { authorization: `Bearer ${service.bootstrap.token}` },
    });
    expect(response.status).toBe(200);
    const identity = (await response.json()) as { capabilities: string[] };
    expect(identity.capabilities).not.toContain('job_reconcile');
    expect(identity.capabilities).not.toContain('job_report_resume');
  } finally {
    await service.close();
  }
});
