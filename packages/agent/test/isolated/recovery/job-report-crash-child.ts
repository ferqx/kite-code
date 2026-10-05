import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { createTaskExtension } from '../../../src/extensions/task';
import { semanticDigest } from '../../../src/json';
import { createRuntime, type RuntimeOptions } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
export function crashReportOptions(input: {
  store: Store;
  profile: { dataRoot: string; profile: string };
  ledger: string;
  releaseChild?: Promise<void>;
  beforeApply?(): Promise<void>;
}): RuntimeOptions {
  const record = (kind: string, request: ModelRequest) =>
    appendFileSync(input.ledger, `${JSON.stringify({ kind, request })}\n`);
  const parent: ModelAdapter = {
    async *stream(request) {
      const report = request.messages.some((message) =>
        message.sourceIds?.some((id) => id.startsWith('result-')),
      );
      if (report) {
        record('report', request);
        yield { type: 'text_delta', text: 'Report exact original crash child result' };
        yield finish;
      } else if (request.messages.at(-1)?.role !== 'tool') {
        record('parent-start', request);
        yield {
          type: 'tool_call',
          id: 'task-call',
          name: 'task',
          arguments: JSON.stringify({
            key: 'original-child',
            role: 'reader',
            resultDisposition: 'after_turn',
            cancellation: 'detached',
            input: { content: 'Original crash child work' },
          }),
        };
        yield { ...finish, reason: 'tool_calls' };
      } else {
        record('parent-complete', request);
        yield { type: 'text_delta', text: 'Original parent complete' };
        yield finish;
      }
    },
  };
  const child: ModelAdapter = {
    async *stream(request) {
      record('child', request);
      if (input.releaseChild) await input.releaseChild;
      yield { type: 'text_delta', text: 'Exact original crash child result' };
      yield finish;
    },
  };
  return {
    store: input.store,
    artifacts: createArtifactStore({ profile: input.profile, store: input.store }),
    model: parent,
    modelId: 'crash-root',
    modelConcurrency: 2,
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'crash-static-permission' };
      },
    },
    afterTurn: {
      async authorize(request) {
        if (request.phase === 'apply') await input.beforeApply?.();
        return { allowed: true, revision: 'crash-static-after-turn' };
      },
    },
    extensions: [
      createTaskExtension({
        roles: [{ id: 'reader', configurationId: 'child', description: 'fixed crash child' }],
        afterTurn: { enabled: true },
      }),
    ],
    childConfigurations: [
      {
        id: 'child',
        version: '1',
        model: child,
        modelId: 'crash-child',
        toolIds: [],
        snapshot: {},
      },
    ],
  };
}

if (import.meta.main) {
  const [root, ledger] = process.argv.slice(2);
  if (!root || !ledger) throw Error('crash_fixture_arguments');
  const profile = { dataRoot: join(root, 'data'), profile: 'crash' };
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId;
  let release!: () => void;
  const childGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = createRuntime(
    crashReportOptions({
      store,
      profile,
      ledger,
      releaseChild: childGate,
      async beforeApply() {
        const view = await store.getView('root');
        const carrier = view.executions.find((execution) => execution.childSessionId)!;
        const execution = (await store.getExecution(carrier.id))!;
        const parentId = (execution.afterTurn as { parentRunId: string }).parentRunId;
        const parent = (await store.getRun(parentId))!;
        const reportId = `report-${await semanticDigest([storeId, execution.id, execution.resultRevision])}`;
        const report = (await store.getCommand(reportId))!;
        if (
          parent.status !== 'completed' ||
          parent.isActive ||
          !['succeeded', 'failed'].includes(execution.status) ||
          report.status !== 'accepted'
        )
          throw Error('crash_boundary_not_ready');
        process.stdout.write(
          `${JSON.stringify({ storeId, sessionId: 'root', reportId, parentId, executionId: execution.id })}\n`,
        );
        // Hold the real public after-turn policy before Store.applyJobReport; the owning parent kills this process.
        await new Promise<void>(() => {});
      },
    }),
  );
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: `file://${root}`,
    name: 'owned crash fixture',
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    commandId: 'create',
    subjectId: 'owner',
    sessionId: 'root',
    workspaceId: 'w',
    title: 'crash root',
  });
  await runtime.submitCommand({
    expectedStoreId: storeId,
    commandId: 'work',
    subjectId: 'owner',
    sessionId: 'root',
    request: { kind: 'run.start', content: 'Delegate before crash' },
  });
  await runtime.waitForCommand('work', { timeoutMs: 5000 });
  release();
  await new Promise<void>(() => {});
}
