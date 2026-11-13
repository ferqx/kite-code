import type {
  AgentClient,
  Command,
  Execution,
  ExtensionCommandRequest,
  SessionView,
} from '@kite-ai/client';
import { expect, test } from '#kite-test';
import { callerTextDigest, canonicalNativeCallerRequest } from '../../electron/caller-journal';
import { NativeCaller } from '../../electron/native-caller';
import type { NativeExtensionHead } from '../../src/extensions-bridge';
import type { NativeRequest, NativeState } from '../../src/native-bridge';
import { memoryPrivateData } from '../private-data.fixture';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Real Caller/Extensions/journal with finite in-memory client ports only. No Service,
 * Runtime, model, Electron, browser daemon, filesystem profile or network listener starts. */
async function fixture() {
  const data = memoryPrivateData();
  const commands = new Map<string, Command>(),
    executions = new Map<string, Execution>();
  const submitted: { sessionId: string; request: ExtensionCommandRequest }[] = [];
  const requests: NativeRequest[] = [],
    publications: (string | undefined)[] = [];
  let prepareGate: ReturnType<typeof deferred> | undefined,
    ackGate: ReturnType<typeof deferred> | undefined;
  const prepareEntered = deferred(),
    admitted = deferred();
  const view = (id: string) =>
    ({
      storeId: 'store',
      snapshotCursor: '0',
      session: {
        id,
        workspaceId: 'workspace',
        rootSessionId: id,
        parentSessionId: null,
        title: `Session ${id}`,
        nextSeq: '0',
        contextSelectionId: `context-${id}`,
        controlRevision: '0',
        deletedAt: null,
      },
      runs: [],
      executions: [],
      messages: [],
    }) as unknown as SessionView;
  const client = {
    serverInfo: {
      storeId: 'store',
      subjectId: 'local-user',
      capabilities: ['extension_queries', 'extensions_actions', 'commands'],
    },
    connect: async () => ({}),
    async observe({ signal }: { signal: AbortSignal }) {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    },
    async getView(id: string) {
      if (id === 'a' && prepareGate) {
        prepareEntered.release();
        await prepareGate.promise;
      }
      return view(id);
    },
    listWorkspaces: async () => [],
    listAllWorkspaces: async () => [],
    listAllSessions: async () => [],
    listSessions: async () => [],
    listExtensions: async () => [
      {
        extensionId: 'builtin.browser',
        version: '1',
        actions: [
          {
            id: 'browser.respond_human',
            version: '1',
            description: 'Respond to an exact human request',
            inputSchema: { type: 'object' },
          },
        ],
        queries: [],
      },
    ],
    async invokeExtension(sessionId: string, request: ExtensionCommandRequest) {
      submitted.push({ sessionId, request: structuredClone(request) });
      const executionId = `execution-${request.commandId}`;
      executions.set(executionId, {
        id: executionId,
        originStoreId: 'store',
        sessionId,
        kind: 'job',
        runId: null,
        parentExecutionId: null,
        definitionId: 'builtin.browser/browser.respond_human',
        definitionVersion: '1',
        status: 'succeeded',
        resultRevision: '1',
      } as Execution);
      const command = {
        id: request.commandId,
        sessionId,
        originStoreId: 'store',
        subjectId: 'local-user',
        kind: 'extension.invoke',
        status: 'applied',
        requestDigest: callerTextDigest(canonicalNativeCallerRequest(request)),
        receipt: {
          executionId,
          status: 'succeeded',
          preparingNextAttempt: false,
          finalizationDigest: 'c'.repeat(64),
        },
      } as unknown as Command;
      commands.set(command.id, command);
      admitted.release();
      await ackGate?.promise;
      return command;
    },
    getCommand: async (id: string) => commands.get(id),
    getExecution: async (id: string) => executions.get(id),
    disposeNetwork() {},
  } as unknown as AgentClient;
  const caller = new NativeCaller(
    client,
    () => publications.push(caller.state().selection?.session.id),
    data,
  );
  const invoke = (request: NativeRequest) => {
    requests.push(structuredClone(request));
    return caller.invoke(request);
  };
  const attached = (await invoke({ method: 'attach' })) as NativeState;
  const generation = attached.generation;
  const selected = (await invoke({
    method: 'select',
    generation,
    sessionId: 'a',
    activationId: 1,
  })) as NativeState;
  const head = (await invoke({
    method: 'extensions.open',
    generation,
    viewSelection: selected.selection!.viewSelection!,
    historyEpoch: selected.historyEpoch ?? 0,
    readId: 'catalogue',
  })) as NativeExtensionHead;
  await invoke({
    method: 'extensions.read',
    generation,
    readId: head.readId,
    offset: 0,
    limit: 65536,
  });
  return {
    caller,
    data,
    commands,
    submitted,
    requests,
    publications,
    generation,
    invoke,
    prepareEntered: prepareEntered.promise,
    admitted: admitted.promise,
    holdPrepare() {
      prepareGate = deferred();
      return prepareGate;
    },
    holdAck() {
      ackGate = deferred();
      return ackGate;
    },
    respond: () =>
      invoke({
        method: 'extensions.invoke',
        generation,
        observationId: head.observationId,
        extensionId: 'builtin.browser',
        actionId: 'browser.respond_human',
        definitionVersion: '1',
        commandId: 'response',
        input: {
          browserId: 'browser-a',
          generation: 'human-generation',
          requestId: 'human-request',
          expectedRevision: '1',
          choice: 'continue',
        },
      }),
    async close() {
      prepareGate?.release();
      ackGate?.release();
      await caller.close();
      data.close();
    },
  };
}

test('immediate B selection revokes a preparing A human response before any command admission', async () => {
  const f = await fixture();
  const gate = f.holdPrepare();
  let response: Promise<unknown> | undefined;
  try {
    response = f.respond().catch((error: Error) => error);
    // Do not wait for prepare/admission before reproducing the real UI switch.
    const selectingB = f.invoke({
      method: 'select',
      generation: f.generation,
      sessionId: 'b',
      activationId: 2,
    });
    await selectingB;
    const boundary = f.publications.length;
    expect(f.caller.state().selection?.session.id).toBe('b');
    expect(f.commands.size).toBe(0);
    expect(f.data.callers()).toHaveLength(0);
    await f.prepareEntered;
    gate.release();
    expect(await response).toMatchObject({ message: 'extensions_observation_unavailable' });
    expect(f.commands.size).toBe(0);
    expect(f.submitted).toHaveLength(0);
    expect(f.data.callers()).toMatchObject([
      { phase: 'submitting', intent: { scope: { sessionId: 'a' } } },
    ]);
    // A saved first intent cannot turn a later lookup into its first POST.
    await f.invoke({
      method: 'extensions.lookup',
      generation: f.generation,
      commandId: 'response',
    });
    expect(f.submitted).toHaveLength(0);
    expect(f.caller.state().selection?.session.id).toBe('b');
    expect(f.publications.slice(boundary).every((id) => !id || id === 'b')).toBe(true);
    expect(f.requests.filter((request) => request.method === 'select')).toMatchObject([
      { sessionId: 'a', activationId: 1 },
      { sessionId: 'b', activationId: 2 },
    ]);
  } finally {
    gate.release();
    await response;
    await f.close();
  }
});

test('an admitted A response with a late ACK cannot select A after B; only a new explicit select can', async () => {
  const f = await fixture();
  const gate = f.holdAck();
  let response: Promise<unknown> | undefined;
  try {
    response = f.respond();
    await f.admitted;
    expect(f.commands.size).toBe(1);
    await f.invoke({ method: 'select', generation: f.generation, sessionId: 'b', activationId: 2 });
    const boundary = f.publications.length;
    gate.release();
    expect(await response).toMatchObject({ outcome: 'succeeded' });
    expect(f.commands.size).toBe(1);
    expect(f.submitted).toHaveLength(1);
    expect(f.submitted[0]?.sessionId).toBe('a');
    expect(f.data.callers()).toMatchObject([
      { phase: 'applied', intent: { scope: { sessionId: 'a' } } },
    ]);
    expect(f.caller.state().selection?.session.id).toBe('b');
    expect(f.publications.slice(boundary).every((id) => !id || id === 'b')).toBe(true);
    await expect(
      f.invoke({ method: 'select', generation: f.generation, sessionId: 'a', activationId: 1 }),
    ).rejects.toMatchObject({ code: 'native_selection_changed' });
    expect(f.caller.state().selection?.session.id).toBe('b');
    await f.invoke({ method: 'select', generation: f.generation, sessionId: 'a', activationId: 3 });
    expect(f.caller.state().selection?.session.id).toBe('a');
  } finally {
    gate.release();
    await response;
    await f.close();
  }
});
