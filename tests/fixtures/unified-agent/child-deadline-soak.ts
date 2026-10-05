/** Explicit macOS qualification; intentionally excluded from ordinary test discovery. */
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../packages/agent/src';
import type {
  JobDefinition,
  JobHandle,
  OperationRef,
  ToolDefinition,
} from '../../../packages/agent/src/extensions';
import { openSqliteStore } from '../../../packages/agent/src/sqlite';

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-child-deadline-soak-')));
const reportPath = join(directory, 'report.json');
const profile = { dataRoot: join(directory, 'data'), profile: 'qualification' };
const store = await openSqliteStore(profile);
const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: '{}' },
  { ...finish, reason: 'tool_calls' },
];
let carrier: OperationRef | undefined,
  attached: OperationRef | undefined,
  detached: OperationRef | undefined;
let childModels = 0,
  modelAborts = 0,
  jobStarts = 0,
  jobStops = 0;
let notifyPartial!: () => void;
const partialStarted = new Promise<void>((resolve) => {
  notifyPartial = resolve;
});
let notifyExpired!: () => void;
const expired = new Promise<void>((resolve) => {
  notifyExpired = resolve;
});
const report: Record<string, unknown> = {
  qualification: 'actual_fixed_30min_child_deadline',
  platform: process.platform,
  pid: process.pid,
  directory,
  reportPath,
  state: 'starting',
};
function save() {
  writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function eventually<T>(read: () => Promise<T | undefined>, durationMs = 10000): Promise<T> {
  const end = Date.now() + durationMs;
  for (;;) {
    const result = await read();
    if (result !== undefined) return result;
    if (Date.now() > end) throw new Error('qualification_fact_timeout');
    await Bun.sleep(20);
  }
}
const pending = new Map<
  JobHandle,
  { finish: () => void; done: Promise<void>; remove: () => void }
>();
const job: JobDefinition = {
  id: 'fixture.live',
  version: '1',
  description: 'Known harmless in-memory qualification work',
  inputSchema: { type: 'object' },
  async start(_input, { signal }) {
    jobStarts++;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handle = { reference: { id: crypto.randomUUID() } };
    const abort = () => finish();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    pending.set(handle, { finish, done, remove: () => signal.removeEventListener('abort', abort) });
    return handle;
  },
  async *observe(handle) {
    const active = pending.get(handle)!;
    await active.done;
    // The harmless local work is stopped, but its logical result was never determined.
    yield {
      type: 'terminal',
      supervision: 'ended',
      result: { outcome: 'outcome_unknown', content: 'qualification_result_unconfirmed' },
    };
  },
  async cancel(handle) {
    jobStops++;
    pending.get(handle)!.finish();
    return { status: 'stopped' };
  },
  async dispose(handle) {
    pending.get(handle)?.remove();
    pending.delete(handle);
  },
};
const childTool: ToolDefinition = {
  id: 'fixture.jobs',
  version: '1',
  description: 'Create attached and detached harmless supervised work',
  inputSchema: { type: 'object' },
  async execute(_input, context) {
    attached = await context.operations.ensure({
      key: 'attached',
      request: { kind: 'job', definitionId: job.id, definitionVersion: '1', input: {} },
      cancellation: 'attached',
    });
    detached = await context.operations.ensure({
      key: 'detached',
      request: { kind: 'job', definitionId: job.id, definitionVersion: '1', input: {} },
      cancellation: 'detached',
    });
    return { outcome: 'succeeded', content: 'two actual Job identities created' };
  },
};
const child: ModelAdapter = {
  async *stream(_request, { signal }) {
    childModels++;
    if (childModels === 1) {
      for (const event of call(childTool.id)) yield event;
      return;
    }
    assert(childModels === 2, 'unexpected_child_model_replay');
    yield { type: 'text_delta', text: 'partial retained across actual thirty minute wait' };
    notifyPartial();
    await new Promise<void>((resolve) => {
      const abort = () => {
        modelAborts++;
        signal.removeEventListener('abort', abort);
        notifyExpired();
        resolve();
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
  },
};
const delegate: ToolDefinition = {
  id: 'fixture.delegate',
  version: '1',
  description: 'Start independent child on the production Loop',
  inputSchema: { type: 'object' },
  async execute(_input, context) {
    carrier = await context.operations.ensure({
      key: 'soak',
      request: {
        kind: 'agent',
        configurationId: 'child',
        input: { content: 'thirty minute real deadline qualification' },
      },
      cancellation: 'detached',
    });
    return { outcome: 'succeeded', content: 'child created' };
  },
};
const parent = createFixedModel([call(delegate.id), [finish]]);
const runtime = createRuntime({
  store,
  model: parent,
  modelId: 'root',
  modelConcurrency: 2,
  permissions: {
    async authorize() {
      return { allowed: true, revision: 'qualification-1' };
    },
  },
  extensions: [
    { id: 'fixture', version: '1', apiMajor: 1, tools: [delegate, childTool], jobs: [job] },
  ],
  childConfigurations: [
    {
      id: 'child',
      version: '1',
      model: child,
      modelId: 'fixed-child',
      toolIds: [childTool.id],
      snapshot: { qualification: true },
    },
  ],
});
try {
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'private qualification',
    rootUri: `file://${directory}`,
  });
  await runtime.createSession({
    expectedStoreId,
    sessionId: 'root',
    workspaceId: 'w',
    commandId: 'create',
    subjectId: 'qualification',
    title: 'real deadline',
  });
  await runtime.submitCommand({
    expectedStoreId,
    sessionId: 'root',
    commandId: 'work',
    subjectId: 'qualification',
    request: { kind: 'run.start', content: 'delegate' },
  });
  await Promise.race([
    partialStarted,
    Bun.sleep(10000).then(() => {
      throw new Error('partial_start_timeout');
    }),
  ]);
  await runtime.waitForCommand('work', { timeoutMs: 10000 });
  const childRun = (await store.getView(carrier!.childSessionId!)).runs[0]!;
  const rootRun = (await store.getView('root')).runs[0]!;
  assert(childRun.deadlineAt! - childRun.createdAt === 1800000, 'not_actual_fixed_thirty_minutes');
  assert(
    rootRun.deadlineAt === null && rootRun.status === 'completed',
    'root_total_deadline_or_wrong_completion',
  );
  await eventually(async () => (jobStarts === 2 ? true : undefined));
  report.state = 'waiting_actual_deadline';
  report.storeId = expectedStoreId;
  report.childSessionId = carrier!.childSessionId;
  report.runId = childRun.id;
  report.startedAt = childRun.createdAt;
  report.deadlineAt = childRun.deadlineAt;
  report.rootDeadlineAt = rootRun.deadlineAt;
  report.carrier = carrier;
  report.attached = attached;
  report.detached = detached;
  save();
  console.log(JSON.stringify(report));
  let guard!: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_resolve, reject) => {
    guard = setTimeout(
      () => reject(new Error('deadline_timeout')),
      Math.max(0, childRun.deadlineAt! - Date.now()) + 60000,
    );
  });
  try {
    await Promise.race([expired, late]);
  } finally {
    clearTimeout(guard);
  }
  const terminal = await eventually(async () => {
    const run = await store.getRun(childRun.id);
    return run && !run.isActive ? run : undefined;
  });
  const actualAttached = await eventually(async () => {
    const row = await store.getExecution(attached!.executionId!);
    return row && row.status === 'outcome_unknown' ? row : undefined;
  });
  const actualDetached = await store.getExecution(detached!.executionId!);
  const cancellation = await store.getCommand(`deadline-${childRun.id}`);
  const messages = await store.listMessages(carrier!.childSessionId!);
  assert(
    terminal.status === 'cancelled' && terminal.reason === 'child_deadline_exceeded',
    'deadline_not_exact_cancel',
  );
  assert(cancellation?.status === 'applied', 'missing_durable_deadline_command');
  assert(
    actualDetached?.status === 'running' && actualDetached.cancelRequestedAt === null,
    'deadline_expanded_to_detached',
  );
  assert(
    messages.some((m) => m.status === 'incomplete' && m.content.includes('partial retained')),
    'partial_lost',
  );
  assert(Date.now() >= childRun.deadlineAt!, 'early_expiry');
  assert(modelAborts === 1 && childModels === 2, 'wrong_model_calls');
  report.state = 'passed';
  report.finishedAt = Date.now();
  report.elapsedMs = Date.now() - childRun.createdAt;
  report.cancelCommand = cancellation;
  report.childRun = terminal;
  report.attachedOutcome = actualAttached.status;
  report.detachedBeforeCleanup = actualDetached.status;
  report.partialMessageIds = messages.filter((m) => m.status === 'incomplete').map((m) => m.id);
  report.calls = { childModels, modelAborts, jobStarts, jobStops };
  save();
  console.log(JSON.stringify(report));
  await runtime.cancelExecution({
    expectedStoreId,
    sessionId: carrier!.childSessionId!,
    subjectId: 'qualification',
    commandId: 'cleanup-detached',
    executionId: detached!.executionId!,
  });
} catch (error) {
  report.state = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
  report.finishedAt = Date.now();
  save();
  console.error(JSON.stringify(report));
  process.exitCode = 1;
} finally {
  await runtime.close();
}
