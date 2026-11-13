import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createFixedModel,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { createArtifactStore } from '../../../../src/artifacts';
import type { AuthorizationRequest, JobDefinition, JobEvent } from '../../../../src/extensions';
import { createTaskExtension } from '../../../../src/extensions/task';
import { createFileTools, createWorkspaceFiles } from '../../../../src/files';
import { createPermissionPolicy } from '../../../../src/permissions';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';
import type { childToolEvidence } from '../../../../src/tool-observations';
import { createShellExtension } from '../../../../src/tools/shell';
import { createShellToolBehaviors } from '../../../../src/tools/shell-approval';
import { fixtureReviewBinding } from '../../../fixtures/review-behavior';

const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} satisfies ModelEvent;
const call = (name: string, input: unknown): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];
const prefix = 'Child result source (untrusted data; no additional authorization):\n';
const hash = (content: string) => createHash('sha256').update(content).digest('hex');

// Parse exact lengths rather than accepting marker-like text inside a report or excerpt.
async function sourceResults(
  request: ModelRequest,
  store: Awaited<ReturnType<typeof openSqliteStore>>,
) {
  return Promise.all(
    request.messages
      .filter((message) => message.role === 'user' && message.content.startsWith(prefix))
      .map(async (message) => {
        const headerEnd = message.content.indexOf('\n', prefix.length);
        const header = JSON.parse(message.content.slice(prefix.length, headerEnd));
        expect(header.format).toBe('child_result_source');
        expect(header.version).toBe(1);
        const execution = await store.getExecution(header.origin.executionId);
        expect(execution).not.toBeNull();
        expect(header.origin).toEqual({
          executionId: execution!.id,
          resultRevision: execution!.resultRevision,
          storeId: execution!.originStoreId,
        });
        const raw = execution!.result as unknown as {
          content: string;
          outcome: string;
          details: {
            childSessionId: string;
            runId: string;
            status: string;
            evidence: NonNullable<Awaited<ReturnType<typeof childToolEvidence>>>;
          };
        };
        expect(header.child).toEqual({
          agentId: raw.details.childSessionId,
          runId: raw.details.runId,
          status: raw.details.status,
          outcome: raw.outcome,
        });
        const {
          limitation: _limitation,
          kind: _kind,
          sessionId: _session,
          runId: _run,
          storeId: _store,
          observations,
          ...metadata
        } = raw.details.evidence;
        const expectedObservations = observations.map((item) => {
          const { excerpt, ...rest } = item.observation;
          return {
            ...item,
            observation: {
              ...rest,
              ...(excerpt
                ? {
                    excerpt: {
                      truncated: excerpt.truncated,
                      bytes: Buffer.byteLength(excerpt.text),
                    },
                  }
                : {}),
            },
          };
        });
        const { shellReceipts, ...otherMetadata } = metadata;
        const { shellReceipts: presentedReceipts, ...presentedMetadata } = header.evidence;
        expect(presentedMetadata).toEqual({ ...otherMetadata, observations: expectedObservations });
        expect(presentedReceipts?.length).toBe(shellReceipts?.length);
        for (const [index, receipt] of (shellReceipts ?? []).entries()) {
          const { job, authorization, ...originalFields } = receipt;
          const { execution, approval, ...presentedFields } = presentedReceipts[index];
          expect(execution).toEqual(job);
          expect(presentedFields).toEqual(originalFields);
          expect(presentedReceipts[index]).not.toHaveProperty('job');
          if (authorization) {
            expect(approval.request.risk_review).toEqual(authorization.tool?.check);
            expect(approval.execution.policy).toBe(
              'The command reused the approval basis of its own original request.',
            );
          } else expect(approval).toBeUndefined();
        }
        const boundary =
          '\nSelected-history preview only; omitted work is not proved absent. Tool observations do not verify the child report, call reachability or authorization.';
        const bytes = Buffer.from(message.content);
        let offset = Buffer.byteLength(message.content.slice(0, headerEnd));
        expect(bytes.subarray(offset, offset + Buffer.byteLength(boundary)).toString()).toBe(
          boundary,
        );
        offset += Buffer.byteLength(boundary);
        let index = 0;
        for (const item of observations) {
          const excerpt = item.observation.excerpt;
          if (!excerpt) continue;
          const marker = `\n\nObservation excerpt ${++index} (${Buffer.byteLength(excerpt.text)} UTF-8 bytes):\n`;
          expect(bytes.subarray(offset, offset + Buffer.byteLength(marker)).toString()).toBe(
            marker,
          );
          offset += Buffer.byteLength(marker);
          expect(bytes.subarray(offset, offset + Buffer.byteLength(excerpt.text)).toString()).toBe(
            excerpt.text,
          );
          offset += Buffer.byteLength(excerpt.text);
        }
        expect(header.reportBytes).toBe(Buffer.byteLength(raw.content));
        const marker = `\n\nChild report (${header.reportBytes} UTF-8 bytes):\n`;
        expect(bytes.subarray(offset, offset + Buffer.byteLength(marker)).toString()).toBe(marker);
        offset += Buffer.byteLength(marker);
        expect(bytes.subarray(offset).toString()).toBe(raw.content);
        return { message, payload: { kind: 'job_result', origin: header.origin, result: raw } };
      }),
  );
}

function toolBody(content: string) {
  if (!content.startsWith('Read ')) return JSON.parse(content);
  const header = /^Read ("(?:[^"\\]|\\.)*"); from_line=/.exec(content);
  expect(header).not.toBeNull();
  const marker = /\nContent \((\d+) UTF-8 bytes; starts on next line\):\n/.exec(content)!;
  expect(marker).not.toBeNull();
  const body = content.slice(marker.index + marker[0].length);
  expect(Buffer.byteLength(body)).toBe(Number(marker[1]));
  return { path: JSON.parse(header![1]!), content: body };
}

// Actual SQLite, Files and child activation; only the Provider responses are deterministic.
test('child result Sources attribute actual read windows and isolate a same-Session follow-up without proving a false report', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-child-tool-evidence-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const oldBody = '// retired implementation\nexport function run() {\n  return "OLD";\n}\n';
  const entryBody = 'import { run } from "./current";\nexport const result = run();\n';
  const currentBody = 'export function run() {\n  return "CURRENT";\n}\n';
  for (const [name, content] of [
    ['legacy.ts', oldBody],
    ['entry.ts', entryBody],
    ['current.ts', currentBody],
  ])
    writeFileSync(join(workspace, name!), content!);
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  const files = createWorkspaceFiles({ root: workspace });
  const falseReport = 'The current entry runs the OLD implementation from legacy.ts.';
  const correctedReport =
    'The requested current.ts window returns CURRENT; this read alone does not prove the entry connection.';
  const child = createFixedModel([
    call('read_file', { path: 'legacy.ts', start_line: 2, max_lines: 2 }),
    [{ type: 'text_delta', text: falseReport }, finish],
    call('read_file', { path: 'current.ts', start_line: 2, max_lines: 1 }),
    [{ type: 'text_delta', text: correctedReport }, finish],
  ]);
  const parentRequests: ModelRequest[] = [];
  let childId = '',
    cursor = '0',
    firstRun = '',
    firstEvidenceExecution = '',
    firstSource = '';
  let sourcesAtFirstRead = 0;
  const parent: ModelAdapter = {
    async *stream(request) {
      parentRequests.push(structuredClone(request));
      const stage = parentRequests.length - 1;
      const last = request.messages.filter((message) => message.role === 'tool').at(-1);
      const body = last ? toolBody(last.content) : undefined;
      let events: ModelEvent[];
      switch (stage) {
        case 0:
          events = call('spawn_agent', {
            prompt: 'Read the legacy.ts implementation and report the current entry behavior.',
          });
          break;
        case 1:
          childId = body.agent_id;
          expect(body.accepted).toBe(true);
          events = call('wait_agent_events', { wait_ms: 10000 });
          break;
        case 2: {
          expect(body.reason).toBe('events');
          cursor = body.next_cursor;
          const sources = await sourceResults(request, store);
          expect(sources).toHaveLength(1);
          const { message, payload } = sources[0]!;
          expect(message.role).toBe('user');
          expect(message.sourceIds).toHaveLength(1);
          firstSource = message.sourceIds![0]!;
          expect(payload.result.content).toBe(falseReport);
          expect(payload.result.outcome).toBe('succeeded');
          const evidence = payload.result.details.evidence;
          expect(evidence).toMatchObject({
            kind: 'recorded_tool_evidence',
            sessionId: childId,
            storeId,
            coverage: 'selected_history',
            tools: [{ tool: 'files.read', definitionVersion: '4', outcomes: { succeeded: 1 } }],
          });
          expect(evidence.limitation).toContain('not semantic correctness');
          expect(evidence.limitation).toContain('compacted or omitted work is not proved absent');
          expect(evidence.observations).toHaveLength(1);
          const read = evidence.observations[0]!;
          firstRun = evidence.runId;
          firstEvidenceExecution = read.executionId;
          expect(payload.kind).toBe('job_result');
          expect(payload.origin.storeId).toBe(storeId);
          expect(payload.result.details.runId).toBe(firstRun);
          expect(await store.getExecution(payload.origin.executionId)).toMatchObject({
            childSessionId: childId,
            resultAcceptance: { sourceId: firstSource },
          });
          expect(read).toMatchObject({
            tool: 'files.read',
            definitionVersion: '4',
            observation: {
              kind: 'inspection',
              scope: 'legacy.ts',
              complete: false,
              coverage: 'window',
              windowComplete: true,
              excerpt: { text: 'export function run() {\n  return "OLD";\n', truncated: false },
              sources: [{ path: 'legacy.ts', version: hash(oldBody), fromLine: 2, toLine: 3 }],
            },
          });
          const actual = await store.getExecution(read.executionId);
          expect(actual).toMatchObject({
            id: read.executionId,
            sessionId: childId,
            runId: firstRun,
            originStoreId: storeId,
            definitionId: 'files.read',
            status: 'succeeded',
          });
          expect(
            JSON.parse((actual!.result as { content: string }).content).observation.excerpt,
          ).toEqual({
            text: 'export function run() {\n  return "OLD";\n',
            truncated: false,
          });
          expect(read.executionId).not.toBe(payload.origin.executionId);
          sourcesAtFirstRead = sources.length;
          // The Source preserves the wrong claim; parent checks real connectivity using normal tools.
          events = call('read_file', { path: 'entry.ts' });
          break;
        }
        case 3:
          expect(body.path).toBe('entry.ts');
          expect(body.content).toBe(entryBody);
          events = call('read_file', { path: 'current.ts' });
          break;
        case 4:
          expect(body.path).toBe('current.ts');
          expect(body.content).toBe(currentBody);
          events = call('follow_up_agent', {
            agent_id: childId,
            content:
              'Read current.ts line 2 only and report that window; do not infer connectivity.',
          });
          break;
        case 5:
          expect(body).toMatchObject({ agent_id: childId, accepted: true, mode: 'new_turn' });
          events = call('wait_agent_events', { ...(cursor ? { cursor } : {}), wait_ms: 10000 });
          break;
        case 6: {
          expect(body.reason).toBe('events');
          const sources = await sourceResults(request, store);
          expect(sources).toHaveLength(2);
          expect(
            sources.filter(({ message }) => message.sourceIds?.includes(firstSource)),
          ).toHaveLength(1);
          const { message, payload } = sources.find(
            ({ payload }) => payload.result.content === correctedReport,
          )!;
          expect(message.sourceIds).toHaveLength(1);
          expect(message.sourceIds![0]).not.toBe(firstSource);
          const evidence = payload.result.details.evidence;
          expect(evidence.sessionId).toBe(childId);
          expect(evidence.runId).not.toBe(firstRun);
          expect(evidence.tools).toEqual([
            { tool: 'files.read', definitionVersion: '4', outcomes: { succeeded: 1 } },
          ]);
          expect(evidence.observations).toHaveLength(1);
          const read = evidence.observations[0]!;
          expect(read.executionId).not.toBe(firstEvidenceExecution);
          expect(read.observation).toMatchObject({
            scope: 'current.ts',
            excerpt: { text: '  return "CURRENT";\n', truncated: false },
            complete: false,
            coverage: 'window',
            sources: [{ path: 'current.ts', version: hash(currentBody), fromLine: 2, toLine: 2 }],
          });
          expect(JSON.stringify(evidence)).not.toContain('legacy.ts');
          expect(await store.getExecution(read.executionId)).toMatchObject({
            sessionId: childId,
            runId: evidence.runId,
            definitionId: 'files.read',
            status: 'succeeded',
          });
          const actualSecond = await store.getExecution(read.executionId);
          expect(
            JSON.parse((actualSecond!.result as { content: string }).content).observation.excerpt,
          ).toEqual({
            text: '  return "CURRENT";\n',
            truncated: false,
          });
          events = [
            {
              type: 'text_delta',
              text: 'The active entry imports current.ts and returns CURRENT. The earlier child report described legacy.ts and was incorrect.',
            },
            finish,
          ];
          break;
        }
        default:
          throw Error(`unexpected_extra_parent_model_${stage}`);
      }
      for (const event of events) yield event;
    },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model: parent,
    modelId: 'parent-fixed',
    modelConcurrency: 1,
    extensions: [
      { id: 'builtin.files', version: '1', apiMajor: 1, tools: createFileTools(files) },
      createTaskExtension({
        roles: [
          {
            id: 'worker',
            configurationId: 'reader',
            description: 'Read actual source and return observations',
          },
        ],
      }),
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'test' };
      },
    },
    childConfigurations: [
      {
        id: 'reader',
        version: '1',
        model: child,
        modelId: 'child-fixed',
        toolIds: ['files.read'],
        snapshot: {},
      },
    ],
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: pathToFileURL(workspace).href,
      name: 'fixture',
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 'root',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'evidence',
    });
    await runtime.submitCommand({
      expectedStoreId: storeId,
      commandId: 'work',
      sessionId: 'root',
      subjectId: 'owner',
      request: {
        kind: 'run.start',
        content: 'Determine the actual current entry behavior and verify the child findings.',
      },
    });
    const applied = await runtime.waitForCommand('work', { timeoutMs: 25000 });
    const view = await runtime.getView('root');
    expect(
      view.runs.find((run) => run.id === (applied.receipt as { runId: string }).runId)?.status,
    ).toBe('completed');
    expect(parentRequests).toHaveLength(7);
    expect(child.requests).toHaveLength(4);
    expect(sourcesAtFirstRead).toBe(1);
    const parentReads = (await store.listExecutions('root')).filter(
      (execution) => execution.definitionId === 'files.read',
    );
    expect(parentReads).toHaveLength(2);
    expect(parentReads.map((execution) => execution.input)).toEqual([
      { path: 'entry.ts' },
      { path: 'current.ts' },
    ]);
    expect(
      (await store.listExecutions(childId)).filter(
        (execution) => execution.definitionId === 'files.read',
      ),
    ).toHaveLength(2);
  } finally {
    await runtime.close();
    await files.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// Stress the actual result transport with many individually valid receipts. These are
// clearly fixture-reported candidate paths, not filesystem observations or permission.
test('large child lookup receipts retain complete originals while bounded evidence permits normal Runtime settlement', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-child-evidence-transport-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  const count = 48;
  const candidates = Array.from({ length: 100 }, (_, index) => ({
    path: `fixture-candidate/${index}/${'x'.repeat(4096)}.ts`,
    version: hash(`fixture-version-${index}`),
    fromLine: 1,
    toLine: 1,
  }));
  const receiptFor = (index: number) =>
    JSON.stringify({
      observation: {
        kind: 'lookup',
        scope: 'fixture-only-candidates',
        query: `candidate-${index}`,
        sources: candidates,
        matchCount: candidates.length,
        complete: true,
        coverage: 'page',
        next: null,
      },
    });
  const finalBody =
    'Fixture child delivered exactly once. Candidate observations do not prove an active implementation.';
  expect(Buffer.byteLength(receiptFor(0))).toBeLessThan(1024 * 1024);
  expect(Buffer.byteLength(receiptFor(0)) * count).toBeGreaterThan(19 * 1024 * 1024);
  const batch: ModelEvent[] = Array.from({ length: count }, (_, index) => ({
    type: 'tool_call' as const,
    id: `fixture-lookup-${index}`,
    name: 'fixture.lookup',
    arguments: JSON.stringify({ index }),
  }));
  batch.push({ ...finish, reason: 'tool_calls' });
  const child = createFixedModel([batch, [{ type: 'text_delta', text: finalBody }, finish]]);
  let childId = '',
    parentCalls = 0,
    sourceId = '',
    deliveredBody = '';
  const parent: ModelAdapter = {
    async *stream(request) {
      const last = request.messages.filter((message) => message.role === 'tool').at(-1);
      let events: ModelEvent[];
      switch (parentCalls++) {
        case 0:
          events = call('spawn_agent', {
            prompt: 'Collect the fixture candidate receipts and deliver the original report once.',
          });
          break;
        case 1:
          childId = JSON.parse(last!.content).agent_id;
          events = call('wait_agent_events', { wait_ms: 20000 });
          break;
        case 2: {
          expect(JSON.parse(last!.content).reason).toBe('events');
          const sources = await sourceResults(request, store);
          expect(sources).toHaveLength(1);
          sourceId = sources[0]!.message.sourceIds![0]!;
          const payload = sources[0]!.payload;
          deliveredBody = payload.result.content;
          expect(payload.result).toMatchObject({ outcome: 'succeeded', content: finalBody });
          const evidence = payload.result.details.evidence;
          expect(evidence).toMatchObject({
            kind: 'recorded_tool_evidence',
            sessionId: childId,
            storeId,
            coverage: 'selected_history',
            observationsOmitted: count,
            toolCallsOmitted: 0,
            observations: [],
            tools: [
              { tool: 'fixture.lookup', definitionVersion: '1', outcomes: { succeeded: count } },
            ],
          });
          expect(evidence.limitation).toContain('bounded preview');
          expect(evidence.limitation).toContain('Full original receipts remain');
          expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(32 * 1024);
          expect(await store.getRun(evidence.runId)).toMatchObject({
            sessionId: childId,
            status: 'completed',
            isActive: false,
          });
          expect(await store.getExecution(payload.origin.executionId)).toMatchObject({
            status: 'succeeded',
            childSessionId: childId,
            resultAcceptance: { sourceId },
          });
          events = [
            {
              type: 'text_delta',
              text: 'Original report received; complete receipts remain attributed fixture data.',
            },
            finish,
          ];
          break;
        }
        default:
          throw Error('unexpected_repeated_parent_delivery');
      }
      for (const event of events) yield event;
    },
  };
  let lookups = 0;
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model: parent,
    modelId: 'parent-fixed',
    modelConcurrency: 1,
    extensions: [
      createTaskExtension({
        roles: [
          {
            id: 'worker',
            configurationId: 'candidate-reader',
            description: 'Read-only fixture candidate data; no filesystem or process effect.',
          },
        ],
      }),
      {
        id: 'fixture.lookups',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.lookup',
            version: '1',
            description:
              'Return explicitly untrusted fixture candidates without accessing files or dispatching effects.',
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              required: ['index'],
              properties: { index: { type: 'integer', minimum: 0, maximum: count - 1 } },
            },
            contextDiscovery: 'read_only',
            async execute(input) {
              lookups++;
              return {
                outcome: 'succeeded',
                content: receiptFor((input as { index: number }).index),
              };
            },
          },
        ],
      },
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture-read-only' };
      },
    },
    childConfigurations: [
      {
        id: 'candidate-reader',
        version: '1',
        model: child,
        modelId: 'child-fixed',
        toolIds: ['fixture.lookup'],
        snapshot: {},
      },
    ],
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: pathToFileURL(root).href,
      name: 'fixture-only',
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 'root',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'bounded evidence',
    });
    await runtime.submitCommand({
      expectedStoreId: storeId,
      commandId: 'work',
      sessionId: 'root',
      subjectId: 'owner',
      request: {
        kind: 'run.start',
        content:
          'Collect the explicitly fictitious lookup data without inferring filesystem facts.',
      },
    });
    const completed = await runtime.waitForCommand('work', { timeoutMs: 25000 });
    expect(await store.getRun((completed.receipt as { runId: string }).runId)).toMatchObject({
      status: 'completed',
      isActive: false,
    });
    expect(parentCalls).toBe(3);
    expect(child.requests).toHaveLength(2);
    expect(lookups).toBe(count);
    expect(deliveredBody).toBe(finalBody);
    expect(sourceId).toBeString();
    const receipts = (await store.listExecutions(childId)).filter(
      (execution) => execution.definitionId === 'fixture.lookup',
    );
    expect(receipts).toHaveLength(count);
    let retainedBytes = 0;
    for (const receipt of receipts) {
      expect(receipt.status).toBe('succeeded');
      const original = (receipt.result as { content: string }).content;
      expect(original).toBe(receiptFor((receipt.input as { index: number }).index));
      expect(JSON.parse(original).observation.sources).toEqual(candidates);
      retainedBytes += Buffer.byteLength(original);
    }
    expect(retainedBytes).toBeGreaterThan(19 * 1024 * 1024);
    const actualBody = child.requests[1]!.messages.filter((message) => message.role === 'tool');
    expect(actualBody).toHaveLength(count);
    expect(
      actualBody.reduce((bytes, message) => bytes + Buffer.byteLength(message.content), 0),
    ).toBe(retainedBytes);
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

// Real SQLite / Shell Tool->Job orchestration; the Job adapter emits controlled public output,
// never starts a subprocess or makes a network request.
for (const registration of [
  'builtin',
  'same-name-extension',
  'unknown-tool-version',
  'auto-approved',
] as const)
  test(`parent Model receives only registered child Shell diagnostics (${registration}) without trusting the final report`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-child-shell-evidence-')));
    const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
    const storeId = (await store.getMetadata()).storeId;
    const commands = ['./validate.sh', 'curl -sS http://127.0.0.1:53666/service'];
    const trustedRegistration = registration === 'builtin' || registration === 'auto-approved';
    const report =
      registration === 'auto-approved'
        ? 'Unverified child claim: no approval was requested.'
        : 'Unverified child claim: everything succeeded.';
    const child = createFixedModel([
      call('shell_execute', { command: commands[0] }),
      call('shell_execute', {
        command: commands[1],
        network: 'internet',
      }),
      [{ type: 'text_delta', text: report }, finish],
    ]);
    let calls = 0,
      received = false,
      childId = '';
    const parent: ModelAdapter = {
      async *stream(request) {
        const last = request.messages.filter((message) => message.role === 'tool').at(-1);
        let events: ModelEvent[];
        switch (calls++) {
          case 0:
            events = call('spawn_agent', {
              prompt: 'Inspect the exact controlled Shell receipts and report.',
            });
            break;
          case 1:
            childId = JSON.parse(last!.content).agent_id;
            events = call('wait_agent_events', { wait_ms: 10000 });
            break;
          case 2: {
            const sources = await sourceResults(request, store);
            expect(sources).toHaveLength(1);
            const evidence = sources[0]!.payload.result.details.evidence;
            expect(evidence.shellReceipts).toHaveLength(trustedRegistration ? 2 : 0);
            expect(evidence.shellReceiptsOmitted).toBe(0);
            if (trustedRegistration) {
              const [validator, service] = evidence.shellReceipts!;
              expect(validator).toMatchObject({
                tool: 'shell.execute',
                command: { text: commands[0], truncated: false },
                requestedPermissions: null,
                job: {
                  status: 'failed',
                  exitCode: 17,
                  effectiveScope:
                    registration === 'auto-approved'
                      ? { filesystem: 'workspace_write', network: 'none' }
                      : null,
                },
                stderr: {
                  text: 'SNAPSHOT_MISSING: registered snapshot was not found\n',
                  truncated: false,
                  omitted: false,
                },
              });
              if (registration === 'auto-approved') {
                expect(validator!.authorization).toEqual({
                  tool: {
                    check: {
                      status: 'succeeded',
                      decision: 'approve_once',
                      requireApproval: false,
                    },
                  },
                  job: { policy: { reason: 'parent_review' } },
                });
                expect(sources[0]!.message.content).toContain('approve_once');
                expect(sources[0]!.message.content).toContain(
                  'reused the approval basis of its own original request',
                );
                expect(sources[0]!.message.content).not.toContain('parent_review');
              } else expect(validator!.authorization).toBeUndefined();
              expect(service).toMatchObject({
                requestedPermissions: { filesystem: 'workspace_write', network: 'internet' },
                job: { status: 'succeeded', exitCode: 0 },
                stdout: { text: 'actual-service-response\n', truncated: false, omitted: false },
              });
              for (const receipt of evidence.shellReceipts!) {
                const tool = await store.getExecution(receipt.executionId);
                const job = await store.getExecution(receipt.job.executionId);
                expect(tool).toMatchObject({
                  kind: 'tool',
                  sessionId: childId,
                  runId: evidence.runId,
                  callId: receipt.callId,
                });
                expect(job).toMatchObject({
                  kind: 'job',
                  sessionId: childId,
                  parentExecutionId: tool!.id,
                  definitionId: 'shell.command',
                });
                expect(receipt.job.status).toBe(job!.status);
              }
              expect(sources[0]!.message.content).toContain('SNAPSHOT_MISSING');
            } else expect(sources[0]!.message.content).not.toContain('SNAPSHOT_MISSING');
            expect(sources[0]!.message.content).not.toContain('private-process-token');
            expect(sources[0]!.payload.result.content).toBe(report);
            expect(evidence.reportVerification).toBe('not_verified');
            received = true;
            events = [
              {
                type: 'text_delta',
                text: 'Only qualified original receipts can substantiate the unverified child report.',
              },
              finish,
            ];
            break;
          }
          default:
            throw Error('unexpected_parent_replay');
        }
        for (const event of events) yield event;
      },
    };
    const job: JobDefinition = {
      id: 'shell.command',
      version: '1',
      description: 'Controlled public Shell receipt fixture',
      inputSchema: { type: 'object' },
      async start(input) {
        return {
          reference: {
            command: (input as { command: string }).command,
            private: 'private-process-token',
          },
        };
      },
      async *observe(handle): AsyncIterable<JobEvent> {
        const command = (handle.reference as { command: string }).command;
        if (command === commands[0]) {
          yield {
            type: 'output',
            stream: 'stderr',
            content: 'SNAPSHOT_MISSING: registered snapshot was not found\n',
          };
          yield {
            type: 'terminal',
            result: { outcome: 'failed', content: 'Shell failed', details: { exitCode: 17 } },
            supervision: 'ended',
          };
        } else {
          yield { type: 'output', stream: 'stdout', content: 'actual-service-response\n' };
          yield {
            type: 'terminal',
            result: { outcome: 'succeeded', content: 'Shell succeeded', details: { exitCode: 0 } },
            supervision: 'ended',
          };
        }
      },
      async cancel() {
        return { status: 'already_finished' };
      },
      async dispose() {},
    };
    const originalShell = createShellExtension({ job, permissionsSchema: { type: 'object' } });
    const selectedShell =
      registration === 'same-name-extension'
        ? { ...originalShell, id: 'fixture.same-name-shell' }
        : registration === 'unknown-tool-version'
          ? {
              ...originalShell,
              tools: originalShell.tools!.map((tool) => ({ ...tool, version: '2' })),
            }
          : originalShell;
    const extensions = [
      selectedShell,
      createTaskExtension({
        roles: [
          {
            id: 'worker',
            configurationId: 'shell-worker',
            description: 'Controlled receipt reader',
          },
        ],
      }),
    ];
    const policy = createPermissionPolicy({
      readPolicy: () => ({
        mode: 'auto',
        workspaceTrust: true,
        revision: 'controlled-auto',
        allowed: [
          { kind: 'model', definitionId: 'parent-fixed', definitionVersion: '1' },
          { kind: 'model', definitionId: 'child-fixed', definitionVersion: '1' },
          ...extensions
            .flatMap((extension) => extension.tools ?? [])
            .map((tool) => ({
              kind: 'tool' as const,
              definitionId: tool.id,
              definitionVersion: tool.version,
            })),
          { kind: 'job', definitionId: 'shell.command', definitionVersion: '1' },
          { kind: 'job', definitionId: 'agent/shell-worker', definitionVersion: '1' },
        ],
      }),
      describeCapability(request) {
        const shell =
          (request.kind === 'tool' || request.kind === 'job') &&
          ['shell.execute', 'shell.command'].includes(request.definitionId);
        const input = request.input as {
          command?: string;
          filesystem?: 'workspace_write' | 'full_access';
          network?: 'none' | 'internet';
          permissions?: {
            filesystem: 'workspace_write' | 'full_access';
            network: 'none' | 'internet';
          };
        };
        const scope = input.permissions ?? {
          filesystem: input.filesystem ?? 'workspace_write',
          network: input.network ?? 'none',
        };
        return {
          kind: request.kind,
          definitionId: request.definitionId,
          definitionVersion: request.definitionVersion,
          revision: 'actual-controlled-configuration',
          hardAllowed: true,
          safeRead: !shell,
          effects: shell ? ['process', 'unknown'] : [],
          ...(shell
            ? {
                autoReview: 'check' as const,
                reviewBehavior: fixtureReviewBinding(behaviors, request),
                executionScope: scope,
                autoReviewKey: hash(JSON.stringify({ command: input.command, scope })),
                commandDigest: hash(
                  JSON.stringify({
                    kind: request.kind,
                    definitionId: request.definitionId,
                    command: input.command,
                  }),
                ),
              }
            : {}),
        };
      },
    });
    const prepareRiskReview = async (request: AuthorizationRequest) => ({
      material: { command: (request.input as { command: string }).command },
      fingerprint: hash((request.input as { command: string }).command),
      reusable: false,
    });
    const behaviors =
      registration === 'auto-approved'
        ? createShellToolBehaviors({
            extensions: [selectedShell],
            snapshot: { fixture: 'controlled-child-shell', host: {} },
            commandDigest: (request) =>
              hash(
                JSON.stringify({
                  kind: request.kind,
                  definitionId: request.definitionId,
                  input: request.input,
                }),
              ),
            prepareRiskReview,
          })
        : [];
    const runtime = createRuntime({
      store,
      model: parent,
      modelId: 'parent-fixed',
      modelConcurrency: 1,
      extensions,
      toolBehaviors: behaviors,
      permissions:
        registration === 'auto-approved'
          ? policy
          : {
              async authorize() {
                return { allowed: true, revision: 'fixture' };
              },
            },
      ...(registration === 'auto-approved'
        ? {
            authorizationCheck: {
              id: 'controlled-risk',
              version: '1',
              modelId: 'review-fixed',
              timeoutMs: 5000,
              model: createFixedModel(
                Array.from({ length: 2 }, () => [
                  {
                    type: 'text_delta' as const,
                    text: '{"risk":"ordinary","reason":"Controlled ordinary fixture."}',
                  },
                  finish,
                ]),
              ),
            },
          }
        : {}),
      childConfigurations: [
        {
          id: 'shell-worker',
          version: '1',
          model: child,
          modelId: 'child-fixed',
          toolIds: ['shell.execute'],
          snapshot: {},
        },
      ],
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        rootUri: pathToFileURL(root).href,
        name: 'fixture',
      });
      await runtime.createSession({
        expectedStoreId: storeId,
        commandId: 'create',
        sessionId: 'root',
        workspaceId: 'w',
        subjectId: 'owner',
        title: 'Shell receipts',
      });
      await runtime.submitCommand({
        expectedStoreId: storeId,
        commandId: 'work',
        sessionId: 'root',
        subjectId: 'owner',
        request: {
          kind: 'run.start',
          content: 'Compare the actual child Shell results, never replay effects.',
        },
      });
      await runtime.waitForCommand('work', { timeoutMs: 25000 });
      expect(received).toBe(true);
      expect(calls).toBe(3);
      expect(child.requests).toHaveLength(3);
    } finally {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
