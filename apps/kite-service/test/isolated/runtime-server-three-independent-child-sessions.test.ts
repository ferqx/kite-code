import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childThreadIdForToolAttempt } from '@kite-ai/agent-kernel';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import { RUNTIME_COMMAND_SCHEMA_, RUNTIME_QUERY_SCHEMA_ } from '@kite-ai/runtime-contract';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type {
  RuntimeServerAdmissionInput,
  RuntimeServerAdmissionPort,
} from '@kite-ai/runtime-server';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import {
  createKiteMultiWorkspaceRuntimeServer,
  createKiteSessionAppServerStorageComposition,
} from '../../src/bootstrap';

const labels = ['A', 'B', 'C'] as const;
type Label = (typeof labels)[number];

test('default Store11 App Server isolates three required child Sessions through partial settlement', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-three-independent-child-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(home, 'kite-session.sqlite');
  const parentSessionId = 'three-independent-parent';
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = home;
  const model = createMockModelServer();
  const gates = Object.fromEntries(labels.map((label) => [label, deferred()])) as Record<
    Label,
    ReturnType<typeof deferred>
  >;
  const childRequests = Object.fromEntries(labels.map((label) => [label, 0])) as Record<
    Label,
    number
  >;
  let parentRequests = 0;
  let finalParentRequests = 0;
  model.setResponses(
    Array.from({ length: 16 }, () => ({
      response: async ({ messages }: { messages: readonly unknown[] }) => {
        const transcript = JSON.stringify(messages);
        const childLabels = labels.filter((label) => transcript.includes(`TRIPLE_CHILD_${label}`));
        if (!transcript.includes('TRIPLE_PARENT') && childLabels.length > 0) {
          expect(childLabels).toHaveLength(1);
          const label = childLabels[0]!;
          for (const other of labels.filter((candidate) => candidate !== label))
            expect(transcript).not.toContain(`TRIPLE_CHILD_${other}`);
          childRequests[label] += 1;
          await gates[label].promise;
          return { message: { content: `TRIPLE_RESULT_${label}` } };
        }
        parentRequests += 1;
        if (parentRequests === 1)
          return {
            message: {
              tool_calls: labels.map((label) => ({
                id: `start-triple-${label}`,
                name: 'task',
                args: {
                  name: `Independent ${label}`,
                  subagent_type: 'review',
                  task: `TRIPLE_CHILD_${label}`,
                  background: true,
                  result_disposition: 'required',
                },
              })),
            },
            toolContinuation: 'required' as const,
          };
        const allSettled = labels.every((label) => transcript.includes(`TRIPLE_RESULT_${label}`));
        if (!allSettled)
          return {
            message: { content: 'Provisional final while required children remain.' },
            expectedRequest: {
              toolResults: labels.map((label) => ({ toolCallId: `start-triple-${label}` })),
            },
          };
        finalParentRequests += 1;
        expect(transcript).toContain('<subagent_result task_id=');
        expect(transcript).toContain('TRIPLE_RESULT_A');
        expect(transcript).toContain('TRIPLE_RESULT_B');
        expect(transcript).toContain('TRIPLE_RESULT_C');
        return { message: { content: 'All three independent children settled.' } };
      },
    })),
  );
  const storage = await createKiteSessionAppServerStorageComposition({
    databasePath,
    hostInstanceId: 'three-independent-host',
  });
  const server = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: databasePath,
    storageOwner: storage,
    workspaces: [
      {
        userId: 'three-independent-user',
        workspace,
        config: {
          providerName: 'three-independent-model',
          providerType: 'openai-compatible' as const,
          apiKey: 'fixture-key',
          baseURL: model.baseURL,
          modelName: 'mock-model',
          modelKwargs: { maxOutputTokens: 64 },
          modelCapabilities: { contextWindowTokens: 4_096, maxOutputTokens: 64 },
          features: { resourceBudget: true },
          sandbox: { enabled: false },
        },
        shellExecutor: async ({ command }: { command: string }) => ({
          ok: true as const,
          command,
          exitCode: 0,
          stdout: '',
          stderr: '',
        }),
        interactionMode: 'accept_edits' as const,
        sandboxBackend: 'none' as const,
        skillOptions: {
          userKiteCodeSkillsDir: join(workspace, 'user-kite-skills'),
          userAgentsSkillsDir: join(workspace, 'user-agent-skills'),
          projectKiteCodeSkillsDir: join(workspace, '.kite-code', 'skills'),
          projectAgentsSkillsDir: join(workspace, '.agents', 'skills'),
        },
        initialSkillActivations: [],
      },
    ],
  });
  const admission: RuntimeServerAdmissionPort = Object.freeze({
    authorize: async (_request: RuntimeServerAdmissionInput) => ({
      allowed: true as const,
      workspace,
    }),
  });
  const transport: RuntimeClientTransport = Object.freeze({
    connect: async () => {
      const pair = server.open({ admission });
      return Object.freeze({
        send: (message: RuntimeProtocolMessage) => pair.client.send(message),
        messages: () => pair.client.messages(),
        close: (reason?: string) => pair.client.close(reason),
      });
    },
  });
  const client = new RuntimeClient({
    transport,
    clientInfo: { name: 'three-independent-child-test', version: '1', instanceId: 'client' },
  });
  const parentEvents = () =>
    storage.storage.sessions.loadEventsStrict(parentSessionId).map(({ event }) => event);
  try {
    const created = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'create_session',
      commandId: 'three-independent-create',
      workspace,
      bootstrapSessionId: parentSessionId,
    });
    expect(created.status).toBe('applied');
    if (created.status !== 'applied') throw new Error('Parent Session creation failed.');
    expect(
      await client.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'start_turn',
        commandId: 'three-independent-start',
        sessionId: parentSessionId,
        expectedRevision: created.revision,
        input: 'TRIPLE_PARENT',
      }),
    ).toMatchObject({ status: 'applied' });
    const childIdFor = (label: Label): string | undefined => {
      const dispatch = parentEvents().find(
        (event) =>
          event.type === 'capability.subagent_dispatch_intent_recorded' &&
          storage.loadCurrentSnapshot(parentSessionId)?.capabilities.invocations[event.invocationId]
            ?.toolCallId === `start-triple-${label}`,
      );
      return dispatch?.type === 'capability.subagent_dispatch_intent_recorded'
        ? childThreadIdForToolAttempt({
            parentSessionId,
            parentInvocationId: dispatch.invocationId,
            parentToolCallId: `start-triple-${label}`,
            attempt: dispatch.attempt,
          })
        : undefined;
    };
    const assertParentStillWaiting = async () => {
      await Bun.sleep(50);
      expect(finalParentRequests).toBe(0);
      expect(
        parentEvents().some((event) => event.type === 'run.error' || event.type === 'turn.aborted'),
      ).toBe(false);
    };
    await until(() => childIdFor('A') !== undefined && childRequests.A === 1).catch(() => {
      throw new Error(
        `Child A did not start: ${JSON.stringify({
          childRequests,
          childIds: labels.map((label) => childIdFor(label)),
          parentEvents: parentEvents().map((event) => event.type),
          parentState: storage.loadCurrentSnapshot(parentSessionId)?.resourceBudget,
        })}`,
      );
    });
    const childA = childIdFor('A')!;
    expect(storage.readSessionLineage(childA)).toEqual({ parentSessionId });
    await until(() => childRequests.B === 1 && childIdFor('C') !== undefined);
    const queuedChildC = childIdFor('C')!;
    expect(storage.readChildSessionIntent(queuedChildC)).not.toBeNull();
    expect(storage.loadCurrentSnapshot(queuedChildC)?.revision).toBe(0);
    expect(storage.readSessionLineage(queuedChildC)).toEqual({ parentSessionId });
    for (const childId of [childA, childIdFor('B')!, queuedChildC])
      expect(storage.readChildExecutionAuthority(parentSessionId, childId)).toMatchObject({
        status: 'active',
        controllerGeneration: 1,
      });
    expect(storage.loadCurrentSnapshot(parentSessionId)?.resourceBudget).toMatchObject({
      reservations: {
        [`child-allotment:${queuedChildC}`]: { state: 'queued' },
      },
    });
    expect(childRequests.C).toBe(0);
    gates.A.resolve();
    await until(() => storage.readChildSessionIntent(childA)?.parentClaimSettledEventId != null);
    expect(
      parentEvents()
        .filter((event) => event.type === 'resource_budget.reconciled')
        .at(-1),
    ).toMatchObject({
      actual: { gauges: { activeSubagents: 0 } },
    });
    await assertParentStillWaiting();

    await until(() => childIdFor('B') !== undefined && childRequests.B === 1).catch(() => {
      const diagnostic = JSON.stringify({
        childRequests,
        childIds: labels.map((label) => childIdFor(label)),
        parentEvents: parentEvents().map((event) => event.type),
      });
      throw new Error(`Child B did not start: ${diagnostic}`);
    });
    const childBId = childIdFor('B')!;
    const aTerminalRevision = storage.loadCurrentSnapshot(childA)!.revision;
    expect(storage.readSessionLineage(childBId)).toEqual({ parentSessionId });
    const bActiveRevision = storage.loadCurrentSnapshot(childBId)!.revision;
    await until(() => childRequests.C === 1).catch(() => {
      const diagnostic = JSON.stringify({
        childRequests,
        childIds: labels.map((label) => childIdFor(label)),
        parentEvents: parentEvents().map((event) => event.type),
        budget: (() => {
          const budget = storage.loadCurrentSnapshot(parentSessionId)?.resourceBudget;
          return budget?.status === 'active'
            ? {
                reservations: Object.values(budget.reservations).map((reservation) => [
                  reservation.invocationId,
                  reservation.state,
                  reservation.executableUpperBound.gauges.activeSubagents,
                  reservation.actual?.gauges.activeSubagents,
                  reservation.actual?.gauges.elapsedRunMs,
                ]),
                waiters: budget.waiters,
              }
            : budget?.status;
        })(),
      });
      throw new Error(`Queued child C did not start after A settlement: ${diagnostic}`);
    });
    const childC = childIdFor('C')!;
    expect(storage.readChildSessionIntent(childC)?.childSessionCreated).toBe(true);
    expect(storage.readSessionLineage(childC)).toEqual({ parentSessionId });
    const cActiveRevision = storage.loadCurrentSnapshot(childC)!.revision;
    expect(cActiveRevision).toBeGreaterThan(0);
    expect(storage.loadCurrentSnapshot(childBId)?.revision).toBe(bActiveRevision);
    expect(storage.loadCurrentSnapshot(childA)?.revision).toBe(aTerminalRevision);
    expect(new Set([childA, childBId, childC]).size).toBe(3);
    expect(storage.listCurrentSessions('', 10).map((entry) => entry.threadId)).toEqual([
      parentSessionId,
    ]);
    await assertParentStillWaiting();
    const background = await client.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'list_background_executions',
      sessionId: parentSessionId,
    });
    expect(background.status).toBe('ok');
    if (background.status !== 'ok') throw new Error('Parent background query failed.');
    const childB = background.backgroundSnapshot?.executions.find(
      (execution) =>
        execution.executionId === storage.readChildSessionIntent(childBId)?.childInvocationId,
    );
    if (!childB) throw new Error('Independent child B was absent from the parent query.');
    expect(childB.status).toBe('running');
    gates.C.resolve();
    await until(() => storage.readChildSessionIntent(childC)?.parentClaimSettledEventId != null);
    const cTerminalRevision = storage.loadCurrentSnapshot(childC)!.revision;
    expect(storage.loadCurrentSnapshot(childBId)?.revision).toBe(bActiveRevision);
    await assertParentStillWaiting();
    gates.B.resolve();
    await until(() => storage.readChildSessionIntent(childBId)?.parentClaimSettledEventId != null);
    await until(() => parentEvents().some((event) => event.type === 'run.completed'));
    const finalEvents = parentEvents();
    expect(
      finalEvents.filter((event) => event.type === 'subagent.child_terminal_imported'),
    ).toHaveLength(3);
    expect(
      finalEvents.filter((event) => event.type === 'subagent.child_creation_failed'),
    ).toHaveLength(0);
    expect(
      finalEvents.filter((event) => event.type === 'subagent.background_result_persisted'),
    ).toHaveLength(3);
    expect(finalEvents.filter((event) => event.type === 'run.completed')).toHaveLength(1);
    expect(
      finalEvents.some((event) => event.type === 'run.error' || event.type === 'turn.aborted'),
    ).toBe(false);
    expect(storage.loadCurrentSnapshot(childA)?.childSessionOrigin?.terminal?.status).toBe(
      'completed',
    );
    expect(storage.loadCurrentSnapshot(childBId)?.childSessionOrigin?.terminal?.status).toBe(
      'completed',
    );
    expect(storage.loadCurrentSnapshot(childC)?.childSessionOrigin?.terminal?.status).toBe(
      'completed',
    );
    expect(storage.loadCurrentSnapshot(childA)?.revision).toBe(aTerminalRevision);
    expect(storage.loadCurrentSnapshot(childC)?.revision).toBe(cTerminalRevision);
    expect(finalParentRequests).toBe(1);
    expect(childRequests).toEqual({ A: 1, B: 1, C: 1 });
  } finally {
    for (const gate of Object.values(gates)) gate.resolve();
    await client.close();
    await server[Symbol.asyncDispose]();
    storage.disposeStorage();
    model.assertComplete({ allowUnconsumedResponses: true });
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 40_000);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate())
    throw new Error('Three independent child Sessions did not cross a durable boundary.');
}
