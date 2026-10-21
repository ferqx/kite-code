import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../../src/artifacts';
import { createTaskExtension } from '../../../../src/extensions/task';
import { semanticDigest } from '../../../../src/json';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';
import { AgentError } from '../../../../src/storage/types';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string, input: unknown): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function until<T>(read: () => Promise<T | undefined>) {
  const end = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw Error('cold_report_fixture_deadline');
    await Bun.sleep(5);
  }
}

test('explicit cold report recovers its committed lost response once and associates a carried question without receiving or copying the old mail', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cold-collaboration-report-')));
  const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  let store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const identity = { expectedStoreId, sessionId: 'root', subjectId: 'owner' };
  const parentRelease = gate(),
    oldMailQueued = gate(),
    childRelease = gate();
  const question = 'Must the final palette be Blue or Green? This answer is still required.';
  const oldBody = 'OLD_EXPLICIT_R1_ONLY: inspection is underway.';
  let rootCalls = 0,
    childCalls = 0,
    hotFaults = 0,
    coldCalls = 0,
    lost = false;
  const coldRequests: ModelRequest[] = [];
  const coldAdmissions: { runId: string | null; sourceId: unknown; started: boolean }[] = [];
  const parent: ModelAdapter = {
    async *stream() {
      if (rootCalls++ === 0) {
        for (const event of call('spawn_agent', {
          prompt: 'Inspect the palette and ask the necessary question.',
        }))
          yield event;
      } else {
        await parentRelease.promise;
        yield {
          type: 'text_delta',
          text: 'Parent ordinary turn ended; child work is still pending.',
        };
        yield finish;
      }
    },
  };
  const child: ModelAdapter = {
    async *stream() {
      switch (childCalls++) {
        case 0:
          for (const event of call('send_agent_message', { target: 'parent', content: oldBody }))
            yield event;
          break;
        case 1:
          oldMailQueued.release();
          await childRelease.promise;
          for (const event of call('send_agent_message', { target: 'parent', content: question }))
            yield event;
          break;
        default:
          yield {
            type: 'text_delta',
            text: `Inspection completed. Palette selection is not complete. Pending question: ${question}`,
          };
          yield finish;
          break;
      }
    },
  };
  const task = () =>
    createTaskExtension({
      roles: [{ id: 'worker', configurationId: 'worker', description: 'general' }],
    });
  const options = () => ({
    store,
    artifacts: createArtifactStore({ profile, store }),
    modelId: 'parent',
    modelConcurrency: 3,
    extensions: [task()],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'current' };
      },
    },
    afterTurn: {
      async authorize() {
        return { allowed: true, revision: 'notification-current' };
      },
    },
    childConfigurations: [
      {
        id: 'worker',
        version: '1',
        model: child,
        modelId: 'child',
        toolIds: ['task.message'],
        snapshot: {},
      },
    ],
  });
  const hotApply = store.applyJobReport.bind(store);
  store.applyJobReport = async (input) => {
    if (!input.activeOnly && !input.recovery && input.authorization) {
      hotFaults++;
      throw new AgentError(
        'report_recovery_required',
        'isolated recoverable hot Store failure before commit',
      );
    }
    return hotApply(input);
  };
  let runtime = createRuntime({ ...options(), model: parent });
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'temp',
      rootUri: pathToFileURL(directory).href,
    });
    await runtime.createSession({
      ...identity,
      commandId: 'create',
      workspaceId: 'w',
      title: 'cold report',
    });
    await runtime.submitCommand({
      ...identity,
      commandId: 'work',
      request: { kind: 'run.start', content: 'Inspect palette' },
    });
    await oldMailQueued.promise;
    parentRelease.release();
    await runtime.waitForCommand('work', { timeoutMs: 5000 });
    const originalRun = (await store.getView('root')).runs.find(
      (run) => run.originCommandId === 'work',
    )!;
    expect(originalRun.status).toBe('completed');
    childRelease.release();
    const carrier = await until(async () =>
      (await store.listExecutions('root')).find(
        (e) => e.childSessionId && e.status === 'succeeded',
      ),
    );
    const reportId = `report-${await semanticDigest([expectedStoreId, carrier.id, carrier.resultRevision])}`;
    await until(async () => {
      const report = await store.getCommand(reportId);
      return report?.status === 'needs_review' ? report : undefined;
    });
    expect(hotFaults).toBe(1);
    const mails = (await store.listAgentMessages({ ...identity })).items;
    expect(mails).toHaveLength(2);
    const oldMail = mails.find((mail) => mail.targetRunId === originalRun.id)!;
    const queued = mails.find((mail) => mail.targetRunId === null)!;
    expect(oldMail).toBeDefined();
    expect(queued).toBeDefined();
    expect(queued.receivedMessageId).toBeNull();
    expect(carrier.resultAcceptance).toBeNull();
    await runtime.close();
    await store.close();
    store = await openSqliteStore(profile);
    const coldApply = store.applyJobReport.bind(store);
    store.applyJobReport = async (input) => {
      const result = await coldApply(input);
      if (input.recovery)
        coldAdmissions.push({
          runId: result.run?.id ?? null,
          sourceId: (result.command.receipt as { sourceId?: string }).sourceId,
          started: result.started,
        });
      if (input.recovery && !lost && result.command.status === 'applied') {
        lost = true;
        throw Error('isolated cold Store response lost after actual commit');
      }
      return result;
    };
    const cold: ModelAdapter = {
      async *stream(request) {
        coldCalls++;
        coldRequests.push(structuredClone(request));
        expect(
          request.messages.filter((message) => message.content.includes(question)),
        ).toHaveLength(1);
        expect(
          request.messages.some((message) =>
            message.content.includes('Palette selection is not complete.'),
          ),
        ).toBe(true);
        yield {
          type: 'text_delta',
          text: 'Inspection is complete; palette work remains pending until the human answers Blue or Green.',
        };
        yield finish;
      },
    };
    runtime = createRuntime({ ...options(), model: cold });
    const input = { ...identity, commandId: 'resume-report', reportCommandId: reportId };
    const receipt = await runtime.resumeJobReport(input);
    expect(receipt.status).toBe('applied');
    expect(lost).toBe(true);
    const report = (await store.getCommand(reportId))!;
    const accepted = report.receipt as { runId: string; sourceId: string };
    await until(async () => {
      const run = await store.getRun(accepted.runId);
      return run?.status === 'completed' ? run : undefined;
    });
    expect(coldCalls).toBe(1);
    expect(coldRequests).toHaveLength(1);
    expect(coldAdmissions).toEqual([
      { runId: accepted.runId, sourceId: accepted.sourceId, started: true },
      { runId: accepted.runId, sourceId: accepted.sourceId, started: false },
    ]);
    expect(
      coldRequests[0]!.messages.some((message) => message.sourceIds?.includes(queued.id)),
    ).toBe(false);
    expect(
      coldRequests[0]!.messages.filter((message) => message.sourceIds?.includes(accepted.sourceId)),
    ).toHaveLength(1);
    expect(
      (await store.getView('root')).runs.filter((run) => run.originCommandId === reportId),
    ).toHaveLength(1);
    expect((await store.getExecution(carrier.id))!.resultAcceptance).toMatchObject({
      runId: accepted.runId,
      sourceId: accepted.sourceId,
    });
    const mailReceipt = (await store.getCommand(queued.id))!.receipt as {
      carriedByResult?: unknown;
    };
    expect(mailReceipt.carriedByResult).toEqual({
      runId: accepted.runId,
      sourceId: accepted.sourceId,
      executionId: carrier.id,
      resultRevision: carrier.resultRevision,
    });
    const afterMail = (await store.getAgentMessage({ ...identity, messageId: queued.id }))!;
    expect(afterMail.receivedMessageId).toBeNull();
    expect(afterMail.receivedRunId).toBeNull();
    expect(afterMail.receivedContextSelectionId).toBeNull();
    const afterOld = (await store.getAgentMessage({ ...identity, messageId: oldMail.id }))!;
    expect(afterOld.targetRunId).toBe(originalRun.id);
    expect(afterOld.receivedRunId).not.toBe(accepted.runId);
    expect(
      (await store.listMessages('root')).filter((message) =>
        message.sourceIds?.includes(queued.id),
      ),
    ).toHaveLength(0);
    const cursor = (await store.getMetadata()).lastChangeCursor;
    expect(await runtime.resumeJobReport(input)).toEqual(receipt);
    expect(coldCalls).toBe(1);
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    parentRelease.release();
    childRelease.release();
    await runtime.close();
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
