import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient, type ResumeRunRequest } from '@kite-ai/client';
import { startService } from '../../src';
import { resumeBinding } from '../fixtures/run-resume-binding';

async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('run_resume_http_timeout')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function firstLine(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let content = '';
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) throw Error('run_resume_child_no_ready');
      content += new TextDecoder().decode(item.value);
      if (content.includes('\n')) return content.split('\n')[0]!;
    }
  } finally {
    reader.releaseLock();
  }
}

test('SIGKILL with complete original Model and pending approval resumes original Run through HTTP; physical lost receipt only queries original command', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-http-run-resume-'));
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  const ledger = join(root, 'effects');
  const child = Bun.spawn(
    [
      process.execPath,
      new URL('../fixtures/run-resume-child.ts', import.meta.url).pathname,
      profile.dataRoot,
      ledger,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let otherSubject: Awaited<ReturnType<typeof startService>> | undefined;
  let relay: ReturnType<typeof createServer> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let resumes = 0,
    gets = 0,
    resolutions = 0;
  let configurationChanged = false;
  try {
    const ready = JSON.parse(await bounded(firstLine(child.stdout))) as {
      storeId: string;
      runId: string;
      interaction: { id: string; revision: string };
    };
    child.kill('SIGKILL');
    expect(await bounded(child.exited)).toBe(137);
    expect(child.signalCode).toBe('SIGKILL');
    expect(await new Response(child.stderr).text()).toBe('');
    expect(readFileSync(ledger, 'utf8')).toBe('model-decision\n');
    const readonly = await openSqliteStore({ ...profile, mode: 'readonly' });
    const original = await readonly.getView('s');
    const originalTool = original.executions.find((item) => item.kind === 'tool')!;
    const originalModel = original.executions.find((item) => item.kind === 'model')!;
    const originalRun = original.runs.find((item) => item.id === ready.runId)!;
    expect(originalTool.status).toBe('planned');
    expect(originalModel.status).toBe('succeeded');
    expect(originalRun.isActive).toBe(true);
    await readonly.close();
    expect(readFileSync(ledger, 'utf8')).toBe('model-decision\n');
    store = await openSqliteStore(profile);
    const binding = resumeBinding({ ledger });
    runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ store, profile }),
      permissions: binding.permissions,
      resolveRecoveryRunConfiguration: async () => {
        resolutions++;
        return resumeBinding({ ledger, changed: configurationChanged });
      },
    });
    service = await startService({
      runtime,
      profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'owned' },
      subjectId: 'owner',
      buildId: 'run-resume',
    });
    const actual = service;
    relay = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const reply = await fetch(`${actual.endpoint}${request.url}`, {
        method: request.method,
        headers: {
          authorization: `Bearer ${actual.bootstrap.token}`,
          'content-type': 'application/json',
        },
        ...(request.method === 'POST' ? { body } : {}),
      });
      const bytes = await reply.arrayBuffer();
      if (request.method === 'POST' && JSON.parse(body.toString()).kind === 'run.resume') {
        resumes++;
        if (reply.status === 202) {
          request.socket.destroy();
          return;
        }
      }
      if (request.url?.startsWith('/v1/commands/')) gets++;
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(Buffer.from(bytes));
    });
    await new Promise<void>((resolve) => relay!.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
    client = createClient({
      endpoint,
      token: actual.bootstrap.token,
      expected: {
        apiMajor: 1,
        profile: actual.bootstrap.profile,
        instanceId: actual.bootstrap.instanceId,
        buildId: actual.bootstrap.buildId,
        requiredCapabilities: ['commands', 'interactions', 'run_resume'],
      },
    });
    await client.connect();
    const before = await client.getView('s');
    const pending = await client.listInteractions('s', {
      storeId: ready.storeId,
      state: 'pending',
    });
    expect(pending.interactions.map((item) => item.id)).toEqual([ready.interaction.id]);
    expect(before.runs.find((item) => item.id === ready.runId)?.isActive).toBe(true);
    expect(resolutions).toBe(0);
    expect(readFileSync(ledger, 'utf8')).toBe('model-decision\n');
    const input: ResumeRunRequest = {
      kind: 'run.resume',
      expectedStoreId: ready.storeId,
      commandId: 'resume-original',
      runId: ready.runId,
    };
    const post = (body: unknown) =>
      fetch(`${actual.endpoint}/v1/sessions/s/commands`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${actual.bootstrap.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    for (const [changed, expectedCode] of [
      [{ expectedStoreId: 'wrong-store' }, 'store_identity_mismatch'],
    ] as const) {
      const response = await post({ ...input, ...changed, commandId: expectedCode });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: expectedCode });
      expect(await runtime.getCommand(expectedCode)).toBeNull();
    }
    const spoof = await post({ ...input, commandId: 'spoof', owner: 'spoof' });
    expect(spoof.status).toBe(400);
    expect(await runtime.getCommand('spoof')).toBeNull();
    const generationSpoof = await post({
      ...input,
      commandId: 'generation-spoof',
      expectedOwnerGeneration: '1',
    });
    expect(generationSpoof.status).toBe(400);
    expect(await runtime.getCommand('generation-spoof')).toBeNull();
    otherSubject = await startService({
      runtime,
      profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'other' },
      subjectId: 'other-subject',
      buildId: 'run-resume',
    });
    const forbidden = await fetch(`${otherSubject.endpoint}/v1/sessions/s/commands`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${otherSubject.bootstrap.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...input, commandId: 'other-subject-resume' }),
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: 'permission_denied' });
    expect(await runtime.getCommand('other-subject-resume')).toBeNull();
    expect(resolutions).toBe(0);
    configurationChanged = true;
    const mismatch = await post({ ...input, commandId: 'configuration-rejected' });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({ code: 'run_configuration_mismatch' });
    expect(readFileSync(ledger, 'utf8')).toBe('model-decision\n');
    expect((await runtime.getExecution(originalTool.id))?.status).toBe('planned');
    configurationChanged = false;
    const rejected = await client
      .resumeRun('s', input)
      .catch((error) => error as Error & { code: string });
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as { code: string }).code).toBe('network_outcome_unknown');
    expect(resumes).toBe(1);
    expect(gets).toBe(0);
    const receipt = await client.getCommand(input.commandId);
    expect(receipt).toMatchObject({
      id: input.commandId,
      kind: 'run.resume',
      status: 'applied',
      sessionId: 's',
      originStoreId: ready.storeId,
      receipt: {
        outcome: 'run_resumed',
        runId: ready.runId,
        originalCommandId: 'work',
        boundary: 'tool_calls',
      },
    });
    expect(resumes).toBe(1);
    expect(gets).toBe(1);
    const after = await client.listInteractions('s', { storeId: ready.storeId, state: 'pending' });
    expect(after.interactions.map((item) => [item.id, item.revision])).toEqual([
      [ready.interaction.id, ready.interaction.revision],
    ]);
    expect(readFileSync(ledger, 'utf8')).toBe('model-decision\n');
    await client.answerInteraction('s', ready.interaction.id, {
      expectedStoreId: ready.storeId,
      commandId: 'answer-original',
      expectedRevision: ready.interaction.revision,
      answer: { kind: 'approval', decision: 'approve' },
    });
    const deadline = Date.now() + 5000;
    for (;;) {
      const view = await client.getView('s');
      if (view.runs.find((item) => item.id === ready.runId)?.status === 'completed') break;
      if (Date.now() > deadline) throw Error('run_resume_completion_timeout');
      await Bun.sleep(1);
    }
    expect(readFileSync(ledger, 'utf8')).toBe(
      'model-decision\ntool-effect:{"exact":"original"}\nmodel-completion\n',
    );
    const final = await client.getView('s');
    expect(final.runs).toHaveLength(1);
    expect(final.executions.filter((item) => item.kind === 'tool')).toHaveLength(1);
    expect(final.executions.find((item) => item.id === originalTool.id)?.status).toBe('succeeded');
    expect(final.executions.find((item) => item.id === originalModel.id)?.result).toEqual(
      originalModel.result,
    );
    const repeat = await fetch(`${actual.endpoint}/v1/sessions/s/commands`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${actual.bootstrap.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    expect(repeat.status).toBe(202);
    expect(await repeat.json()).toEqual(receipt);
    const forbiddenPrior = await fetch(`${otherSubject.endpoint}/v1/sessions/s/commands`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${otherSubject.bootstrap.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    expect(forbiddenPrior.status).toBe(403);
    expect(await forbiddenPrior.json()).toMatchObject({ code: 'permission_denied' });
    expect(resolutions).toBe(2);
    expect(readFileSync(ledger, 'utf8')).toBe(
      'model-decision\ntool-effect:{"exact":"original"}\nmodel-completion\n',
    );
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    client?.disposeNetwork();
    if (relay) {
      relay.closeAllConnections();
      await new Promise<void>((resolve) => relay!.close(() => resolve()));
    }
    await otherSubject?.close();
    await service?.close();
    await runtime?.close();
    await store?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
