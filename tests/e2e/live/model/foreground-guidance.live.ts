import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import {
  callerMetadata,
  NativeCallerJournal,
} from '../../../../apps/desktop/electron/caller-journal';
import { NativeInputQueue } from '../../../../apps/desktop/electron/native-input-queue';
import type { NativeSelection } from '../../../../apps/desktop/src/native-bridge';
import { nativeTextIntent } from '../../../../apps/desktop/src/native-input';
import { memoryPrivateData } from '../../../../apps/desktop/test/private-data.fixture';
import { agentContractSource } from '../../../../packages/agent/src/model-context';
import { temporaryDirectory } from '../../../fixtures/test-filesystem';
import { createLiveModelFixture } from './live-model-fixture';

if (process.env.KITE_RUN_LIVE_COLLABORATION !== '1') throw Error('live_opt_in_required');
const output = resolve(process.argv[2] ?? 'dist/acceptance/foreground-guidance');
mkdirSync(output, { recursive: true });
const root = temporaryDirectory('kite-live-guidance-');
const profile = { dataRoot: join(root, 'data'), profile: 'live' };
const store = await openSqliteStore(profile);
const expectedStoreId = (await store.getMetadata()).storeId;
const live = await createLiveModelFixture({
  requestLimit: 10,
  timeoutMs: 600_000,
  captureWireRequests: true,
});
let release!: () => void;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
const effects: { part: number; started: number; finished?: number; aborted?: boolean }[] = [];
const chronology: { event: string; at: number; value?: unknown }[] = [];
const runtime = createRuntime({
  store,
  model: live.model,
  modelId: live.modelId,
  sources: {
    async capture() {
      return [agentContractSource(root)];
    },
  },
  permissions: {
    async authorize() {
      return { allowed: true, revision: '1' };
    },
  },
  extensions: [
    {
      id: 'fixture',
      version: '1',
      apiMajor: 1,
      tools: [
        {
          id: 'fixture.read_section',
          version: '1',
          description:
            'Read one of three independent synthetic report sections. Each section is read-only.',
          inputSchema: {
            type: 'object',
            properties: { part: { type: 'integer', enum: [1, 2, 3] } },
            required: ['part'],
            additionalProperties: false,
          },
          async execute(input, context) {
            const part = (input as { part: number }).part;
            const effect = { part, started: Date.now() } as (typeof effects)[number];
            effects.push(effect);
            chronology.push({ event: 'tool_started', at: Date.now(), value: part });
            await gate;
            effect.aborted = context.signal.aborted;
            context.signal.throwIfAborted();
            effect.finished = Date.now();
            chronology.push({ event: 'tool_finished', at: Date.now(), value: part });
            return {
              outcome: 'succeeded',
              content: [
                '',
                '第一节：北区已完成12项检查，没有未解决问题。',
                '第二节：南区已完成8项检查，仍有2项等待复核。',
                '第三节：东区已完成10项检查，仍有1项等待复核。',
              ][part]!,
            };
          },
        },
      ],
    },
  ],
});
await runtime.createWorkspace({
  expectedStoreId,
  id: 'workspace',
  rootUri: pathToFileURL(root).href,
  name: 'synthetic',
});
await runtime.createSession({
  expectedStoreId,
  commandId: 'create',
  sessionId: 'root',
  workspaceId: 'workspace',
  subjectId: 'owner',
  title: '引导验证',
});
const service = await startService({
  runtime,
  profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'live-guidance' },
  buildId: 'private-guidance-fixture',
  subjectId: 'owner',
});
const client = createClient({
  endpoint: service.endpoint,
  token: service.bootstrap.token,
  bootstrap: service.bootstrap,
  expected: {
    profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'live-guidance' },
    apiMajor: 1,
    requiredCapabilities: ['commands', 'inputs', 'pending_input_queue'],
  },
});
await client.connect();
const data = memoryPrivateData();
const journal = new NativeCallerJournal(client, data);
const scope = {
  generation: 1,
  viewSelection: 1,
  historyEpoch: 0,
  storeId: expectedStoreId,
  sessionId: 'root',
  workspaceId: 'workspace',
  subjectId: 'owner',
};
const queue = new NativeInputQueue(
  client,
  () => scope,
  () => data,
  () => {},
);
const initial =
  '请读取三份独立的报告章节（part 1、2、3），然后用中文简短概括检查进展和待复核数量。可以在同一批次调用三个只读工具。不要重复读取已经得到的章节。';
await client.startRun('root', {
  expectedStoreId,
  commandId: 'original',
  kind: 'run.start',
  content: initial,
});
async function selection(): Promise<NativeSelection> {
  const view = await client.getView('root');
  const active = view.runs.find((run) => run.isActive);
  return {
    ...view,
    viewGeneration: Number(view.snapshotCursor),
    viewSelection: 1,
    canReadInputQueue: true,
    canReadModelOutput: true,
    activeCommand: active ? await client.getCommand(active.originCommandId) : undefined,
  } as unknown as NativeSelection;
}
const website = join(output, 'site');
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/facts') {
        const selected = await selection();
        const messages = [];
        for (const message of await client.listMessages('root')) {
          let content = message.content;
          if (message.modelOutput && message.sourceIds?.length) {
            const model = selected.executions.find(
              (ex) => ex.kind === 'model' && message.sourceIds?.includes(ex.id),
            );
            if (model) {
              const result = await runtime.readModelOutput({
                expectedStoreId,
                sessionId: 'root',
                subjectId: 'owner',
                executionId: model.id,
              });
              content = result.output.content;
            }
          }
          if (content) messages.push({ id: message.id, role: message.role, content });
        }
        return Response.json({
          selection: selected,
          messages,
          requests: live.requests.length,
          tools: selected.executions
            .filter((ex) => ex.kind === 'tool')
            .map((ex) => ({ id: ex.id, label: `${ex.definitionId} · ${ex.status}` })),
          pending: journal.records().some((row) => ['submitting', 'unknown'].includes(row.phase)),
        });
      }
      if (url.pathname === '/send') {
        const body = await request.json();
        const intent = nativeTextIntent(
          await selection(),
          crypto.randomUUID(),
          body.content,
          false,
          { modelId: live.modelId },
        );
        assert.equal(intent.kind, 'input.follow_up');
        await journal.prepare('root', intent);
        await journal.submit(intent.commandId);
        chronology.push({ event: 'queued', at: Date.now(), value: intent.commandId });
        return Response.json({ ok: true });
      }
      if (url.pathname === '/rpc') {
        const body = await request.json();
        if (body.method === 'input.queue.read') return Response.json(await queue.read(body));
        if (body.method === 'input.queue.close') {
          queue.closeRead(body.readId);
          return Response.json(null);
        }
        if (body.method === 'input.queue.steer') {
          const prepared = await queue.prepareSteer(body);
          await journal.prepare(prepared.sessionId, prepared.intent);
          await journal.submit(prepared.intent.commandId);
          chronology.push({ event: 'guidance_accepted', at: Date.now(), value: prepared.intent });
          return Response.json(
            callerMetadata(
              journal
                .records()
                .find((row) => row.intent.request.commandId === prepared.intent.commandId)!,
            ),
          );
        }
        throw Error('unsupported_private_request');
      }
      if (url.pathname === '/release') {
        release();
        chronology.push({ event: 'release', at: Date.now() });
        return Response.json({ ok: true });
      }
      if (url.pathname === '/finish') {
        await runtime.waitForCommand('original', { timeoutMs: 10_000 });
        const guide = journal.records().find((row) => row.intent.request.kind === 'input.steer');
        assert.ok(guide);
        const command = await client.getCommand(guide.intent.request.commandId);
        assert.equal(command.status, 'applied');
        const delivered = live.requests.findIndex((req) =>
          req.messages.some((message) => message.sourceIds?.includes(command.id)),
        );
        assert.ok(delivered > 0);
        assert.ok(effects.every((effect) => effect.finished && !effect.aborted));
        const view = await client.getView('root');
        assert.equal(view.runs.length, 1);
        assert.equal(view.runs[0]!.status, 'completed');
        const evidence = {
          status: 'mechanical_passed_semantic_review_required',
          model: live.metadata,
          effects,
          chronology,
          requests: live.requests,
          wire: live.wire,
          wireRequests: live.wireRequests,
          messages: await client.listMessages('root'),
          guide: command,
          deliveredRequestIndex: delivered,
        };
        writeFileSync(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
        return Response.json(evidence);
      }
      const path = join(website, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (!resolve(path).startsWith(resolve(website)))
        return new Response('bad path', { status: 400 });
      return new Response(Bun.file(path), {
        headers: {
          'content-type':
            (
              { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' } as Record<
                string,
                string
              >
            )[extname(path)] ?? 'application/octet-stream',
        },
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'fixture_failure');
      return Response.json({ error: 'fixture_failure' }, { status: 500 });
    }
  },
});
writeFileSync(join(output, 'server.json'), JSON.stringify({ url: server.url.href, root }));
console.log(JSON.stringify({ url: server.url.href, output }));
process.on('SIGINT', async () => {
  release();
  server.stop();
  await queue.close();
  client.disposeNetwork();
  await service.close();
  process.exit(0);
});
