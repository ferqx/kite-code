import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../../src/artifacts';
import { createTaskExtension } from '../../../../src/extensions/task';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';
import { createAskUserExtension } from '../../../../src/tools/ask-user';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string, input: unknown): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 7000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw Error('question_loop_deadline');
    await Bun.sleep(5);
  }
}

for (const carried of [true, false])
  test(`idle parent question ${carried ? 'carried by result' : 'adopted as original mail'} closes through a finite pending result, human clarification and stable-child follow-up without observers`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-question-loop-')));
    const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
    const store = await openSqliteStore(profile),
      expectedStoreId = (await store.getMetadata()).storeId;
    const identity = { expectedStoreId, subjectId: 'owner', sessionId: 'root' };
    const receiveOriginal = store.receiveAgentMessages.bind(store);
    let intercepted: Parameters<typeof store.receiveAgentMessages>[0] | undefined;
    let releaseReceive!: () => void;
    const receiveGate = new Promise<void>((resolve) => {
      releaseReceive = resolve;
    });
    store.receiveAgentMessages = async (input) => {
      if (
        !carried &&
        !intercepted &&
        !input.resultOptions &&
        input.runId &&
        (await store.getRun(input.runId))?.sessionId === 'root'
      ) {
        intercepted = input;
        await receiveGate;
      }
      return receiveOriginal(input);
    };

    const question = 'Which palette must the deliverable use: Blue or Green?';
    const pending = `EXECUTION_ENDED_BUSINESS_PENDING. Completed: inspected all inputs. Not completed: apply the chosen palette. Decision required: ${carried ? question : 'Select Blue or Green before applying the palette.'}`;
    const complete =
      'BUSINESS_COMPLETE. Completed: inspected inputs and applied Blue. No work remains pending.';
    const summary = `Preserved child pending facts: ${pending}`;
    let compressedSourceId: string | undefined;
    let compressionTriggered = false;
    let releaseChild!: () => void;
    const initialGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let rootCalls = 0,
      childCalls = 0,
      agentId = '',
      cursor = '0';
    const rootRequests: ModelRequest[] = [],
      childRequests: ModelRequest[] = [];
    const parent: ModelAdapter = {
      async *stream(request) {
        if (
          request.messages.some((message) => message.content.includes('QUESTION_LOOP_SUMMARIZE'))
        ) {
          yield { type: 'text_delta', text: summary };
          yield finish;
          return;
        }
        rootRequests.push(structuredClone(request));
        const tool = request.messages.filter((message) => message.role === 'tool').at(-1);
        const body = tool ? JSON.parse(tool.content) : null;
        let events: ModelEvent[];
        switch (rootCalls++) {
          case 0:
            events = call('spawn_agent', {
              prompt:
                'Inspect inputs, then ask parent which palette is required. If no answer arrives after one finite wait, report exactly what remains undecided.',
            });
            break;
          case 1:
            agentId = body.agent_id;
            events = [
              {
                type: 'text_delta',
                text: 'Delegated inspection; palette selection remains unresolved.',
              },
              finish,
            ];
            break;
          case 2:
            expect(JSON.stringify(request.messages)).toContain(pending);
            expect(
              request.messages.filter((message) => message.content.includes(question)),
            ).toHaveLength(1);
            events = call('wait_agent_events', { wait_ms: 0 });
            break;
          case 3:
            cursor = body.next_seq;
            events = call('ask_user', {
              questions: [
                {
                  question,
                  options: [
                    { label: 'Blue', description: 'Use Blue' },
                    { label: 'Green', description: 'Use Green' },
                  ],
                },
              ],
            });
            break;
          case 4:
            expect(JSON.stringify(body)).toContain('Blue');
            events = call('follow_up_agent', {
              agent_id: agentId,
              content:
                'The human clarified the pending palette question: Blue. Apply Blue and finish the remaining work.',
            });
            break;
          case 5:
            expect(body).toMatchObject({ accepted: true, agent_id: agentId, mode: 'new_turn' });
            events = call('wait_agent_events', { after_seq: cursor, wait_ms: 5000 });
            break;
          default:
            expect(JSON.stringify(request.messages)).toContain(complete);
            events = [
              {
                type: 'text_delta',
                text: 'Final summary: Blue was confirmed by the human and applied. Inspection and palette work are complete; the earlier pending result was not business completion.',
              },
              finish,
            ];
        }
        for (const event of events) yield event;
      },
    };
    const child: ModelAdapter = {
      async *stream(request) {
        if (
          request.messages.some((message) => message.content.includes('QUESTION_LOOP_SUMMARIZE'))
        ) {
          yield { type: 'text_delta', text: summary };
          yield finish;
          return;
        }
        childRequests.push(structuredClone(request));
        const tool = request.messages.filter((message) => message.role === 'tool').at(-1);
        let events: ModelEvent[];
        switch (childCalls++) {
          case 0:
            await initialGate;
            events = call('send_agent_message', { target: 'parent', content: question });
            break;
          case 1:
            expect(JSON.parse(tool!.content)).toMatchObject({ accepted: true, delivery: 'queued' });
            events = call('wait_agent_events', { wait_ms: 25 });
            break;
          case 2:
            if (carried) expect(JSON.stringify(request.messages)).toContain(summary);
            else expect(JSON.parse(tool!.content)).toMatchObject({ reason: 'timeout' });
            events = [{ type: 'text_delta', text: pending }, finish];
            break;
          default:
            expect(JSON.stringify(request.messages)).toContain('The human clarified');
            if (compressedSourceId)
              expect(
                request.messages.some(
                  (message) =>
                    message.sourceIds?.includes(compressedSourceId!) &&
                    message.content.includes(summary),
                ),
              ).toBe(true);
            events = [{ type: 'text_delta', text: complete }, finish];
        }
        for (const event of events) yield event;
      },
    };
    const task = createTaskExtension({
      roles: [{ id: 'worker', configurationId: 'worker', description: 'bounded collaborator' }],
    });
    // No on* callbacks or test notification observers participate in delivery.
    const runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      model: parent,
      modelId: 'parent',
      modelConcurrency: 1,
      compressor: {
        id: 'question-loop.summary',
        version: '1',
        async shouldCompress(input) {
          return (
            carried &&
            !compressionTriggered &&
            input.session.parentSessionId !== null &&
            input.messages.some((message) => message.content.includes('"reason":"timeout"'))
          );
        },
        async prepare(input) {
          expect(input.session.parentSessionId).not.toBeNull();
          compressionTriggered = true;
          return {
            instructions: 'QUESTION_LOOP_SUMMARIZE preserve pending facts, never authorize work',
            snapshot: { scope: 'pending-child' },
          };
        },
        async validateSummary(input) {
          return input.summary === summary;
        },
      },
      extensions: [task, createAskUserExtension()],
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'trusted' };
        },
      },
      afterTurn: {
        async authorize() {
          return { allowed: true, revision: 'idle-parent-report' };
        },
      },
      childConfigurations: [
        {
          id: 'worker',
          version: '1',
          model: child,
          modelId: 'child',
          toolIds: task.tools!.filter((tool) => !tool.model?.hidden).map((tool) => tool.id),
          snapshot: {},
        },
      ],
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'private',
        rootUri: pathToFileURL(directory).href,
      });
      await runtime.createSession({
        ...identity,
        commandId: 'create',
        workspaceId: 'w',
        title: 'question loop',
      });
      await runtime.submitCommand({
        ...identity,
        commandId: 'work',
        request: {
          kind: 'run.start',
          content:
            'Inspect the deliverable and finish only after the required palette is confirmed.',
        },
      });
      await runtime.waitForCommand('work', { timeoutMs: 7000 });
      const firstRoot = (await store.getView('root')).runs[0]!;
      expect(firstRoot.status).toBe('completed');
      expect(firstRoot.isActive).toBe(false);
      releaseChild();
      if (!carried) {
        const receive = await until(async () => intercepted);
        const mailId = receive.messageIds[0]!;
        const database = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
        const cursor = (await store.getMetadata()).lastChangeCursor;
        try {
          database.exec(
            `CREATE TRIGGER isolated_mail_fault BEFORE INSERT ON message WHEN NEW.id='agent-mail-${mailId}' BEGIN SELECT RAISE(ABORT,'isolated receive transaction fault'); END`,
          );
          let failed = false;
          try {
            await receiveOriginal(receive);
          } catch {
            failed = true;
          }
          expect(failed).toBe(true);
          expect(
            (await store.getAgentMessage({ ...identity, messageId: mailId }))!.receivedMessageId,
          ).toBeNull();
          expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
        } finally {
          database.exec('DROP TRIGGER IF EXISTS isolated_mail_fault');
          database.close();
        }
        let replyLost = false;
        try {
          await receiveOriginal(receive);
          throw Error('isolated committed receive response lost');
        } catch {
          replyLost = true;
        }
        expect(replyLost).toBe(true);
        const afterCommit = (await store.getMetadata()).lastChangeCursor;
        const retries = await Promise.all([receiveOriginal(receive), receiveOriginal(receive)]);
        expect(retries).toEqual([[`agent-mail-${mailId}`], [`agent-mail-${mailId}`]]);
        expect((await store.getMetadata()).lastChangeCursor).toBe(afterCommit);
        releaseReceive();
      }
      const card = await until(async () =>
        (await store.listInteractions({ ...identity, state: 'pending' })).interactions.find(
          (value) => value.definitionId === 'ask_user',
        ),
      );
      const beforeAnswer = await store.getView(agentId);
      expect(beforeAnswer.runs).toHaveLength(1);
      expect(beforeAnswer.runs[0]!.status).toBe('completed');
      const firstCarrier = (await store.listExecutions('root')).find(
        (execution) => execution.childSessionId === agentId,
      )!;
      expect(firstCarrier.status).toBe('succeeded');
      expect((firstCarrier.result as { content: string }).content).toBe(pending);
      const waits = beforeAnswer.executions.filter(
        (execution) => execution.definitionId === 'task.events',
      );
      expect(waits).toHaveLength(1);
      expect(waits[0]!.input).toMatchObject({ waitMs: 25 });
      const mail = (await store.listAgentMessages({ ...identity })).items[0]!;
      expect(mail.targetRunId).toBeNull();
      expect(mail.receivedMessageId === null).toBe(carried);
      const receipt = (await store.getCommand(mail.id))!.receipt;
      if (carried)
        expect(receipt).toMatchObject({
          carriedByResult: {
            executionId: firstCarrier.id,
            resultRevision: firstCarrier.resultRevision,
          },
        });
      else {
        expect(receipt).not.toHaveProperty('carriedByResult');
        const rootView = await store.getView('root');
        const owner = {
          sessionId: 'root',
          instanceId: rootView.session.ownerInstanceId!,
          generation: rootView.session.ownerGeneration,
        };
        const receive = {
          expectedStoreId,
          owner,
          runId: mail.receivedRunId!,
          messageIds: [mail.id],
        };
        const before = (await store.getMetadata()).lastChangeCursor;
        const consumers = await Promise.all([
          store.receiveAgentMessages(receive),
          store.receiveAgentMessages(receive),
        ]);
        expect(consumers).toEqual([[mail.receivedMessageId!], [mail.receivedMessageId!]]);
        expect((await store.getMetadata()).lastChangeCursor).toBe(before);
      }
      if (carried) {
        const selection = beforeAnswer.session.contextSelectionId;
        const selected = await store.getSelectedContext({ expectedStoreId, sessionId: agentId });
        expect(selected.selection.id).toBe(selection);
        expect(selected.compression).toBeDefined();
        compressedSourceId = selected.compression!.id;
      }
      await runtime.answerInteraction({
        ...identity,
        commandId: 'human-blue',
        presentationSessionId: card.presentationSessionId,
        interactionId: card.id,
        expectedRevision: card.revision,
        answer: { kind: 'question', answers: { q1: 'q1-o1' } },
      });
      await until(async () => {
        const view = await store.getView('root');
        return view.messages.find(
          (message) =>
            message.role === 'assistant' && message.content.includes('Final summary: Blue'),
        );
      });
      const childView = await store.getView(agentId);
      expect(
        childView.runs.filter((run) => run.originCommandId.startsWith('child-start-')),
      ).toHaveLength(2);
      expect(childView.runs.every((run) => run.status === 'completed')).toBe(true);
      const finalRoot = await store.getView('root');
      expect(finalRoot.runs).toHaveLength(2);
      expect(
        finalRoot.executions.filter((execution) => execution.childSessionId === agentId),
      ).toHaveLength(2);
      expect(
        finalRoot.messages.filter((message) => message.sourceIds?.includes(mail.id)),
      ).toHaveLength(carried ? 0 : 1);
      expect(
        (await store.getAgentMessage({ ...identity, messageId: mail.id }))!.receivedMessageId ===
          null,
      ).toBe(carried);
    } finally {
      releaseReceive();
      releaseChild();
      await runtime.close();
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20000);

test('ordinary human successor does not adopt queued mail or retarget R1, and a lost QueueOnly response creates no second mail', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-parent-mail-cutoff-')));
  const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile),
    expectedStoreId = (await store.getMetadata()).storeId;
  const identity = { expectedStoreId, sessionId: 'root', subjectId: 'owner' };
  const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  };
  const parentFinish = gate(),
    successorFinish = gate(),
    firstSender = gate(),
    lateSender = gate(),
    childFinish = gate();
  const queued: { id: string; source: string }[] = [];
  const originalQueue = store.queueAgentMessage.bind(store);
  let lostResponse = false;
  store.queueAgentMessage = async (input) => {
    const receipt = await originalQueue(input);
    queued.push({ id: receipt.id, source: input.sourceExecutionId });
    if (queued.length === 1) {
      await firstSender.promise;
      lostResponse = true;
      throw Error('isolated response lost after durable QueueOnly commit');
    }
    if (queued.length === 2) await lateSender.promise;
    return receipt;
  };
  let rootCalls = 0,
    childCalls = 0,
    childId = '';
  const requests: ModelRequest[] = [];
  const parent: ModelAdapter = {
    async *stream(request) {
      requests.push(structuredClone(request));
      if (rootCalls++ === 0)
        for (const event of call('spawn_agent', {
          prompt: 'Send progress and await the explicitly authorized continuation.',
        }))
          yield event;
      else {
        if (rootCalls === 2) await parentFinish.promise;
        else await successorFinish.promise;
        yield {
          type: 'text_delta',
          text:
            rootCalls === 2
              ? 'Parent ordinary round ended.'
              : 'Continued same work without adopting late or obsolete mail.',
        };
        yield finish;
      }
    },
  };
  const child: ModelAdapter = {
    async *stream() {
      const text = [
        'Bound only to R1',
        'Queued before successor but confirmed after its cursor',
        'Queued after successor sequence cutoff',
      ][childCalls++];
      if (text)
        for (const event of call('send_agent_message', { target: 'parent', content: text }))
          yield event;
      else {
        await childFinish.promise;
        yield { type: 'text_delta', text: 'Child round ended.' };
        yield finish;
      }
    },
  };
  const task = createTaskExtension({
    roles: [{ id: 'worker', configurationId: 'worker', description: 'bounded' }],
  });
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model: parent,
    modelId: 'parent',
    modelConcurrency: 2,
    extensions: [task],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'actual' };
      },
    },
    childConfigurations: [
      {
        id: 'worker',
        version: '1',
        model: child,
        modelId: 'child',
        snapshot: {},
        toolIds: task.tools!.filter((tool) => !tool.model?.hidden).map((tool) => tool.id),
      },
    ],
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'private',
      rootUri: pathToFileURL(directory).href,
    });
    await runtime.createSession({
      ...identity,
      commandId: 'create',
      workspaceId: 'w',
      title: 'mail watermarks',
    });
    await runtime.submitCommand({
      ...identity,
      commandId: 'work',
      request: { kind: 'run.start', content: 'Original A work' },
    });
    await until(async () => (queued.length === 1 && requests.length === 2 ? true : undefined));
    const firstRun = (await store.getView('root')).runs[0]!;
    const firstMail = (await store.getAgentMessage({ ...identity, messageId: queued[0]!.id }))!;
    expect(firstMail.targetRunId).toBe(firstRun.id);
    expect(firstMail.state).toBe('pending_sender');
    parentFinish.release();
    await runtime.waitForCommand('work', { timeoutMs: 7000 });
    firstSender.release();
    await until(async () => (queued.length === 2 ? true : undefined));
    expect(lostResponse).toBe(true);
    const secondMail = (await store.getAgentMessage({ ...identity, messageId: queued[1]!.id }))!;
    expect(secondMail.targetRunId).toBeNull();
    expect(secondMail.state).toBe('pending_sender');
    await runtime.submitCommand({
      ...identity,
      commandId: 'continue-A',
      request: {
        kind: 'input.follow_up',
        afterRunId: firstRun.id,
        contextSelectionId: firstRun.contextSelectionId,
        content: '追加 work 的实际说明。',
      },
    });
    await until(async () => (requests.length === 3 ? true : undefined));
    const secondRun = (await store.getView('root')).runs.find((run) => run.id !== firstRun.id)!;
    expect(secondRun.rootWorkCommandId).toBe('continue-A');
    const sealed = (await store.getCommand(secondRun.originCommandId))!.receipt as {
      mailAdoption?: { parentRunId: string };
    };
    expect(sealed.mailAdoption).toBeUndefined();
    lateSender.release();
    await until(async () =>
      queued.length === 3 &&
      (await store.getAgentMessage({ ...identity, messageId: queued[2]!.id }))!.state === 'accepted'
        ? true
        : undefined,
    );
    const all = await store.listAgentMessages({ ...identity });
    expect(all.items).toHaveLength(3);
    expect(all.items.every((mail) => mail.receivedMessageId === null)).toBe(true);
    expect(
      (await store.listAgentMessages({ ...identity, runId: secondRun.id, pendingOnly: true }))
        .items,
    ).toHaveLength(0);
    const rootView = await store.getView('root');
    const owner = {
      sessionId: 'root',
      instanceId: rootView.session.ownerInstanceId!,
      generation: rootView.session.ownerGeneration,
    };
    for (const mail of all.items) {
      let rejected = false;
      try {
        await store.receiveAgentMessages({
          expectedStoreId,
          owner,
          runId: secondRun.id,
          messageIds: [mail.id],
        });
      } catch (error) {
        expect((error as { code: string }).code).toBe('agent_message_not_found');
        rejected = true;
      }
      expect(rejected).toBe(true);
    }
    expect(
      (await store.getAgentMessage({ ...identity, messageId: firstMail.id }))!.targetRunId,
    ).toBe(firstRun.id);
    successorFinish.release();
    await runtime.waitForCommand('continue-A', { timeoutMs: 7000 });
    childId = (await store.listExecutions('root')).find((execution) => execution.childSessionId)!
      .childSessionId!;
    const childRun = (await store.getView(childId)).runs[0]!;
    await runtime.cancelRun({
      ...identity,
      sessionId: childId,
      commandId: 'stop-child',
      runId: childRun.id,
    });
    childFinish.release();
  } finally {
    parentFinish.release();
    successorFinish.release();
    firstSender.release();
    lateSender.release();
    childFinish.release();
    await runtime.close();
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
