import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMcpAdapter } from '@kite-ai/agent/mcp';
import type { ModelEvent } from '@kite-ai/ai';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import type {
  CaseEvidence,
  UnifiedSoakCaseId,
} from '../../../../scripts/runtime/unified-soak-cases';
import { check, fixture, until } from './common';
import { type McpSoakStdioAssets, runOwnedMcpStdio } from './mcp-owned-stdio';

export type { McpSoakStdioAssets } from './mcp-owned-stdio';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function runFunctionalCase(
  root: string,
  caseId: UnifiedSoakCaseId,
  stdioAssets?: McpSoakStdioAssets,
): Promise<CaseEvidence> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const evidence: CaseEvidence = {
    caseId,
    status: 'passed',
    pid: process.pid,
    nonce: randomUUID(),
    durationMs: 0,
    workloadDurationMs: 0,
    cleanupConfirmed: false,
    assertions: [],
    unavailable: [],
  };
  const started = performance.now();
  try {
    if (caseId === 'long_runtime_replay') await replayPolicy(root, evidence);
    else if (caseId === 'subagent_cancel_recovery') await childCancel(root, evidence);
    else if (caseId === 'model_transient_stream') await modelFault(root, evidence);
    else if (caseId === 'mcp_churn') await mcpChurn(root, evidence, stdioAssets);
    else if (caseId === 'storage_and_logger_faults') await storageFault(root, evidence);
    else {
      evidence.status = 'unavailable';
      evidence.unavailable.push(`${caseId}_dedicated_host_not_implemented`);
    }
  } catch (error) {
    evidence.status = 'failed';
    evidence.unavailable.push(error instanceof Error ? error.message : 'case_failed');
  } finally {
    evidence.durationMs = performance.now() - started;
    evidence.workloadDurationMs = evidence.durationMs;
  }
  return evidence;
}
async function replayPolicy(root: string, e: CaseEvidence) {
  const output = '完整 retained output\r\n'.repeat(5000);
  let calls = 0,
    held = false,
    toolEffects = 0,
    readEffects = 0;
  writeFileSync(join(root, 'source.txt'), '真实 source bytes\r\n', { mode: 0o600 });
  const f = await fixture(root, {
    modelId: 'fixed',
    modelConcurrency: 1,
    compressor: {
      id: 'soak',
      version: '1',
      async prepare() {
        return { instructions: 'SOAK_SUMMARIZE', snapshot: { algorithm: 'fixed' } };
      },
    },
    permissions: {
      async authorize(request) {
        return request.definitionId === 'soak.read'
          ? {
              allowed: false,
              revision: 'owned',
              approval: {
                request: { title: 'Read original owned file' },
                grants: ['approve_once'],
              },
            }
          : { allowed: true, revision: 'owned' };
      },
    },
    extensions: [
      {
        id: 'soak',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'soak.count',
            version: '1',
            description: 'actual finite tool receipt',
            inputSchema: { type: 'object' },
            async execute() {
              toolEffects++;
              return { outcome: 'succeeded', content: 'actual tool result' };
            },
          },
          {
            id: 'soak.read',
            version: '1',
            description: 'read original owned file',
            inputSchema: { type: 'object' },
            async execute() {
              readEffects++;
              return {
                outcome: 'succeeded',
                content: readFileSync(join(root, 'source.txt'), 'utf8'),
              };
            },
          },
        ],
      },
    ],
    model: {
      async *stream(request, { signal }) {
        calls++;
        if (request.messages.some((m) => m.role === 'user' && m.content === 'thirteen-tools')) {
          const count = request.messages.filter(
            (m) => m.role === 'tool' && m.toolCallId?.startsWith('thirteen-'),
          ).length;
          if (count < 13) {
            yield {
              type: 'tool_call',
              id: `thirteen-${count}`,
              name: 'soak.count',
              arguments: '{}',
            };
            yield { ...finish, reason: 'tool_calls' };
            return;
          }
        }
        if (
          request.messages.at(-1)?.role === 'user' &&
          request.messages.at(-1)?.content === 'ask-read'
        ) {
          yield { type: 'tool_call', id: 'asked-read', name: 'soak.read', arguments: '{}' };
          yield { ...finish, reason: 'tool_calls' };
          return;
        }
        if (JSON.stringify(request.messages).includes('SOAK_SUMMARIZE')) {
          yield { type: 'text_delta', text: 'actual original compressed facts' };
          yield finish;
          return;
        }
        if (JSON.stringify(request.messages).includes('hold-slot')) {
          held = true;
          yield { type: 'text_delta', text: 'original partial' };
          while (!signal.aborted) await Bun.sleep(5);
          throw Error('cancelled');
        }
        yield { type: 'text_delta', text: output };
        yield finish;
      },
    },
  });
  try {
    const sessionId = await f.session('history');
    for (let i = 0; i < 13; i++) {
      const run = await f.start(sessionId, `ordinary-${i}`);
      check(
        e.assertions,
        `run_completed_${i}`,
        (await f.finish(run.runId))?.status ?? 'missing',
        'completed',
      );
    }
    check(e.assertions, 'sequential_runs_complete', calls, 13);
    const view = await f.store.getView(sessionId);
    e.identities = view.executions.map((v) => ({
      storeId: v.originStoreId,
      sessionId: v.sessionId,
      runId: v.runId,
      executionId: v.id,
      commandId: v.originCommandId,
    }));
    const model = view.executions.filter((v) => v.kind === 'model').at(-1)!;
    const full = await f.runtime.readModelOutput({
      expectedStoreId: f.storeId,
      sessionId,
      subjectId: 'soak',
      executionId: model.id,
    });
    check(e.assertions, 'full_output_hash', hash(full.output.content), hash(output));
    const replaySessionId = 'replay-only';
    await f.store.createSession({
      expectedStoreId: f.storeId,
      commandId: 'create-replay',
      sessionId: replaySessionId,
      workspaceId: 'w',
      subjectId: 'soak',
      title: 'readonly replay',
    });
    // Public Store admission only: no owner, Model dispatch or legacy event writer.
    for (let i = 0; i < 10000; i++)
      await f.store.acceptCommand({
        expectedStoreId: f.storeId,
        sessionId: replaySessionId,
        subjectId: 'soak',
        commandId: `replay-${i}`,
        request: { kind: 'run.start', content: 'readonly replay seed' },
      });
    const upper = (await f.store.getMetadata()).lastChangeCursor;
    let after = '0',
      count = 0;
    while (BigInt(after) < BigInt(upper)) {
      const page = await f.store.getChanges({ after, limit: 200, sessionIds: [replaySessionId] });
      const selected = page.events.filter((v) => BigInt(v.cursor) <= BigInt(upper));
      if (!selected.length) break;
      for (const event of selected) {
        if (BigInt(event.cursor) <= BigInt(after) || event.sessionId !== replaySessionId)
          throw Error('replay_scope');
        after = event.cursor;
        count++;
      }
    }
    check(e.assertions, 'replay_exact_cursor', count >= 10000 && after === upper, true);
    const holdS = await f.session('held'),
      nextS = await f.session('waiting');
    const hold = await f.start(holdS, 'hold-slot');
    await until(
      async () => held,
      (v) => v,
    );
    const queued = await f.start(nextS, 'queued-slot');
    await Bun.sleep(50);
    check(e.assertions, 'explicit_slot_wait', calls, 14);
    await f.client.cancelCommand(holdS, {
      kind: 'command.cancel',
      expectedStoreId: f.storeId,
      commandId: 'cancel-slot',
      targetCommandId: hold.commandId,
    });
    check(
      e.assertions,
      'cancel_releases_slot',
      (await f.finish(queued.runId))?.status ?? 'missing',
      'completed',
    );
    const stepsS = await f.session('steps');
    const steps = await f.start(stepsS, 'thirteen-tools');
    const finished = await f.finish(steps.runId);
    check(
      e.assertions,
      'no_hidden_twelve_step_limit',
      finished?.status === 'completed' && toolEffects === 13,
      true,
    );
    const askS = await f.session('ask');
    const asked = await f.start(askS, 'ask-read');
    const cards = await until(
      () => f.client.listInteractions(askS, { storeId: f.storeId, state: 'pending', limit: 100 }),
      (value) => value.interactions.length > 0,
    );
    const card = cards.interactions[0]!;
    check(e.assertions, 'approval_before_io', readEffects, 0);
    await f.client.answerInteraction(askS, card.id, {
      expectedStoreId: f.storeId,
      commandId: 'approve-original',
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
    check(
      e.assertions,
      'actual_approved_tool',
      (await f.finish(asked.runId))?.status === 'completed' && readEffects === 1,
      true,
    );
    const selection = (await f.client.getView(askS)).session.contextSelectionId;
    await f.client.compressContext(askS, {
      expectedStoreId: f.storeId,
      commandId: 'actual-compression',
      expectedContextSelectionId: selection,
    });
    await f.runtime.waitForCommand('actual-compression', { timeoutMs: 15000 });
    const selected = await f.store.getSelectedContext({
      expectedStoreId: f.storeId,
      sessionId: askS,
    });
    check(
      e.assertions,
      'actual_compression_published',
      !!selected.compression && selected.compression.originStoreId === f.storeId,
      true,
    );
  } finally {
    await f.close();
    e.cleanupConfirmed = true;
  }
}
async function childCancel(root: string, e: CaseEvidence) {
  let childEntered = false,
    childCancelled = false;
  let carrierId = '';
  const f = await fixture(root, {
    modelId: 'parent',
    model: {
      async *stream(request) {
        if (!request.messages.some((m) => m.role === 'tool')) {
          yield { type: 'tool_call', id: 'original-call', name: 'soak.delegate', arguments: '{}' };
          yield { ...finish, reason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'parent completed' };
          yield finish;
        }
      },
    },
    extensions: [
      {
        id: 'soak',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'soak.delegate',
            version: '1',
            description: 'owned child',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              const op = await context.operations.ensure({
                key: 'original-child',
                cancellation: 'attached',
                request: {
                  kind: 'agent',
                  configurationId: 'worker',
                  input: { content: 'owned child' },
                },
              });
              carrierId = op.executionId!;
              return { outcome: 'succeeded', content: 'delegated' };
            },
          },
        ],
      },
    ],
    childConfigurations: [
      {
        id: 'worker',
        version: '1',
        modelId: 'child',
        toolIds: [],
        snapshot: {},
        model: {
          async *stream(_request, { signal }) {
            childEntered = true;
            yield { type: 'text_delta', text: 'child partial' };
            while (!signal.aborted) await Bun.sleep(5);
            childCancelled = true;
            throw Error('child_cancelled');
          },
        },
      },
    ],
  });
  try {
    const s = await f.session('parent');
    await f.start(s, 'delegate');
    await until(
      async () => childEntered,
      (v) => v,
    );
    const carrier = await f.store.getExecution(carrierId);
    const childS = carrier?.childSessionId;
    if (carrier)
      e.identities = [
        {
          storeId: carrier.originStoreId,
          sessionId: carrier.sessionId,
          runId: carrier.runId,
          executionId: carrier.id,
          commandId: carrier.originCommandId,
        },
      ];
    check(
      e.assertions,
      'actual_child_scope',
      !!childS && childS !== s && carrier?.sessionId === s,
      true,
    );
    await f.client.cancelExecution(s, {
      kind: 'execution.cancel',
      expectedStoreId: f.storeId,
      commandId: 'cancel-child',
      executionId: carrierId,
    });
    await until(
      async () => childCancelled,
      (v) => v,
    );
    const child = await until(
      () => f.store.getView(childS!),
      (v) => v.runs.every((r) => !r.isActive),
    );
    check(
      e.assertions,
      'child_cancel_settled',
      child.executions.every((v) => ['succeeded', 'failed', 'cancelled'].includes(v.status)),
      true,
    );
    check(e.assertions, 'parent_scope_preserved', (await f.client.getView(s)).session.id, s);
  } finally {
    await f.close();
    e.cleanupConfirmed = true;
  }
}
async function modelFault(root: string, e: CaseEvidence) {
  let calls = 0,
    transportAborted = false;
  const chunk = (delta: unknown, reason: string | null) =>
    `data: ${JSON.stringify({ id: 'owned', object: 'chat.completion.chunk', created: 1, model: 'fixed', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      calls++;
      const input = JSON.stringify(await request.json());
      if (input.includes('actual-429'))
        return Response.json({ error: { message: 'owned rate limit' } }, { status: 429 });
      if (input.includes('actual-503'))
        return Response.json({ error: { message: 'owned unavailable' } }, { status: 503 });
      if (input.includes('partial-drop'))
        return new Response(chunk({ content: 'actual partial' }, null), {
          headers: { 'content-type': 'text/event-stream' },
        });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(chunk({ content: 'held partial' }, null)));
            request.signal.addEventListener(
              'abort',
              () => {
                transportAborted = true;
                controller.close();
              },
              { once: true },
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const binding = createCompatibleModelBinding({
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    modelId: 'fixed',
    apiKey: 'owned-local',
  });
  const f = await fixture(root, {
    modelId: 'fixed',
    model: createSdkModelAdapter({ models: new Map([['fixed', binding]]) }),
  });
  try {
    const s = await f.session('partial');
    const run = await f.start(s, 'partial-drop');
    const terminal = await f.finish(run.runId);
    e.identities = (await f.store.getView(s)).executions.map((v) => ({
      storeId: v.originStoreId,
      sessionId: v.sessionId,
      runId: v.runId,
      executionId: v.id,
      commandId: v.originCommandId,
    }));
    check(
      e.assertions,
      'partial_not_complete',
      terminal?.status === 'failed' &&
        (await f.client.getView(s)).messages.some((m) => m.status === 'incomplete'),
      true,
    );
    check(e.assertions, 'single_attempt_no_hidden_retry', calls, 1);
    const held = await f.session('abort');
    const work = await f.start(held, 'held-transport');
    await until(
      async () => calls,
      (v) => v === 2,
    );
    await f.client.cancelCommand(held, {
      kind: 'command.cancel',
      expectedStoreId: f.storeId,
      commandId: 'cancel-transport',
      targetCommandId: work.commandId,
    });
    await f.finish(work.runId);
    await until(
      async () => transportAborted,
      (v) => v,
    );
    check(e.assertions, 'actual_transport_abort', transportAborted, true);
    for (const status of [429, 503]) {
      const sessionId = await f.session(`status-${status}`);
      const before = calls;
      const attempt = await f.start(sessionId, `actual-${status}`);
      const failed = await f.finish(attempt.runId);
      check(e.assertions, `http_${status}_terminal`, failed?.status ?? 'missing', 'failed');
      check(e.assertions, `http_${status}_single_attempt`, calls - before, 1);
    }
  } finally {
    await f.close();
    server.stop(true);
    e.cleanupConfirmed = true;
  }
}
async function mcpChurn(root: string, e: CaseEvidence, stdioAssets?: McpSoakStdioAssets) {
  let changed = false,
    calls = 0,
    ownedMcpCompleted = false;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const rpc = (await request.json()) as { id?: number; method: string };
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      if (rpc.method === 'initialize')
        result = {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'owned', version: '1' },
          capabilities: { tools: {} },
        };
      else if (rpc.method === 'tools/list')
        result = {
          tools: [
            {
              name: changed ? 'changed' : 'read',
              description: 'owned local read',
              inputSchema: { type: 'object' },
            },
          ],
        };
      else {
        calls++;
        result = { content: [{ type: 'text', text: '完整 local MCP result' }] };
      }
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    },
  });
  const adapter = createMcpAdapter({
    id: 'owned',
    transport: { type: 'http', url: server.url.href },
  });
  const scope = adapter.scope('original');
  const tools = await scope.snapshotTools();
  const f = await fixture(root, {
    modelId: 'fixed',
    model: {
      async *stream(request) {
        if (request.messages.at(-1)?.role === 'user') {
          yield { type: 'tool_call', id: randomUUID(), name: tools[0]!.id, arguments: '{}' };
          yield { ...finish, reason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'done' };
          yield finish;
        }
      },
    },
    extensions: [{ id: 'remote', version: '1', apiMajor: 1, tools }],
  });
  try {
    check(e.assertions, 'actual_catalogue', tools.length, 1);
    const sessionId = await f.session('mcp');
    const first = await f.start(sessionId, 'remote');
    await f.finish(first.runId);
    e.identities = (await f.store.getView(sessionId)).executions.map((v) => ({
      storeId: v.originStoreId,
      sessionId: v.sessionId,
      runId: v.runId,
      executionId: v.id,
      commandId: v.originCommandId,
    }));
    check(e.assertions, 'actual_remote_result', calls, 1);
    changed = true;
    adapter.invalidateCatalogue();
    await scope.snapshotTools();
    const stale = await f.start(sessionId, 'old definition');
    await f.finish(stale.runId);
    const executions = (await f.store.getView(sessionId)).executions.filter(
      (v) => v.runId === stale.runId && v.kind === 'tool',
    );
    check(
      e.assertions,
      'catalogue_drift_rejected',
      executions.some((v) => v.status === 'failed') && calls === 1,
      true,
    );
    await scope.release();
    let rejected = false;
    try {
      await scope.snapshotTools();
    } catch {
      rejected = true;
    }
    check(e.assertions, 'released_scope_rejected', rejected, true);
    if (!stdioAssets) throw Error('mcp_stdio_owned_assets_missing');
    await runOwnedMcpStdio(root, e, stdioAssets);
    ownedMcpCompleted = true;
  } finally {
    await f.close();
    await adapter.close();
    server.stop(true);
    e.cleanupConfirmed = ownedMcpCompleted;
  }
}
async function storageFault(root: string, e: CaseEvidence) {
  const f = await fixture(root, {
    modelId: 'fixed',
    model: {
      async *stream() {
        yield { type: 'text_delta', text: 'done' };
        yield finish;
      },
    },
  });
  const db = new Database(join(root, 'data', 'soak', 'core.db'));
  try {
    const s = await f.session('storage');
    e.identities = [
      { storeId: f.storeId, sessionId: s, runId: null, executionId: null, commandId: null },
    ];
    const before = (await f.store.getMetadata()).lastChangeCursor;
    db.exec('BEGIN IMMEDIATE');
    let settled = false;
    const write = f.store
      .acceptCommand({
        expectedStoreId: f.storeId,
        sessionId: s,
        subjectId: 'soak',
        commandId: 'blocked',
        request: { kind: 'run.start', content: 'blocked' },
      })
      .finally(() => {
        settled = true;
      });
    await Bun.sleep(100);
    check(e.assertions, 'actual_writer_lock', settled, false);
    db.exec('ROLLBACK');
    await write;
    const full = new Database(join(root, 'full.db'));
    try {
      full.exec('CREATE TABLE owned(value BLOB)');
      const pages = (full.query('PRAGMA page_count').get() as { page_count: number }).page_count;
      full.exec(`PRAGMA max_page_count=${pages}`);
      let code = '';
      try {
        full.run('INSERT INTO owned VALUES(?)', [new Uint8Array(1024 * 1024)]);
      } catch (error) {
        code = String((error as { code: string }).code);
      }
      check(e.assertions, 'actual_sqlite_full', code, 'SQLITE_FULL');
    } finally {
      full.close();
    }
    db.exec(
      "CREATE TRIGGER owned_fault BEFORE INSERT ON change_event WHEN NEW.type='command.accepted' BEGIN SELECT RAISE(ABORT,'owned log write fault'); END",
    );
    let rejected = false;
    try {
      await f.store.acceptCommand({
        expectedStoreId: f.storeId,
        sessionId: s,
        subjectId: 'soak',
        commandId: 'log-fault',
        request: { kind: 'run.start', content: 'fault' },
      });
    } catch {
      rejected = true;
    }
    check(
      e.assertions,
      'failed_write_no_partial_event',
      rejected && !(await f.store.getCommand('log-fault')),
      true,
    );
    db.exec('DROP TRIGGER owned_fault');
    await f.store.acceptCommand({
      expectedStoreId: f.storeId,
      sessionId: s,
      subjectId: 'soak',
      commandId: 'after-fault',
      request: { kind: 'run.start', content: 'after' },
    });
    check(
      e.assertions,
      'fault_removed_write_succeeds',
      (await f.store.getCommand('after-fault'))?.status ?? 'missing',
      'accepted',
    );
    check(
      e.assertions,
      'cursor_monotonic',
      BigInt((await f.store.getMetadata()).lastChangeCursor) > BigInt(before),
      true,
    );
  } finally {
    db.close();
    await f.close();
    e.cleanupConfirmed = true;
  }
}
