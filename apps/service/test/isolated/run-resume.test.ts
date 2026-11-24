import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ExecutionRecord } from '@kite-ai/agent/storage';
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-http-run-resume-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  const ledger = join(root, 'effects');
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('../fixtures/run-resume-child.ts', import.meta.url)),
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
      answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
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

test.each([
  'loaded Skill',
  'unread Skill',
  'new steer',
  'new steer before a second exit',
  'queued result and steer before a second exit',
] as const)('original Run continues across context refresh and a cold boundary with %s', async (mode) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-resume-context-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const workspace = join(root, 'workspace');
  const document = join(workspace, 'guide/SKILL.md');
  const skill = (body: string) =>
    `---\nname: Guide\ndescription: Original project guide\n---\n${body}\n`;
  mkdirSync(join(workspace, 'guide'), { recursive: true });
  writeFileSync(document, skill('Guide V1'));
  writeFileSync(join(workspace, 'AGENTS.md'), 'Original project instruction.');
  writeFileSync(join(workspace, 'seed.txt'), 'Original seeded data.');
  writeFileSync(join(workspace, 'target.txt'), 'Original target data.');

  const requests: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const index = requests.length;
      requests.push(JSON.stringify(await request.json()));
      const call =
        index === 0 && mode !== 'unread Skill'
          ? { name: 'load_skill', arguments: JSON.stringify({ skill_id: 'guide' }) }
          : index < 2
            ? {
                name: 'read_file',
                arguments: JSON.stringify({ path: index === 0 ? 'seed.txt' : 'target.txt' }),
              }
            : undefined;
      const chunk = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        chunk(
          call
            ? { tool_calls: [{ index: 0, id: `call-${index}`, type: 'function', function: call }] }
            : { content: 'Original work completed.' },
          null,
        ) +
          chunk({}, call ? 'tool_calls' : 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const fixture = fileURLToPath(
    new URL('../fixtures/run-resume-context-child.ts', import.meta.url),
  );
  const endpoint = new URL('v1', server.url).href;
  type Cut = { execution: ExecutionRecord; expectedOwnerGeneration: string };
  const start = (phase: string, cut?: Cut) =>
    Bun.spawn(
      [
        process.execPath,
        fixture,
        root,
        endpoint,
        phase,
        ...(cut ? [cut.execution.runId!, cut.expectedOwnerGeneration] : []),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
  const crashAt = async (phase: string, previous?: Cut): Promise<Cut> => {
    const child = start(phase, previous);
    try {
      const cut: Cut = JSON.parse(await bounded(firstLine(child.stdout)));
      child.kill('SIGKILL');
      expect(await bounded(child.exited)).toBe(137);
      expect(child.signalCode).toBe('SIGKILL');
      return cut;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await child.exited;
      expect(await new Response(child.stderr).text()).toBe('');
    }
  };
  const finish = async (phase: string, previous: Cut) => {
    const child = start(phase, previous);
    try {
      const exit = await bounded(child.exited);
      expect(await new Response(child.stderr).text()).toBe('');
      expect(exit).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await child.exited;
    }
  };
  try {
    const original = await crashAt('seed');
    expect(requests).toHaveLength(1);
    let successor: Cut | undefined;
    if (mode === 'queued result and steer before a second exit') {
      writeFileSync(join(workspace, 'AGENTS.md'), 'Current project instruction.');
      const retired = await crashAt('include-cut', original);
      expect(retired.execution).toMatchObject({
        id: original.execution.id,
        status: 'cancelled',
        modelDispatched: false,
        result: { content: 'model_context_reassembled_before_dispatch' },
      });
      expect(requests).toHaveLength(1);
      await finish('finish', retired);
      const decision = requests[1]!;
      const included = decision.indexOf(
        'Explicitly include the selected historical execution result',
      );
      expect(decision).toContain('Current project instruction.');
      expect(included).toBeGreaterThanOrEqual(0);
      expect(decision.indexOf('Apply this correction after the selected result.')).toBeGreaterThan(
        included,
      );
    } else if (mode === 'new steer' || mode === 'new steer before a second exit') {
      if (mode === 'new steer') {
        writeFileSync(join(workspace, 'AGENTS.md'), 'Current project instruction.');
        await finish('steer', original);
        expect(requests[1]).toContain('Current project instruction.');
      } else {
        writeFileSync(document, skill('Guide V2'));
        const steered = await crashAt('steer-cut', original);
        expect(steered.execution.id).toBe(original.execution.id);
        expect(requests).toHaveLength(1);
        await finish('finish', steered);
        expect(requests[1]).toContain('Guide V2');
      }
      expect(requests[1]).toContain('Apply this latest correction while resuming the work.');
    } else {
      writeFileSync(document, skill('Guide V2'));
      successor = await crashAt('successor', original);
      expect(requests).toHaveLength(2);
      expect(successor.execution.runId).toBe(original.execution.runId);
      if (mode === 'loaded Skill') {
        expect(requests[1]).toContain('Guide V2');
        writeFileSync(document, skill('Guide V3'));
        await finish('reject', successor);
        expect(requests).toHaveLength(2);
        const readback = await openSqliteStore({ ...profile, mode: 'readonly' });
        try {
          const session = (await readback.getSession('s'))!;
          successor = { ...successor, expectedOwnerGeneration: session.ownerGeneration };
        } finally {
          await readback.close();
        }
        writeFileSync(document, skill('Guide V2'));
      } else {
        expect(requests[1]).not.toContain('Guide V2');
        expect(successor.execution.decisionSource).toMatchObject({
          modelExecutionId: original.execution.id,
        });
      }
      await finish('finish', successor);
    }
    expect(requests).toHaveLength(3);

    const store = await openSqliteStore(profile);
    try {
      const view = await store.getView('s');
      expect(view.runs).toHaveLength(1);
      expect(view.runs[0]).toMatchObject({ id: original.execution.runId, status: 'completed' });
      const tools = view.executions.filter((execution) => execution.kind === 'tool');
      expect(tools).toHaveLength(2);
      expect(tools.every((execution) => execution.status === 'succeeded')).toBe(true);
      if (successor)
        expect(await store.getExecution(successor.execution.id)).toMatchObject({
          status: 'succeeded',
          authorization: { dispatched: true },
        });
      if (mode === 'new steer' || mode === 'new steer before a second exit') {
        expect(await store.getCommand('correction')).toMatchObject({ status: 'applied' });
        expect(await store.getExecution(original.execution.id)).toMatchObject({
          status: 'cancelled',
          modelDispatched: false,
          result: { content: 'superseded_by_user_input' },
        });
      }
      if (mode === 'queued result and steer before a second exit') {
        const source = tools.find(({ definitionId }) => definitionId === 'skills.load')!;
        const included = await store.getCommand('include-original');
        const steer = await store.getCommand('after-include');
        expect(included).toMatchObject({
          status: 'applied',
          receipt: {
            outcome: 'result_included',
            executionId: source.id,
            resultRevision: source.resultRevision,
            runId: original.execution.runId,
          },
        });
        expect(steer).toMatchObject({ status: 'applied', receipt: { supersededExecutionIds: [] } });
        expect(requests[1]).toContain(source.id);
        const successors = (await store.listExecutions('s')).filter(
          ({ kind, decisionSource }) =>
            kind === 'model' &&
            (decisionSource as { contextRefreshOf?: string } | null)?.contextRefreshOf ===
              original.execution.id,
        );
        expect(successors).toHaveLength(1);
        expect(successors[0]).toMatchObject({ status: 'succeeded', modelDispatched: true });
      }
    } finally {
      await store.close();
    }
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 25000);
