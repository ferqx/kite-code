import type {
  AgentClient,
  Command,
  Execution,
  ExtensionCatalogue,
  ExtensionCommandRequest,
  PublicView,
} from '@kite-ai/client';
import { NativeExtensions } from '../electron/extensions';
import { decodeNativeRequest } from '../electron/native-ipc';
import type { AgentBrowserView } from '../src/agent-browser-view';
import type { NativeExtensionScope } from '../src/extensions-bridge';
import type { NativeBridge, NativeCallerRecord, NativeRequest } from '../src/native-bridge';

export const browserScope: NativeExtensionScope = {
  generation: 1,
  viewSelection: 1,
  historyEpoch: 0,
  storeId: 'store',
  sessionId: 'session',
  workspaceId: 'workspace',
  contextSelectionId: 'context',
};
export function browserView(): AgentBrowserView {
  return {
    browserId: 'browser',
    generation: 'browser-generation',
    seq: '1',
    state: 'agent',
    url: 'https://example.test/',
    title: 'Example',
    frame: { mimeType: 'image/jpeg', data: '/9j/2Q==', width: 800, height: 600, seq: '1' },
    annotations: [
      {
        ref: '@e1',
        number: 1,
        role: 'button',
        name: 'Continue',
        box: { x: 100, y: 100, width: 200, height: 80 },
      },
    ],
    selectedAnnotation: null,
  };
}
export function browserFixture() {
  let currentScope: NativeExtensionScope | undefined = { ...browserScope };
  let view = browserView();
  let queryGate: Promise<void> | undefined;
  let drop = false,
    foreignHead = false,
    inFlight = 0,
    maxInFlight = 0,
    handoffs = 0,
    resumes = 0;
  const responseGates = new Map<NativeRequest['method'], () => Promise<void>>();
  const calls: NativeRequest[] = [],
    submitted: ExtensionCommandRequest[] = [],
    records: NativeCallerRecord[] = [];
  const commands = new Map<string, Command>(),
    executions = new Map<string, Execution>();
  const catalogue: ExtensionCatalogue[] = [
    {
      extensionId: 'builtin.browser',
      version: '1',
      actions: ['handoff', 'resume', 'input', 'select', 'close'].map((action) => ({
        id: `browser.${action}`,
        version: '1',
        description: action,
        inputSchema: { type: 'object' },
      })),
      queries: [
        { id: 'browser.view', version: '1', description: 'View', inputSchema: { type: 'object' } },
      ],
    },
  ];
  const client = {
    serverInfo: { storeId: 'store', subjectId: 'local-user' },
    async listExtensions() {
      return structuredClone(catalogue);
    },
    async queryExtension() {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const payload = structuredClone(view);
      try {
        await queryGate;
        return [
          {
            extensionId: 'builtin.browser',
            contentType: 'application/vnd.kite.browser-view+json',
            contentVersion: 1,
            summary: 'Browser',
            payload,
            artifactRefs: [],
            actions: [],
          },
        ] as unknown as PublicView[];
      } finally {
        inFlight--;
      }
    },
    async getView(id: string) {
      return {
        storeId: 'store',
        session: { id, workspaceId: currentScope?.workspaceId ?? 'workspace' },
      };
    },
    async getExecution(id: string) {
      return executions.get(id);
    },
  } as unknown as AgentClient;
  const main = new NativeExtensions(client, () => currentScope, {
    async prepare(sessionId, request) {
      const row = {
        intent: {
          scope: {
            storeId: 'store',
            sessionId,
            workspaceId: currentScope?.workspaceId ?? 'workspace',
          },
          subjectId: 'local-user',
          request,
          target: { kind: 'session', id: sessionId },
          bodyDigest: 'a'.repeat(64),
          requestDigest: 'b'.repeat(64),
        },
        phase: 'submitting',
      } as NativeCallerRecord;
      records.push(row);
      return row;
    },
    async submit(commandId) {
      const row = records.find((row) => row.intent.request.commandId === commandId)!;
      const request = row.intent.request as ExtensionCommandRequest;
      submitted.push(request);
      const input = request.input as Record<string, unknown>;
      if (request.actionId === 'browser.handoff') {
        view.state = 'human';
        view.generation = `human-generation${++handoffs === 1 ? '' : `-${handoffs}`}`;
      }
      if (request.actionId === 'browser.resume') {
        view.state = 'agent';
        view.generation = `resumed-generation${++resumes === 1 ? '' : `-${resumes}`}`;
        view.selectedAnnotation = null;
      }
      if (request.actionId === 'browser.select')
        view.selectedAnnotation = view.annotations.find((item) => item.ref === input.ref) ?? null;
      if (request.actionId === 'browser.input') {
        view.seq = String(BigInt(view.seq) + 1n);
        view.selectedAnnotation = null;
      }
      if (request.actionId === 'browser.close') {
        view.state = 'closed';
        view.selectedAnnotation = null;
      }
      const executionId = `execution-${commandId}`;
      executions.set(executionId, {
        id: executionId,
        originStoreId: 'store',
        sessionId: row.intent.scope.sessionId,
        runId: null,
        parentExecutionId: null,
        kind: 'job',
        definitionId: `builtin.browser/${request.actionId}`,
        definitionVersion: '1',
        status: 'succeeded',
        resultRevision: '1',
      } as Execution);
      const command = {
        id: commandId,
        kind: 'extension.invoke',
        originStoreId: 'store',
        sessionId: row.intent.scope.sessionId,
        subjectId: 'local-user',
        requestDigest: row.intent.requestDigest,
        status: 'applied',
        receipt: {
          executionId,
          status: 'succeeded',
          preparingNextAttempt: false,
          finalizationDigest: 'c'.repeat(64),
        },
      } as unknown as Command;
      commands.set(commandId, command);
      row.phase = 'applied';
      if (drop) throw Error('lost_ack');
      return command;
    },
    async lookup(commandId) {
      if (drop) throw Error('offline');
      const command = commands.get(commandId);
      if (!command) throw Error('missing');
      return command;
    },
    records: () => records,
    releaseFirst() {},
  });
  const dispatch = {
    async request(raw: NativeRequest) {
      const request = decodeNativeRequest(raw);
      switch (request.method) {
        case 'extensions.open': {
          const head = await main.open(request);
          return foreignHead ? { ...head, scope: { ...head.scope, sessionId: 'foreign' } } : head;
        }
        case 'extensions.query':
          return main.query(request);
        case 'extensions.read':
          return main.read(request);
        case 'extensions.close':
          main.close(request.readId);
          return undefined;
        case 'extensions.release':
          main.release();
          return undefined;
        case 'extensions.invoke':
          return main.invoke(request);
        case 'extensions.lookup':
          return main.lookup(request.commandId);
        default:
          throw Error(`unexpected_bridge_call:${request.method}`);
      }
    },
  };
  const bridge = {
    async request(raw: NativeRequest) {
      calls.push(raw);
      const gate = responseGates.get(raw.method);
      responseGates.delete(raw.method);
      const result = await dispatch.request(raw);
      await gate?.();
      return result;
    },
  } as NativeBridge;
  return {
    bridge,
    main,
    calls,
    submitted,
    records,
    catalogue,
    // Hold an already-produced Main response, rather than blocking its underlying operation.
    deferNextResponse(method: NativeRequest['method']) {
      if (responseGates.has(method)) throw Error('browser_response_already_deferred');
      let held = false,
        release!: () => void,
        drop!: () => void;
      const wait = new Promise<void>((resolve, reject) => {
        release = resolve;
        drop = () => reject(Error('lost_browser_response'));
      });
      responseGates.set(method, () => {
        held = true;
        return wait;
      });
      return {
        get held() {
          return held;
        },
        release,
        drop,
      };
    },
    get view() {
      return view;
    },
    set view(value) {
      view = value;
    },
    get scope() {
      return currentScope;
    },
    set scope(value) {
      currentScope = value;
    },
    get drop() {
      return drop;
    },
    set drop(value) {
      drop = value;
    },
    set foreignHead(value: boolean) {
      foreignHead = value;
    },
    set queryGate(value: Promise<void> | undefined) {
      queryGate = value;
    },
    get maxInFlight() {
      return maxInFlight;
    },
  };
}
