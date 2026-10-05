import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { artifactPath } from '../../../src/artifacts-files';
import type { ContextCompressor } from '../../../src/context';
import type { Extension } from '../../../src/extensions';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 3, outputTokens: 2 },
};
function gate() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
}
async function bounded<T>(value: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('compression_fixture_timeout')), 6000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function fixture(
  options: {
    automatic?: boolean;
    fault?: 'provider' | 'commit' | 'cancel' | 'append' | 'source' | 'tool_reply';
    large?: boolean;
    conflict?: boolean;
    resetSafe?: boolean;
    denyCompression?: boolean;
    step?: boolean;
    changeStepOnReset?: boolean;
    skipGovernance?: boolean;
    refreshAfterAutoFailure?: boolean;
    instructions?: string;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-compression-'))),
    profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId;
  const requests: ModelRequest[] = [],
    order: string[] = [];
  const entered = gate(),
    held = gate();
  let completed = 0,
    memoryVersion = 1,
    capabilityVersion = 1,
    rejectSummary = false,
    automaticFailed = false;
  const summary = options.large
    ? `exact-summary-${'x'.repeat(17 * 1024 * 1024)}`
    : 'actual summary of original range';
  const compressor: ContextCompressor = {
    id: 'fixture.compressor',
    version: '1',
    async validateSummary(input) {
      expect(input.summary === summary).toBe(true);
      return !rejectSummary;
    },
    async validateExpanded(input) {
      if (options.changeStepOnReset) capabilityVersion++;
      return (
        options.resetSafe !== false &&
        input.messages.some((message) => message.content === 'actual original answer')
      );
    },
    async prepare(input) {
      order.push('compression');
      expect(input.messages.length).toBeGreaterThan(0);
      expect(input.sources.map((s) => s.id)).toContain('fixture:memory');
      return {
        instructions: options.instructions ?? 'SUMMARIZE EXACT INPUT; no tool calls',
        snapshot: {
          algorithm: 'fixture',
          ordering: ['contributions', 'compression', 'completion'],
        },
      };
    },
    ...(options.automatic
      ? {
          async shouldCompress(input) {
            return (
              input.messages.some((m) => m.content === 'new auto work') &&
              !input.messages.some((m) => m.sourceIds?.some((id) => id.startsWith('compression-')))
            );
          },
        }
      : {}),
  };
  const extension: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    context: {
      async capture() {
        order.push('memory');
        return [
          {
            id: 'fixture:memory',
            kind: 'record',
            scope: 'session',
            digest: `actual-${memoryVersion}`,
            content: `trusted namespace readonly contribution ${memoryVersion}`,
            role: 'user',
          },
        ];
      },
    },
    records: [
      { contentType: 'fixture.requirement', contentVersion: 1, schema: { type: 'object' } },
    ],
    completionGovernance: {
      async prepare() {
        order.push('completion');
        completed++;
        return {
          kind: 'continue' as const,
          key: 'actual-next-check',
          content: 'Confirm the actual completion after compression',
        };
      },
    },
    ...(options.conflict ? { compression: compressor } : {}),
  };
  const modelAdapter: ModelAdapter = {
    async *stream(request, { signal }) {
      requests.push(structuredClone(request));
      if (request.messages.some((message) => message.content.includes('SUMMARIZE EXACT INPUT'))) {
        if (options.fault === 'cancel')
          yield { type: 'text_delta', text: 'actual incomplete summary' };
        entered.release();
        if (options.fault === 'cancel' || options.fault === 'append' || options.fault === 'source')
          await Promise.race([
            held.waiting,
            new Promise<never>((_, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
              if (signal.aborted) reject(signal.reason);
            }),
          ]);
        if (options.fault === 'provider') {
          automaticFailed = true;
          throw new Error('actual fixed Provider failure');
        }
        if (options.fault === 'tool_reply') {
          yield {
            type: 'tool_call',
            id: 'forbidden-summary-call',
            name: 'fixture.no-such-tool',
            arguments: '{}',
          };
          yield { ...finish, reason: 'tool_calls' };
          return;
        }
        yield { type: 'text_delta', text: summary };
        yield finish;
      } else {
        yield { type: 'text_delta', text: 'actual original answer' };
        yield finish;
      }
    },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    ...(options.automatic && !options.skipGovernance
      ? {
          async initializeRunRequirements(input) {
            if ((input.command.request as { content?: string }).content !== 'new auto work')
              return [];
            const ctx = await input.forExtension('fixture'),
              key = `run/${input.run.id}/completion`;
            await ctx.records.create({
              key,
              contentType: 'fixture.requirement',
              contentVersion: 1,
              value: { required: true },
            });
            return [
              {
                extensionId: 'fixture',
                sessionId: input.session.id,
                runId: input.run.id,
                requirementId: 'completion',
                definitionVersion: '1',
                recordKey: key,
                revision: '1',
                phase: 'completion' as const,
              },
            ];
          },
          conditions: {
            async evaluate(refs, _phase, context) {
              return Promise.all(
                refs.map(async (ref) => {
                  const scoped = await context!.forRequirement(ref),
                    record = await scoped.records.get(ref.recordKey);
                  const executions = await store.listExecutions(ref.sessionId, 200);
                  return {
                    requirement: ref,
                    recordRevision: record!.revision,
                    outcome: executions.some(
                      (execution) =>
                        execution.runId === ref.runId &&
                        execution.kind === 'model' &&
                        execution.status === 'succeeded' &&
                        JSON.stringify(execution.input).includes('completion_diagnostic'),
                    )
                      ? ('satisfied' as const)
                      : ('unsatisfied' as const),
                    evidence: { actualRun: ref.runId },
                  };
                }),
              );
            },
          },
        }
      : {}),
    modelId: 'fixed',
    ...(options.step
      ? {
          async resolveRunConfiguration() {
            return {
              modelId: 'fixed',
              model: modelAdapter,
              snapshot: { actual: 'step fixture' },
              readStepCapabilities: async () => ({
                extensions: [],
                toolIds: [],
                snapshot: { actualCacheVersion: capabilityVersion },
              }),
            };
          },
        }
      : {}),
    compressor,
    extensions: [extension],
    model: modelAdapter,
    permissions: {
      async authorize(request) {
        if (
          options.refreshAfterAutoFailure &&
          automaticFailed &&
          capabilityVersion === 1 &&
          !JSON.stringify(request.input).includes('SUMMARIZE EXACT INPUT')
        )
          capabilityVersion++;
        if (
          options.denyCompression &&
          JSON.stringify(request.input).includes('SUMMARIZE EXACT INPUT')
        )
          return { allowed: false, revision: '1', reason: 'actual policy denial' };
        return { allowed: true, revision: '1' };
      },
    },
  });
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'w',
    rootUri: `file://${root}`,
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    sessionId: 's',
    subjectId: 'owner',
    commandId: 'create',
    workspaceId: 'w',
    title: 'source',
  });
  const base = { expectedStoreId: storeId, sessionId: 's', subjectId: 'owner' };
  return {
    root,
    profile,
    store,
    storeId,
    runtime,
    base,
    requests,
    order,
    entered,
    held,
    summary,
    rejectNextSummary() {
      rejectSummary = true;
    },
    mutateMemory() {
      memoryVersion++;
    },
    get completed() {
      return completed;
    },
    async work(commandId: string, content: string) {
      await runtime.submitCommand({ ...base, commandId, request: { kind: 'run.start', content } });
      return runtime.waitForCommand(commandId, { timeoutMs: 15000 });
    },
    async close() {
      held.release();
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('accepted follow-up between summary completion and publication does not change compression input', async () => {
  const f = await fixture();
  try {
    await f.work('original', 'original work');
    const selection = (await f.store.getView('s')).session.contextSelectionId;
    const originalCommit = f.store.commitCompression.bind(f.store);
    let intercepted = false;
    f.store.commitCompression = async (input) => {
      if (!intercepted) {
        intercepted = true;
        const before = await f.store.getView('s');
        expect(
          before.executions.find((e) => e.id === input.compressionId.slice('compression-'.length))
            ?.status,
        ).toBe('succeeded');
        await f.runtime.submitCommand({
          ...f.base,
          commandId: 'queued-after-summary',
          request: {
            kind: 'input.follow_up',
            content: 'queued after maintenance',
            afterRunId: input.runId,
            contextSelectionId: selection,
          },
        });
        const queued = await f.store.getCommand('queued-after-summary');
        expect(queued?.status).toBe('accepted');
        expect((await f.store.getView('s')).messages).toEqual(before.messages);
      }
      return originalCommit(input);
    };
    await f.runtime.compressContext({
      ...f.base,
      commandId: 'compact',
      expectedContextSelectionId: selection,
    });
    await f.runtime.waitForCommand('compact', { timeoutMs: 10000 });
    const run = (await f.store.getView('s')).runs.find((r) => r.originCommandId === 'compact');
    expect(run?.status).toBe('completed');
    expect(intercepted).toBe(true);
    expect(
      (await f.store.getSelectedContext({ expectedStoreId: f.storeId, sessionId: 's' }))
        .compression,
    ).toBeDefined();
    await f.runtime.waitForCommand('queued-after-summary', { timeoutMs: 10000 });
    expect(
      (await f.store.getView('s')).runs.find((r) => r.originCommandId === 'queued-after-summary')
        ?.status,
    ).toBe('completed');
    expect(f.requests).toHaveLength(3);
    expect(
      f.requests[2]?.messages.some(
        (m) => typeof m.content === 'string' && m.content.includes(f.summary),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

for (const addition of ['message', 'result_ref'] as const)
  test(`compression final SQL rejects actual ${addition} added after summary completion`, async () => {
    const f = await fixture();
    const physical = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    try {
      await f.work('original', 'original work');
      const selection = (await f.store.getView('s')).session.contextSelectionId;
      const originalCommit = f.store.commitCompression.bind(f.store);
      f.store.commitCompression = async (input) => {
        // An independent SQLite writer commits after Runtime freshness checks,
        // exercising the final publication transaction rather than an earlier guard.
        physical.transaction(() => {
          physical.run("UPDATE session SET next_seq=next_seq+1 WHERE id='s'");
          if (addition === 'message') {
            physical.run(
              "INSERT INTO message(id,session_id,run_id,seq,role,status,source_json) SELECT 'late-message',id,NULL,next_seq,'user','complete',? FROM session WHERE id='s'",
              [JSON.stringify({ content: 'actual late input', sourceIds: ['late-input'] })],
            );
            physical.run("INSERT INTO message_part VALUES('late-message',0,'text',1,0,?)", [
              JSON.stringify({ content: 'actual late input' }),
            ]);
          } else {
            physical.run(
              "INSERT INTO context_snapshot(id,session_id,selection_id,seq,sources_json,request_json,kind) SELECT 'late-result',id,context_selection_id,next_seq,'[]',?, 'result_ref' FROM session WHERE id='s'",
              [JSON.stringify({ pendingInput: false })],
            );
          }
        })();
        return originalCommit(input);
      };
      await f.runtime.compressContext({
        ...f.base,
        commandId: 'compact',
        expectedContextSelectionId: selection,
      });
      await f.runtime.waitForCommand('compact', { timeoutMs: 10000 });
      const run = (await f.store.getView('s')).runs.find((r) => r.originCommandId === 'compact');
      expect(run?.status).toBe('failed');
      expect(run?.reason).toBe('compression_context_changed');
      expect(
        physical.query("SELECT count(*) n FROM context_snapshot WHERE kind='compression'").get(),
      ).toEqual({ n: 0 });
      expect(f.requests).toHaveLength(2);
    } finally {
      physical.close();
      await f.close();
    }
  });

test('manual compression has recorded Model/usage and exact immutable coverage, new explicit work receives summary without old history or replay', async () => {
  const f = await fixture();
  try {
    await f.work('original', 'original work');
    const before = await f.store.getView('s'),
      selection = before.session.contextSelectionId;
    const command = await f.runtime.compressContext({
      ...f.base,
      commandId: 'compact',
      expectedContextSelectionId: selection,
      focus: 'retain facts',
    });
    expect(command.status).toBe('accepted');
    await f.runtime.waitForCommand('compact', { timeoutMs: 10000 });
    const page = await f.store.getSelectedContext({ expectedStoreId: f.storeId, sessionId: 's' });
    expect(page.compression).toBeDefined();
    expect(page.selection.id).toBe(selection);
    expect(page.compression!.coveredThroughSeq).toBe(command.seq);
    expect(page.messages).toHaveLength(0);
    const view = await f.store.getView('s');
    expect(view.messages.length).toBeGreaterThan(before.messages.length);
    const compression = view.executions.find((e) => e.id === page.compression!.modelExecutionId)!;
    expect(compression.status).toBe('succeeded');
    expect(compression.kind).toBe('model');
    expect(compression.result).toMatchObject({
      content: f.summary,
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect((compression.input as { tools: unknown[] }).tools).toHaveLength(0);
    const water = (await f.store.getMetadata()).lastChangeCursor;
    await f.runtime.compressContext({
      ...f.base,
      commandId: 'compact',
      expectedContextSelectionId: selection,
      focus: 'retain facts',
    });
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(water);
    expect(f.requests).toHaveLength(2);
    await f.work('next', 'new explicit work');
    const actual = f.requests[2]!;
    expect(actual.messages.some((m) => m.content === 'original work')).toBe(false);
    expect(actual.messages.filter((m) => m.sourceIds?.includes(page.compression!.id))).toHaveLength(
      1,
    );
    expect(
      actual.messages.find((m) => m.sourceIds?.includes(page.compression!.id))!.content,
    ).toContain(f.summary);
    expect(actual.messages.find((m) => m.sourceIds?.includes(page.compression!.id))!.role).toBe(
      'user',
    );
    await f.runtime.forkSession({
      expectedStoreId: f.storeId,
      sourceSessionId: 's',
      subjectId: 'owner',
      commandId: 'fork',
      newSessionId: 'fork',
      title: 'summary fork',
      expectedContextSelectionId: selection,
    });
    await f.runtime.submitCommand({
      ...f.base,
      sessionId: 'fork',
      commandId: 'fork-work',
      request: { kind: 'run.start', content: 'fork new work' },
    });
    await f.runtime.waitForCommand('fork-work', { timeoutMs: 10000 });
    expect(f.requests[3]!.messages.some((m) => m.content.includes(f.summary))).toBe(true);
    expect(f.requests[3]!.messages.some((m) => m.content === 'original work')).toBe(false);
    const first = before.messages[0]!;
    const rewind = await f.runtime.selectContext({
      ...f.base,
      commandId: 'rewind',
      expectedContextSelectionId: selection,
      boundary: { messageId: first.id, seq: first.seq },
    });
    const rewound = await f.store.getSelectedContext({
      expectedStoreId: f.storeId,
      sessionId: 's',
    });
    expect(rewound.selection.id).toBe(rewind.selection.id);
    expect(rewound.compression).toBeUndefined();
    expect(rewound.messages.map((m) => m.content)).toEqual(['original work']);
  } finally {
    await f.close();
  }
});
for (const fault of ['provider', 'commit', 'cancel', 'append', 'source'] as const)
  test(`compression ${fault} keeps old selected context without partial effective summary`, async () => {
    const f = await fixture({ fault });
    let physical: Database | undefined;
    try {
      await f.work('original', 'original work');
      const before = await f.store.getSelectedContext({
          expectedStoreId: f.storeId,
          sessionId: 's',
        }),
        selection = before.selection.id;
      if (fault === 'commit') {
        physical = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
        physical.run(
          "CREATE TRIGGER fail_compression BEFORE UPDATE OF kind ON context_snapshot WHEN NEW.kind='compression' BEGIN SELECT RAISE(ABORT,'commit failure'); END",
        );
      }
      await f.runtime.compressContext({
        ...f.base,
        commandId: 'compact',
        expectedContextSelectionId: selection,
      });
      await bounded(f.entered.waiting);
      if (fault === 'cancel')
        await f.runtime.cancelCommand({
          ...f.base,
          commandId: 'cancel',
          targetCommandId: 'compact',
        });
      if (fault === 'append') {
        const run = (await f.store.getView('s')).runs.find((r) => r.originCommandId === 'compact')!;
        await f.runtime.submitCommand({
          ...f.base,
          commandId: 'steer',
          request: {
            kind: 'input.steer',
            contextSelectionId: selection,
            targetRunId: run.id,
            content: 'new admitted input',
          },
        });
      }
      if (fault === 'source') f.mutateMemory();
      f.held.release();
      await f.runtime.waitForCommand('compact', { timeoutMs: 10000 });
      const after = await f.store.getSelectedContext({
        expectedStoreId: f.storeId,
        sessionId: 's',
      });
      expect(after.compression).toBeUndefined();
      expect(after.selection.id).toBe(selection);
      expect(after.messages.filter((m) => m.content.includes('actual summary'))).toHaveLength(0);
      expect(after.messages.some((m) => m.content === 'original work')).toBe(true);
      expect(
        (await f.store.getView('s')).runs.find((r) => r.originCommandId === 'compact')!.status,
      ).not.toBe('completed');
    } finally {
      physical?.close();
      await f.close();
    }
  });

test('trusted automatic slot orders actual contributions → compression → normal Model → beforeComplete; conflicting slots make zero Provider calls', async () => {
  const f = await fixture({ automatic: true });
  try {
    await f.work('original', 'original work');
    f.order.length = 0;
    await f.work('auto', 'new auto work');
    expect(f.requests).toHaveLength(4);
    expect(f.requests[1]!.tools).toHaveLength(0);
    expect(
      f.requests[2]!.messages.some((m) => m.sourceIds?.some((id) => id.startsWith('compression-'))),
    ).toBe(true);
    expect(f.order.indexOf('memory')).toBeLessThan(f.order.indexOf('compression'));
    expect(f.order.indexOf('compression')).toBeLessThan(f.order.indexOf('completion'));
  } finally {
    await f.close();
  }
  const conflict = await fixture({ conflict: true });
  try {
    await conflict.work('no-model', 'ordinary');
    expect(conflict.requests).toHaveLength(0);
    expect((await conflict.store.getView('s')).runs[0]!.reason).toBe('compression_slot_conflict');
  } finally {
    await conflict.close();
  }
});

test('reset safely restores history without Provider, wrong point/unsafe window keep active summary and noop is durable', async () => {
  for (const resetSafe of [true, false]) {
    const f = await fixture({ resetSafe });
    try {
      await f.work('original', 'original work');
      const selection = (await f.store.getSession('s'))!.contextSelectionId;
      await f.runtime.compressContext({
        ...f.base,
        commandId: 'compact',
        expectedContextSelectionId: selection,
      });
      await f.runtime.waitForCommand('compact');
      const compressed = (
        await f.store.getSelectedContext({ expectedStoreId: f.storeId, sessionId: 's' })
      ).compression!;
      const count = f.requests.length;
      await f.runtime.resetCompressionContext({
        ...f.base,
        commandId: 'reset',
        expectedContextSelectionId: selection,
        expectedCompressionId: compressed.id,
      });
      await f.runtime.waitForCommand('reset');
      const page = await f.store.getSelectedContext({ expectedStoreId: f.storeId, sessionId: 's' });
      expect(f.requests.length).toBe(count);
      expect(page.selection.id).toBe(selection);
      if (resetSafe) {
        expect(page.compression).toBeUndefined();
        expect(page.messages.map((m) => m.content)).toEqual([
          'original work',
          'actual original answer',
        ]);
        expect(
          (await f.store.getView('s')).runs.find((r) => r.originCommandId === 'reset')!.status,
        ).toBe('completed');
        await f.runtime.resetCompressionContext({
          ...f.base,
          commandId: 'noop',
          expectedContextSelectionId: selection,
          expectedCompressionId: null,
        });
        await f.runtime.waitForCommand('noop');
        expect(f.requests.length).toBe(count);
        await f.work('next', 'after reset');
        expect(
          f.requests.at(-1)!.messages.some((m) => m.content === 'actual original answer'),
        ).toBe(true);
        expect(f.requests.at(-1)!.messages.some((m) => m.content.includes('Context summary'))).toBe(
          false,
        );
      } else {
        expect(page.compression!.id).toBe(compressed.id);
        expect(
          (await f.store.getView('s')).runs.find((r) => r.originCommandId === 'reset')!.reason,
        ).toBe('compression_reset_unsafe');
      }
    } finally {
      await f.close();
    }
  }
});

test('unchanged selected history refuses another summary; final Run completion rollback cannot publish a summary', async () => {
  const f = await fixture();
  let physical: Database | undefined;
  try {
    await f.work('original', 'original work');
    const selection = (await f.store.getSession('s'))!.contextSelectionId;
    physical = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    physical.run(
      "CREATE TRIGGER fail_run_completion BEFORE UPDATE OF status ON run WHEN NEW.status='completed' AND EXISTS(SELECT 1 FROM command WHERE id=NEW.origin_command_id AND kind='context.compress') BEGIN SELECT RAISE(ABORT,'completion failure'); END",
    );
    await f.runtime.compressContext({
      ...f.base,
      commandId: 'fault',
      expectedContextSelectionId: selection,
    });
    await f.runtime.waitForCommand('fault');
    expect(
      (await f.store.getSelectedContext({ expectedStoreId: f.storeId, sessionId: 's' }))
        .compression,
    ).toBeUndefined();
    expect(
      (await f.store.getView('s')).runs.find((r) => r.originCommandId === 'fault')!.status,
    ).toBe('failed');
    physical.run('DROP TRIGGER fail_run_completion');
    await f.runtime.compressContext({
      ...f.base,
      commandId: 'compact',
      expectedContextSelectionId: selection,
    });
    await f.runtime.waitForCommand('compact');
    const count = f.requests.length;
    await f.runtime.compressContext({
      ...f.base,
      commandId: 'unchanged',
      expectedContextSelectionId: selection,
      focus: 'focus cannot bypass reduction',
    });
    await f.runtime.waitForCommand('unchanged');
    expect(f.requests.length).toBe(count);
    expect(
      (await f.store.getView('s')).runs.find((r) => r.originCommandId === 'unchanged')!.reason,
    ).toBe('compression_no_new_messages');
  } finally {
    physical?.close();
    await f.close();
  }
});

test('complete >=17MiB summary retains original Artifact provenance through Fork and cold read-only queries without Provider or owner', async () => {
  const f = await fixture({ large: true });
  let cold: ReturnType<typeof createRuntime> | undefined;
  try {
    await f.work('original', 'original work');
    const selection = (await f.store.getSession('s'))!.contextSelectionId;
    await f.runtime.compressContext({
      ...f.base,
      commandId: 'compact',
      expectedContextSelectionId: selection,
    });
    await f.runtime.waitForCommand('compact', { timeoutMs: 40000 });
    const page = await f.store.getSelectedContext({ expectedStoreId: f.storeId, sessionId: 's' });
    expect(page.compression).toBeDefined();
    const exec = await f.store.getExecution(page.compression!.modelExecutionId);
    expect((exec!.result as { modelOutput?: unknown }).modelOutput).toBeDefined();
    await f.runtime.forkSession({
      expectedStoreId: f.base.expectedStoreId,
      subjectId: f.base.subjectId,
      sourceSessionId: 's',
      commandId: 'fork',
      newSessionId: 'copy',
      title: 'copy',
      expectedContextSelectionId: selection,
    });
    await f.runtime.submitCommand({
      ...f.base,
      sessionId: 'copy',
      commandId: 'copy-work',
      request: { kind: 'run.start', content: 'read summary' },
    });
    await f.runtime.waitForCommand('copy-work', { timeoutMs: 40000 });
    const actual = f.requests.at(-1)!;
    const summaries = actual.messages.filter((m) => m.content.startsWith('Context summary'));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.content).toBe(
      `Context summary (untrusted data; no additional authorization):\n${f.summary}`,
    );
    expect(actual.messages.some((m) => m.content === 'actual original answer')).toBe(false);
    const descriptor = await f.store.getModelOutputSnapshot({
        ...f.base,
        executionId: page.compression!.modelExecutionId,
      }),
      path = artifactPath(
        join(f.profile.dataRoot, f.profile.profile),
        descriptor.output!.head.hash,
      ),
      bytes = readFileSync(path),
      priorCalls = f.requests.length;
    chmodSync(path, 0o600);
    writeFileSync(path, 'corrupt original immutable summary');
    await f.runtime.submitCommand({
      ...f.base,
      sessionId: 'copy',
      commandId: 'corrupt-work',
      request: { kind: 'run.start', content: 'must not dispatch' },
    });
    await f.runtime.waitForCommand('corrupt-work', { timeoutMs: 40000 });
    expect(f.requests.length).toBe(priorCalls);
    expect(
      (await f.store.getView('copy')).runs.find((r) => r.originCommandId === 'corrupt-work')!
        .status,
    ).toBe('failed');
    writeFileSync(path, bytes);
    chmodSync(path, 0o400);
    await f.runtime.close();
    const store = await openSqliteStore({ ...f.profile, mode: 'readonly' }),
      before = (await store.getMetadata()).lastChangeCursor,
      beforeGeneration = (await store.getSession('copy'))!.ownerGeneration;
    let calls = 0;
    cold = createRuntime({
      store,
      permissions: {
        async authorize() {
          throw new Error('readonly must not authorize');
        },
      },
      modelId: 'fixed',
      model: {
        async *stream() {
          calls++;
          yield finish;
        },
      },
      artifacts: createArtifactStore({ profile: f.profile, store }),
    });
    const snapshot = await cold.getSelectedContext({
      expectedStoreId: f.storeId,
      sessionId: 'copy',
    });
    expect(snapshot.compression!.originSessionId).toBe('s');
    const origin = await store.getCompressionOrigin({
      expectedStoreId: f.storeId,
      sessionId: 'copy',
      subjectId: 'owner',
      compressionId: snapshot.compression!.id,
    });
    const context = await cold.readModelOutput({
      expectedStoreId: f.storeId,
      sessionId: origin.originSessionId,
      subjectId: 'owner',
      executionId: origin.modelExecutionId,
    });
    expect(context.output.content === f.summary).toBe(true);
    expect(calls).toBe(0);
    expect((await store.getMetadata()).lastChangeCursor).toBe(before);
    expect((await store.getSession('copy'))!.ownerGeneration).toBe(beforeGeneration);
    expect((await store.getSession('copy'))!.ownerInstanceId).toBeNull();
  } finally {
    await cold?.close();
    await f.close();
  }
}, 60000);

test('original scope denial, actual hard permission denial and unsupported Part preserve history with zero compression Model', async () => {
  const denied = await fixture({ denyCompression: true });
  try {
    await denied.work('original', 'original work');
    const selection = (await denied.store.getSession('s'))!.contextSelectionId;
    const before = denied.requests.length;
    for (const changed of [{ expectedStoreId: 'foreign-store' }, { subjectId: 'intruder' }]) {
      let error: unknown;
      try {
        await denied.runtime.compressContext({
          ...denied.base,
          ...changed,
          commandId: 'wrong',
          expectedContextSelectionId: selection,
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
    }
    await denied.runtime.compressContext({
      ...denied.base,
      commandId: 'deny',
      expectedContextSelectionId: selection,
    });
    await denied.runtime.waitForCommand('deny');
    expect(denied.requests.length).toBe(before);
    expect(
      (await denied.store.getSelectedContext({ expectedStoreId: denied.storeId, sessionId: 's' }))
        .compression,
    ).toBeUndefined();
    expect(
      (await denied.store.getView('s')).runs.find((r) => r.originCommandId === 'deny')!.status,
    ).toBe('failed');
  } finally {
    await denied.close();
  }
  const f = await fixture();
  let physical: Database | undefined;
  try {
    await f.work('original', 'original work');
    const selection = (await f.store.getSession('s'))!.contextSelectionId,
      count = f.requests.length;
    physical = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    physical.run(
      "UPDATE message_part SET kind='future.opaque',content_version=9 WHERE message_id=(SELECT id FROM message WHERE role='user' LIMIT 1)",
    );
    await f.runtime.compressContext({
      ...f.base,
      commandId: 'unknown',
      expectedContextSelectionId: selection,
    });
    await f.runtime.waitForCommand('unknown');
    expect(f.requests.length).toBe(count);
    expect((await f.store.getView('s')).messages.some((m) => m.content === 'original work')).toBe(
      true,
    );
    expect(
      (await f.store.getView('s')).runs.find((r) => r.originCommandId === 'unknown')!.reason,
    ).toBe('context_content_unsupported');
  } finally {
    physical?.close();
    await f.close();
  }
});

test('manual-only default never auto invokes slot and reset publication rollback preserves exact old point', async () => {
  const f = await fixture();
  let physical: Database | undefined;
  try {
    await f.work('original', 'new auto work');
    expect(f.requests).toHaveLength(1);
    expect(f.order).not.toContain('compression');
    const selection = (await f.store.getSession('s'))!.contextSelectionId;
    await f.runtime.compressContext({
      ...f.base,
      commandId: 'compact',
      expectedContextSelectionId: selection,
    });
    await f.runtime.waitForCommand('compact');
    const compression = (
        await f.store.getSelectedContext({ expectedStoreId: f.storeId, sessionId: 's' })
      ).compression!,
      count = f.requests.length;
    physical = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    physical.run(
      "CREATE TRIGGER reset_fault BEFORE INSERT ON context_snapshot WHEN NEW.kind='compression_reset' BEGIN SELECT RAISE(ABORT,'reset fault'); END",
    );
    await f.runtime.resetCompressionContext({
      ...f.base,
      commandId: 'failed-reset',
      expectedContextSelectionId: selection,
      expectedCompressionId: compression.id,
    });
    await f.runtime.waitForCommand('failed-reset');
    expect(f.requests.length).toBe(count);
    expect(
      (await f.store.getSelectedContext({ expectedStoreId: f.storeId, sessionId: 's' }))
        .compression!.id,
    ).toBe(compression.id);
    expect(
      (await f.store.getView('s')).runs.find((r) => r.originCommandId === 'failed-reset')!.status,
    ).toBe('failed');
    physical.run('DROP TRIGGER reset_fault');
    await f.runtime.resetCompressionContext({
      ...f.base,
      commandId: 'wrong-point',
      expectedContextSelectionId: selection,
      expectedCompressionId: 'other-point',
    });
    await f.runtime.waitForCommand('wrong-point');
    expect(
      (await f.store.getSelectedContext({ expectedStoreId: f.storeId, sessionId: 's' }))
        .compression!.id,
    ).toBe(compression.id);
    expect(f.requests.length).toBe(count);
  } finally {
    physical?.close();
    await f.close();
  }
});

test('invalid summary tool call remains only original history and cannot poison later Model/Fork pairing or become a boundary', async () => {
  const f = await fixture({ fault: 'tool_reply' });
  try {
    await f.work('original', 'original work');
    const selection = (await f.store.getSession('s'))!.contextSelectionId;
    await f.runtime.compressContext({
      ...f.base,
      commandId: 'invalid',
      expectedContextSelectionId: selection,
    });
    await f.runtime.waitForCommand('invalid');
    const view = await f.store.getView('s'),
      summaryMessage = view.messages.find((message) =>
        message.toolCalls?.some((call) => call.id === 'forbidden-summary-call'),
      )!;
    expect(summaryMessage).toBeDefined();
    expect(view.executions.filter((execution) => execution.kind === 'tool')).toHaveLength(0);
    expect(view.runs.find((run) => run.originCommandId === 'invalid')!.status).toBe('failed');
    let rejected: unknown;
    try {
      await f.runtime.selectContext({
        ...f.base,
        commandId: 'bad-boundary',
        expectedContextSelectionId: selection,
        boundary: { messageId: summaryMessage.id, seq: summaryMessage.seq },
      });
    } catch (error) {
      rejected = error;
    }
    expect((rejected as { code?: string })?.code).toBe('context_boundary_invalid');
    await f.runtime.forkSession({
      expectedStoreId: f.base.expectedStoreId,
      subjectId: f.base.subjectId,
      sourceSessionId: 's',
      commandId: 'fork-safe',
      newSessionId: 'safe-copy',
      title: 'safe',
      expectedContextSelectionId: selection,
    });
    expect(
      (await f.store.getView('safe-copy')).messages.some((message) =>
        message.toolCalls?.some((call) => call.id === 'forbidden-summary-call'),
      ),
    ).toBe(false);
    await f.work('next', 'ordinary after invalid summary');
    expect(
      f.requests
        .at(-1)!
        .messages.some((message) =>
          message.toolCalls?.some((call) => call.id === 'forbidden-summary-call'),
        ),
    ).toBe(false);
    expect(
      (await f.store.getSelectedContext({ expectedStoreId: f.storeId, sessionId: 's' }))
        .compression,
    ).toBeUndefined();
  } finally {
    await f.close();
  }
});

test('reset captures actual Step capabilities before preflight and final cache change refuses clear without Provider', async () => {
  for (const changed of [false, true]) {
    const f = await fixture({ step: true, changeStepOnReset: changed });
    try {
      await f.work('original', 'original work');
      const selection = (await f.store.getSession('s'))!.contextSelectionId;
      await f.runtime.compressContext({
        ...f.base,
        commandId: 'compact',
        expectedContextSelectionId: selection,
      });
      await f.runtime.waitForCommand('compact');
      const point = (
          await f.store.getSelectedContext({ expectedStoreId: f.storeId, sessionId: 's' })
        ).compression!,
        count = f.requests.length;
      await f.runtime.resetCompressionContext({
        ...f.base,
        commandId: 'reset',
        expectedContextSelectionId: selection,
        expectedCompressionId: point.id,
      });
      await f.runtime.waitForCommand('reset');
      const result = await f.store.getSelectedContext({
          expectedStoreId: f.storeId,
          sessionId: 's',
        }),
        run = (await f.store.getView('s')).runs.find((r) => r.originCommandId === 'reset')!;
      expect(f.requests.length).toBe(count);
      if (changed) {
        expect(result.compression!.id).toBe(point.id);
        expect(run.reason).toBe('capability_refresh_required');
      } else {
        expect(result.compression).toBeUndefined();
        expect(run.status).toBe('completed');
      }
    } finally {
      await f.close();
    }
  }
});

test('trusted actual summary/window preflight rejects an ineffective result and preserves original point plus new tail', async () => {
  const f = await fixture();
  try {
    await f.work('original', 'original work');
    const selection = (await f.store.getSession('s'))!.contextSelectionId;
    await f.runtime.compressContext({
      ...f.base,
      commandId: 'compact',
      expectedContextSelectionId: selection,
    });
    await f.runtime.waitForCommand('compact');
    const original = (
      await f.store.getSelectedContext({ expectedStoreId: f.storeId, sessionId: 's' })
    ).compression!;
    await f.work('new-tail', 'actual new work');
    f.rejectNextSummary();
    await f.runtime.compressContext({
      ...f.base,
      commandId: 'ineffective',
      expectedContextSelectionId: selection,
    });
    await f.runtime.waitForCommand('ineffective');
    const context = await f.store.getSelectedContext({
        expectedStoreId: f.storeId,
        sessionId: 's',
      }),
      run = (await f.store.getView('s')).runs.find((r) => r.originCommandId === 'ineffective')!;
    expect(run.status).toBe('failed');
    expect(run.reason).toBe('compression_not_reducible');
    expect(context.compression!.id).toBe(original.id);
    expect(context.messages.some((m) => m.content === 'actual new work')).toBe(true);
    expect(context.messages.some((m) => m.content === f.summary)).toBe(false);
  } finally {
    await f.close();
  }
});

test('automatic Provider failure preserves old input, unchanged Model-refresh does not retry and new input/manual may retry', async () => {
  const f = await fixture({
    automatic: true,
    skipGovernance: true,
    step: true,
    fault: 'provider',
    refreshAfterAutoFailure: true,
  });
  try {
    await f.work('original', 'original work');
    await f.work('automatic', 'new auto work');
    const first = (await f.store.getView('s')).runs.find((r) => r.originCommandId === 'automatic')!;
    expect(first.status).toBe('completed');
    expect(
      f.requests.filter((request) =>
        request.messages.some((message) => message.content.includes('SUMMARIZE EXACT INPUT')),
      ),
    ).toHaveLength(1);
    expect(f.order.filter((entry) => entry === 'compression')).toHaveLength(1);
    const ordinary = f.requests.at(-1)!;
    expect(ordinary.messages.some((message) => message.content === 'original work')).toBe(true);
    expect(ordinary.messages.some((message) => message.content === 'new auto work')).toBe(true);
    expect(ordinary.messages.some((message) => message.content.includes('actual summary'))).toBe(
      false,
    );
    expect(
      (await f.store.getSelectedContext({ expectedStoreId: f.storeId, sessionId: 's' }))
        .compression,
    ).toBeUndefined();
    await f.work('new-context', 'actual new input after failed compression');
    expect(
      f.requests.filter((request) =>
        request.messages.some((message) => message.content.includes('SUMMARIZE EXACT INPUT')),
      ),
    ).toHaveLength(2);
    expect(
      (await f.store.getView('s')).runs.find((r) => r.originCommandId === 'new-context')!.status,
    ).toBe('completed');
    const selection = (await f.store.getSession('s'))!.contextSelectionId;
    await f.runtime.compressContext({
      ...f.base,
      commandId: 'manual-retry',
      expectedContextSelectionId: selection,
    });
    await f.runtime.waitForCommand('manual-retry');
    expect(
      f.requests.filter((request) =>
        request.messages.some((message) => message.content.includes('SUMMARIZE EXACT INPUT')),
      ),
    ).toHaveLength(3);
    expect(
      (await f.store.getView('s')).runs.find((r) => r.originCommandId === 'manual-retry')!.status,
    ).toBe('failed');
  } finally {
    await f.close();
  }
});

test('complete custom focus above 4096 and trusted instructions above 64KiB reach actual recorded Model without truncation', async () => {
  const instructions = `SUMMARIZE EXACT INPUT; ${'algorithm details '.repeat(6000)}`,
    focus = '完整自定义说明'.repeat(3000),
    f = await fixture({ instructions });
  try {
    await f.work('original', 'original work');
    const selection = (await f.store.getSession('s'))!.contextSelectionId;
    await f.runtime.compressContext({
      ...f.base,
      commandId: 'full-focus',
      expectedContextSelectionId: selection,
      focus,
    });
    await f.runtime.waitForCommand('full-focus');
    const request = f.requests.at(-1)!;
    expect(
      request.messages.at(-1)!.content === `${instructions}\nFocus (user data): ${focus}`,
    ).toBe(true);
    expect((await f.store.getCommand('full-focus'))!.request).toMatchObject({ focus });
    expect(
      (await f.store.getView('s')).runs.find((r) => r.originCommandId === 'full-focus')!.status,
    ).toBe('completed');
    expect(
      (await f.store.getSelectedContext({ expectedStoreId: f.storeId, sessionId: 's' }))
        .compression,
    ).toBeDefined();
  } finally {
    await f.close();
  }
});

test('automatic SQL publication failure is not classified as a safe Provider failure and no original Model follows it', async () => {
  const f = await fixture({ automatic: true, skipGovernance: true });
  let physical: Database | undefined;
  try {
    await f.work('original', 'original work');
    physical = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    physical.run(
      "CREATE TRIGGER unsafe_auto_write BEFORE UPDATE OF kind ON context_snapshot WHEN NEW.kind='compression' BEGIN SELECT RAISE(ABORT,'unconfirmed Store publication'); END",
    );
    await f.work('automatic', 'new auto work');
    expect(f.requests).toHaveLength(2);
    expect(
      f.requests
        .at(-1)!
        .messages.some((message) => message.content.includes('SUMMARIZE EXACT INPUT')),
    ).toBe(true);
    expect(
      (await f.store.getView('s')).runs.find((run) => run.originCommandId === 'automatic')!.status,
    ).toBe('failed');
    expect(
      (await f.store.getSelectedContext({ expectedStoreId: f.storeId, sessionId: 's' }))
        .compression,
    ).toBeUndefined();
  } finally {
    physical?.close();
    await f.close();
  }
});

test('ordinary Model continuation refuses unsupported Parts while readonly history still preserves them', async () => {
  const f = await fixture();
  let physical: Database | undefined;
  try {
    await f.work('original', 'original work');
    const count = f.requests.length;
    physical = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    physical.run(
      "UPDATE message_part SET content_version=91 WHERE message_id=(SELECT id FROM message WHERE role='user' LIMIT 1)",
    );
    expect(
      (
        await f.store.getSelectedContext({ expectedStoreId: f.storeId, sessionId: 's' })
      ).messages.some((message) => message.content === 'original work'),
    ).toBe(true);
    await f.work('unsupported', 'new explicit work');
    expect(f.requests.length).toBe(count);
    expect(
      (await f.store.getView('s')).runs.find((run) => run.originCommandId === 'unsupported')!
        .reason,
    ).toBe('context_content_unsupported');
  } finally {
    physical?.close();
    await f.close();
  }
});
