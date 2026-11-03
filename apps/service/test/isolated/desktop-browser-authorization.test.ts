import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { AgentRuntime } from '@kite-ai/agent';
import type {
  ExtensionRecord,
  ExtensionRecordWrite,
  Json,
  ToolContext,
} from '@kite-ai/agent/extensions';
import { createDesktopBrowserAuthorization } from '../../src/desktop-browser-authorization';

const intent = { key: 'original', url: 'https://example.test/destination' };
const releasedIdentity = { pageId: 'fixed-page', incarnation: 'fixed-incarnation' };
function fixture(
  options: {
    prepareDenial?: string;
    commitFailure?: string;
    armed?: boolean;
    existing?: boolean;
    choice?: string;
    invalidReceipt?: boolean;
    commitAckLost?: boolean;
    inspectFails?: boolean;
    cancelFails?: boolean;
    beforeAnswer?(): void;
    afterPrepare?(): void;
    nested?: boolean;
    releasedPage?(
      sessionId: string,
      url?: string,
    ): { url: string; identity?: typeof releasedIdentity } | null;
    existingUrl?: string;
    invalidateMissingReleasedPage?(sessionId: string, identity: typeof releasedIdentity): void;
  } = {},
) {
  const abort = new AbortController();
  const records = new Map<string, ExtensionRecord>();
  const calls: Record<string, unknown>[] = [];
  let questions = 0;
  let mutations = 0;
  let revision = 0;
  const interactions = new Map<string, Record<string, unknown>>();
  let proposal:
    | {
        requestId: unknown;
        state: string;
        url: unknown;
        requireExisting?: unknown;
        existingPage?: unknown;
        page: { kind: string; title: string; url: string; id?: string };
      }
    | undefined;
  let observed: Json | undefined;
  const own = {
    id: 'tool',
    kind: 'tool',
    definitionId: 'browser.open',
    definitionVersion: '1',
    sessionId: 'session',
    runId: (options.nested ? null : 'run') as string | null,
    parentExecutionId: options.nested ? 'code' : null,
    originStoreId: 'store',
    originCommandId: 'work',
    rootWorkCommandId: 'work',
    rootWorkSeq: '1',
    attempt: 1,
    status: 'running',
    authorization: { dispatched: true },
    cancelRequestedAt: null,
    input: { ...intent },
  };
  const job = {
    ...own,
    id: 'job',
    kind: 'job',
    definitionId: 'browser.session',
    parentExecutionId: 'tool',
    runId: null,
    input: { browserId: intent.key, url: intent.url },
  };
  const run = {
    id: 'run',
    isActive: true,
    sessionId: 'session',
    originStoreId: 'store',
    originCommandId: 'work',
    rootWorkCommandId: 'work',
    rootWorkSeq: '1',
    contextSelectionId: 'selection',
  };
  const runs = new Map<string, unknown>([[run.id, run]]);
  const executions = new Map<string, unknown>([
    ['tool', own],
    ['job', job],
  ]);
  if (options.nested)
    executions.set('code', {
      ...own,
      id: 'code',
      runId: 'run',
      parentExecutionId: null,
      definitionId: 'browser.execute',
      input: { code: 'await browser.open(url)' },
    });
  const commands = new Map<string, Record<string, unknown>>([
    [
      'work',
      {
        id: 'work',
        kind: 'run.start',
        originStoreId: 'store',
        subjectId: 'user',
        presentationSessionId: 'session',
        sessionId: 'session',
        rootWorkCommandId: 'work',
        rootWorkSeq: '1',
        status: 'applied',
        seq: '1',
        cancelRequestedAt: null,
      },
    ],
  ]);
  const session = {
    id: 'session',
    parentSessionId: null as string | null,
    rootSessionId: 'session',
    nextSeq: '100',
  };
  const messages: Record<string, unknown>[] = [];
  const host = {
    async getExecution(id: string) {
      return executions.get(id) ?? null;
    },
    async getRun(id: string) {
      return runs.get(id) ?? null;
    },
    async getCommand(id: string) {
      return commands.get(id) ?? null;
    },
    async getInteraction(input: { interactionId: string }) {
      return interactions.get(input.interactionId);
    },
    async getSession() {
      return session;
    },
    async beginSessionExport() {
      return {
        storeId: 'store',
        rootSessionId: 'session',
        sections: [{ section: 'commands', highWaterSeq: String(commands.size) }],
      };
    },
    async readSessionExportPage(input: {
      afterSeq: string;
      manifest: { sections: { highWaterSeq: string }[] };
    }) {
      const rows = [...commands.values()].map((command, index) => ({
        id: command.id,
        record: { kind: command.kind },
        seq: String(index + 1),
      }));
      return {
        records: rows.filter(
          (row) =>
            BigInt(row.seq) > BigInt(input.afterSeq) &&
            BigInt(row.seq) <= BigInt(input.manifest.sections[0]!.highWaterSeq),
        ),
        nextAfterSeq: null,
      };
    },
    async listMessages(_id: string, input: { afterSeq: string; upperSeq: string; limit: number }) {
      return messages
        .filter(
          (message) =>
            BigInt(String(message.seq)) > BigInt(input.afterSeq) &&
            BigInt(String(message.seq)) <= BigInt(input.upperSeq),
        )
        .slice(0, input.limit);
    },
    async readRunExtensionRecord(input: { key: string; runId: string }) {
      expect(input.runId).toBe('run');
      return records.get(input.key) ?? null;
    },
  } as unknown as AgentRuntime;
  const context = {
    sessionId: own.sessionId,
    executionId: own.id,
    runId: own.runId,
    signal: abort.signal,
    dispatchAuthorization: {
      revision: 'accepted-original-dispatch',
      snapshot: {
        namespace: 'builtin.permissions',
        version: '1',
        data: { mode: 'full', workspaceTrust: true },
      },
    },
    records: {
      async get(key: string) {
        return records.get(key) ?? null;
      },
      async list(input: { afterKey?: string; contentType?: string; limit?: number }) {
        return [...records.values()]
          .filter(
            (record) =>
              (!input.afterKey || record.key > input.afterKey) &&
              (!input.contentType || record.contentType === input.contentType),
          )
          .sort((a, b) => a.key.localeCompare(b.key))
          .slice(0, input.limit ?? 200);
      },
      async write(input: ExtensionRecordWrite) {
        abort.signal.throwIfAborted();
        expect(input.expectedRevision).toBe(records.get(input.key)?.revision ?? null);
        const record: ExtensionRecord = {
          ...input,
          extensionId: 'builtin.browser',
          sessionId: 'session',
          originStoreId: 'store',
          revision: `${++revision}`,
          value: structuredClone(input.value),
        };
        records.set(record.key, record);
        return record;
      },
    },
    async requestInteractionWithReceipt({ request }: { request: Json }) {
      questions++;
      observed = request;
      const accepted = {
        interactionId: questions === 1 ? 'question' : `question-${questions}`,
        originStoreId: own.originStoreId,
        sessionId: own.sessionId,
        runId: own.runId,
        executionId: own.id,
        attempt: own.attempt,
        decisionRevision: 'accepted',
        request,
        answer: { kind: 'question', answers: { control: options.choice ?? 'allow' } },
      };
      const interaction = {
        id: accepted.interactionId,
        subjectId: 'user',
        presentationSessionId: 'session',
        kind: 'question',
        definitionId: own.definitionId,
        definitionVersion: '1',
        originStoreId: own.originStoreId,
        sessionId: own.sessionId,
        runId: own.runId,
        executionId: own.id,
        attempt: own.attempt,
        state: 'answered',
        acceptedDecisionRevision: options.invalidReceipt ? 'forged' : 'accepted',
        request: structuredClone(request),
        answer: structuredClone(accepted.answer),
      };
      interactions.set(accepted.interactionId, interaction);
      session.nextSeq = String(BigInt(session.nextSeq) + 1n);
      commands.set(`answer-${accepted.interactionId}`, {
        id: `answer-${accepted.interactionId}`,
        kind: 'interaction.answer',
        status: 'applied',
        seq: session.nextSeq,
        originStoreId: 'store',
        sessionId: 'session',
        subjectId: 'user',
        rootWorkCommandId: own.rootWorkCommandId,
        rootWorkSeq: own.rootWorkSeq,
        cancelRequestedAt: null,
        request: {
          kind: 'interaction.answer',
          interactionId: accepted.interactionId,
          answer: accepted.answer,
        },
        receipt: {
          outcome: 'answer_saved',
          interactionId: accepted.interactionId,
          decisionRevision: accepted.decisionRevision,
          cancelled: false,
        },
      });
      options.beforeAnswer?.();
      return accepted;
    },
  } as unknown as ToolContext;
  const adapter = createDesktopBrowserAuthorization({
    runtime: () => host,
    releasedPage: options.releasedPage,
    invalidateMissingReleasedPage: options.invalidateMissingReleasedPage,
    async call(input) {
      calls.push(input);
      if (input.op === 'prepareGrant') {
        if (options.prepareDenial) throw Error(options.prepareDenial);
        if (proposal) expect(['cancelled', 'expired']).toContain(proposal.state);
        proposal = {
          requestId: input.requestId,
          state: options.armed ? 'ready' : 'question',
          url: input.url,
          ...(input.requireExisting === true ? { requireExisting: true } : {}),
          ...(input.existingPage ? { existingPage: structuredClone(input.existingPage) } : {}),
          page: options.existing
            ? {
                kind: 'existing',
                id: 'fixed-page',
                title: '账户页面',
                url: options.existingUrl ?? 'https://example.test/account',
              }
            : { kind: 'new', title: '', url: 'about:blank' },
        };
      } else if (input.op === 'commitGrant') {
        expect(input.executionId).toBe(own.id);
        expect(input.authorizationDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(input.interactionId).toBeUndefined();
        expect(input.decisionRevision).toBeUndefined();
        mutations++;
        if (options.commitFailure) {
          proposal!.state = 'expired';
          throw Error(options.commitFailure);
        }
        proposal!.state = 'committed';
        if (options.commitAckLost) throw Error('response_lost');
      } else if (input.op === 'inspectGrant') {
        if (options.inspectFails) throw Error('response_lost');
      } else if (input.op === 'cancelGrant') {
        if (options.cancelFails) throw Error('response_lost');
        proposal!.state = 'cancelled';
      } else throw Error('unexpected');
      if (input.op === 'prepareGrant') options.afterPrepare?.();
      return structuredClone(proposal);
    },
  });
  return {
    adapter,
    context,
    host,
    executions,
    runs,
    commands,
    session,
    messages,
    interactions,
    calls,
    records,
    own,
    job,
    run,
    abort,
    get questions() {
      return questions;
    },
    get mutations() {
      return mutations;
    },
    get observed() {
      return observed;
    },
    get proposal() {
      return proposal;
    },
  };
}

function nextTool(
  f: ReturnType<typeof fixture>,
  input = { key: 'another-key', url: 'https://example.test/another' },
  newWork = false,
  continuation = false,
) {
  f.executions.set(f.own.id, structuredClone(f.own));
  f.own.id = `tool-${f.executions.size}`;
  f.own.input = input;
  if (newWork || continuation) {
    f.runs.set(f.run.id, structuredClone(f.run));
    f.run.id = `${f.run.id}-next`;
    f.own.runId = f.run.id;
  }
  if (newWork) {
    f.own.rootWorkCommandId = f.run.rootWorkCommandId = 'new-work';
    f.own.rootWorkSeq = f.run.rootWorkSeq = '200';
    f.own.originCommandId = f.run.originCommandId = 'new-work';
    f.commands.set('new-work', {
      ...f.commands.get('work'),
      id: 'new-work',
      rootWorkCommandId: 'new-work',
      rootWorkSeq: '200',
      seq: '200',
    });
    f.session.nextSeq = '200';
  }
  f.executions.set(f.own.id, f.own);
  f.runs.set(f.run.id, f.run);
  return { ...f.context, executionId: f.own.id, runId: f.own.runId };
}
function humanSteer(f: ReturnType<typeof fixture>, inputKind = 'input.steer') {
  const seq = String(BigInt(f.session.nextSeq) + 1n),
    messageSeq = String(BigInt(seq) + 1n);
  const id = `steer-${seq}`,
    messageId = `message-${seq}`;
  f.commands.set(id, {
    id,
    seq,
    sessionId: 'session',
    originStoreId: 'store',
    subjectId: 'user',
    rootWorkCommandId: f.own.rootWorkCommandId,
    rootWorkSeq: f.own.rootWorkSeq,
    kind: inputKind,
    status: 'applied',
    cancelRequestedAt: null,
    request: { kind: inputKind, targetRunId: f.run.id, contextSelectionId: 'selection' },
    receipt: {
      outcome: 'input_applied',
      runId: f.run.id,
      messageId,
      contextSelectionId: 'selection',
    },
  });
  f.messages.push({
    id: messageId,
    seq: messageSeq,
    sessionId: 'session',
    runId: f.run.id,
    role: 'user',
    status: 'complete',
    inputKind,
    originCommandId: id,
    sourceIds: [id],
    contextSelectionId: 'selection',
  });
  f.session.nextSeq = messageSeq;
  return id;
}

async function seedLegacyRefusal(f: ReturnType<typeof fixture>) {
  const request = {
    schema: { type: 'object', properties: { control: { enum: ['allow', 'deny'] } } },
  };
  const accepted = await f.context.requestInteractionWithReceipt!({ kind: 'question', request });
  const work = {
    sessionId: f.own.sessionId,
    originStoreId: f.own.originStoreId,
    rootWorkCommandId: f.own.rootWorkCommandId,
    rootWorkSeq: f.own.rootWorkSeq,
    subjectId: 'user',
  };
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        work.originStoreId,
        work.sessionId,
        work.rootWorkCommandId,
        work.rootWorkSeq,
      ]),
    )
    .digest('hex');
  await f.context.records.write({
    key: `grant/refusal/${digest}`,
    expectedRevision: null,
    contentType: 'application/vnd.kite.browser-refusal+json',
    contentVersion: 1,
    executable: true,
    value: {
      ...work,
      phase: 'refused',
      executionId: f.own.id,
      runId: f.own.runId,
      attempt: f.own.attempt,
      upperSeq: f.session.nextSeq,
      boundarySessionId: 'session',
      answerCommandId: `answer-${accepted.interactionId}`,
      accepted: JSON.parse(JSON.stringify(accepted)),
    } as Json,
  });
}

for (const mode of ['full', 'auto', 'accept_edits'])
  test(`${mode} accepted original Tool dispatch binds the exact page without a second Question`, async () => {
    const f = fixture({ existing: mode === 'auto' });
    f.context.dispatchAuthorization!.snapshot!.data = { mode, workspaceTrust: true };
    expect(await f.adapter.prepareOpen(f.context, intent)).toBeUndefined();
    expect(f.questions).toBe(0);
    expect(f.mutations).toBe(1);
    expect(f.calls.map((call) => call.op)).toEqual(['prepareGrant', 'commitGrant']);
    expect(f.calls[0]).toMatchObject({
      executionId: 'tool',
      browserId: intent.key,
      url: intent.url,
      storeId: 'store',
      sessionId: 'session',
    });
    const saved = [...f.records.values()].find(
      (row) => row.contentType === 'application/vnd.kite.browser-grant+json',
    )!;
    expect(saved.value).toMatchObject({
      state: 'ready',
      executionId: 'tool',
      dispatch: {
        digest: f.calls[1]!.authorizationDigest,
        inputDigest: createHash('sha256')
          .update(JSON.stringify({ key: intent.key, url: intent.url }))
          .digest('hex'),
        revision: 'accepted-original-dispatch',
      },
    });
    expect((saved.value as { accepted?: unknown }).accepted).toBeUndefined();
    expect(await f.adapter.grantForJob({ ...f.context, executionId: 'job' }, intent.key)).toEqual({
      grantId: String(f.calls[0]!.requestId),
      grantExecutionId: 'tool',
    });
  });

test('existing manual page grant stays a no-Question fast path with original Tool and page ownership', async () => {
  const f = fixture({ armed: true });
  expect(await f.adapter.prepareOpen(f.context, intent)).toBeUndefined();
  expect(f.questions).toBe(0);
  expect(f.mutations).toBe(0);
  expect(
    await f.adapter.grantForJob({ ...f.context, executionId: 'job' }, intent.key),
  ).toBeDefined();
  f.job.parentExecutionId = 'foreign';
  await expect(
    f.adapter.grantForJob({ ...f.context, executionId: 'job' }, intent.key),
  ).rejects.toThrow('scope_invalid');
});

for (const missing of ['context', 'dispatched', 'input', 'caller', 'cancelled', 'ended'])
  test(`missing or changed ${missing} original dispatch proof makes zero Main requests`, async () => {
    const f = fixture();
    if (missing === 'context') Object.assign(f.context, { dispatchAuthorization: undefined });
    if (missing === 'dispatched') f.own.authorization.dispatched = false;
    if (missing === 'input') f.own.input = { ...intent, url: 'https://foreign.test/' };
    if (missing === 'caller') f.own.id = 'foreign-tool';
    if (missing === 'cancelled') f.own.cancelRequestedAt = Date.now() as never;
    if (missing === 'ended') f.run.isActive = false;
    expect(await f.adapter.prepareOpen(f.context, intent)).toMatchObject({ outcome: 'failed' });
    expect(f.questions).toBe(0);
    expect(f.calls).toEqual([]);
  });

for (const failure of [
  'browser_page_grant_create_failed',
  'browser_page_initialization_failed',
  'browser_page_grant_changed',
])
  test(`confirmed ${failure} preserves the original cause without a Question or permit`, async () => {
    const f = fixture({ commitFailure: failure });
    expect(await f.adapter.prepareOpen(f.context, intent)).toMatchObject({
      outcome: 'failed',
      details: { code: failure },
    });
    expect(f.calls.map((call) => call.op)).toEqual(['prepareGrant', 'commitGrant', 'cancelGrant']);
    expect(f.questions).toBe(0);
    await expect(
      f.adapter.grantForJob({ ...f.context, executionId: 'job' }, intent.key),
    ).rejects.toThrow('explicit_grant_required');
  });

test('lost commit acknowledgement only inspects the original request, with no replay or synthetic approval', async () => {
  const f = fixture({ commitAckLost: true });
  expect(await f.adapter.prepareOpen(f.context, intent)).toBeUndefined();
  expect(f.calls.map((call) => call.op)).toEqual(['prepareGrant', 'commitGrant', 'inspectGrant']);
  expect(f.mutations).toBe(1);
  expect(f.questions).toBe(0);
});

test('unobservable commit and unconfirmed cleanup stay unknown and never change intent to retry', async () => {
  for (const options of [
    { commitAckLost: true, inspectFails: true },
    { commitFailure: 'browser_page_grant_create_failed', cancelFails: true },
  ]) {
    const f = fixture(options);
    expect(await f.adapter.prepareOpen(f.context, intent)).toMatchObject({
      outcome: 'outcome_unknown',
    });
    const before = f.calls.length;
    expect(await f.adapter.prepareOpen(nextTool(f), f.own.input)).toMatchObject({
      outcome: 'outcome_unknown',
    });
    expect(f.calls).toHaveLength(before);
    expect(f.mutations).toBe(1);
    expect(f.questions).toBe(0);
  }
});

test('cancellation and an ended Run after page reservation cancel only the original proposal', async () => {
  for (const change of ['cancel', 'end']) {
    let f!: ReturnType<typeof fixture>;
    f = fixture({
      afterPrepare() {
        if (change === 'cancel') f.abort.abort();
        else f.run.isActive = false;
      },
    });
    expect(await f.adapter.prepareOpen(f.context, intent)).toMatchObject({
      outcome: change === 'cancel' ? 'cancelled' : 'failed',
    });
    expect(f.calls.map((call) => call.op)).toEqual(['prepareGrant', 'cancelGrant']);
    expect(f.mutations).toBe(0);
    expect(f.questions).toBe(0);
  }
});

test('the same accepted policy revision cannot substitute another input or Tool execution', async () => {
  const f = fixture();
  expect(await f.adapter.prepareOpen(f.context, intent)).toBeUndefined();
  const original = [...f.records.values()].find(
    (row) => row.contentType === 'application/vnd.kite.browser-grant+json',
  )!;
  const saved = original.value as { dispatch: { inputDigest: string } };
  saved.dispatch.inputDigest = '0'.repeat(64);
  await expect(
    f.adapter.grantForJob({ ...f.context, executionId: 'job' }, intent.key),
  ).rejects.toThrow('explicit_grant_required');
  expect(await f.adapter.prepareOpen(f.context, intent)).toMatchObject({
    outcome: 'failed',
    details: { code: 'browser_page_grant_intent_conflict' },
  });
});

test('page reservation cannot outlive its exact dispatch proof or raw input digest', async () => {
  for (const armed of [false, true])
    for (const change of ['authorization', 'input'] as const) {
      let f!: ReturnType<typeof fixture>;
      f = fixture({
        armed,
        afterPrepare() {
          if (change === 'authorization')
            Object.defineProperty(f.context, 'dispatchAuthorization', { value: undefined });
          // Both strings normalize to the same URL, but the original dispatched input is different.
          else f.own.input.url = 'https://example.test:443/destination';
        },
      });
      expect(await f.adapter.prepareOpen(f.context, intent)).toMatchObject({
        outcome: 'failed',
        details: { code: 'browser_page_grant_scope_changed' },
      });
      expect(f.calls.map((call) => call.op)).toEqual(['prepareGrant', 'cancelGrant']);
      expect(f.mutations).toBe(0);
      await expect(
        f.adapter.grantForJob({ ...f.context, executionId: 'job' }, intent.key),
      ).rejects.toThrow('explicit_grant_required');
    }
});

test('legacy consent and unknown records remain unchanged and cannot become fresh page grants', async () => {
  for (const legacy of ['missing-dispatch', 'asking', 'question', 'unknown'] as const) {
    const f = fixture({ nested: true });
    expect(await f.adapter.prepareOpen(f.context, intent)).toBeUndefined();
    const record = [...f.records.values()].find(
      (row) => row.contentType === 'application/vnd.kite.browser-grant+json',
    )!;
    const value = record.value as Record<string, unknown>;
    if (legacy === 'missing-dispatch') delete value.dispatch;
    if (legacy === 'asking' || legacy === 'unknown') value.state = legacy;
    if (legacy === 'question') value.question = { legacy: true };
    const before = JSON.stringify(record);
    f.calls.length = 0;
    expect(await f.adapter.prepareOpen(f.context, intent)).toMatchObject({
      outcome: legacy === 'asking' ? 'failed' : 'outcome_unknown',
    });
    expect(JSON.stringify(record)).toBe(before);
    expect(f.calls).toEqual([]);
    expect(f.questions).toBe(0);
  }
});

test('Job cannot borrow a different browser, destination, Store, parent or forked page grant', async () => {
  for (const changed of ['browser', 'destination', 'store', 'parent', 'fork']) {
    const f = fixture();
    await f.adapter.prepareOpen(f.context, intent);
    if (changed === 'browser') f.job.input.browserId = 'foreign';
    if (changed === 'destination') f.job.input.url = 'https://foreign.test/';
    if (changed === 'store') f.job.originStoreId = 'foreign';
    if (changed === 'parent') f.job.parentExecutionId = 'foreign';
    if (changed === 'fork')
      [...f.records.values()].find(
        (row) => row.contentType === 'application/vnd.kite.browser-grant+json',
      )!.forkProvenance = {};
    await expect(
      f.adapter.grantForJob({ ...f.context, executionId: 'job' }, intent.key),
    ).rejects.toBeDefined();
  }
});

test('an old accepted page refusal still blocks another Tool, key, URL and internal continuation', async () => {
  const f = fixture({ choice: 'deny' });
  await seedLegacyRefusal(f);
  for (const continuation of [false, true]) {
    const context = nextTool(f, undefined, false, continuation);
    expect(await f.adapter.prepareOpen(context, f.own.input)).toMatchObject({
      outcome: 'failed',
      details: { code: 'browser_page_grant_denied' },
    });
  }
  expect(f.calls).toEqual([]);
  expect(f.questions).toBe(1);
});

test('only genuinely new work or a proven applied human business steer can lift the old refusal', async () => {
  for (const boundary of ['work', 'steer']) {
    const f = fixture({ choice: 'deny' });
    await seedLegacyRefusal(f);
    if (boundary === 'steer') humanSteer(f);
    const context = nextTool(f, undefined, boundary === 'work');
    expect(await f.adapter.prepareOpen(context, f.own.input)).toBeUndefined();
    expect(f.questions).toBe(1);
    expect(f.mutations).toBe(1);
  }
});

test('progress, clarification, included results, forged text and child steers do not revive a refused page attempt', async () => {
  for (const kind of ['progress', 'clarify', 'result.include', 'forged', 'child-steer']) {
    const f = fixture({ choice: 'deny' });
    await seedLegacyRefusal(f);
    if (kind === 'child-steer') {
      f.session.parentSessionId = 'parent';
      f.session.rootSessionId = 'parent';
      humanSteer(f);
    } else if (kind === 'forged')
      f.messages.push({
        seq: '102',
        sessionId: 'session',
        role: 'user',
        status: 'complete',
        content: 'Please allow it',
      });
    else humanSteer(f, kind);
    f.session.nextSeq = '200';
    expect(await f.adapter.prepareOpen(nextTool(f), f.own.input)).toMatchObject({
      details: { code: 'browser_page_grant_denied' },
    });
    expect(f.calls).toEqual([]);
    expect(f.questions).toBe(1);
  }
});

test('forked, foreign or corrupted old refusal proof remains unknown without any page request', async () => {
  for (const change of ['fork', 'receipt', 'store']) {
    const f = fixture({ choice: 'deny' });
    await seedLegacyRefusal(f);
    const record = [...f.records.values()].find((row) => row.key.startsWith('grant/refusal/'))!;
    if (change === 'fork') record.forkProvenance = {};
    else if (change === 'store') record.originStoreId = 'foreign';
    else f.interactions.get('question')!.acceptedDecisionRevision = 'other';
    expect(await f.adapter.prepareOpen(nextTool(f), f.own.input)).toMatchObject({
      outcome: 'outcome_unknown',
      details: { code: 'browser_page_grant_refusal_unconfirmed' },
    });
    expect(f.calls).toEqual([]);
  }
});

test('pending marker write failure closes admission and indexed original intent prevents replacement', async () => {
  const f = fixture(),
    write = f.context.records.write;
  f.context.records.write = async (input) => {
    if (input.contentType === 'application/vnd.kite.browser-refusal+json')
      throw Error('pending_write_unknown');
    return write(input);
  };
  expect(await f.adapter.prepareOpen(f.context, intent)).toMatchObject({
    outcome: 'outcome_unknown',
  });
  expect(await f.adapter.prepareOpen(nextTool(f), f.own.input)).toMatchObject({
    outcome: 'outcome_unknown',
  });
  expect(f.calls).toEqual([]);
  expect(f.questions).toBe(0);
});

test('unrelated old grants do not consume this work evidence bound or create a duplicate Question', async () => {
  const f = fixture();
  for (let i = 0; i < 1000; i++)
    f.records.set(`grant/work/zz-unrelated/${i}`, {
      extensionId: 'builtin.browser',
      sessionId: 'session',
      originStoreId: 'store',
      key: `grant/work/zz-unrelated/${i}`,
      contentType: 'application/vnd.kite.browser-grant+json',
      contentVersion: 1,
      revision: '1',
      value: { unrelated: true },
    });
  expect(await f.adapter.prepareOpen(f.context, intent)).toBeUndefined();
  expect(f.questions).toBe(0);
  expect(f.mutations).toBe(1);
});

test('a trusted released URL binds this exact new dispatch to an existing page and survives metadata disappearance', async () => {
  let released: { url: string; identity: typeof releasedIdentity } | null = {
    url: 'https://EXAMPLE.test:443/destination',
    identity: releasedIdentity,
  };
  const f = fixture({
    releasedPage: () => released,
    existing: true,
    existingUrl: intent.url,
  });
  expect(await f.adapter.prepareOpen(f.context, intent)).toBeUndefined();
  expect(f.calls[0]).toMatchObject({
    op: 'prepareGrant',
    requireExisting: true,
    existingPage: releasedIdentity,
  });
  const saved = [...f.records.values()].find(
    (record) => record.contentType === 'application/vnd.kite.browser-grant+json',
  )!;
  expect(saved.value).toMatchObject({
    requireExisting: true,
    existingPage: releasedIdentity,
    state: 'ready',
  });
  released = null;
  expect(await f.adapter.prepareOpen(f.context, intent)).toBeUndefined();
  expect(f.calls.map((call) => call.op)).toEqual(['prepareGrant', 'commitGrant', 'inspectGrant']);
  expect(f.questions).toBe(0);
  expect(f.mutations).toBe(1);
  expect(
    await f.adapter.grantForJob({ ...f.context, executionId: f.job.id } as never, intent.key),
  ).toMatchObject({ grantExecutionId: f.own.id });
});

test('a requested earlier page keeps its own identity when a different page was released most recently', async () => {
  const lookups: { sessionId: string; url: string | undefined }[] = [];
  const earlier = { url: intent.url, identity: releasedIdentity };
  const latest = {
    url: 'https://example.test/other',
    identity: { pageId: 'other-page', incarnation: 'other-incarnation' },
  };
  const f = fixture({
    existing: true,
    existingUrl: intent.url,
    releasedPage(sessionId, url) {
      lookups.push({ sessionId, url });
      return url === earlier.url ? earlier : latest;
    },
  });
  expect(await f.adapter.prepareOpen(f.context, intent)).toBeUndefined();
  expect(lookups).toEqual([{ sessionId: 'session', url: intent.url }]);
  expect(f.calls[0]).toMatchObject({
    op: 'prepareGrant',
    requireExisting: true,
    existingPage: releasedIdentity,
  });
  expect(f.questions).toBe(0);
  expect(f.mutations).toBe(1);
});

test('ambiguous trusted retained-page metadata refuses before remote reservation without hiding its reason', async () => {
  const f = fixture({
    releasedPage() {
      throw Error('browser_page_existing_ambiguous');
    },
  });
  expect(await f.adapter.prepareOpen(f.context, intent)).toMatchObject({
    outcome: 'failed',
    details: { code: 'browser_page_existing_ambiguous' },
  });
  expect(f.calls).toEqual([]);
  expect(f.records.size).toBe(0);
  expect(f.questions).toBe(0);
  expect(f.mutations).toBe(0);
});

test('same-URL metadata without a valid private identity never guesses or gains authority on reentry', async () => {
  for (const identity of [
    undefined,
    { pageId: '', incarnation: 'i' },
    { pageId: 'p', incarnation: '' },
  ]) {
    let released = { url: intent.url, identity };
    const f = fixture({ releasedPage: () => released });
    expect(await f.adapter.prepareOpen(f.context, intent)).toMatchObject({
      outcome: 'failed',
      details: { code: 'browser_page_existing_mismatch' },
    });
    released = { url: intent.url, identity: releasedIdentity };
    expect(await f.adapter.prepareOpen(f.context, intent)).toMatchObject({
      outcome: 'failed',
      details: { code: 'browser_page_existing_mismatch' },
    });
    expect(f.calls).toEqual([]);
    expect(f.mutations).toBe(0);
    expect(f.questions).toBe(0);
  }
});

test('a legacy existing-only record may inspect its original grant but never receives a new identity', async () => {
  const f = fixture({
    releasedPage: () => ({ url: intent.url, identity: releasedIdentity }),
    existing: true,
    existingUrl: intent.url,
  });
  expect(await f.adapter.prepareOpen(f.context, intent)).toBeUndefined();
  const record = [...f.records.values()].find(
    (entry) => entry.contentType === 'application/vnd.kite.browser-grant+json',
  )!;
  delete (record.value as Record<string, Json>).existingPage;
  delete f.proposal!.existingPage;
  expect(await f.adapter.prepareOpen(f.context, intent)).toBeUndefined();
  expect(f.calls.map((call) => call.op)).toEqual(['prepareGrant', 'commitGrant', 'inspectGrant']);
  expect((f.records.get(record.key)!.value as Record<string, Json>).existingPage).toBeUndefined();
  expect(
    await f.adapter.grantForJob({ ...f.context, executionId: f.job.id } as never, intent.key),
  ).toMatchObject({ grantExecutionId: f.own.id });
});

test('an unrelated released URL leaves the original new-page intent unchanged on reentry', async () => {
  let released = { url: 'https://example.test/another' };
  const f = fixture({ releasedPage: () => released });
  expect(await f.adapter.prepareOpen(f.context, intent)).toBeUndefined();
  expect(f.calls[0]?.requireExisting).toBeUndefined();
  released = { url: intent.url };
  expect(await f.adapter.prepareOpen(f.context, intent)).toBeUndefined();
  const saved = [...f.records.values()].find(
    (record) => record.contentType === 'application/vnd.kite.browser-grant+json',
  )!;
  expect((saved.value as { requireExisting?: unknown }).requireExisting).toBeUndefined();
  expect(f.calls.map((call) => call.op)).toEqual(['prepareGrant', 'commitGrant', 'inspectGrant']);
  expect(f.mutations).toBe(1);
});

for (const drift of [
  'missing-flag',
  'false-flag',
  'new-page',
  'different-url',
  'missing-identity',
  'different-page',
  'different-incarnation',
  'extra-identity-field',
  'different-page-echo',
] as const)
  test(`an existing-only grant rejects ${drift} on inspect without preparing a replacement`, async () => {
    const f = fixture({
      releasedPage: () => ({ url: intent.url, identity: releasedIdentity }),
      existing: true,
      existingUrl: intent.url,
    });
    expect(await f.adapter.prepareOpen(f.context, intent)).toBeUndefined();
    if (drift === 'missing-flag') delete f.proposal!.requireExisting;
    if (drift === 'false-flag') f.proposal!.requireExisting = false;
    if (drift === 'missing-identity') delete f.proposal!.existingPage;
    if (drift === 'different-page')
      f.proposal!.existingPage = { ...releasedIdentity, pageId: 'other' };
    if (drift === 'different-incarnation')
      f.proposal!.existingPage = { ...releasedIdentity, incarnation: 'replacement' };
    if (drift === 'extra-identity-field')
      f.proposal!.existingPage = { ...releasedIdentity, targetId: 'outside' };
    if (drift === 'different-page-echo') f.proposal!.page.id = 'other';
    if (drift === 'new-page') f.proposal!.page.kind = 'new';
    if (drift === 'different-url') f.proposal!.page.url = 'https://example.test/changed';
    expect(await f.adapter.prepareOpen(f.context, intent)).toMatchObject({
      outcome: 'outcome_unknown',
    });
    expect(f.calls.filter((call) => call.op === 'prepareGrant')).toHaveLength(1);
    expect(f.calls.filter((call) => call.op === 'commitGrant')).toHaveLength(1);
    expect(f.questions).toBe(0);
  });

test('released metadata is not read until the exact active dispatch source is verified', async () => {
  let reads = 0;
  const f = fixture({
    releasedPage: () => {
      reads++;
      return { url: intent.url };
    },
  });
  f.run.isActive = false;
  expect(await f.adapter.prepareOpen(f.context, intent)).toMatchObject({ outcome: 'failed' });
  expect(reads).toBe(0);
  expect(f.calls).toEqual([]);
  expect(f.records.size).toBe(0);
});

test('startup recovery requires observing the exact retained page before another remote intent', async () => {
  const f = fixture({
    releasedPage: () => {
      throw Error('browser_page_recovery_required');
    },
  });
  expect(await f.adapter.prepareOpen(f.context, intent)).toMatchObject({
    outcome: 'failed',
    details: { code: 'browser_page_recovery_required' },
  });
  expect(f.calls).toEqual([]);
  expect(f.records.size).toBe(0);
  expect(f.questions).toBe(0);
});

for (const code of [
  'browser_page_existing_missing',
  'browser_page_existing_mismatch',
  'browser_page_existing_ambiguous',
]) {
  test(`${code} during prepare remains the original refusal with no replacement request`, async () => {
    const invalidated: unknown[] = [];
    const f = fixture({
      releasedPage: () => ({ url: intent.url, identity: releasedIdentity }),
      prepareDenial: code,
      invalidateMissingReleasedPage: (...args) => invalidated.push(args),
    });
    expect(await f.adapter.prepareOpen(f.context, intent)).toMatchObject({
      outcome: 'failed',
      details: { code },
    });
    expect(await f.adapter.prepareOpen(f.context, intent)).toMatchObject({
      outcome: 'failed',
      details: { code },
    });
    expect(f.calls.map((call) => call.op)).toEqual(['prepareGrant']);
    expect(f.calls[0]?.requireExisting).toBe(true);
    expect(f.mutations).toBe(0);
    expect(f.questions).toBe(0);
    expect(invalidated).toEqual(
      code === 'browser_page_existing_missing' ? [['session', releasedIdentity]] : [],
    );
  });
  if (code === 'browser_page_existing_ambiguous') continue;
  test(`${code} during commit preserves its cause after canceling the exact original intent`, async () => {
    const invalidated: unknown[] = [];
    const f = fixture({
      releasedPage: () => ({ url: intent.url, identity: releasedIdentity }),
      existing: true,
      existingUrl: intent.url,
      commitFailure: code,
      invalidateMissingReleasedPage: (...args) => invalidated.push(args),
    });
    expect(await f.adapter.prepareOpen(f.context, intent)).toMatchObject({
      outcome: 'failed',
      details: { code },
    });
    expect(f.calls.map((call) => call.op)).toEqual(['prepareGrant', 'commitGrant', 'cancelGrant']);
    expect(f.calls.every((call) => call.requestId === f.calls[0]?.requestId)).toBe(true);
    expect(f.questions).toBe(0);
    expect(invalidated).toEqual(
      code === 'browser_page_existing_missing' ? [['session', releasedIdentity]] : [],
    );
  });
}

test('missing-page metadata survives an unconfirmed intent cancellation', async () => {
  const invalidated: unknown[] = [];
  const f = fixture({
    releasedPage: () => ({ url: intent.url, identity: releasedIdentity }),
    existing: true,
    existingUrl: intent.url,
    commitFailure: 'browser_page_existing_missing',
    cancelFails: true,
    invalidateMissingReleasedPage: (...args) => invalidated.push(args),
  });
  expect(await f.adapter.prepareOpen(f.context, intent)).toMatchObject({
    outcome: 'outcome_unknown',
    details: { code: 'browser_page_grant_cancel_unconfirmed' },
  });
  expect(invalidated).toEqual([]);
  expect(f.calls.map((call) => call.op)).toEqual(['prepareGrant', 'commitGrant', 'cancelGrant']);
});
