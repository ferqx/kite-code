import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent, type ModelRequest } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { type AgentRuntime, createRuntime } from '../../../src';
import { inheritHostRevocation } from '../../../src/execution/host-control';
import type { AuthorizationRequest, Extension, Json } from '../../../src/extensions';
import { createTaskExtension } from '../../../src/extensions/task';
import {
  builtinCapability,
  type CapabilityDescription,
  createPermissionPolicy,
} from '../../../src/permissions';
import { openSqliteStore } from '../../../src/sqlite';
import { AgentError } from '../../../src/storage/types';
import {
  browserPageReference,
  createBrowserController,
  createBrowserExecution,
  createBrowserExtension,
  createBrowserHumanCoordinator,
  type NativeBrowserTransport,
} from '../../../src/tools/browser';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function until(read: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!(await read())) {
    if (Date.now() > end) throw Error('async_browser_fixture_timeout');
    await sleepTimer(5);
  }
}
async function fixture(
  ended = false,
  proactive = false,
  notificationFailure?: 'known' | 'unknown',
  nested = false,
  auto?: {
    rejectContinuation?: boolean;
    afterContinue?: 'close' | 'navigate';
    deny?: string;
    invalidTarget?: boolean;
    runBoundChecker?: boolean;
    waitForEvents?: boolean;
    finishWhileReviewing?: boolean;
  },
  finalWhilePending = false,
) {
  const root = mkdtempSync(join(tmpdir(), 'kite-human-async-'));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' }),
    storeId = (await store.getMetadata()).storeId;
  let finishOwner!: (value: { confirmed: boolean }) => void;
  const completion = new Promise<{ confirmed: boolean }>((resolve) => {
    finishOwner = resolve;
  });
  let resumes = 0,
    handoffs = 0,
    independent = false,
    releaseWork!: () => void;
  let beforeResume: (() => Promise<void>) | undefined;
  let failHandoff = false,
    wrongSelection = false;
  const work = new Promise<void>((resolve) => {
    releaseWork = resolve;
  });
  const transport: NativeBrowserTransport = {
    ready: Promise.resolve(),
    completion,
    async request() {
      return { success: true, data: {} };
    },
    async capture() {
      return {
        frame: { mimeType: 'image/jpeg', data: 'small', width: 800, height: 600 },
        annotations: [],
      };
    },
    async close() {
      finishOwner({ confirmed: true });
      return { confirmed: true };
    },
    async dispose() {},
    async handoff() {
      handoffs++;
      if (failHandoff) throw Error('fixture_return_ack_unknown');
    },
    async resume() {
      resumes++;
      await beforeResume?.();
    },
  };
  const controller = createBrowserController({
    createTransport: () => transport,
    captureIntervalMs: 60000,
  });
  let runtime!: AgentRuntime;
  let beforeWorkRead: (() => Promise<void>) | undefined;
  let beforeResponseRead: ((stage: string) => Promise<void>) | undefined;
  let beforeResponseWrite: ((value: Json) => Promise<void>) | undefined;
  let notifications = 0,
    terminalWaits = 0;
  let beforeInclude: (() => Promise<void>) | undefined;
  let nestedSourceDamage: 'parent' | 'cancelled' | 'work' | undefined;
  const human = createBrowserHumanCoordinator({
    controller,
    runtime: () =>
      new Proxy(runtime, {
        get(target, property) {
          if (property === 'readWorkEligibility')
            return async (input: Parameters<AgentRuntime['readWorkEligibility']>[0]) => {
              const result = await target.readWorkEligibility(input);
              await beforeWorkRead?.();
              await beforeResponseRead?.('readWorkEligibility');
              return result;
            };
          if (property === 'includeResult' && !notificationFailure)
            return async (input: Parameters<AgentRuntime['includeResult']>[0]) => {
              await beforeInclude?.();
              return target.includeResult(input);
            };
          if (property === 'includeResult' && notificationFailure)
            return async () => {
              notifications++;
              if (notificationFailure === 'known') throw new AgentError('input_target_stopped');
              throw Error('fixture_notification_response_lost');
            };
          const value = Reflect.get(target, property);
          if (['getExecution', 'getCommand', 'getRun', 'getSession'].includes(String(property)))
            return async (...args: unknown[]) => {
              const result = await Reflect.apply(value, target, args);
              await beforeResponseRead?.(String(property));
              if (property === 'getSession' && result && wrongSelection)
                return { ...result, contextSelectionId: 'foreign-selection' };
              if (
                property === 'getExecution' &&
                result &&
                typeof result === 'object' &&
                'definitionId' in result &&
                result.definitionId === 'browser.execute' &&
                nestedSourceDamage
              ) {
                if (nestedSourceDamage === 'parent')
                  return { ...result, definitionId: 'arbitrary.tool' };
                if (nestedSourceDamage === 'cancelled')
                  return { ...result, cancelRequestedAt: Date.now() };
                return { ...result, rootWorkCommandId: 'foreign-work' };
              }
              return result;
            };
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
  });
  // Preserve the builtin-only registration when instrumenting this controlled definition.
  const response = { ...human.response };
  const executeResponse = response.execute;
  response.execute = (input, context) =>
    executeResponse(input, {
      ...context,
      records: {
        ...context.records,
        async get(key) {
          const result = await context.records.get(key);
          await beforeResponseRead?.('records.get');
          return result;
        },
        async write(input) {
          await beforeResponseWrite?.(input.value);
          const result = await context.records.write(input);
          await beforeResponseRead?.('records.write');
          return result;
        },
      },
    });
  const instrumentedResponse = Object.freeze(response);
  inheritHostRevocation(human.response, instrumentedResponse);
  const originalExtension = createBrowserExtension({
    controller,
    human: { ...human, response: instrumentedResponse },
  });
  let environments = 0;
  const code = createBrowserExecution({
    controller,
    createExecutor() {
      environments++;
      let page: Json;
      return {
        async execute({ code: script, call }) {
          if (script === 'open') page = await call('open', { url: 'https://example.test/' });
          else if (script === 'human')
            await call('requestHuman', {
              page: page!,
              args: ['Review this controlled form, then explicitly continue and notify.'],
            });
          else if (script === 'close' || script === 'navigate') {
            const available = (await call('pages', {})) as { id: string }[];
            page = available[0]!.id;
            await call(script, {
              page,
              args: script === 'navigate' ? ['https://example.test/next'] : [],
            });
          } else {
            const available = (await call('pages', {})) as { id: string }[];
            page = available[0]!.id;
            await call('snapshot', { page, args: [] });
          }
          return { value: page!, output: '' };
        },
        async close() {
          return { confirmed: true };
        },
      };
    },
  });
  const extension = nested
    ? {
        ...originalExtension,
        tools: [...originalExtension.tools!, ...code.tools],
        jobs: [...originalExtension.jobs!, ...code.jobs],
        records: [
          ...originalExtension.records!,
          {
            contentType: 'application/vnd.kite.browser-code+json',
            contentVersion: 1,
            schema: { type: 'object' },
          },
        ],
      }
    : originalExtension;
  const independentExtension: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    actions: [
      {
        id: 'fixture.ordinary',
        version: '1',
        description: 'ordinary queued no-op',
        inputSchema: { type: 'object' },
        async prepare(input) {
          return input;
        },
        async execute() {
          return { outcome: 'succeeded', content: 'ordinary' };
        },
      },
      {
        id: 'fixture.control_probe',
        version: '1',
        runControl: true,
        description: 'negative new-work boundary probe',
        inputSchema: { type: 'object' },
        async prepare(input) {
          return input;
        },
        async execute(_input, context) {
          const codes: string[] = [];
          try {
            await context.operations.ensure({
              key: 'forbidden',
              request: {
                kind: 'job',
                definitionId: 'browser.human_wait',
                definitionVersion: '1',
                input: { requestId: 'forbidden' },
              },
            });
          } catch (error) {
            codes.push((error as { code: string }).code);
          }
          try {
            await context.requestInput?.({ schema: { const: true } });
          } catch (error) {
            codes.push((error as { code: string }).code);
          }
          return { outcome: 'succeeded', content: JSON.stringify(codes) };
        },
      },
    ],
    tools: [
      {
        id: 'fixture.independent',
        version: '1',
        model: { name: 'independent_work' },
        description: 'Controlled unrelated local work',
        inputSchema: { type: 'object', additionalProperties: false },
        async execute(_input, context) {
          independent = true;
          const abort = () => releaseWork();
          context.signal.addEventListener('abort', abort, { once: true });
          try {
            await work;
            context.signal.throwIfAborted();
            return { outcome: 'succeeded', content: 'independent work done' };
          } finally {
            context.signal.removeEventListener('abort', abort);
          }
        },
      },
    ],
  };
  const taskExtension = createTaskExtension({
    roles: [{ id: 'unused', configurationId: 'unused', description: 'Unused controlled role' }],
  });
  const extensions = [
    extension,
    independentExtension,
    ...(auto?.waitForEvents ? [taskExtension] : []),
  ];
  const requests: ModelRequest[] = [];
  let beforeModel: ((signal: AbortSignal) => Promise<void>) | undefined;
  let sourceDamage: 'job' | 'store' | 'parent' | 'selection' | undefined;
  let workspaceTrust = true;
  const model = {
    async *stream(request: ModelRequest, options: { signal: AbortSignal }) {
      requests.push(structuredClone(request));
      await beforeModel?.(options.signal);
      options.signal.throwIfAborted();
      const turn = requests.length;
      let name = '',
        args: Json = {};
      if (turn === 1) {
        name = 'browser_open';
        args = { url: 'https://example.test/' };
        if (nested) {
          name = 'browser_execute';
          args = { code: 'open', description: '打开测试页面' };
        }
      }
      if (turn === 2 && !proactive) {
        await until(() => {
          options.signal.throwIfAborted();
          return controller.view('s')?.state === 'agent';
        });
        const view = controller.view('s')!;
        name = 'browser_request_human';
        args = {
          page_ref: browserPageReference(
            {
              storeId,
              sessionId: 's',
              runId: (await store.getExecution(request.requestId))!.runId!,
            },
            {
              browserId: view.browserId,
              generation: auto?.invalidTarget ? 'foreign-generation' : view.generation,
            },
          ),
          reason: 'Review this controlled form, then explicitly continue and notify.',
        };
        if (nested) {
          name = 'browser_execute';
          args = { code: 'human', description: '交还测试控制' };
        }
      }
      if (
        (turn === 3 && !ended && !proactive && !finalWhilePending) ||
        (turn === 2 && proactive) ||
        (ended && turn === 4)
      )
        name = auto?.waitForEvents ? 'wait_agent_events' : 'independent_work';
      if ((turn === 4 && !ended && !proactive) || (turn === 3 && proactive)) {
        const view = controller.view('s')!;
        name = 'browser_snapshot';
        args = {
          page_ref: browserPageReference(
            {
              storeId,
              sessionId: 's',
              runId: (await store.getExecution(request.requestId))!.runId!,
            },
            view,
          ),
        };
        if (nested) {
          name = 'browser_execute';
          args = { code: auto?.afterContinue ?? 'observe', description: '读取当前页面' };
        } else if (auto?.afterContinue) {
          name = `browser_${auto.afterContinue}`;
          if (auto.afterContinue === 'navigate')
            Object.assign(args, { url: 'https://example.test/next' });
        }
      }
      if (turn === 3 && auto?.finishWhileReviewing) {
        independent = true;
        await work;
        options.signal.throwIfAborted();
        name = '';
      }
      const events: ModelEvent[] = name
        ? [
            { type: 'tool_call', id: `call-${turn}`, name, arguments: JSON.stringify(args) },
            { ...finish, reason: 'tool_calls' },
          ]
        : [{ type: 'text_delta', text: 'ASYNC_FINISHED' }, finish];
      yield* createFixedModel([events]).stream(request, options);
    },
  };
  const reviewResult = (decision: 'approve_once' | 'reject') => [
    {
      type: 'text_delta' as const,
      text: JSON.stringify({ decision, reason: 'Exact current fixture request' }),
    },
    finish,
  ];
  let beforeAuthorization: ((request: AuthorizationRequest) => Promise<void>) | undefined;
  let bindingDisposals = 0;
  const checker = createFixedModel([
    reviewResult(auto?.rejectContinuation ? 'reject' : 'approve_once'),
    reviewResult(auto?.rejectContinuation ? 'reject' : 'approve_once'),
    reviewResult(auto?.rejectContinuation ? 'reject' : 'approve_once'),
    reviewResult('approve_once'),
  ]);
  const reviewer = {
    async *stream(request: ModelRequest, options: { signal: AbortSignal }) {
      yield* checker.stream(request, options);
    },
  };
  const descriptions = extensions.flatMap((entry) => [
    ...(entry.tools ?? []).map((tool) => ({
      kind: 'tool' as const,
      definitionId: tool.id,
      definitionVersion: tool.version,
      ...builtinCapability(entry.id, tool.id, 'tool', '', tool.version),
      revision: 'actual-fixture-tool',
      hardAllowed: auto?.deny !== tool.id,
    })),
    ...(entry.jobs ?? []).map((job) => ({
      kind: 'job' as const,
      definitionId: job.id,
      definitionVersion: job.version,
      ...builtinCapability(entry.id, job.id, 'job', '', job.version),
      revision: 'actual-fixture-job',
      hardAllowed: auto?.deny !== job.id,
    })),
    ...(entry.actions ?? []).map((action) => ({
      kind: 'job' as const,
      definitionId: `${entry.id}/${action.id}`,
      definitionVersion: action.version,
      ...builtinCapability(entry.id, action.id, 'action', '', action.version),
      revision: 'actual-fixture-action',
      hardAllowed: auto?.deny !== action.id,
    })),
  ]);
  runtime = createRuntime({
    store: new Proxy(store, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === 'getExecution')
          return async (id: string) => {
            const row = await target.getExecution(id);
            if (row?.definitionId === 'browser.session') {
              if (sourceDamage === 'job') return { ...row, id: 'replacement-job' };
              if (sourceDamage === 'store') return { ...row, originStoreId: 'foreign-store' };
              if (sourceDamage === 'parent') return { ...row, parentExecutionId: 'foreign-open' };
            }
            return row;
          };
        if (property === 'getSession')
          return async (id: string) => {
            const row = await target.getSession(id);
            return row && sourceDamage === 'selection'
              ? { ...row, contextSelectionId: 'foreign-selection' }
              : row;
          };
        if (property === 'setRunResultWait')
          return async (input: Parameters<typeof store.setRunResultWait>[0]) => {
            const result = await target.setRunResultWait(input);
            if (
              input.executionIds.length &&
              (await target.getExecution(input.executionIds[0]!))?.status === 'succeeded'
            )
              terminalWaits++;
            return result;
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
    model,
    modelId: 'fixed',
    extensions,
    ...(auto
      ? auto.runBoundChecker
        ? {
            async resolveRunConfiguration() {
              return {
                model,
                modelId: 'fixed',
                snapshot: {},
                async dispose() {
                  bindingDisposals++;
                },
                authorizationCheck: {
                  id: 'human-policy-check',
                  version: '1',
                  modelId: 'fixed',
                  model: reviewer,
                },
              };
            },
          }
        : {
            authorizationCheck: {
              id: 'human-policy-check',
              version: '1',
              modelId: 'fixed',
              model: reviewer,
            },
          }
      : {}),
    permissions: auto
      ? createPermissionPolicy({
          readPolicy: () => ({
            mode: 'auto',
            workspaceTrust,
            revision: 'current-human-policy',
            allowed: [
              { kind: 'model', definitionId: 'fixed', definitionVersion: '1' },
              ...descriptions,
            ],
          }),
          describeCapability: async (request) => {
            const description: CapabilityDescription | null =
              request.kind === 'model'
                ? {
                    kind: request.kind,
                    definitionId: request.definitionId,
                    definitionVersion: request.definitionVersion,
                    effects: ['read'],
                    safeRead: true,
                    hardAllowed: true,
                    revision: 'controlled-model',
                  }
                : request.definitionId === 'fixture.independent'
                  ? {
                      kind: request.kind,
                      definitionId: request.definitionId,
                      definitionVersion: request.definitionVersion,
                      effects: ['read'],
                      safeRead: true,
                      hardAllowed: true,
                      revision: 'controlled-independent-work',
                    }
                  : (descriptions.find(
                      (entry) =>
                        entry.kind === request.kind &&
                        entry.definitionId === request.definitionId &&
                        entry.definitionVersion === request.definitionVersion,
                    ) ?? null);
            await beforeAuthorization?.(request);
            return description;
          },
        })
      : {
          async authorize() {
            return { allowed: true, revision: 'fixture' };
          },
        },
  });
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: pathToFileURL(root).href,
    name: 'w',
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    commandId: 'create',
    subjectId: 'owner',
    sessionId: 's',
    workspaceId: 'w',
    title: 'controlled browser fixture',
  });
  await runtime.submitCommand({
    expectedStoreId: storeId,
    commandId: 'original-run',
    subjectId: 'owner',
    sessionId: 's',
    request: {
      kind: 'run.start',
      content: 'Use browser, ask human, do unrelated work, continue on correlated result.',
    },
  });
  const readRequest = async () => {
    const values = await store.listExtensionRecords({
      extensionId: 'builtin.browser',
      sessionId: 's',
      afterKey: 'human/',
      limit: 10,
    });
    return values.find((row) => row.key.startsWith('human/'));
  };
  const respond = async (commandId: string, choice: 'continue' | 'stop' = 'continue') => {
    const row = (await readRequest())!,
      v = row.value as Record<string, Json>;
    return runtime.submitCommand({
      expectedStoreId: storeId,
      commandId,
      sessionId: 's',
      subjectId: 'owner',
      request: {
        kind: 'extension.invoke',
        extensionId: 'builtin.browser',
        actionId: 'browser.respond_human',
        definitionVersion: '1',
        input: {
          requestId: v.requestId!,
          expectedRevision: row.revision,
          browserId: v.browserId!,
          generation: v.generation!,
          choice,
        },
      },
    });
  };
  return {
    runtime,
    store,
    controller,
    storeId,
    root,
    requests,
    checker,
    set beforeModel(value: ((signal: AbortSignal) => Promise<void>) | undefined) {
      beforeModel = value;
    },
    set sourceDamage(value: 'job' | 'store' | 'parent' | 'selection' | undefined) {
      sourceDamage = value;
    },
    set workspaceTrust(value: boolean) {
      workspaceTrust = value;
    },
    set beforeAuthorization(value: ((request: AuthorizationRequest) => Promise<void>) | undefined) {
      beforeAuthorization = value;
    },
    get bindingDisposals() {
      return bindingDisposals;
    },
    async action(actionId: string, commandId: string, selected = controller.view('s')!) {
      return runtime.submitCommand({
        expectedStoreId: storeId,
        commandId,
        sessionId: 's',
        subjectId: 'owner',
        request: {
          kind: 'extension.invoke',
          extensionId: 'builtin.browser',
          actionId,
          definitionVersion: '1',
          input: { browserId: selected.browserId, generation: selected.generation },
        },
      });
    },
    readRequest,
    respond,
    async cancelPending() {
      await until(async () => Boolean(await readRequest()));
      const row = (await readRequest())!.value as Record<string, Json>;
      await runtime.cancelExecution({
        expectedStoreId: storeId,
        sessionId: 's',
        subjectId: 'owner',
        commandId: 'cancel-pending-receipt',
        executionId: (row.job as unknown as { executionId: string }).executionId,
      });
    },
    releaseWork,
    async disposeCode() {
      await code.disposeCommand('s', 'original-run');
    },
    get environments() {
      return environments;
    },
    set nestedSourceDamage(value: 'parent' | 'cancelled' | 'work' | undefined) {
      nestedSourceDamage = value;
    },
    get resumes() {
      return resumes;
    },
    get handoffs() {
      return handoffs;
    },
    set wrongSelection(value: boolean) {
      wrongSelection = value;
    },
    get terminalWaits() {
      return terminalWaits;
    },
    set beforeInclude(value: (() => Promise<void>) | undefined) {
      beforeInclude = value;
    },
    get notifications() {
      return notifications;
    },
    set beforeWorkRead(value: (() => Promise<void>) | undefined) {
      beforeWorkRead = value;
    },
    set beforeResponseRead(value: ((stage: string) => Promise<void>) | undefined) {
      beforeResponseRead = value;
    },
    set beforeResponseWrite(value: ((value: Json) => Promise<void>) | undefined) {
      beforeResponseWrite = value;
    },
    set beforeResume(value: (() => Promise<void>) | undefined) {
      beforeResume = value;
    },
    set failHandoff(value: boolean) {
      failHandoff = value;
    },
    get independent() {
      return independent;
    },
  };
}
for (const nested of [false, true])
  for (const afterContinue of ['close', 'navigate'] as const)
    test(`legacy Auto handoff/wait and ${afterContinue} use no reviewer (unified=${nested})`, async () => {
      const f = await fixture(false, false, undefined, nested, { afterContinue });
      try {
        await until(() => f.independent).catch(async (error) => {
          throw Error(
            JSON.stringify({
              error: String(error),
              checker: f.checker.requests.length,
              executions: (await f.store.listExecutions('s')).map((row) => ({
                definition: row.definitionId,
                status: row.status,
                result: row.result,
              })),
            }),
          );
        });
        await until(async () =>
          (await f.store.listExecutions('s')).some(
            (row) =>
              row.definitionId === 'browser.human_wait' && row.authorization?.dispatched === true,
          ),
        );
        // Explicit legacy handoff retains its receipt protocol. Every exact
        // builtin browser operation bypasses review in the current policy.
        expect(f.checker.requests).toHaveLength(0);
        const before = await f.store.listExecutions('s');
        expect(before.find((row) => row.definitionId === 'browser.request_human')?.status).toBe(
          'succeeded',
        );
        expect(f.controller.view('s')?.state).toBe('human');
        expect(f.handoffs).toBe(1);
        await f.respond('real-current-continuation');
        await f.runtime.waitForCommand('real-current-continuation', { timeoutMs: 5000 });
        expect(f.checker.requests).toHaveLength(0);
        expect(f.resumes).toBe(1);
        f.releaseWork();
        await f.runtime.waitForCommand('original-run', { timeoutMs: 5000 });
        expect(f.checker.requests).toHaveLength(0);
        const entries = await f.store.listExecutions('s');
        expect(entries.find((row) => row.definitionId === `browser.${afterContinue}`)?.status).toBe(
          'succeeded',
        );
        if (afterContinue === 'close') expect(f.controller.view('s')?.state).toBe('closed');
        expect(
          (await f.runtime.listInteractions({ expectedStoreId: f.storeId, sessionId: 's' }))
            .interactions,
        ).toEqual([]);
      } finally {
        f.releaseWork();
        await f.disposeCode();
        await f.runtime.close();
        rmSync(f.root, { recursive: true, force: true });
      }
    }, 15000);

test('Auto Continue remains bound to the original Run after an immediate task.events snapshot without a reviewer', async () => {
  const f = await fixture(false, false, undefined, true, {
    runBoundChecker: true,
    waitForEvents: true,
    afterContinue: 'close',
  });
  try {
    await until(async () =>
      (await f.store.listExecutions('s')).some(
        (row) => row.definitionId === 'task.events' && row.status === 'succeeded',
      ),
    );
    expect(f.checker.requests).toHaveLength(0);
    expect(f.controller.view('s')?.state).toBe('human');
    await f.respond('run-bound-continuation');
    await f.runtime.waitForCommand('run-bound-continuation', { timeoutMs: 3000 });
    expect(f.checker.requests).toHaveLength(0);
    expect(f.resumes).toBe(1);
    await f.runtime.waitForCommand('original-run', { timeoutMs: 5000 });
    const entries = await f.store.listExecutions('s');
    const action = entries.find(
      (row) => row.definitionId === 'builtin.browser/browser.respond_human',
    )!;
    expect(action.status).toBe('succeeded');
    expect(action.runId).toBeNull();
    expect(action.parentExecutionId).toBeNull();
    expect(entries.find((row) => row.definitionId === 'task.events')?.status).toBe('succeeded');
    expect(entries.find((row) => row.definitionId === 'browser.human_wait')?.status).toBe(
      'succeeded',
    );
    const request = (await f.readRequest())!.value as Record<string, Json>;
    expect((await f.runtime.getCommand(`human-result-${request.requestId}`))?.kind).toBe(
      'result.include',
    );
    expect(f.requests).toHaveLength(5);
    expect(JSON.stringify(f.requests.at(-1))).toContain('human-result-');
    expect(
      (await f.runtime.listInteractions({ expectedStoreId: f.storeId, sessionId: 's' }))
        .interactions,
    ).toEqual([]);
  } finally {
    f.releaseWork();
    await f.disposeCode();
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15000);

test('legacy continuation retains the exact original task and purpose in its durable Action source without review', async () => {
  const f = await fixture(false, false, undefined, true, { runBoundChecker: true });
  try {
    await until(() => f.independent);
    await f.respond('purpose-reviewed-continue');
    await f.runtime.waitForCommand('purpose-reviewed-continue', { timeoutMs: 3000 });
    const action = (await f.store.listExecutions('s')).find(
      (row) => row.originCommandId === 'purpose-reviewed-continue',
    )!;
    const material = JSON.parse(JSON.stringify(action.decisionSource)).continuation;
    expect(f.checker.requests).toHaveLength(0);
    expect(material).toBeDefined();
    expect(material.originalTask.request.content).toBe(
      'Use browser, ask human, do unrelated work, continue on correlated result.',
    );
    expect(material.continuation.reason).toBe(
      'Review this controlled form, then explicitly continue and notify.',
    );
    expect(material.continuation.effect).toContain('does not navigate, click, fill or submit');
    expect(material.trustedAsAuthority).toBe(false);
    expect(action.runId).toBeNull();
    expect(material.originalRun.id).toBe(
      ((await f.runtime.getCommand('original-run'))!.receipt as { runId: string }).runId,
    );
    expect(f.resumes).toBe(1);
  } finally {
    f.releaseWork();
    await f.disposeCode();
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15000);

test('legacy continuation keeps its exact authorization while the original Run advances into result wait', async () => {
  const f = await fixture(false, false, undefined, true, {
    runBoundChecker: true,
    finishWhileReviewing: true,
  });
  const barrier = holdAuthorization(f);
  try {
    await until(() => f.independent);
    const command = await f.runtime.getCommand('original-run');
    const runId = (command!.receipt as { runId: string }).runId;
    expect((await f.runtime.getRun(runId))?.status).toBe('running');
    await f.respond('progress-reviewed-continue');
    await barrier.started;
    f.releaseWork();
    await until(async () => (await f.runtime.getRun(runId))?.status === 'waiting_execution');
    barrier.release();
    await f.runtime.waitForCommand('progress-reviewed-continue', { timeoutMs: 5000 });
    expect(f.checker.requests).toHaveLength(0);
    const actions = (await f.store.listExecutions('s')).filter(
      (row) => row.originCommandId === 'progress-reviewed-continue',
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]?.status).toBe('succeeded');
    expect(f.resumes).toBe(1);
    await f.runtime.waitForCommand('original-run', { timeoutMs: 5000 });
    expect((await f.runtime.getRun(runId))?.status).toBe('completed');
  } finally {
    barrier.release();
    f.releaseWork();
    await f.disposeCode();
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15000);

function holdAuthorization(f: Awaited<ReturnType<typeof fixture>>, ignoreCancellation = false) {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.beforeAuthorization = async (request) => {
    if (
      request.kind !== 'job' ||
      !['builtin.browser/browser.respond_human', 'builtin.browser/browser.resume'].includes(
        request.definitionId,
      )
    )
      return;
    const signal = request.signal;
    entered();
    if (ignoreCancellation) return blocked;
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      blocked.then(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      });
      if (signal.aborted) abort();
    });
  };
  return { started, release };
}
for (const nested of [false, true])
  test(`explicit legacy manual resume retains its original ${nested ? 'nested execute' : 'open'} Run without review`, async () => {
    const f = await fixture(false, true, undefined, nested, { runBoundChecker: true });
    try {
      await until(() => f.independent);
      await f.action('browser.handoff', 'manual-handoff');
      await f.runtime.waitForCommand('manual-handoff', { timeoutMs: 3000 });
      expect(f.controller.view('s')?.state).toBe('human');
      expect(f.checker.requests).toHaveLength(0);
      await f.action('browser.resume', 'manual-resume');
      await f.runtime.waitForCommand('manual-resume', { timeoutMs: 3000 });
      expect(f.checker.requests).toHaveLength(0);
      expect(f.resumes).toBe(1);
      expect(f.controller.view('s')?.state).toBe('agent');
      expect(
        (await f.runtime.listInteractions({ expectedStoreId: f.storeId, sessionId: 's' }))
          .interactions,
      ).toEqual([]);
      const resume = (await f.store.listExecutions('s')).find(
        (row) => row.originCommandId === 'manual-resume',
      )!;
      expect(resume.runId).toBeNull();
      expect(resume.parentExecutionId).toBeNull();
      const material = JSON.parse(JSON.stringify(resume.decisionSource)).continuation;
      expect(material.continuation.operation).toBe('resume');
      expect(material.originalTask.request.content).toBe(
        'Use browser, ask human, do unrelated work, continue on correlated result.',
      );
      f.releaseWork();
      await f.runtime.waitForCommand('original-run', { timeoutMs: 5000 });
    } finally {
      f.releaseWork();
      await f.disposeCode();
      await f.runtime.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 15000);

test('a hard capability denial cannot resume or manufacture a human result after an immediate task.events snapshot', async () => {
  const f = await fixture(false, false, undefined, true, {
    runBoundChecker: true,
    waitForEvents: true,
    deny: 'browser.respond_human',
  });
  try {
    await until(async () =>
      (await f.store.listExecutions('s')).some(
        (row) => row.definitionId === 'task.events' && row.status === 'succeeded',
      ),
    );
    await f.respond('denied-run-review');
    await f.runtime.waitForCommand('denied-run-review', { timeoutMs: 3000 });
    expect(f.checker.requests).toHaveLength(0);
    expect(f.resumes).toBe(0);
    const rows = await f.store.listExecutions('s');
    expect(rows.find((row) => row.originCommandId === 'denied-run-review')?.status).toBe('failed');
    expect(rows.find((row) => row.definitionId === 'task.events')?.status).toBe('succeeded');
    expect(rows.find((row) => row.definitionId === 'browser.human_wait')?.status).toBe('running');
    const request = (await f.readRequest())!.value as Record<string, Json>;
    expect(await f.runtime.getCommand(`human-result-${request.requestId}`)).toBeNull();
    expect(
      (await f.runtime.listInteractions({ expectedStoreId: f.storeId, sessionId: 's' }))
        .interactions,
    ).toEqual([]);
  } finally {
    f.releaseWork();
    await f.disposeCode();
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15000);

test('Stop interrupts legacy continuation authorization during task.events; a late policy return cannot resume', async () => {
  const f = await fixture(false, false, undefined, true, {
    runBoundChecker: true,
    waitForEvents: true,
  });
  const barrier = holdAuthorization(f);
  try {
    await until(async () =>
      (await f.store.listExecutions('s')).some(
        (row) => row.definitionId === 'task.events' && row.status === 'dispatching',
      ),
    );
    await f.respond('pending-reviewed-continue');
    await barrier.started;
    await f.respond('immediate-human-stop', 'stop');
    await f.runtime.waitForCommand('immediate-human-stop', { timeoutMs: 1500 });
    expect(f.resumes).toBe(0);
    expect(f.controller.view('s')?.state).toBe('closed');
    barrier.release();
    await f.runtime.waitForCommand('pending-reviewed-continue', { timeoutMs: 1500 });
    expect(f.resumes).toBe(0);
    expect(
      (await f.store.listExecutions('s')).find(
        (row) => row.originCommandId === 'pending-reviewed-continue',
      )?.authorization?.dispatched,
    ).not.toBe(true);
    expect(
      (await f.runtime.listInteractions({ expectedStoreId: f.storeId, sessionId: 's' }))
        .interactions,
    ).toEqual([]);
  } finally {
    barrier.release();
    f.releaseWork();
    await f.disposeCode();
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15000);

test('ending the original Run cancels legacy continuation authorization and retains its binding until policy returns', async () => {
  const f = await fixture(false, false, undefined, true, {
    runBoundChecker: true,
    waitForEvents: true,
  });
  const barrier = holdAuthorization(f, true);
  try {
    await until(async () =>
      (await f.store.listExecutions('s')).some(
        (row) => row.definitionId === 'task.events' && row.status === 'dispatching',
      ),
    );
    await f.respond('cancelled-run-review');
    await barrier.started;
    await f.runtime.cancelCommand({
      expectedStoreId: f.storeId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'stop-original',
      targetCommandId: 'original-run',
    });
    await f.runtime.waitForCommand('original-run', { timeoutMs: 3000 });
    expect(f.bindingDisposals).toBe(0);
    expect(f.resumes).toBe(0);
    barrier.release();
    await f.runtime.waitForCommand('cancelled-run-review', { timeoutMs: 3000 });
    await until(() => f.bindingDisposals === 1);
    expect(f.resumes).toBe(0);
    expect(
      (await f.store.listExecutions('s')).find(
        (row) => row.originCommandId === 'cancelled-run-review',
      )?.authorization?.dispatched,
    ).not.toBe(true);
  } finally {
    barrier.release();
    f.releaseWork();
    await f.disposeCode();
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15000);

for (const damage of ['job', 'store', 'parent', 'selection'] as const)
  test(`explicit legacy resume rejects a changed ${damage} source without a reviewer`, async () => {
    const f = await fixture(false, true, undefined, true, { runBoundChecker: true });
    try {
      await until(() => f.independent);
      await f.action('browser.handoff', 'source-handoff');
      await f.runtime.waitForCommand('source-handoff', { timeoutMs: 3000 });
      f.sourceDamage = damage;
      await f.action('browser.resume', 'invalid-source-resume');
      await f.runtime.waitForCommand('invalid-source-resume', { timeoutMs: 3000 });
      expect(f.resumes).toBe(0);
      expect(f.checker.requests).toHaveLength(0);
      expect((await f.runtime.getCommand('invalid-source-resume'))?.status).toBe('rejected');
      expect(
        (await f.runtime.listInteractions({ expectedStoreId: f.storeId, sessionId: 's' }))
          .interactions,
      ).toEqual([]);
    } finally {
      f.sourceDamage = undefined;
      f.releaseWork();
      await f.disposeCode();
      await f.runtime.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 15000);

for (const change of ['generation', 'cancelled-job', 'policy'] as const)
  test(`legacy resume cannot dispatch after ${change} changes while policy is being read`, async () => {
    const f = await fixture(false, true, undefined, true, { runBoundChecker: true });
    const barrier = holdAuthorization(f);
    try {
      await until(() => f.independent);
      await f.action('browser.handoff', 'pending-source-handoff');
      await f.runtime.waitForCommand('pending-source-handoff', { timeoutMs: 3000 });
      await f.action('browser.resume', 'reviewed-stale-resume');
      await barrier.started;
      let unrelatedResumes = 0;
      if (change === 'generation') {
        // A separate trusted host transition changes the authoritative generation.
        await f.controller.resume('s', f.controller.view('s')!, new AbortController().signal);
        await f.controller.handoff('s', f.controller.view('s')!, new AbortController().signal);
        unrelatedResumes = 1;
      } else if (change === 'cancelled-job') {
        const job = (await f.store.listExecutions('s')).find(
          (row) => row.definitionId === 'browser.session',
        )!;
        await f.runtime.cancelExecution({
          expectedStoreId: f.storeId,
          sessionId: 's',
          subjectId: 'owner',
          commandId: 'cancel-browser-source',
          executionId: job.id,
        });
      } else f.workspaceTrust = false;
      barrier.release();
      await f.runtime.waitForCommand('reviewed-stale-resume', { timeoutMs: 3000 });
      expect(f.resumes).toBe(unrelatedResumes);
      expect(
        (await f.store.listExecutions('s')).find(
          (row) => row.originCommandId === 'reviewed-stale-resume',
        )?.authorization?.dispatched,
      ).not.toBe(true);
      expect(
        (await f.runtime.listInteractions({ expectedStoreId: f.storeId, sessionId: 's' }))
          .interactions,
      ).toEqual([]);
    } finally {
      f.workspaceTrust = true;
      barrier.release();
      f.releaseWork();
      await f.disposeCode();
      await f.runtime.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 15000);

test('a same-Session replacement Run cannot revive an old retained browser Job', async () => {
  const f = await fixture(false, true, undefined, false, { runBoundChecker: true });
  try {
    await until(() => f.independent);
    await f.action('browser.handoff', 'old-run-handoff');
    await f.runtime.waitForCommand('old-run-handoff', { timeoutMs: 3000 });
    f.releaseWork();
    await f.runtime.waitForCommand('original-run', { timeoutMs: 5000 });
    expect(f.controller.view('s')?.state).toBe('human');
    f.beforeModel = (signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
        if (signal.aborted) resolve();
      });
    await f.runtime.submitCommand({
      expectedStoreId: f.storeId,
      commandId: 'replacement-run',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'A separate current task.' },
    });
    await until(() => f.requests.length === 5);
    await f.action('browser.resume', 'old-page-new-run');
    await f.runtime.waitForCommand('old-page-new-run', { timeoutMs: 3000 });
    expect((await f.runtime.getCommand('old-page-new-run'))?.status).toBe('rejected');
    expect(f.resumes).toBe(0);
    expect(f.checker.requests).toHaveLength(0);
    expect(
      (await f.runtime.listInteractions({ expectedStoreId: f.storeId, sessionId: 's' }))
        .interactions,
    ).toEqual([]);
  } finally {
    f.releaseWork();
    await f.disposeCode();
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15000);

for (const denied of ['foreign-target', 'hard-cap'] as const)
  test(`Auto legacy handoff cannot bypass ${denied} when its extra review is removed`, async () => {
    const f = await fixture(
      false,
      false,
      undefined,
      false,
      denied === 'foreign-target' ? { invalidTarget: true } : { deny: 'browser.request_human' },
    );
    try {
      await until(() => f.independent);
      expect(f.checker.requests).toHaveLength(0);
      expect(f.handoffs).toBe(0);
      expect(f.controller.view('s')?.state).toBe('agent');
      const rows = await f.store.listExecutions('s');
      const handoff = rows.find((row) => row.definitionId === 'browser.request_human')!;
      expect(handoff.status).toBe('failed');
      expect(handoff.authorization?.dispatched).toBe(denied === 'foreign-target');
      expect(rows.some((row) => row.definitionId === 'browser.human_wait')).toBe(false);
    } finally {
      f.releaseWork();
      await f.runtime.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 15000);

for (const nested of [false, true])
  for (const choice of ['continue', 'stop'] as const)
    test(`a natural final waits for one explicit human result without another Question (nested=${nested}, choice=${choice})`, async () => {
      const f = await fixture(false, false, undefined, nested, undefined, true);
      let release!: () => void;
      const inclusion = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await until(() => f.requests.length === 3);
        const asked = (await f.store.listExecutions('s')).find(
          (row) => row.definitionId === 'browser.request_human',
        )!;
        const pending = (await f.readRequest())!.value as Record<string, Json>;
        const runId = (pending.taskRunId as string) ?? asked.runId!;
        await until(async () =>
          ['completed', 'waiting_execution'].includes((await f.store.getRun(runId))!.status),
        );
        expect(await f.store.getRun(runId)).toMatchObject({
          status: 'waiting_execution',
          isActive: true,
        });
        expect(
          (
            await f.store.listInteractions({
              expectedStoreId: f.storeId,
              sessionId: 's',
              limit: 100,
            })
          ).interactions,
        ).toHaveLength(0);
        f.beforeInclude = async () => inclusion;
        await f.respond('one-correlated-continue', choice);
        await until(() => f.terminalWaits > 0);
        expect(f.requests).toHaveLength(3);
        expect(f.terminalWaits).toBeLessThanOrEqual(3);
        expect(await f.store.getRun(runId)).toMatchObject({
          status: 'waiting_execution',
          isActive: true,
        });
        release();
        await f.runtime.waitForCommand('one-correlated-continue', { timeoutMs: 5000 });
        await f.runtime.waitForCommand('original-run', { timeoutMs: 5000 });
        expect(await f.store.getRun(runId)).toMatchObject({ status: 'completed', isActive: false });
        expect(f.requests).toHaveLength(5);
        expect(JSON.stringify(f.requests[3])).toContain(pending.requestId as string);
        expect(f.resumes).toBe(choice === 'continue' ? 1 : 0);
        expect((await f.runtime.getCommand(`human-result-${pending.requestId}`))?.status).toBe(
          'applied',
        );
      } finally {
        release();
        f.releaseWork();
        await f.disposeCode();
        await f.runtime.close();
        rmSync(f.root, { recursive: true, force: true });
      }
    }, 15000);

for (const damage of ['scope', 'revision', 'selection'] as const)
  test(`a final-waiting Run rejects a human response with wrong ${damage} before reacquiring control`, async () => {
    const f = await fixture(false, false, undefined, true, undefined, true);
    try {
      await until(async () =>
        (await f.store.listExecutions('s')).some(
          (row) => row.definitionId === 'browser.request_human' && row.status === 'succeeded',
        ),
      );
      const row = (await f.readRequest())!,
        value = row.value as Record<string, Json>,
        runId = value.taskRunId as string;
      await until(async () => (await f.store.getRun(runId))?.status === 'waiting_execution');
      f.wrongSelection = damage === 'selection';
      await f.runtime.submitCommand({
        expectedStoreId: f.storeId,
        sessionId: 's',
        subjectId: 'owner',
        commandId: 'wrong-human-response',
        request: {
          kind: 'extension.invoke',
          extensionId: 'builtin.browser',
          actionId: 'browser.respond_human',
          definitionVersion: '1',
          input: {
            requestId: value.requestId!,
            expectedRevision:
              damage === 'revision' ? String(BigInt(row.revision) + 1n) : row.revision,
            browserId: damage === 'scope' ? 'foreign-browser' : value.browserId!,
            generation: value.generation!,
            choice: 'continue',
          },
        },
      });
      await f.runtime.waitForCommand('wrong-human-response', { timeoutMs: 5000 });
      expect(f.resumes).toBe(0);
      expect(f.controller.view('s')?.state).toBe('human');
      expect(f.requests).toHaveLength(3);
      expect(await f.runtime.getCommand(`human-result-${value.requestId}`)).toBeNull();
      expect(await f.store.getRun(runId)).toMatchObject({
        status: 'waiting_execution',
        isActive: true,
      });
      f.wrongSelection = false;
      await f.respond('accurate-human-response');
      await f.runtime.waitForCommand('original-run', { timeoutMs: 5000 });
      expect(f.resumes).toBe(1);
    } finally {
      f.releaseWork();
      await f.disposeCode();
      await f.runtime.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 15000);

for (const outcome of ['failed', 'cancelled', 'unknown', 'expired'] as const)
  test(`a ${outcome} human receipt ends a final wait without inventing a response or another Model`, async () => {
    const f = await fixture(
      false,
      false,
      outcome === 'unknown' ? 'unknown' : undefined,
      true,
      undefined,
      true,
    );
    const originalNow = Date.now;
    try {
      await until(async () => Boolean(await f.readRequest()));
      const value = (await f.readRequest())!.value as Record<string, Json>,
        runId = value.taskRunId as string;
      await until(async () => (await f.store.getRun(runId))?.status === 'waiting_execution');
      if (outcome === 'cancelled') await f.cancelPending();
      if (outcome === 'failed') await f.controller.close('s', f.controller.view('s')!);
      if (outcome === 'expired') {
        Date.now = () => (value.expiresAt as number) + 1;
        await f.respond('expired-human-response');
      }
      if (outcome === 'unknown') {
        await f.respond('unknown-human-response');
        await f.runtime.waitForCommand('unknown-human-response', { timeoutMs: 5000 });
      }
      await f.runtime.waitForCommand('original-run', { timeoutMs: 5000 });
      expect(await f.store.getRun(runId)).toMatchObject({
        status: 'failed',
        isActive: false,
        reason: 'necessary_condition_unsatisfied',
      });
      expect(f.requests).toHaveLength(3);
      expect(await f.runtime.getCommand(`human-result-${value.requestId}`)).toBeNull();
    } finally {
      Date.now = originalNow;
      f.releaseWork();
      await f.disposeCode();
      await f.runtime.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 15000);

test('a configured rejecting reviewer cannot block an exact legacy continuation or create an approval', async () => {
  const f = await fixture(false, false, undefined, true, { rejectContinuation: true });
  try {
    await until(() => f.independent);
    const original = (await f.readRequest())!;
    await f.respond('unreviewed-continuation');
    await f.runtime.waitForCommand('unreviewed-continuation', { timeoutMs: 5000 });
    expect(f.checker.requests).toHaveLength(0);
    expect(f.resumes).toBe(1);
    expect(f.controller.view('s')?.state).toBe('agent');
    const action = (await f.store.listExecutions('s')).find(
      (row) => row.originCommandId === 'unreviewed-continuation',
    )!;
    expect(action.status).toBe('succeeded');
    expect(action.authorization?.dispatched).toBe(true);
    expect((await f.readRequest())!.revision).not.toBe(original.revision);
    const resolved = (await f.readRequest())!.value as Record<string, Json>;
    expect(resolved.state).toBe('resolved');
    expect((await f.runtime.getCommand(`human-result-${resolved.requestId}`))?.kind).toBe(
      'result.include',
    );
    expect(
      (await f.runtime.listInteractions({ expectedStoreId: f.storeId, sessionId: 's' }))
        .interactions,
    ).toEqual([]);
  } finally {
    f.releaseWork();
    await f.disposeCode();
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15000);

test.each([
  false,
  true,
])('handoff (unified=%s) returns pending, model starts unrelated work, and explicit human result inclusion retains exact Job provenance once', async (nested) => {
  const f = await fixture(false, false, undefined, nested);
  try {
    await until(() => f.independent);
    const entries = await f.store.listExecutions('s');
    const asked = entries.find((row) => row.definitionId === 'browser.request_human')!;
    expect({ status: asked.status, result: asked.result }).toMatchObject({
      status: 'succeeded',
      result: { outcome: 'succeeded' },
    });
    const originRunId = nested
      ? entries.find((row) => row.id === asked.parentExecutionId)!.runId!
      : asked.runId!;
    if (nested) {
      expect(asked.runId).toBeNull();
      const saved = (await f.readRequest())!.value as Record<string, Json>;
      expect(saved.runId).toBeNull();
      expect(saved.taskRunId).toBe(originRunId);
      expect(f.environments).toBe(1);
    }
    expect(JSON.stringify(asked.result)).toContain('pending');
    expect(f.requests).toHaveLength(3);
    expect(f.controller.view('s')?.state).toBe('human');
    expect(
      (
        await f.controller.command(
          's',
          f.controller.view('s')!,
          { action: 'navigate', url: 'https://example.test/no' },
          new AbortController().signal,
        )
      ).outcome,
    ).toBe('failed');
    const originalRequest = (await f.readRequest())!;
    const requestValue = originalRequest.value as Record<string, Json>;
    const independent = entries.find((row) => row.definitionId === 'fixture.independent')!;
    await f.runtime.invokeActionFromTool({
      expectedStoreId: f.storeId,
      sessionId: 's',
      subjectId: 'owner',
      parentExecutionId: independent.id,
      commandId: 'model-cannot-respond',
      request: {
        kind: 'extension.invoke',
        extensionId: 'builtin.browser',
        actionId: 'browser.respond_human',
        definitionVersion: '1',
        input: {
          requestId: requestValue.requestId!,
          expectedRevision: originalRequest.revision,
          browserId: requestValue.browserId!,
          generation: requestValue.generation!,
          choice: 'continue',
        },
      },
    });
    expect(f.resumes).toBe(0);
    expect(f.controller.view('s')?.state).toBe('human');
    const beforeReply = (await f.store.getMetadata()).lastChangeCursor;
    await f.respond('continue-human');
    await f.runtime.waitForCommand('continue-human', { timeoutMs: 5000 });
    const response = (await f.store.listExecutions('s')).find(
      (row) =>
        row.definitionId === 'builtin.browser/browser.respond_human' &&
        row.originCommandId === 'continue-human',
    )!;
    if (!response)
      throw Error(
        JSON.stringify({
          command: await f.runtime.getCommand('continue-human'),
          request: await f.readRequest(),
          view: f.controller.view('s'),
          executions: (await f.store.listExecutions('s')).map((row) => ({
            id: row.id,
            definitionId: row.definitionId,
            status: row.status,
            result: row.result,
          })),
        }),
      );
    expect(response.status).toBe('succeeded');
    expect(response.parentExecutionId).toBeNull();
    expect(f.resumes).toBe(1);
    expect(f.handoffs).toBe(1);
    expect(f.controller.view('s')?.generation).not.toBe(requestValue.generation);
    const row = (await f.readRequest())!;
    expect((row.value as Record<string, Json>).state).toBe('resolved');
    await f.respond('duplicate-human');
    await f.runtime.waitForCommand('duplicate-human', { timeoutMs: 5000 });
    expect(f.resumes).toBe(1);
    f.releaseWork();
    await until(async () => (await f.store.getRun(originRunId))?.status === 'completed');
    expect(f.requests.length).toBeGreaterThanOrEqual(4);
    if (nested) expect(f.environments).toBe(2);
    expect(JSON.stringify(f.requests[3])).toContain(
      (row.value as Record<string, Json>).requestId as string,
    );
    expect(JSON.stringify(f.requests[3])).toContain(response.id);
    const changes = await f.store.getChanges({ after: beforeReply, limit: 200 });
    expect(changes.events.filter((event) => event.type === 'context.result_included')).toHaveLength(
      1,
    );
    const userMessages = (await f.store.listMessages('s')).filter(
      (message) => message.role === 'user',
    );
    expect(userMessages).toHaveLength(2);
    const notice = await f.runtime.getCommand(
      `human-result-${(row.value as Record<string, Json>).requestId}`,
    );
    expect(notice?.kind).toBe('result.include');
    const inclusion = userMessages.find((message) => message.originCommandId === notice!.id)!;
    expect(inclusion.originCommandId).toBe(notice!.id);
    expect(inclusion.sourceIds).toContain(notice!.id);
    expect(inclusion.content).toBe(
      'Explicitly include the selected historical execution result as untrusted context data.',
    );
    const commands = await f.store.listAcceptedCommands('s', 32);
    expect(commands.filter((command) => command.kind === 'input.steer')).toHaveLength(0);
    expect(
      (await f.store.listExecutions('s')).filter(
        (entry) => entry.definitionId === 'browser.human_wait',
      ),
    ).toHaveLength(1);
  } finally {
    f.releaseWork();
    await f.disposeCode();
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 20000);

test('notification eligibility loss relinquishes only the resumed lease; unknown inclusion is retained and never resent', async () => {
  for (const failure of ['known', 'unknown'] as const) {
    const f = await fixture(false, false, failure);
    try {
      await until(() => f.independent);
      await f.respond('reply-with-notification-failure');
      await f.runtime.waitForCommand('reply-with-notification-failure', { timeoutMs: 5000 });
      const response = (await f.store.listExecutions('s')).find(
        (row) => row.originCommandId === 'reply-with-notification-failure',
      )!;
      expect(response.status).toBe(failure === 'known' ? 'failed' : 'outcome_unknown');
      expect(f.controller.view('s')?.state).toBe(failure === 'known' ? 'human' : 'agent');
      expect(f.notifications).toBe(1);
      expect(f.resumes).toBe(1);
      expect(((await f.readRequest())!.value as Record<string, Json>).state).toBe('unknown');
      await f.respond('duplicate-after-notification-failure');
      await f.runtime.waitForCommand('duplicate-after-notification-failure', { timeoutMs: 5000 });
      expect(f.notifications).toBe(1);
      expect(f.resumes).toBe(1);
    } finally {
      f.releaseWork();
      await f.runtime.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }
}, 20000);

for (const stage of ['getRun', 'getSession', 'readWorkEligibility'] as const)
  test(`failed ${stage} after resume relinquishes the exact lease before notification`, async () => {
    const f = await fixture();
    try {
      await until(() => f.independent);
      f.beforeResponseRead = async (current) => {
        if (f.resumes && current === stage) throw Error('fixture_post_resume_read_failed');
      };
      await f.respond('post-resume-read-failure');
      await f.runtime.waitForCommand('post-resume-read-failure', { timeoutMs: 5000 });
      expect(f.resumes).toBe(1);
      expect(f.handoffs).toBe(2);
      expect(f.controller.view('s')?.state).toBe('human');
      const request = (await f.readRequest())!.value as Record<string, Json>;
      expect(await f.runtime.getCommand(`human-result-${request.requestId}`)).toBeNull();
      expect(request.state).toBe('unknown');
    } finally {
      f.releaseWork();
      await f.runtime.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 20000);

for (const failure of ['record-write', 'return-unknown'] as const)
  test(`post-resume recheck with ${failure} keeps compensation independent of record publication`, async () => {
    const f = await fixture();
    try {
      await until(() => f.independent);
      f.beforeResponseRead = async (stage) => {
        if (f.resumes && stage === 'getRun') throw Error('fixture_recheck_failed');
      };
      if (failure === 'record-write')
        f.beforeResponseWrite = async () => {
          if (f.resumes) throw Error('fixture_record_write_failed');
        };
      else f.failHandoff = true;
      await f.respond('recheck-cleanup-failure');
      await f.runtime.waitForCommand('recheck-cleanup-failure', { timeoutMs: 5000 });
      expect(f.resumes).toBe(1);
      expect(f.handoffs).toBe(2);
      expect(f.controller.view('s')?.state).toBe(
        failure === 'record-write' ? 'human' : 'outcome_unknown',
      );
      const row = (await f.readRequest())!;
      const request = row.value as Record<string, Json>;
      expect(request.state).toBe(failure === 'record-write' ? 'responding' : 'unknown');
      expect(await f.runtime.getCommand(`human-result-${request.requestId}`)).toBeNull();
      const view = await f.runtime.queryExtension({
        expectedStoreId: f.storeId,
        subjectId: 'owner',
        sessionId: 's',
        extensionId: 'builtin.browser',
        queryId: 'browser.view',
        input: {},
      });
      expect(view[0]?.payload).toMatchObject({ humanPending: { state: 'unknown' } });
      await f.respond('repeat-recheck-cleanup-failure');
      await f.runtime.waitForCommand('repeat-recheck-cleanup-failure', { timeoutMs: 5000 });
      expect(f.resumes).toBe(1);
      expect(f.handoffs).toBe(2);
    } finally {
      f.releaseWork();
      await f.runtime.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 20000);

for (const failure of ['known', 'unknown'] as const)
  test(`notification ${failure} with unavailable record storage never repeats the notice`, async () => {
    const f = await fixture(false, false, failure);
    try {
      await until(() => f.independent);
      f.beforeResponseWrite = async () => {
        if (f.resumes) throw Error('fixture_record_write_failed');
      };
      await f.respond('notification-record-failure');
      await f.runtime.waitForCommand('notification-record-failure', { timeoutMs: 5000 });
      expect(f.controller.view('s')?.state).toBe(failure === 'known' ? 'human' : 'agent');
      expect(f.handoffs).toBe(failure === 'known' ? 2 : 1);
      expect(f.notifications).toBe(1);
      const response = (await f.store.listExecutions('s')).find(
        (row) => row.originCommandId === 'notification-record-failure',
      )!;
      expect(response.status).toBe('outcome_unknown');
      f.releaseWork();
      await f.runtime.waitForCommand('original-run', { timeoutMs: 5000 });
      const views = await f.runtime.queryExtension({
        expectedStoreId: f.storeId,
        subjectId: 'owner',
        sessionId: 's',
        extensionId: 'builtin.browser',
        queryId: 'browser.view',
        input: {},
      });
      expect(views[0]?.payload).toMatchObject({ humanPending: { state: 'unknown' } });
      await f.respond('repeat-notification-record-failure');
      await f.runtime.waitForCommand('repeat-notification-record-failure', { timeoutMs: 5000 });
      expect(f.notifications).toBe(1);
      expect(f.resumes).toBe(1);
    } finally {
      f.releaseWork();
      await f.runtime.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 20000);

test('committed inclusion with a lost resolved-record receipt remains unknown without returning or repeating control', async () => {
  const f = await fixture();
  try {
    await until(() => f.independent);
    f.beforeResponseRead = async (stage) => {
      if (f.resumes && stage === 'records.write') throw Error('fixture_record_receipt_lost');
    };
    await f.respond('resolved-record-ack-lost');
    await f.runtime.waitForCommand('resolved-record-ack-lost', { timeoutMs: 5000 });
    const request = (await f.readRequest())!.value as Record<string, Json>;
    expect(request.state).toBe('resolved');
    expect(await f.runtime.getCommand(`human-result-${request.requestId}`)).not.toBeNull();
    expect(f.resumes).toBe(1);
    expect(f.handoffs).toBe(1);
    const response = (await f.store.listExecutions('s')).find(
      (row) => row.originCommandId === 'resolved-record-ack-lost',
    )!;
    expect(response.status).toBe('outcome_unknown');
    await f.respond('repeat-resolved-record-ack-lost');
    await f.runtime.waitForCommand('repeat-resolved-record-ack-lost', { timeoutMs: 5000 });
    expect(f.resumes).toBe(1);
  } finally {
    f.releaseWork();
    await f.disposeCode();
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 20000);

test('a late reply cannot target a different active Run, and cancelled work never regains the page', async () => {
  const f = await fixture(true);
  try {
    await f.cancelPending();
    await f.runtime.waitForCommand('original-run', { timeoutMs: 5000 });
    await f.runtime.submitCommand({
      expectedStoreId: f.storeId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'other-run',
      request: { kind: 'run.start', content: 'Different independent task' },
    });
    await until(() => f.independent);
    const before = f.requests.length;
    await f.respond('wrong-run-reply');
    await f.runtime.waitForCommand('wrong-run-reply', { timeoutMs: 5000 });
    expect(f.resumes).toBe(0);
    expect(f.requests).toHaveLength(before);
    const req = (await f.readRequest())!.value as Record<string, Json>;
    expect(await f.runtime.getCommand(`human-result-${req.requestId}`)).toBeNull();
    expect(f.controller.view('s')?.state).toBe('human');
  } finally {
    f.releaseWork();
    await f.disposeCode();
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
  const g = await fixture();
  try {
    await until(() => g.independent);
    const req = (await g.readRequest())!.value as Record<string, Json>;
    await g.runtime.cancelRun({
      expectedStoreId: g.storeId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'cancel-original',
      runId: req.runId as string,
    });
    await until(async () => !(await g.store.getRun(req.runId as string))?.isActive);
    await g.respond('cancelled-reply');
    const blocked = await g.runtime.waitForCommand('cancelled-reply', { timeoutMs: 5000 }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(blocked).toMatchObject({ code: 'session_recovery_required' });
    expect(g.resumes).toBe(0);
    expect(g.controller.view('s')?.state).not.toBe('agent');
    expect(await g.runtime.getCommand(`human-result-${req.requestId}`)).toBeNull();
  } finally {
    g.releaseWork();
    await g.runtime.close();
    rmSync(g.root, { recursive: true, force: true });
  }
}, 20000);
test('an ended original Run rejects the old response without reacquiring browser control or reviving work', async () => {
  const f = await fixture(true);
  try {
    await f.cancelPending();
    await f.runtime.waitForCommand('original-run', { timeoutMs: 5000 });
    await f.respond('late-human');
    await f.runtime.waitForCommand('late-human', { timeoutMs: 5000 });
    expect(f.resumes).toBe(0);
    expect(f.controller.view('s')?.state).toBe('human');
    expect(f.requests).toHaveLength(3);
  } finally {
    await f.disposeCode();
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 20000);

test('proactive human takeover and return dispatch under the active Runtime owner; ordinary Actions stay queued and control cannot start new work', async () => {
  const f = await fixture(false, true);
  const submit = (id: string, extensionId: string, actionId: string, input: Json) =>
    f.runtime.submitCommand({
      expectedStoreId: f.storeId,
      subjectId: 'owner',
      sessionId: 's',
      commandId: id,
      request: { kind: 'extension.invoke', extensionId, actionId, definitionVersion: '1', input },
    });
  try {
    await until(() => f.independent);
    await submit('ordinary', 'fixture', 'fixture.ordinary', {});
    await submit('probe', 'fixture', 'fixture.control_probe', {});
    await f.runtime.waitForCommand('probe', { timeoutMs: 5000 });
    expect((await f.runtime.getCommand('ordinary'))?.status).toBe('accepted');
    const probe = (await f.store.listExecutions('s')).find(
      (row) => row.definitionId === 'fixture/fixture.control_probe',
    )!;
    expect(probe.status).toBe('succeeded');
    expect(JSON.stringify(probe.result)).toContain('control_action_new_work_denied');
    expect(
      (await f.store.listExecutions('s')).filter(
        (row) => row.definitionId === 'browser.human_wait',
      ),
    ).toHaveLength(0);
    const before = f.controller.view('s')!;
    await submit('takeover', 'builtin.browser', 'browser.handoff', {
      browserId: before.browserId,
      generation: before.generation,
    });
    await f.runtime.waitForCommand('takeover', { timeoutMs: 5000 });
    expect(f.controller.view('s')?.state).toBe('human');
    expect(f.handoffs).toBe(1);
    const human = f.controller.view('s')!;
    await submit('return', 'builtin.browser', 'browser.resume', {
      browserId: human.browserId,
      generation: human.generation,
    });
    await f.runtime.waitForCommand('return', { timeoutMs: 5000 });
    expect(f.controller.view('s')?.state).toBe('agent');
    expect(f.resumes).toBe(1);
    expect((await f.runtime.getCommand('ordinary'))?.status).toBe('accepted');
    expect(
      (await f.store.listExecutions('s')).filter(
        (row) => row.definitionId === 'fixture/fixture.ordinary',
      ),
    ).toHaveLength(0);
    f.releaseWork();
    await f.runtime.waitForCommand('original-run', { timeoutMs: 5000 });
    await f.runtime.waitForCommand('ordinary', { timeoutMs: 5000 });
    expect(
      (await f.store.listExecutions('s')).filter(
        (row) => row.definitionId === 'fixture/fixture.ordinary',
      ),
    ).toHaveLength(1);
  } finally {
    f.releaseWork();
    await f.disposeCode();
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 20000);

test('carrier cancellation while response eligibility awaits must win before any resume dispatch', async () => {
  const f = await fixture();
  let reached = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await until(() => f.independent);
    f.beforeWorkRead = async () => {
      reached = true;
      await gate;
    };
    await f.respond('response-cancellation-race');
    await until(() => reached);
    const carrier = (await f.store.listExecutions('s')).find(
      (row) => row.definitionId === 'browser.human_wait',
    )!;
    await f.runtime.cancelExecution({
      expectedStoreId: f.storeId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'cancel-human-carrier',
      executionId: carrier.id,
    });
    await until(async () => (await f.runtime.getExecution(carrier.id))?.status === 'cancelled');
    release();
    await f.runtime.waitForCommand('response-cancellation-race', { timeoutMs: 5000 });
    expect(f.resumes).toBe(0);
    expect(f.controller.view('s')?.state).toBe('human');
    const req = (await f.readRequest())!.value as Record<string, Json>;
    expect(await f.runtime.getCommand(`human-result-${req.requestId}`)).toBeNull();
  } finally {
    release();
    f.releaseWork();
    await f.disposeCode();
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 20000);

for (const [stage, occurrence] of [
  ['getExecution', 1],
  ['getCommand', 1],
  ['getRun', 1],
  ['getSession', 1],
  ['readWorkEligibility', 1],
  ['records.get', 1],
  ['records.write', 1],
  ['getExecution', 2],
] as const) {
  test(`carrier cancellation after execute ${stage}#${occurrence} prevents resume`, async () => {
    const f = await fixture();
    let reached = false,
      calls = 0,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await until(() => f.independent);
      f.beforeResponseRead = async (current) => {
        if (current === stage && ++calls === occurrence) {
          reached = true;
          await gate;
        }
      };
      await f.respond('cancel-at-response-boundary');
      await until(() => reached);
      const carrier = (await f.store.listExecutions('s')).find(
        (row) => row.definitionId === 'browser.human_wait',
      )!;
      await f.runtime.cancelExecution({
        expectedStoreId: f.storeId,
        sessionId: 's',
        subjectId: 'owner',
        commandId: 'cancel-boundary',
        executionId: carrier.id,
      });
      await until(async () => (await f.runtime.getExecution(carrier.id))?.status === 'cancelled');
      release();
      await f.runtime.waitForCommand('cancel-at-response-boundary', { timeoutMs: 5000 });
      expect(f.resumes).toBe(0);
      expect(f.controller.view('s')?.state).toBe('human');
      const request = (await f.readRequest())!.value as Record<string, Json>;
      expect(await f.runtime.getCommand(`human-result-${request.requestId}`)).toBeNull();
    } finally {
      release();
      f.releaseWork();
      await f.runtime.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 20000);
}

for (const phase of ['resume-ack', 'after-resume', 'return-unknown'] as const) {
  test(`carrier cancellation at ${phase} keeps or returns control without a notification`, async () => {
    const f = await fixture();
    let reached = false,
      calls = 0,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await until(() => f.independent);
      if (phase === 'resume-ack')
        f.beforeResume = async () => {
          reached = true;
          await gate;
        };
      else
        f.beforeWorkRead = async () => {
          if (++calls === 2) {
            reached = true;
            await gate;
          }
        };
      await f.respond('cancel-after-resume');
      await until(() => reached);
      expect(f.controller.view('s')?.state).toBe(phase === 'resume-ack' ? 'pausing' : 'agent');
      if (phase === 'return-unknown') f.failHandoff = true;
      const carrier = (await f.store.listExecutions('s')).find(
        (row) => row.definitionId === 'browser.human_wait',
      )!;
      await f.runtime.cancelExecution({
        expectedStoreId: f.storeId,
        sessionId: 's',
        subjectId: 'owner',
        commandId: 'cancel-inflight-response',
        executionId: carrier.id,
      });
      await until(async () => (await f.runtime.getExecution(carrier.id))?.status === 'cancelled');
      release();
      await f.runtime.waitForCommand('cancel-after-resume', { timeoutMs: 5000 });
      expect(f.resumes).toBe(1); // dispatched before cancellation, never resent
      expect(f.handoffs).toBe(2); // original yield + exactly one compensating return
      expect(f.controller.view('s')?.state).toBe(
        phase === 'return-unknown' ? 'outcome_unknown' : 'human',
      );
      const request = (await f.readRequest())!.value as Record<string, Json>;
      expect(await f.runtime.getCommand(`human-result-${request.requestId}`)).toBeNull();
      const response = (await f.store.listExecutions('s')).find(
        (row) => row.originCommandId === 'cancel-after-resume',
      )!;
      if (phase === 'return-unknown') expect(response.status).toBe('outcome_unknown');
    } finally {
      release();
      f.releaseWork();
      await f.runtime.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 20000);
}

for (const change of ['expiry', 'page-closed'] as const) {
  test(`${change} while the final carrier read awaits never dispatches a resume`, async () => {
    const f = await fixture();
    let reached = false,
      calls = 0,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalNow = Date.now;
    try {
      await until(() => f.independent);
      f.beforeResponseRead = async (stage) => {
        if (stage === 'getExecution' && ++calls === 2) {
          reached = true;
          await gate;
        }
      };
      await f.respond('expired-before-control-effect');
      await until(() => reached);
      if (change === 'expiry') {
        const expiresAt = ((await f.readRequest())!.value as Record<string, Json>)
          .expiresAt as number;
        Date.now = () => expiresAt + 1;
      } else {
        expect((await f.controller.close('s', f.controller.view('s')!)).outcome).toBe('succeeded');
      }
      release();
      await f.runtime.waitForCommand('expired-before-control-effect', { timeoutMs: 5000 });
      expect(f.resumes).toBe(0);
      expect(f.controller.view('s')?.state).not.toBe('agent');
    } finally {
      Date.now = originalNow;
      release();
      f.releaseWork();
      await f.runtime.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 20000);
}

for (const damage of ['parent', 'cancelled', 'work'] as const)
  test(`nested human continuation rejects damaged ${damage} source before resume or notification`, async () => {
    const f = await fixture(false, false, undefined, true);
    try {
      await until(() => f.independent);
      f.nestedSourceDamage = damage;
      await f.respond('invalid-source');
      await f.runtime.waitForCommand('invalid-source', { timeoutMs: 5000 });
      expect(f.resumes).toBe(0);
      expect(f.controller.view('s')?.state).toBe('human');
      const row = (await f.readRequest())!.value as Record<string, Json>;
      expect(await f.runtime.getCommand(`human-result-${row.requestId}`)).toBeNull();
      expect(row.state).toBe('pending');
    } finally {
      f.releaseWork();
      await f.disposeCode();
      await f.runtime.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 15000);

test('nested human Stop closes the original page lease without resuming and includes one real result', async () => {
  const f = await fixture(false, false, undefined, true);
  try {
    await until(() => f.independent);
    await f.respond('stop-human', 'stop');
    await f.runtime.waitForCommand('stop-human', { timeoutMs: 5000 });
    expect(f.resumes).toBe(0);
    expect(f.controller.view('s')?.state).toBe('closed');
    const row = (await f.readRequest())!.value as Record<string, Json>;
    expect(row.state).toBe('resolved');
    expect((await f.runtime.getCommand(`human-result-${row.requestId}`))?.kind).toBe(
      'result.include',
    );
  } finally {
    f.releaseWork();
    await f.disposeCode();
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15000);

test('nested source change during resume returns only that lease and sends no continuation', async () => {
  const f = await fixture(false, false, undefined, true);
  try {
    await until(() => f.independent);
    f.beforeResume = async () => {
      f.nestedSourceDamage = 'work';
    };
    await f.respond('source-changed-during-resume');
    await f.runtime.waitForCommand('source-changed-during-resume', { timeoutMs: 5000 });
    expect(f.resumes).toBe(1);
    expect(f.handoffs).toBe(2);
    expect(f.controller.view('s')?.state).toBe('human');
    const row = (await f.readRequest())!.value as Record<string, Json>;
    expect(row.state).toBe('unknown');
    expect(await f.runtime.getCommand(`human-result-${row.requestId}`)).toBeNull();
  } finally {
    f.releaseWork();
    await f.disposeCode();
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15000);
