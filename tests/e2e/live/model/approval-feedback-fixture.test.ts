import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { ExecutionRecord } from '@kite-ai/agent/storage';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import {
  createDefaultApprovalObservation,
  hasMinimalShellRiskInput,
  liveModelSelection,
  liveReasoningEffort,
  originalToolFeedbackReceived,
  partialChildFailureFeedbackReceived,
  partialChildFailurePrerequisites,
  partialValidatorInvocations,
} from './approval-feedback-fixture';

type Execution = Parameters<typeof originalToolFeedbackReceived>[0];
const job: Execution = {
  id: 'original-job',
  kind: 'job',
  definitionId: 'shell.command',
  status: 'failed',
  sessionId: 'actor',
  originStoreId: 'store',
  result: { outcome: 'failed', content: 'Shell failed', details: { exitCode: 17 } },
};
const details = {
  ref: {
    key: 'original-handle',
    executionId: job.id,
    extensionId: 'builtin.shell',
    originStoreId: 'store',
    sessionId: 'actor',
  },
  stdout: 'source-雪😀\n',
  stderr: 'INPUT_NOT_READY: prepare READY\n',
};
const tool: Execution = {
  id: 'original-tool',
  callId: 'call',
  kind: 'tool',
  definitionId: 'shell.execute',
  status: 'failed',
  sessionId: 'actor',
  originStoreId: 'store',
  result: { outcome: 'failed', content: JSON.stringify(details), details },
};
const feedback = {
  role: 'tool',
  toolCallId: 'call',
  sourceIds: [tool.id],
  content: `The command failed.\nExit code: 17.\nshell_id: "original-handle"\nstdout:\n${details.stdout}\nstderr:\n${details.stderr}`,
};

test('live reasoning effort preserves low by default and accepts explicit medium', () => {
  expect(liveReasoningEffort(undefined)).toBe('low');
  expect(liveReasoningEffort('low')).toBe('low');
  expect(liveReasoningEffort('high')).toBe('high');
  expect(liveReasoningEffort('medium')).toBe('medium');
  for (const input of ['', 'MEDIUM', 'LOW', 'high,low'])
    expect(() => liveReasoningEffort(input)).toThrow('reasoning_effort_invalid');
});

test('live model selection preserves luna by default and independently supports the terra low comparison', () => {
  expect(liveModelSelection(undefined)).toBe('gpt-6-luna');
  expect(liveModelSelection('default')).toBe('default');
  expect(liveModelSelection('gpt-6-luna')).toBe('gpt-6-luna');
  expect(liveModelSelection('gpt-6.1-terra')).toBe('gpt-6.1-terra');
  expect({ model: liveModelSelection('gpt-6-luna'), effort: liveReasoningEffort('high') }).toEqual({
    model: 'gpt-6-luna',
    effort: 'high',
  });
  expect({
    model: liveModelSelection('gpt-6.1-terra'),
    effort: liveReasoningEffort('low'),
  }).toEqual({ model: 'gpt-6.1-terra', effort: 'low' });
  for (const input of ['', 'terra', 'gpt-6.1-terra, gpt-6-luna', 'GPT-6-LUNA', 'gpt-6-astra'])
    expect(() => liveModelSelection(input)).toThrow('model_invalid');
});

test('Shell risk input requires the exact current owner projection and rejects generic policy fields', () => {
  const input = {
    purpose: 'shell_risk',
    operation: { kind: 'tool', definitionId: 'shell.execute' },
    material: { command: 'pwd', cwd: '/owned' },
  };
  expect(hasMinimalShellRiskInput(input)).toBe(true);
  for (const [field, value] of Object.entries({
    policyRevision: 'revision',
    request: {},
    requireApproval: false,
    authorizationContext: {},
    decisionContext: {},
  }))
    expect(hasMinimalShellRiskInput({ ...input, [field]: value })).toBe(false);
  expect(hasMinimalShellRiskInput({ ...input, purpose: 'authorization_check' })).toBe(false);
  expect(hasMinimalShellRiskInput({ purpose: 'shell_risk', operation: input.operation })).toBe(
    false,
  );
  expect(hasMinimalShellRiskInput(null)).toBe(false);
});

const observationRequest = (requestId: string): ModelRequest => ({
  requestId,
  modelId: 'original-model',
  messages: [],
  tools: [],
});
const adapterSnapshot = (effort: 'medium' | 'low', cap?: number) => ({
  adapterId: 'original-sdk',
  adapterVersion: '1',
  provider: {
    availability: 'available' as const,
    family: 'compatible',
    modelId: 'original-wire-model',
  },
  settings: {
    reasoningEffort: effort,
    ...(cap ? { maxOutputTokens: cap } : {}),
    maxRetries: 0,
    maxSteps: 1,
    allowSystemInMessages: true,
  },
  transformation: { id: 'original-transform', version: '1' },
});
const observation = (extra: Partial<Parameters<typeof createDefaultApprovalObservation>[0]> = {}) =>
  createDefaultApprovalObservation({
    modelId: 'original-model',
    signal: new AbortController().signal,
    metadata: {},
    ...extra,
  });

test('transparent model tap preserves distinct business and reviewer bindings, original request, signal and events', async () => {
  const tap = observation();
  const controller = new AbortController();
  const signal = controller.signal;
  const seen: { request: ModelRequest; signal: AbortSignal }[] = [];
  const event: ModelEvent = { type: 'text_delta', text: 'original 雪🙂' };
  const make = (effort: 'medium' | 'low', cap?: number): ModelAdapter => ({
    describeRequest: () => adapterSnapshot(effort, cap),
    async *stream(request, input) {
      seen.push({ request, signal: input.signal });
      yield event;
    },
  });
  const business = make('medium'),
    reviewer = make('low', 256);
  const businessTap = tap.wrap(business, 'business'),
    reviewerTap = tap.wrap(reviewer, 'reviewer');
  const first = observationRequest('business-original'),
    second = observationRequest('check-original');
  expect(businessTap.describeRequest?.(first)).toEqual(business.describeRequest?.(first));
  expect(reviewerTap.describeRequest?.(second)).toEqual(reviewer.describeRequest?.(second));
  for (const [model, request] of [
    [businessTap, first],
    [reviewerTap, second],
  ] as const)
    for await (const actual of model.stream(request, { signal })) expect(actual).toBe(event);
  expect(seen[0]?.request).toBe(first);
  expect(seen[1]?.request).toBe(second);
  expect(seen.every((entry) => entry.signal === signal)).toBe(true);
  expect(
    tap.logical.map((entry) => [
      entry.requestId,
      entry.role,
      entry.binding?.settings.reasoningEffort,
      entry.binding?.settings.maxOutputTokens,
      entry.completed,
    ]),
  ).toEqual([
    ['business-original', 'business', 'medium', undefined, true],
    ['check-original', 'reviewer', 'low', 256, true],
  ]);
  expect(tap.requests).toEqual([first, second]);
});

test('transparent wire tap forwards exact init and complete bytes with original request identity and no retries', async () => {
  const captured: Uint8Array[] = [];
  const tap = observation({ rawResponse: (_, bytes) => captured.push(bytes) });
  const signal = new AbortController().signal;
  const init = {
    method: 'POST',
    signal,
    body: JSON.stringify({
      model: 'original-wire-model',
      messages: [],
      reasoning_effort: 'low',
      max_tokens: 256,
    }),
  };
  const bytes = new TextEncoder().encode(
    'data: {"choices":[{"delta":{"content":"雪🙂"}}]}\n\ndata: [DONE]\n\n',
  );
  let calls = 0;
  const original = Object.assign(
    async (input: Parameters<typeof fetch>[0], actual?: Parameters<typeof fetch>[1]) => {
      calls++;
      expect(input).toBe('https://owned.invalid/model');
      expect(actual).toBe(init);
      let part = 0;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (part === 0) controller.enqueue(bytes.slice(0, 41));
              else if (part === 1) controller.enqueue(bytes.slice(41));
              else controller.close();
              part++;
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-type': 'text/event-stream', 'x-owned': 'preserved' } },
      );
    },
    { preconnect: fetch.preconnect },
  );
  const observed = tap.observeFetch(original);
  const model: ModelAdapter = {
    async *stream() {
      const response = await observed('https://owned.invalid/model', init);
      expect(response.headers.get('x-owned')).toBe('preserved');
      yield { type: 'text_delta', text: await response.text() };
    },
  };
  for await (const event of tap
    .wrap(model, 'reviewer')
    .stream(observationRequest('original-check'), { signal }))
    expect(event).toEqual({ type: 'text_delta', text: new TextDecoder().decode(bytes) });
  expect(calls).toBe(1);
  expect(captured).toEqual([bytes]);
  expect(tap.wireRequests).toEqual([
    {
      physicalIndex: 0,
      requestId: 'original-check',
      body: init.body,
      bytes: Buffer.byteLength(init.body),
    },
  ]);
  expect(tap.physical.attempts[0]).toMatchObject({
    requestId: 'original-check',
    eof: true,
    cancelled: false,
    failed: false,
    terminal: 'sse_done',
    bytes: bytes.length,
  });
  expect(JSON.stringify(tap.metadata)).not.toContain('owned.invalid');
});

test('transparent wire tap preserves reader cancellation and does not drain unread output', async () => {
  const tap = observation();
  const reason = new Error('original-reader-cancel');
  let reads = 0,
    cancelled: unknown;
  const original = Object.assign(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              reads++;
              controller.enqueue(new TextEncoder().encode('original chunk'));
            },
            cancel(input) {
              cancelled = input;
            },
          },
          { highWaterMark: 0 },
        ),
      ),
    { preconnect: fetch.preconnect },
  );
  const observed = tap.observeFetch(original);
  const model: ModelAdapter = {
    async *stream() {
      const response = await observed('https://owned.invalid/model', {
        method: 'POST',
        body: '{}',
      });
      const reader = response.body!.getReader();
      try {
        const item = await reader.read();
        yield { type: 'text_delta', text: new TextDecoder().decode(item.value) };
      } finally {
        await reader.cancel(reason);
      }
    },
  };
  const iterator = tap
    .wrap(model, 'business')
    .stream(observationRequest('cancel-original'), { signal: new AbortController().signal })
    [Symbol.asyncIterator]();
  expect((await iterator.next()).done).toBe(false);
  await iterator.return?.();
  expect(reads).toBe(1);
  expect(cancelled).toBe(reason);
  expect(tap.logical[0]?.completed).toBe(false);
  expect(tap.physical.attempts[0]).toMatchObject({ cancelled: true, eof: false });
});

test('transparent observation propagates original abort and transport errors without retry or replacement', async () => {
  const tap = observation();
  const controller = new AbortController();
  const error = new TypeError('original-private-error');
  let calls = 0;
  const original = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls++;
      expect(init?.signal).toBe(controller.signal);
      controller.abort(error);
      throw error;
    },
    { preconnect: fetch.preconnect },
  );
  const observed = tap.observeFetch(original);
  const model: ModelAdapter = {
    async *stream(_request, input) {
      await observed('https://owned.invalid/model', {
        method: 'POST',
        body: '{}',
        signal: input.signal,
      });
      yield { type: 'text_delta', text: 'unreachable' };
    },
  };
  const iterator = tap
    .wrap(model, 'reviewer')
    .stream(observationRequest('failed-original'), { signal: controller.signal })
    [Symbol.asyncIterator]();
  await expect(iterator.next()).rejects.toBe(error);
  expect(controller.signal.reason).toBe(error);
  expect(calls).toBe(1);
  expect(tap.attemptFailures).toEqual([
    { requestId: 'failed-original', eventCount: 0, reason: 'model_failed' },
  ]);
  expect(tap.physical.attempts[0]).toMatchObject({ failed: true, status: 0 });
});

test('logical observation leaves EOF alone and preserves the original failure if cleanup also fails', async () => {
  const tap = observation();
  let returns = 0;
  const failure = new TypeError('original-model-failure');
  const adapter = (fail: boolean): ModelAdapter => ({
    stream() {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (fail) throw failure;
              return { done: true as const, value: undefined };
            },
            async return() {
              returns++;
              throw Error('secondary-cleanup-failure');
            },
          };
        },
      };
    },
  });
  const signal = new AbortController().signal;
  const eof = tap
    .wrap(adapter(false), 'business')
    .stream(observationRequest('eof-original'), { signal })
    [Symbol.asyncIterator]();
  expect((await eof.next()).done).toBe(true);
  expect(returns).toBe(0);
  const failed = tap
    .wrap(adapter(true), 'reviewer')
    .stream(observationRequest('failure-original'), { signal })
    [Symbol.asyncIterator]();
  await expect(failed.next()).rejects.toBe(failure);
  expect(returns).toBe(1);
});

test('installed observer covers real Bun FetchSession transport and restores the original surfaces', async () => {
  const tap = observation();
  const originalFetch = globalThis.fetch,
    originalSession = Bun.FetchSession;
  let received = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      received++;
      return new Response('data: [DONE]\n\n');
    },
  });
  const restore = tap.install();
  const session = new Bun.FetchSession();
  try {
    const model: ModelAdapter = {
      async *stream(_request, input) {
        const response = await session.fetch(`http://127.0.0.1:${server.port}/`, {
          method: 'POST',
          body: '{}',
          signal: input.signal,
          proxy: false,
        });
        yield { type: 'text_delta', text: await response.text() };
      },
    };
    for await (const event of tap
      .wrap(model, 'business')
      .stream(observationRequest('session-original'), { signal: new AbortController().signal }))
      expect(event).toEqual({ type: 'text_delta', text: 'data: [DONE]\n\n' });
    expect(received).toBe(1);
    expect(tap.wireRequests.map((entry) => entry.requestId)).toEqual(['session-original']);
    expect(tap.physical.attempts[0]).toMatchObject({ requestId: 'session-original', eof: true });
  } finally {
    restore();
    session.close();
    await server.stop(true);
  }
  expect(globalThis.fetch).toBe(originalFetch);
  expect(Bun.FetchSession).toBe(originalSession);
});

function partialFixture() {
  const content = 'witness-original-雪\n';
  const row = (input: Partial<ExecutionRecord>) =>
    ({
      sessionId: 'child',
      originStoreId: 'store',
      runId: 'child-run',
      definitionVersion: '1',
      authorization: { dispatched: true },
      result: null,
      input: {},
      ...input,
    }) as ExecutionRecord;
  const write = row({
    id: 'write',
    kind: 'tool',
    definitionId: 'files.write',
    definitionVersion: '3',
    status: 'succeeded',
    input: { path: 'witness.txt', base: null, content },
    result: {
      outcome: 'succeeded',
      content: 'original write',
      details: {
        fileChange: {
          before: null,
          after: {
            hash: createHash('sha256').update(content).digest('hex'),
            size: Buffer.byteLength(content),
          },
        },
      },
    },
  });
  const tool = row({
    id: 'validator-tool',
    kind: 'tool',
    definitionId: 'shell.execute',
    status: 'failed',
  });
  const job = row({
    id: 'validator-job',
    kind: 'job',
    definitionId: 'shell.command',
    status: 'failed',
    parentExecutionId: tool.id,
    result: {
      outcome: 'failed',
      content: 'Shell failed',
      details: { exitCode: 17, processTreeStopped: true },
    },
  });
  const model = row({ id: 'next-model', kind: 'model', definitionId: 'live', status: 'running' });
  const carrier = row({
    id: 'carrier',
    kind: 'job',
    definitionId: 'agent/general',
    sessionId: 's',
    childSessionId: 'child',
    reference: { runId: 'child-run' },
    childConfiguration: {
      snapshot: { snapshot: { roleId: 'general' } },
    } as unknown as ExecutionRecord['childConfiguration'],
    status: 'running',
  });
  return {
    model,
    carrier,
    records: [write, tool, job, model],
    workspace: '/owned/workspace',
    witnessContent: content,
    expectedContent: content,
    validatorUnchanged: true,
    validatorJobs: [job.id],
    outputs: {
      [job.id]: {
        stdout: `WITNESS_READBACK:${content}`,
        stderr: 'CONTROLLED_VALIDATOR_FAILURE: witness readback completed; exit 17.\n',
      },
    },
    alreadyInjected: false,
  };
}

test('partial failure guard arms only after original native mutation and terminal validator readback in the exact business child', () => {
  const f = partialFixture();
  const before = structuredClone(f);
  expect(partialChildFailurePrerequisites(f)).toMatchObject({
    writeExecutionId: 'write',
    validatorJobId: 'validator-job',
    childSessionId: 'child',
    childRunId: 'child-run',
    nativeFileWrite: true,
  });
  for (const changed of [
    { alreadyInjected: true },
    { witnessContent: null },
    { witnessContent: 'different' },
    { validatorUnchanged: false },
    { model: { ...f.model, kind: 'tool' as const } },
    { model: { ...f.model, definitionId: 'authorization.check' } },
    { model: { ...f.model, sessionId: 's' } },
    { model: { ...f.model, runId: null } },
    { carrier: { ...f.carrier, childSessionId: 'other' } },
    { carrier: { ...f.carrier, originStoreId: 'foreign' } },
    { carrier: { ...f.carrier, reference: { runId: 'other-run' } } },
    { validatorJobs: [] },
    { validatorJobs: ['validator-job', 'validator-job'] },
    { records: [f.records[1]!, f.records[2]!, f.records[0]!, f.model] },
    { records: [{ ...f.records[0]!, status: 'outcome_unknown' as const }, ...f.records.slice(1)] },
    { records: [{ ...f.records[0]!, definitionVersion: '4' }, ...f.records.slice(1)] },
    {
      records: [
        {
          ...f.records[0]!,
          result: {
            outcome: 'succeeded',
            details: { fileChange: { before: null, after: { hash: 'wrong', size: 1 } } },
          },
        },
        ...f.records.slice(1),
      ],
    },
    { records: [...f.records, { ...f.records[0]!, id: 'duplicate-write' }] },
    {
      records: [
        f.records[0]!,
        f.records[1]!,
        { ...f.records[2]!, result: { details: { exitCode: 0, processTreeStopped: true } } },
        f.model,
      ],
    },
    {
      records: [
        f.records[0]!,
        f.records[1]!,
        { ...f.records[2]!, result: { details: { exitCode: 17, processTreeStopped: false } } },
        f.model,
      ],
    },
    {
      outputs: {
        'validator-job': {
          stdout: f.outputs['validator-job']!.stdout.trimEnd(),
          stderr: f.outputs['validator-job']!.stderr,
        },
      },
    },
    {
      outputs: {
        'validator-job': {
          stdout: f.outputs['validator-job']!.stdout,
          stderr: 'some other failure',
        },
      },
    },
  ])
    expect(partialChildFailurePrerequisites({ ...f, ...changed })).toBeNull();
  expect(f).toEqual(before);
});

test('partial failure control accepts only the current writable general role, without retired aliases', () => {
  const fixture = partialFixture();
  expect(partialChildFailurePrerequisites(fixture)).not.toBeNull();
  for (const roleId of [
    'worker',
    'code',
    'plan',
    'review',
    'explore',
    'GENERAL',
    null,
    undefined,
  ]) {
    const carrier = {
      ...fixture.carrier,
      childConfiguration: {
        snapshot: { snapshot: { roleId } },
      } as unknown as ExecutionRecord['childConfiguration'],
    };
    expect(partialChildFailurePrerequisites({ ...fixture, carrier })).toBeNull();
  }
});

test('literal validator detection excludes path mentions and counts repeated original invocations', () => {
  expect(partialValidatorInvocations([['./partial-validator.sh']], '/owned/workspace')).toBe(1);
  expect(
    partialValidatorInvocations([['/bin/sh', 'partial-validator.sh']], '/owned/workspace'),
  ).toBe(1);
  expect(partialValidatorInvocations([['echo', 'partial-validator.sh']], '/owned/workspace')).toBe(
    0,
  );
  expect(
    partialValidatorInvocations([['sh', '-c', './partial-validator.sh']], '/owned/workspace'),
  ).toBe(0);
  expect(
    partialValidatorInvocations(
      [['sh', 'partial-validator.sh'], ['./partial-validator.sh']],
      '/owned/workspace',
    ),
  ).toBe(2);
  expect(partialValidatorInvocations(undefined, '/owned/workspace')).toBe(0);
  expect(partialValidatorInvocations(null, '/owned/workspace')).toBe(0);
});

test('nonliteral Shell effects need an independent exact original review and cannot borrow another child Run', () => {
  const f = partialFixture();
  const records = f.records.slice(1);
  const review = {
    writeExecutionId: 'validator-job',
    reason: 'Original command writes once before the unchanged validator reads it.',
  };
  expect(partialChildFailurePrerequisites({ ...f, records })).toBeNull();
  expect(
    partialChildFailurePrerequisites({ ...f, records, shellWriteReview: review }),
  ).toMatchObject({ nativeFileWrite: false, writeExecutionId: 'validator-job' });
  for (const shellWriteReview of [
    { ...review, reason: '' },
    { ...review, writeExecutionId: 'not-original' },
  ])
    expect(partialChildFailurePrerequisites({ ...f, records, shellWriteReview })).toBeNull();
  const wrongRun = [{ ...records[0]!, runId: 'another-child-run' }, ...records.slice(1)];
  expect(
    partialChildFailurePrerequisites({ ...f, records: wrongRun, shellWriteReview: review }),
  ).toBeNull();
  const foreign = [{ ...records[0]!, sessionId: 'other-child' }, ...records.slice(1)];
  expect(
    partialChildFailurePrerequisites({ ...f, records: foreign, shellWriteReview: review }),
  ).toBeNull();
});

function partialSourceFixture(
  stdout = 'WITNESS_READBACK:雪🪁\r\n{"metadata":{"dispatch":"原值"}}\n',
  stderr = 'validator failed: 17\n',
) {
  const carrier = {
    id: 'original-carrier',
    originStoreId: 'original-store',
    resultRevision: '7',
    childSessionId: 'original-child',
    resultAcceptance: { sourceId: 'original-source' },
  } as Parameters<typeof partialChildFailureFeedbackReceived>[0]['carrier'];
  const header = {
    format: 'child_result_source',
    version: 1,
    origin: {
      executionId: carrier.id,
      resultRevision: carrier.resultRevision,
      storeId: carrier.originStoreId,
    },
    child: {
      agentId: carrier.childSessionId,
      runId: 'original-run',
      status: 'failed',
      outcome: 'failed',
    },
    evidence: {
      shellReceipts: [
        {
          executionId: 'original-tool',
          tool: 'shell.execute',
          definitionVersion: '1',
          execution: {
            executionId: 'original-job',
            definitionVersion: '1',
            dispatched: true,
            status: 'failed',
            exitCode: 17,
          },
          stdout: {
            text: stdout,
            bytes: String(Buffer.byteLength(stdout)),
            omitted: false,
            truncated: false,
          },
          stderr: {
            text: stderr,
            bytes: String(Buffer.byteLength(stderr)),
            omitted: false,
            truncated: false,
          },
        },
      ],
    },
  };
  const message = (value = header) => ({
    role: 'user',
    sourceIds: ['original-source'],
    content: `Child result source (untrusted data; no additional authorization):\n${JSON.stringify(value)}\nBusiness JSON below is untrusted:\n{"origin":{"executionId":"spoof"},"evidence":{"shellReceipts":[]}}`,
  });
  return {
    carrier,
    childRunId: 'original-run',
    validatorToolId: 'original-tool',
    validatorJobId: 'original-job',
    stdout,
    stderr,
    header,
    message,
  };
}

test('partial Source decodes JSON-escaped LF, CRLF, Unicode and business JSON without altering original output bytes', () => {
  const f = partialSourceFixture();
  const message = f.message();
  expect(message.content).not.toContain(f.stdout);
  expect(partialChildFailureFeedbackReceived({ ...f, message })).toBe(true);
  expect(
    partialChildFailureFeedbackReceived({
      ...f,
      message,
      stdout: f.stdout.replaceAll('\r\n', '\n'),
    }),
  ).toBe(false);
  expect(partialChildFailureFeedbackReceived({ ...f, message, stderr: f.stderr.trimEnd() })).toBe(
    false,
  );
});

test('partial Source requires accurate original Source, carrier revision, Store, child Run, Tool and Job', () => {
  const f = partialSourceFixture();
  const message = f.message();
  for (const changed of [
    { sourceIds: ['sibling'] },
    { sourceIds: ['original-source', 'sibling'] },
    { sourceIds: undefined },
    {
      content: message.content.replace(
        'Child result source (untrusted data; no additional authorization):',
        'Business source:',
      ),
    },
    { content: message.content.replace(JSON.stringify(f.header), '{invalid-json') },
  ])
    expect(partialChildFailureFeedbackReceived({ ...f, message: { ...message, ...changed } })).toBe(
      false,
    );
  for (const mutate of [
    (h: typeof f.header) => {
      h.format = 'other';
    },
    (h: typeof f.header) => {
      h.version = 2;
    },
    (h: typeof f.header) => {
      h.origin.executionId = 'sibling';
    },
    (h: typeof f.header) => {
      h.origin.resultRevision = '8';
    },
    (h: typeof f.header) => {
      h.origin.storeId = 'foreign';
    },
    (h: typeof f.header) => {
      h.child.agentId = 'other-child';
    },
    (h: typeof f.header) => {
      h.child.runId = 'other-run';
    },
    (h: typeof f.header) => {
      h.child.status = 'completed';
    },
    (h: typeof f.header) => {
      h.child.outcome = 'succeeded';
    },
    (h: typeof f.header) => {
      h.evidence.shellReceipts[0]!.executionId = 'sibling-tool';
    },
    (h: typeof f.header) => {
      h.evidence.shellReceipts[0]!.execution.executionId = 'sibling-job';
    },
    (h: typeof f.header) => {
      h.evidence.shellReceipts[0]!.tool = 'other-shell';
    },
    (h: typeof f.header) => {
      h.evidence.shellReceipts[0]!.definitionVersion = '2';
    },
    (h: typeof f.header) => {
      h.evidence.shellReceipts[0]!.execution.definitionVersion = '2';
    },
    (h: typeof f.header) => {
      h.evidence.shellReceipts[0]!.execution.status = 'succeeded';
    },
    (h: typeof f.header) => {
      h.evidence.shellReceipts[0]!.execution.exitCode = 0;
    },
    (h: typeof f.header) => {
      h.evidence.shellReceipts[0]!.execution.dispatched = false;
    },
  ]) {
    const h = structuredClone(f.header);
    mutate(h);
    expect(partialChildFailureFeedbackReceived({ ...f, message: f.message(h) })).toBe(false);
  }
});

test('partial Source rejects missing, duplicate, truncated, omitted or byte-drifting receipts even with matching business text', () => {
  const f = partialSourceFixture();
  for (const mutate of [
    (h: typeof f.header) => {
      h.evidence.shellReceipts = [];
    },
    (h: typeof f.header) => {
      h.evidence.shellReceipts.push(structuredClone(h.evidence.shellReceipts[0]!));
    },
    ...(['stdout', 'stderr'] as const).flatMap((stream) => [
      (h: typeof f.header) => {
        h.evidence.shellReceipts[0]![stream].text += '\n';
      },
      (h: typeof f.header) => {
        h.evidence.shellReceipts[0]![stream].bytes = '0';
      },
      (h: typeof f.header) => {
        h.evidence.shellReceipts[0]![stream].omitted = true;
      },
      (h: typeof f.header) => {
        h.evidence.shellReceipts[0]![stream].truncated = true;
      },
    ]),
  ]) {
    const h = structuredClone(f.header);
    mutate(h);
    expect(
      partialChildFailureFeedbackReceived({
        ...f,
        message: {
          ...f.message(h),
          content: `${f.message(h).content}\n${f.stdout}\n${f.stderr}\n${JSON.stringify(f.header)}`,
        },
      }),
    ).toBe(false);
  }
});

test('public Shell cause with exact original source, handle, exit code and unchanged bytes replaces an internal receipt JSON requirement', () => {
  expect(feedback.content).not.toContain(String((tool.result as { content: string }).content));
  expect(originalToolFeedbackReceived(tool, feedback, [tool, job])).toBe(true);
  for (const altered of [
    { ...feedback, sourceIds: ['sibling'] },
    { ...feedback, sourceIds: [tool.id, 'sibling'] },
    { ...feedback, toolCallId: 'other' },
    { ...feedback, role: 'assistant' },
    { ...feedback, content: feedback.content.replace('original-handle', 'invented') },
    { ...feedback, content: feedback.content.replace('Exit code: 17.', 'Exit code: 0.') },
    { ...feedback, content: feedback.content.replace('雪😀', '雪') },
    {
      ...feedback,
      content: feedback.content.replace('INPUT_NOT_READY: prepare READY', 'INPUT_NOT_READY'),
    },
  ])
    expect(originalToolFeedbackReceived(tool, altered, [tool, job])).toBe(false);
  expect(originalToolFeedbackReceived(tool, feedback, [tool])).toBe(false);
  expect(originalToolFeedbackReceived(tool, feedback, [tool, { ...job, sessionId: 'other' }])).toBe(
    false,
  );
});

test('a timed-out original command retains its public deadline cause and accurate terminal outcome', () => {
  const timeout = {
    ...tool,
    result: { ...(tool.result as object), details: { ...details, timedOut: true } },
  };
  const cancelled = {
    ...job,
    status: 'cancelled' as const,
    result: { outcome: 'cancelled', content: 'cancelled' },
  };
  const receipt = {
    ...feedback,
    content: feedback.content.replace(
      'The command failed.',
      'The command exceeded its execution deadline and cancellation was requested.',
    ),
  };
  expect(originalToolFeedbackReceived(timeout, receipt, [cancelled])).toBe(true);
  expect(originalToolFeedbackReceived(timeout, feedback, [cancelled])).toBe(false);
});

test('original nested user refusal is verified from its public command explanation rather than approval_denied JSON', () => {
  const denied = {
    ...job,
    result: { outcome: 'failed', content: 'approval_denied' },
    authorization: { human: { decision: 'deny' } },
  } as Execution;
  const receipt = {
    ...feedback,
    content: feedback.content.replace(
      'The command failed.',
      'The user denied this command. It was not executed.',
    ),
  };
  expect(receipt.content).not.toContain('approval_denied');
  expect(originalToolFeedbackReceived(tool, receipt, [denied])).toBe(true);
  expect(originalToolFeedbackReceived(tool, feedback, [denied])).toBe(false);
});

test('unknown effects and original gate refusals require their distinct English cause', () => {
  expect(
    originalToolFeedbackReceived(
      { ...tool, status: 'outcome_unknown' },
      {
        ...feedback,
        content: `${feedback.content}\nOutcome unknown. The operation may have produced effects.`,
      },
      [job],
    ),
  ).toBe(true);
  expect(
    originalToolFeedbackReceived({ ...tool, status: 'outcome_unknown' }, feedback, [job]),
  ).toBe(false);
  const generic = {
    ...tool,
    definitionId: 'files.write',
    result: {
      outcome: 'failed',
      content: 'permission_denied',
      details: { reason: 'file_full_access_required' },
    },
  };
  const scope = {
    ...feedback,
    content:
      'Writing outside the workspace through this file tool requires Full mode. This request did not change the file; this is not a user rejection of the task.',
  };
  expect(originalToolFeedbackReceived(generic, scope, [])).toBe(true);
  expect(originalToolFeedbackReceived({ ...generic, status: 'outcome_unknown' }, scope, [])).toBe(
    false,
  );
  expect(
    originalToolFeedbackReceived(
      { ...generic, status: 'outcome_unknown' },
      { ...scope, content: 'Outcome unknown. Verify the original operation.' },
      [],
    ),
  ).toBe(true);
  const rejected = {
    ...generic,
    authorization: { check: { decision: 'reject', reason: 'exact review refusal' } },
  } as Execution;
  expect(
    originalToolFeedbackReceived(
      rejected,
      {
        ...scope,
        content: 'Automatic approval rejected this request. Review reason: exact review refusal',
      },
      [],
    ),
  ).toBe(true);
  expect(originalToolFeedbackReceived(rejected, scope, [])).toBe(false);
});

test('normal missing-file results and structured public Task errors do not require machine envelopes', () => {
  const missing = {
    ...tool,
    definitionId: 'files.read',
    status: 'succeeded',
    result: {
      outcome: 'succeeded',
      content: 'File does not exist: "missing.txt".',
      details: { path: 'missing.txt', exists: false },
    },
  } as Execution;
  expect(
    originalToolFeedbackReceived(
      missing,
      { ...feedback, content: 'File does not exist: "missing.txt".' },
      [],
    ),
  ).toBe(true);
  expect(originalToolFeedbackReceived(missing, { ...feedback, content: 'Read 0 lines.' }, [])).toBe(
    false,
  );
  const task = {
    ...tool,
    definitionId: 'task.follow_up',
    result: {
      outcome: 'failed',
      content: '{"accepted":false,"error":{"message":"The Agent request has invalid arguments."}}',
      details: { error: { message: 'The Agent request has invalid arguments.' } },
    },
  };
  expect(
    originalToolFeedbackReceived(
      task,
      {
        ...feedback,
        content: 'This Agent request was not accepted. The Agent request has invalid arguments.',
      },
      [],
    ),
  ).toBe(true);
});
