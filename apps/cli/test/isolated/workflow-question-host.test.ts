import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { type AnswerInteractionRequest, createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { observeCommand, run } from '../../src';

test('ordinary question physically loses POST and GET responses; original answer is recovered once before terminal work', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-workflow-question-'));
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  let effects = 0,
    answer: unknown,
    prompts = 0;
  const runtime = createRuntime({
    store,
    modelId: 'fixed',
    model: createFixedModel([
      [
        { type: 'tool_call', id: 'ask', name: 'fixture.question', arguments: '{}' },
        { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
      [
        { type: 'text_delta', text: 'QUESTION_DONE' },
        { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    ]),
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'trusted-fixture' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.question',
            version: '1',
            description: 'Actual generic question transport',
            inputSchema: { type: 'object', additionalProperties: false },
            async execute(_input, context) {
              answer = await context.requestInput({
                question: 'Choose original verification decision',
                schema: {
                  type: 'object',
                  required: ['decision', 'detail'],
                  additionalProperties: false,
                  properties: {
                    decision: { type: 'string', enum: ['replan', 'waive'] },
                    detail: { type: 'string', minLength: 1 },
                  },
                },
              });
              effects++;
              return { outcome: 'succeeded', content: JSON.stringify(answer) };
            },
          },
        ],
      },
    ],
  });
  const service = await startService({
    runtime,
    profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'owned-fixture' },
    buildId: 'fixed',
    subjectId: 'owner',
  });
  const sockets = new Set<Socket>();
  let original: AnswerInteractionRequest | undefined,
    recovery = false,
    postDropped = 0,
    getDropped = 0;
  const seen: { method: string; path: string }[] = [];
  const relay = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const body = bytes.length ? JSON.parse(bytes.toString()) : undefined;
    seen.push({ method: request.method!, path: request.url! });
    const upstream = await fetch(`${service.endpoint}${request.url}`, {
      method: request.method,
      headers: {
        authorization: `Bearer ${service.bootstrap.token}`,
        'content-type': 'application/json',
      },
      ...(bytes.length ? { body: bytes } : {}),
    });
    const content = Buffer.from(await upstream.arrayBuffer());
    if (request.method === 'POST' && request.url?.endsWith('/answer')) {
      original = structuredClone(body);
      postDropped++;
      request.socket.destroy();
      return;
    }
    if (
      request.method === 'GET' &&
      original &&
      request.url?.includes(`/commands/${original.commandId}`) &&
      !recovery
    ) {
      getDropped++;
      request.socket.destroy();
      return;
    }
    response.writeHead(upstream.status, { 'content-type': 'application/json' });
    response.end(content);
  });
  relay.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  let client: ReturnType<typeof createClient> | undefined;
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'owned',
      rootUri: `file://${root}`,
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      subjectId: 'owner',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Question',
    });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    client = createClient({
      endpoint: `http://127.0.0.1:${(relay.address() as AddressInfo).port}`,
      token: service.bootstrap.token,
      expected: {
        profile: service.bootstrap.profile,
        instanceId: service.bootstrap.instanceId,
        buildId: 'fixed',
        apiMajor: 1,
        requiredCapabilities: ['commands', 'interactions'],
      },
    });
    await client.connect();
    const intent = {
      kind: 'run.start' as const,
      expectedStoreId: storeId,
      commandId: 'work',
      content: 'original ordinary question',
    };
    const options = {
      client,
      write() {},
      timeoutMs: 5000,
      pollIntervalMs: 5,
      async answerInteraction() {
        prompts++;
        return {
          kind: 'question' as const,
          answers: { decision: 'replan', detail: 'original accurate reason' },
        };
      },
    };
    const first = await run('s', intent, options);
    expect(first.status).toBe('waiting_interaction');
    expect(first.answerIntent?.phase).toBe('unknown');
    expect(postDropped).toBe(1);
    expect(getDropped).toBeGreaterThanOrEqual(1);
    expect(first.answerIntent?.request).toEqual(original);
    recovery = true;
    const boundary = seen.length;
    const final = await observeCommand('s', intent, {
      ...options,
      answerIntent: first.answerIntent,
    });
    expect(final.status).toBe('succeeded');
    expect(prompts).toBe(1);
    expect(postDropped).toBe(1);
    expect(effects).toBe(1);
    expect(answer).toEqual({ decision: 'replan', detail: 'original accurate reason' });
    expect(seen[boundary]).toEqual({ method: 'GET', path: `/v1/commands/${original!.commandId}` });
    expect(seen.slice(boundary).every((value) => value.method === 'GET')).toBe(true);
    const db = new Database(resolveProfile(profile).databasePath, { readonly: true });
    try {
      const rows = db
        .query(
          "SELECT request_json,subject_id,session_id FROM command WHERE kind='interaction.answer'",
        )
        .all() as { request_json: string; subject_id: string; session_id: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ subject_id: 'owner', session_id: 's' });
      expect(JSON.parse(rows[0]!.request_json)).toMatchObject({
        interactionId: first.answerIntent!.interactionId,
        expectedRevision: original!.expectedRevision,
        answer: original!.answer,
      });
    } finally {
      db.close();
    }
  } finally {
    client?.disposeNetwork();
    for (const socket of sockets) socket.destroy();
    if (relay.listening) await new Promise<void>((resolve) => relay.close(() => resolve()));
    await service.close();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('actual paired CLI host retains unknown answer across its wait cycle and recovers original answer ID', async () => {
  const { runSelectedCLI } = await import('../../host');
  const { parseCLIArguments } = await import('../../src/arguments');
  const { Readable } = await import('node:stream');
  const { readFileSync } = await import('node:fs');
  const root = realpathSync(mkdtempSync('/private/tmp/kite-question-host-'));
  const lines: string[] = [];
  let saved: string | undefined,
    answerPosts = 0,
    originalReads = 0;
  try {
    const { buildOwnedDaemon } = await import('../fixtures/daemon-host-build');
    const artifactDirectory = join(root, 'artifact');
    await buildOwnedDaemon(artifactDirectory);
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, '../fixtures/interaction-child.ts')],
      target: 'bun',
      packages: 'external',
      outdir: artifactDirectory,
    });
    expect(build.success).toBe(true);
    const entrypoint = join(artifactDirectory, 'interaction-child.js');
    const code = await runSelectedCLI({
      arguments: parseCLIArguments(['run', '--thread', 's', '--task', 'original question']),
      dataRoot: join(root, 'data'),
      profile: 'owned',
      cwd: root,
      artifact: {
        entrypoint,
        entrypointSha256: createHash('sha256').update(readFileSync(entrypoint)).digest('hex'),
        executable: realpathSync(process.execPath),
        executableSha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
        buildId: 'fixed',
        apiMajor: 1,
      },
      stdin: Readable.from(['approve\n{"reply":"first"}\n']),
      write(line) {
        lines.push(line);
      },
      prompt() {},
      onLaunched(connection) {
        const client = connection.client,
          post = client.answerInteraction.bind(client),
          get = client.getCommand.bind(client);
        client.answerInteraction = async (session, id, input, options) => {
          const result = await post(session, id, input, options);
          if (input.answer.kind === 'question') {
            answerPosts++;
            saved = input.commandId;
            throw Error('lost actual question response');
          }
          return result;
        };
        client.getCommand = async (id, options) => {
          const result = await get(id, options);
          if (id === saved) {
            originalReads++;
            if (originalReads === 1) throw Error('lost original answer lookup');
          }
          return result;
        };
      },
    });
    expect(code).toBe(0);
    expect(answerPosts).toBe(1);
    expect(originalReads).toBe(2);
    expect(lines.some((line) => line.startsWith(`answer recovered ${saved} `))).toBe(true);
    expect(
      JSON.parse(
        readFileSync(
          join(
            resolveProfile({ dataRoot: join(root, 'data'), profile: 'owned' }).profilePath,
            'answer',
          ),
          'utf8',
        ),
      ),
    ).toEqual({
      reply: 'first',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

// Executed only after the real Workflow attempt/decision assembly is qualified by its owner.
for (const decision of ['replan', 'waive'] as const)
  test(`default paired CLI JSON ${decision} keeps original failed verification and adopts the exact user decision`, async () => {
    const { workflowQuestionProfile } = await import('../fixtures/workflow-question-profile');
    const { runSelectedCLI } = await import('../../host');
    const { parseCLIArguments } = await import('../../src/arguments');
    const { PassThrough } = await import('node:stream');
    const f = await workflowQuestionProfile(decision);
    const stdin = new PassThrough();
    const prompts: { kind: string; definitionId?: string }[] = [];
    let savedAnswerId: string | undefined,
      questionPosts = 0,
      originalGets = 0;
    const lines: string[] = [];
    let ownedPid: number | undefined;
    try {
      const code = await runSelectedCLI({
        arguments: parseCLIArguments([
          'run',
          '--thread',
          's',
          '--task',
          'original verification task',
          '--activate-skill',
          'alpha-skill',
          '--full',
          '--trust-workspace',
        ]),
        dataRoot: f.profile.dataRoot,
        profile: f.profile.profile,
        cwd: f.workspace,
        artifact: f.artifact,
        stdin,
        write(line) {
          lines.push(line);
        },
        prompt(line) {
          if (!line.startsWith('{')) return;
          const card = JSON.parse(line) as { kind: string; request: { definitionId?: string } };
          prompts.push({ kind: card.kind, definitionId: card.request.definitionId });
          stdin.write(
            card.kind === 'approval'
              ? 'approve\n'
              : `${JSON.stringify({ decision, detail: 'original explicit user instruction' })}\n`,
          );
        },
        onLaunched(connection) {
          ownedPid = connection.pid;
          const client = connection.client;
          const post = client.answerInteraction.bind(client),
            get = client.getCommand.bind(client);
          client.answerInteraction = async (session, id, request, options) => {
            const response = await post(session, id, request, options);
            if (request.answer.kind === 'question') {
              questionPosts++;
              savedAnswerId = request.commandId;
              throw Error('lost real Workflow question answer response');
            }
            return response;
          };
          client.getCommand = async (id, options) => {
            const response = await get(id, options);
            if (id === savedAnswerId && ++originalGets === 1)
              throw Error('lost first original Workflow answer lookup');
            return response;
          };
        },
      });
      if (code !== 0) {
        const debug = new Database(f.profile.databasePath, { readonly: true });
        try {
          console.error({
            lines,
            requests: f.requests.length,
            runs: debug.query('SELECT status,reason FROM run').all(),
            interactions: debug.query('SELECT kind,state,request_json FROM interaction').all(),
            executions: debug
              .query(
                'SELECT kind,state,adapter_id,intent_json,result_json,parent_execution_id FROM execution',
              )
              .all(),
            records: debug
              .query(
                "SELECT key,json FROM extension_record WHERE extension_id='builtin.skill-workflow'",
              )
              .all(),
          });
        } finally {
          debug.close();
        }
      }
      expect(code).toBe(0);
      expect(questionPosts).toBe(1);
      expect(originalGets).toBe(2);
      expect(prompts.filter((card) => card.kind === 'question')).toHaveLength(1);
      expect(
        prompts.filter((card) => card.kind === 'approval').map((card) => card.definitionId),
      ).toEqual(
        decision === 'waive'
          ? ['complete_skill', 'skill.workflow.verify', 'decide_skill_verification']
          : [
              'complete_skill',
              'skill.workflow.verify',
              'decide_skill_verification',
              'complete_skill',
              'skill.workflow.verify',
            ],
      );
      expect(lines.some((line) => line.startsWith(`answer recovered ${savedAnswerId} `))).toBe(
        true,
      );
      const output = lines.find((line) => line.startsWith('answer {'));
      expect(JSON.parse(output!.slice(7)).content).toBe('WORKFLOW_DECISION_DONE');
      expect(f.requests.length).toBe(decision === 'waive' ? 3 : 4);
      expect(JSON.stringify(f.requests[0]!.messages)).toContain(f.instructions);
      expect(readFileSync(f.ledger, 'utf8').trim().split('\n')).toHaveLength(
        decision === 'waive' ? 1 : 2,
      );
      const db = new Database(f.profile.databasePath, { readonly: true });
      try {
        const records = db
          .query(
            "SELECT key,json FROM extension_record WHERE extension_id='builtin.skill-workflow'",
          )
          .all() as { key: string; json: string }[];
        const failed = records.filter((record) => record.key.endsWith('/attempts/1/verification'));
        expect(failed).toHaveLength(1);
        expect(JSON.parse(failed[0]!.json).outcome).toBe('failed');
        const originalOutput = records.filter((record) =>
          record.key.endsWith('/attempts/1/closed'),
        );
        expect(originalOutput).toHaveLength(1);
        expect(JSON.parse(originalOutput[0]!.json).output).toEqual({
          answer: 'original failed output',
        });
        const question = db
          .query(
            "SELECT id,subject_id,session_id,presentation_session_id,answer_json,state,accepted_decision_revision,origin_store_id,run_id,execution_id,request_json FROM interaction WHERE kind='question'",
          )
          .get() as {
          id: string;
          subject_id: string;
          session_id: string;
          presentation_session_id: string;
          answer_json: string;
          state: string;
          accepted_decision_revision: number;
          origin_store_id: string;
          run_id: string;
          execution_id: string;
          request_json: string;
        };
        expect(question).toMatchObject({
          session_id: 's',
          presentation_session_id: 's',
          state: 'answered',
          accepted_decision_revision: 2,
        });
        expect(db.query('SELECT id,status,origin_command_id FROM run').get()).toEqual({
          id: question.run_id,
          status: 'completed',
          origin_command_id: (
            db.query("SELECT id FROM command WHERE kind='run.start'").get() as { id: string }
          ).id,
        });
        const decisionRecord = records.find((record) =>
          record.key.includes('/attempts/1/decision/'),
        )!;
        const adopted = JSON.parse(decisionRecord.json);
        expect(adopted.request).toEqual(JSON.parse(question.request_json));
        expect(adopted.proof).toMatchObject({
          interactionId: question.id,
          originStoreId: question.origin_store_id,
          sessionId: 's',
          runId: question.run_id,
          executionId: question.execution_id,
          decisionRevision: '2',
          request: adopted.request,
          answer: JSON.parse(question.answer_json),
        });
        const failedProof = JSON.parse(failed[0]!.json),
          closed = JSON.parse(originalOutput[0]!.json);
        expect(adopted.request).toMatchObject({
          attempt: 1,
          headRevision: closed.headRevision,
          outputDigest: closed.outputDigest,
          verifier: failedProof,
        });
        expect(failedProof.outputDigest).toBe(closed.outputDigest);
        expect(
          db
            .query(
              'SELECT state,kind,session_id,adapter_id,result_revision FROM execution WHERE id=?',
            )
            .get(failedProof.executionId),
        ).toEqual({
          state: 'failed',
          kind: 'job',
          session_id: 's',
          adapter_id: 'skill.workflow.verify',
          result_revision: Number(failedProof.resultRevision),
        });
        const head = JSON.parse(records.find((record) => record.key.endsWith('/head'))!.json);
        expect(head).toEqual(
          decision === 'waive'
            ? { kind: 'head', attempt: 1, waiverKey: decisionRecord.key }
            : { kind: 'head', attempt: 2 },
        );
        expect(JSON.parse(question.answer_json)).toEqual({
          kind: 'question',
          answers: { decision, detail: 'original explicit user instruction' },
        });
        const answers = db
          .query(
            "SELECT subject_id,session_id,request_json FROM command WHERE kind='interaction.answer' AND json_extract(request_json,'$.answer.kind')='question'",
          )
          .all() as { subject_id: string; session_id: string; request_json: string }[];
        expect(answers).toHaveLength(1);
        expect(answers[0]).toMatchObject({ subject_id: question.subject_id, session_id: 's' });
        expect(JSON.parse(answers[0]!.request_json).interactionId).toBe(question.id);
        expect(db.query("SELECT subject_id FROM command WHERE kind='run.start'").get()).toEqual({
          subject_id: question.subject_id,
        });
        if (decision === 'waive') {
          expect(
            records.some(
              (record) =>
                JSON.parse(record.json).status === 'waived' ||
                JSON.parse(record.json).outcome === 'waived',
            ),
          ).toBe(true);
        } else {
          const second = records.filter((record) =>
            record.key.endsWith('/attempts/2/verification'),
          );
          expect(second).toHaveLength(1);
          expect(JSON.parse(second[0]!.json).outcome).toBe('passed');
        }
      } finally {
        db.close();
      }
      expect(() => process.kill(ownedPid!, 0)).toThrow();
    } finally {
      stdin.destroy();
      f.close();
    }
  }, 30000);
