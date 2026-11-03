import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import Ajv from 'ajv';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import type { ExecutionResources } from '../../../src/execution/resources';
import type { Json, ToolResult } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';
import {
  type BrowserController,
  BrowserTransportError,
  createBrowserController,
  createBrowserExtension,
  type NativeBrowserTransport,
} from '../../../src/tools/browser';
import {
  type BrowserCodeExecutor,
  createBrowserExecution,
} from '../../../src/tools/browser/execute';
import { createBrowserExecutor } from '../../../src/tools/browser/executor';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1eIAAAAASUVORK5CYII=';
const largeSnapshot = {
  url: `https://example.test/${'雪😀'.repeat(2500)}`,
  title: `${'\u0001'.repeat(500)}"\\😀`,
  snapshot: '雪'.repeat(65536),
  name: `${'\u0001"\\雪😀'.repeat(166)}尾巴`,
};
const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
type Batch = Parameters<BrowserCodeExecutor['execute']>[0];
type Program = (batch: Batch, state: Record<string, Json>) => Promise<Json>;
const obj = (value: Json) => value as Record<string, Json>;
const pageCall = (batch: Batch, state: Record<string, Json>, method: string, args: Json[] = []) =>
  batch.call(method, { page: state.page!, args });

async function fixture(
  programs: Program[],
  options: {
    refuseOpen?: boolean;
    missingRetained?: boolean;
    retainedFailure?: 'browser_page_existing_missing' | 'browser_page_existing_mismatch';
    confirmedMissingRetainedOnce?: boolean;
    recoverInitialNavigation?: boolean;
    denyFill?: boolean;
    unknownFill?: boolean;
    parallel?: boolean;
    failSnapshot?: boolean;
    failImage?: boolean;
    processConcurrency?: number;
    occupyProcessSlot?: boolean;
    cancelDuringFill?: boolean;
    deferBrowserAuthorization?: boolean;
    waitForCompletion?: boolean;
    earlyBrowserOutcome?: 'failed' | 'outcome_unknown';
    finalContent?: string;
    internalAuthorizationCheck?: boolean;
    additionalSession?: boolean;
    unconfirmedExecutorClose?: boolean;
    deferNavigation?: boolean;
    deferReady?: boolean;
    failNavigation?: boolean;
    unconfirmedTransportClose?: boolean;
    endBeforeSnapshot?: boolean;
    realCodes?: string[];
    callInputs?: Record<string, Json>[];
    largeSnapshot?: boolean;
    sharedPage?: boolean;
    multipleSharedPages?: boolean;
    legacyReleasedPage?: boolean;
    duplicateReleasedCandidate?: boolean | number;
    followupFrom?: number;
    runBreaks?: number[];
    beforeFinal?: () => Promise<void>;
    timeoutCode?: string;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-browser-execute-')));
  let realFactory = createBrowserExecutor;
  if (options.realCodes) {
    const built = await Bun.build({
      entrypoints: [
        join(import.meta.dir, '../../../src/tools/browser/executor/worker.ts'),
        join(import.meta.dir, '../../../src/mcp/stdio-guardian.ts'),
        join(import.meta.dir, '../../../src/tools/browser/executor/index.ts'),
      ],
      target: 'bun',
      outdir: root,
      naming: '[name].js',
    });
    if (!built.success) throw Error('fixture_build_failed');
    // Match the development Source facade: Host callback identity and result
    // discriminants must survive a separately bundled executor implementation.
    realFactory = (await import(pathToFileURL(join(root, 'index.js')).href)).createBrowserExecutor;
  }
  const profile = { dataRoot: join(root, 'data'), profile: 'fixture' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const native: Json[] = [];
  const mainPage = { id: 'retained-main-page', url: 'about:blank', value: '', clicks: 0 };
  const mainIdentity = { pageId: mainPage.id, incarnation: randomUUID() };
  const retainedMainPages = [{ page: mainPage, identity: mainIdentity }];
  let initialNavigationLost = false;
  const nativePages: string[] = [];
  const executorCalls: string[] = [];
  const apiFailures: string[] = [];
  const realBoundaries: {
    state?: string;
    jobs: { id: string; status: string }[];
    closes: number;
  }[] = [];
  const states: Record<string, Json>[] = [];
  let releaseBrowserAuthorization!: () => void, enteredBrowserAuthorization!: () => void;
  const browserAuthorization = new Promise<void>((resolve) => {
    releaseBrowserAuthorization = resolve;
  });
  const browserAuthorizationEntered = new Promise<void>((resolve) => {
    enteredBrowserAuthorization = resolve;
  });
  let releaseNavigation!: () => void, enteredNavigation!: () => void;
  const navigation = new Promise<void>((resolve) => {
    releaseNavigation = resolve;
  });
  const navigationEntered = new Promise<void>((resolve) => {
    enteredNavigation = resolve;
  });
  let enteredTransport!: () => void;
  const transportCreated = new Promise<void>((resolve) => {
    enteredTransport = resolve;
  });
  let startingChecks = 0;
  let owners = 0,
    executorCloses = 0,
    transportCloses = 0;
  let resolveTransport!: (value: { confirmed: boolean }) => void;
  const completion = new Promise<{ confirmed: boolean }>((resolve) => {
    resolveTransport = resolve;
  });
  const pageTransport = (page = mainPage, identity = mainIdentity): NativeBrowserTransport => ({
    ...(options.sharedPage
      ? { sharedPage: true as const, sharedPageIdentity: () => ({ ...identity }) }
      : {}),
    ready: options.deferReady ? navigation : Promise.resolve(),
    completion,
    async request(command, signal): Promise<Json> {
      native.push(structuredClone(command));
      if (options.sharedPage) nativePages.push(page.id);
      if (obj(command).action === 'url' && options.sharedPage)
        return { success: true, data: { url: page.url } };
      if (obj(command).action === 'navigate') {
        enteredNavigation();
        if (options.deferNavigation) {
          let abort!: () => void;
          try {
            await Promise.race([
              navigation,
              new Promise<never>((_resolve, reject) => {
                abort = () => reject(signal.reason ?? Error('navigation_cancelled'));
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) abort();
              }),
            ]);
          } finally {
            signal.removeEventListener('abort', abort);
          }
        }
        if (options.failNavigation) throw Error('synthetic_navigation_ack_lost');
        if (options.recoverInitialNavigation && !initialNavigationLost) {
          initialNavigationLost = true;
          page.url = 'https://example.test/redirected';
          throw new BrowserTransportError('browser_native_response_lost', true);
        }
        if (options.sharedPage) page.url = String(obj(command).url);
      }
      if (obj(command).action === 'fill' && options.cancelDuringFill) {
        const work = await store.getCommand('work');
        const runId = (work!.receipt as { runId: string }).runId;
        await runtime.cancelRun({
          expectedStoreId,
          sessionId: 'session',
          subjectId: 'owner',
          commandId: 'cancel-during-fill',
          runId,
        });
        throw Error('synthetic_cancelled_dispatched_input');
      }
      if (obj(command).action === 'snapshot' && options.failSnapshot)
        return { success: false, error: 'synthetic_initial_snapshot_failure' };
      if (obj(command).action === 'fill' && options.unknownFill)
        throw Error('dispatched_transport_lost');
      if (obj(command).action === 'snapshot' && options.largeSnapshot)
        return {
          success: true,
          data: {
            origin: largeSnapshot.url,
            title: largeSnapshot.title,
            snapshot: largeSnapshot.snapshot,
            refs: Object.fromEntries(
              Array.from({ length: 20 }, (_, index) => [
                `e${index + 1}`,
                { role: 'textbox', name: largeSnapshot.name },
              ]),
            ),
          },
        };
      if (options.sharedPage) {
        if (obj(command).action === 'fill') page.value = String(obj(command).value);
        if (obj(command).action === 'click') page.clicks++;
        return {
          success: true,
          data: {
            url: page.url,
            snapshot: `textbox Name ${page.value}; Clicks: ${page.clicks}`,
            title: 'Local form',
            refs: { e1: { role: 'textbox', name: 'Name' } },
          },
        };
      }
      return { success: true, data: { snapshot: 'textbox Name', title: 'Local form' } };
    },
    async capture() {
      return {
        url: options.sharedPage ? page.url : 'https://example.test/',
        title: 'Local form',
        frame: { mimeType: 'image/jpeg', data: 'preview-only', width: 640, height: 480 },
        annotations: [
          {
            ref: 'e1',
            number: 1,
            role: 'textbox',
            name: 'Name',
            box: { x: 1, y: 2, width: 30, height: 10 },
          },
        ],
      };
    },
    async capturePng() {
      if (options.failImage) throw Error('desktop_browser_read_stale');
      return {
        data: png,
        width: 1,
        height: 1,
        viewport: { width: 640, height: 480 },
        navigation: 1,
      };
    },
    async close() {
      transportCloses++;
      if (options.deferReady) releaseNavigation();
      const confirmed = !options.unconfirmedTransportClose;
      resolveTransport({ confirmed });
      return { confirmed };
    },
    async dispose() {},
  });
  const transport = pageTransport();
  const controller = createBrowserController({
    runtime: () => runtime,
    ...(options.sharedPage ? { sharedPage: true as const } : {}),
    createTransport(_context, binding) {
      owners++;
      enteredTransport();
      let selected = transport;
      if (options.multipleSharedPages) {
        let retained = retainedMainPages.find(({ page }) => page.url === new URL(binding.url).href);
        if (!retained && retainedMainPages[0]?.page.url === 'about:blank')
          retained = retainedMainPages[0]!;
        if (!retained) {
          const id = `retained-main-page-${retainedMainPages.length + 1}`;
          retained = {
            page: { id, url: 'about:blank', value: '', clicks: 0 },
            identity: { pageId: id, incarnation: randomUUID() },
          };
          retainedMainPages.push(retained);
        }
        selected = pageTransport(retained.page, retained.identity);
      }
      if (options.additionalSession || options.sharedPage) {
        let ended!: (value: { confirmed: boolean }) => void;
        let disposed = false;
        let released: ReturnType<NonNullable<NativeBrowserTransport['releasedSharedPage']>> = null;
        return {
          ...selected,
          completion: new Promise<{ confirmed: boolean }>((resolve) => {
            ended = resolve;
          }),
          async close() {
            transportCloses++;
            if (options.deferReady) releaseNavigation();
            if (
              options.recoverInitialNavigation &&
              initialNavigationLost &&
              !_context.signal.aborted
            )
              released = { url: mainPage.url, title: 'Local form', identity: { ...mainIdentity } };
            ended({ confirmed: true });
            return { confirmed: true };
          },
          async dispose() {
            await selected.dispose();
            if (options.recoverInitialNavigation) await Bun.sleep(80);
            disposed = true;
          },
          releasedSharedPage() {
            return disposed ? structuredClone(released) : null;
          },
        };
      }
      return selected;
    },
    captureIntervalMs: 60000,
    ...(options.largeSnapshot || options.recoverInitialNavigation
      ? { observationMode: async () => 'on-demand' as const }
      : {}),
  });
  const execution = createBrowserExecution({
    controller: {
      ...controller,
      ...(options.legacyReleasedPage
        ? { releasedPages: undefined }
        : options.duplicateReleasedCandidate
          ? {
              releasedPages(sessionId: string) {
                const pages = controller.releasedPages!(sessionId);
                const first = pages[0];
                const count =
                  typeof options.duplicateReleasedCandidate === 'number'
                    ? options.duplicateReleasedCandidate
                    : 2;
                return first
                  ? [
                      ...pages,
                      ...Array.from({ length: count - 1 }, (_, index) => ({
                        ...first,
                        url: new URL(first.url).href,
                        identity: {
                          pageId: `duplicate-main-page-${index}`,
                          incarnation: `duplicate-inc-${index}`,
                        },
                      })),
                    ]
                  : pages;
              },
            }
          : {}),
      view(sessionId) {
        const view = controller.view(sessionId);
        if (view?.state === 'starting') startingChecks++;
        return view;
      },
    },
    createExecutor() {
      const state: Record<string, Json> = {};
      states.push(state);
      let closed = false;
      if (options.realCodes) {
        let real: ReturnType<typeof createBrowserExecutor> | undefined;
        return {
          async execute(batch) {
            executorCalls.push(batch.code);
            real ??= realFactory({
              scope: 'runtime-real-fixture',
              workerPath: join(root, 'worker.js'),
              guardianPath: join(root, 'stdio-guardian.js'),
            });
            const result = await (await real).execute(
              batch.code === options.timeoutCode ? { ...batch, timeoutMs: 100 } : batch,
            );
            realBoundaries.push({
              state: controller.view('session')?.state,
              jobs: (await store.listExecutions('session'))
                .filter((row) => row.definitionId === 'browser.session')
                .map((row) => ({ id: row.id, status: row.status })),
              closes: transportCloses,
            });
            return result;
          },
          async close() {
            if (!closed) executorCloses++;
            closed = true;
            return real ? (await real).close() : { confirmed: true };
          },
        };
      }
      return {
        async execute(batch) {
          executorCalls.push(batch.code);
          const value = await programs[Number(batch.code)]!(
            {
              ...batch,
              async call(method, args) {
                try {
                  return await batch.call(method, args);
                } catch (error) {
                  apiFailures.push(error instanceof Error ? error.message : String(error));
                  throw error;
                }
              },
            },
            state,
          );
          return { value, output: 'controlled-executor-fixture' };
        },
        async close() {
          if (!closed) executorCloses++;
          closed = true;
          return { confirmed: !options.unconfirmedExecutorClose };
        },
      };
    },
  });
  let confirmedMissing = false;
  const browser = createBrowserExtension({
    controller,
    prepareOpen:
      options.refuseOpen ||
      options.missingRetained ||
      options.retainedFailure ||
      options.confirmedMissingRetainedOnce ||
      options.recoverInitialNavigation
        ? async (context, intent) => {
            const own = await context.getExecution(context.executionId);
            if (options.recoverInitialNavigation) {
              try {
                controller.releasedPage!(context.sessionId, intent.url);
              } catch (error) {
                if (error instanceof Error && error.message === 'browser_page_recovery_required')
                  return { outcome: 'failed', content: error.message };
                throw error;
              }
              return undefined;
            }
            if (options.confirmedMissingRetainedOnce) {
              if (own?.rootWorkCommandId !== 'next-work' || confirmedMissing) return undefined;
              confirmedMissing = true;
              const original = controller.releasedPage!(context.sessionId, 'https://example.test/');
              // Substitute only the trusted Service/Main admission boundary: the
              // original target is confirmed missing before any replacement exists.
              expect(original?.identity).toEqual(mainIdentity);
              retainedMainPages.splice(0, 1);
              controller.invalidateMissingReleasedPage!(context.sessionId, original!.identity!);
              return { outcome: 'failed', content: 'browser_page_existing_missing' };
            }
            if (options.refuseOpen || own?.rootWorkCommandId === 'next-work')
              return {
                outcome: 'failed',
                content: options.refuseOpen
                  ? 'browser_page_grant_refused'
                  : (options.retainedFailure ?? 'browser_existing_page_unavailable'),
              };
            return undefined;
          }
        : undefined,
  });
  const extension = {
    ...browser,
    tools: [...browser.tools!, ...execution.tools],
    jobs: [
      ...browser.jobs!.map((job) =>
        job.id !== 'browser.session' || !options.earlyBrowserOutcome
          ? job
          : {
              ...job,
              async start() {
                return { reference: { fixture: 'ended-before-controller' } };
              },
              async *observe() {
                yield {
                  type: 'terminal' as const,
                  supervision: 'ended' as const,
                  result: {
                    outcome: options.earlyBrowserOutcome!,
                    content: `original_${options.earlyBrowserOutcome}_before_controller`,
                  },
                };
              },
              async cancel() {
                return { status: 'stopped' as const };
              },
              async dispose() {},
            },
      ),
      ...execution.jobs,
    ],
    records: [
      ...browser.records!,
      {
        contentType: 'application/vnd.kite.browser-code+json',
        contentVersion: 1,
        schema: { type: 'object' },
      },
    ],
  };
  const calls = programs.map((_, index) => ({
    type: 'tool_call' as const,
    id: `batch-${index}`,
    name: 'browser_execute',
    arguments: JSON.stringify(
      options.callInputs?.[index] ?? {
        code: options.realCodes?.[index] ?? String(index),
        description: '执行浏览器操作',
      },
    ),
  }));
  const responses: ModelEvent[][] = [];
  const appendRun = (selected: typeof calls) => {
    if (options.parallel) responses.push([...selected, { ...finish, reason: 'tool_calls' }]);
    else for (const call of selected) responses.push([call, { ...finish, reason: 'tool_calls' }]);
    responses.push([
      ...(options.finalContent
        ? [{ type: 'text_delta' as const, text: options.finalContent }]
        : []),
      finish,
    ]);
  };
  let runOffset = 0;
  for (const boundary of options.runBreaks ??
    (options.followupFrom === undefined ? [] : [options.followupFrom])) {
    appendRun(calls.slice(runOffset, boundary));
    runOffset = boundary;
  }
  appendRun(calls.slice(runOffset));
  if (options.additionalSession) responses.push([finish]);
  const fixed = createFixedModel(responses);
  const model: ReturnType<typeof createFixedModel> = {
    get requests() {
      return fixed.requests;
    },
    async *stream(request, streamOptions) {
      for await (const event of fixed.stream(request, streamOptions)) {
        if (event.type === 'finish' && event.reason === 'stop') await options.beforeFinal?.();
        yield event;
      }
    },
  };
  const authorizationMarker = 'INTERNAL_BROWSER_AUTHORIZATION_RESULT_ONLY';
  const checker = createFixedModel([
    [
      {
        type: 'text_delta',
        text: JSON.stringify({ decision: 'approve_once', reason: authorizationMarker }),
      },
      finish,
    ],
  ]);
  const authorizations: string[] = [];
  let endedBeforeSnapshot = false;
  let endedOriginal: { id: string; resultRevision: string; result: Json } | undefined;
  const runtime: ReturnType<typeof createRuntime> = createRuntime({
    store,
    model,
    modelId: 'fixture',
    ...(options.internalAuthorizationCheck
      ? {
          authorizationCheck: {
            id: 'browser-fixture-checker',
            version: '1',
            modelId: 'browser-checker',
            model: checker,
          },
        }
      : {}),
    ...(options.processConcurrency ? { processConcurrency: options.processConcurrency } : {}),
    extensions: [extension],
    artifacts: createArtifactStore({ profile, store }),
    permissions: {
      async authorize(request) {
        authorizations.push(request.definitionId);
        if (
          request.definitionId === 'browser.snapshot' &&
          options.endBeforeSnapshot &&
          !endedBeforeSnapshot
        ) {
          endedBeforeSnapshot = true;
          while (controller.view('session')?.state !== 'agent') await Bun.sleep(5);
          resolveTransport({ confirmed: false });
          while (
            !(await store.listExecutions('session')).some(
              (row) => row.definitionId === 'browser.session' && row.status === 'outcome_unknown',
            )
          )
            await Bun.sleep(5);
          const ended = (await store.listExecutions('session')).find(
            (row) => row.definitionId === 'browser.session',
          )!;
          endedOriginal = structuredClone({
            id: ended.id,
            resultRevision: ended.resultRevision,
            result: ended.result,
          });
        }
        if (request.definitionId === 'browser.session' && options.deferBrowserAuthorization) {
          enteredBrowserAuthorization();
          let abort!: () => void;
          try {
            await Promise.race([
              browserAuthorization,
              new Promise<never>((_resolve, reject) => {
                abort = () => reject(request.signal.reason ?? Error('cancel_requested'));
                request.signal.addEventListener('abort', abort, { once: true });
                if (request.signal.aborted) abort();
              }),
            ]);
            request.signal.throwIfAborted();
          } finally {
            request.signal.removeEventListener('abort', abort);
          }
        }
        if (request.definitionId === 'browser.session' && options.internalAuthorizationCheck)
          return {
            allowed: false,
            revision: 'browser-check-required',
            snapshot: { namespace: 'fixture.permissions', version: '1', data: { mode: 'auto' } },
            check: { request: { task: 'Authorize this exact fixture Browser Job' } },
          };
        return request.definitionId === 'browser.fill' && options.denyFill
          ? { allowed: false, revision: 'denied', reason: 'fixture_fill_denied' }
          : { allowed: true, revision: 'allowed' };
      },
    },
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'workspace',
    name: 'fixture',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    expectedStoreId,
    sessionId: 'session',
    workspaceId: 'workspace',
    commandId: 'create',
    subjectId: 'owner',
    title: 'fixture',
  });
  const resources = Reflect.get(
    Reflect.get(Reflect.get(runtime, 'execution'), 'options'),
    'resources',
  ) as ExecutionResources;
  const releaseProcessSlot = options.occupyProcessSlot
    ? await resources.acquire(
        { slot: 'process' },
        { sessionId: 'external-occupant', workspaceId: 'workspace' },
        new AbortController().signal,
      )
    : () => {};
  await runtime.submitCommand({
    expectedStoreId,
    sessionId: 'session',
    commandId: 'work',
    subjectId: 'owner',
    request: { kind: 'run.start', content: 'Complete the local form' },
  });
  if (options.additionalSession) {
    await runtime.createSession({
      expectedStoreId,
      sessionId: 'second',
      workspaceId: 'workspace',
      commandId: 'create-second',
      subjectId: 'owner',
      title: 'second fixture',
    });
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 'second',
      commandId: 'second-work',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'Complete the second local form' },
    });
  }
  if (options.waitForCompletion !== false)
    await runtime.waitForCommand('work', { timeoutMs: 6000 });
  return {
    runtime,
    store,
    controller,
    model,
    checker,
    authorizationMarker,
    native,
    nativePages,
    mainPage,
    mainIdentity,
    retainedMainPages,
    setCode(index: number, code: string) {
      calls[index]!.arguments = JSON.stringify({ code, description: '执行浏览器操作' });
    },
    async startNewRun(commandId = 'next-work') {
      return runtime.submitCommand({
        expectedStoreId,
        sessionId: 'session',
        commandId,
        subjectId: 'owner',
        request: {
          kind: 'run.start',
          content: 'Continue on the retained page with fresh observations',
        },
      });
    },
    states,
    executorCalls,
    authorizations,
    apiFailures,
    realBoundaries,
    get endedOriginal() {
      return endedOriginal;
    },
    browserAuthorizationEntered,
    releaseBrowserAuthorization,
    releaseProcessSlot,
    navigationEntered,
    transportCreated,
    releaseNavigation,
    get startingChecks() {
      return startingChecks;
    },
    get owners() {
      return owners;
    },
    get executorCloses() {
      return executorCloses;
    },
    get transportCloses() {
      return transportCloses;
    },
    async close() {
      releaseProcessSlot();
      if (options.unconfirmedExecutorClose)
        await expect(execution.disposeCommand('session', 'work')).rejects.toThrow(
          'browser_executor_cleanup_unknown',
        );
      else await execution.disposeCommand('session', 'work');
      if (options.additionalSession) await execution.disposeCommand('second', 'second-work');
      if (
        options.unconfirmedExecutorClose ||
        options.unconfirmedTransportClose ||
        options.endBeforeSnapshot
      ) {
        await expect(runtime.close()).rejects.toThrow('shutdown_cleanup_unconfirmed');
        expect(runtime.getLifecycleState().state).toBe('drain_failed');
        // This fixture owns no OS interpreter. Direct Store teardown is not
        // production stop confirmation and never returns the retained permit.
        await store.close();
      } else await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('original code-only internal browser inputs remain valid without a public purpose description', () => {
  const { tools } = createBrowserExecution({
    controller: {} as BrowserController,
    createExecutor() {
      throw Error('schema_validation_must_not_dispatch');
    },
  });
  const validate = new Ajv({ strict: false }).compile(
    tools.find((tool) => tool.id === 'browser.execute')!.inputSchema,
  );
  expect(validate({ code: '0' })).toBe(true);
  expect(validate({ code: '0', description: '读取北京天气' })).toBe(true);
  expect(validate({ code: '0', description: '读'.repeat(11) })).toBe(false);
});

test.each([
  '读取北京天气',
  '读'.repeat(10),
  '🙂'.repeat(10),
])('browser call purpose is bounded, persisted and kept out of the interpreter: %s', async (description) => {
  const f = await fixture(
    [
      async (batch) => {
        expect(batch.code).toBe('0');
        expect(Object.hasOwn(batch, 'description')).toBe(false);
        return null;
      },
    ],
    { callInputs: [{ code: '0', description }] },
  );
  try {
    const tool = f.model.requests[0]!.tools.find((tool) => tool.id === 'browser_execute')!;
    expect(tool.inputSchema).toMatchObject({
      required: ['code', 'description'],
      properties: { description: { maxLength: 10, pattern: '\\S' } },
    });
    expect(f.executorCalls).toEqual(['0']);
    const saved = (await f.store.listExecutions('session')).find(
      (entry) => entry.definitionId === 'browser.execute',
    )!;
    expect(saved.input).toEqual({ code: '0', description });
    const call = f.model.requests[1]!.messages.flatMap((message) => message.toolCalls ?? []).find(
      (call) => call.name === 'browser_execute',
    )!;
    expect(JSON.parse(call.arguments)).toEqual({ code: '0', description });
  } finally {
    await f.close();
  }
});

test.each([
  undefined,
  '',
  '   ',
  '读'.repeat(11),
  '🙂'.repeat(11),
  1,
])('invalid or missing browser purpose fails before interpreter dispatch: %s', async (description) => {
  const f = await fixture([async () => null], {
    callInputs: [{ code: '0', ...(description === undefined ? {} : { description }) }],
  });
  try {
    expect(f.executorCalls).toEqual([]);
    expect(f.states).toEqual([]);
    expect(
      f.model.requests[1]!.messages.some(
        (message) => message.role === 'tool' && message.content.includes('invalid_tool_arguments'),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

for (const ending of ['completed', 'cancelled', 'unknown'] as const)
  test(`capacity two serializes two Sessions' environments and preserves ${ending} admission`, async () => {
    let release!: () => void;
    const opening = new Promise<void>((resolve) => {
      release = resolve;
    });
    const program: Program = async (batch, state) => {
      await opening;
      await open(batch, state);
      await pageCall(batch, state, 'close');
      return null;
    };
    const f = await fixture([program, program], {
      processConcurrency: 2,
      waitForCompletion: false,
      additionalSession: true,
      unconfirmedExecutorClose: ending === 'unknown',
    });
    const until = async (predicate: () => Promise<boolean> | boolean) => {
      const deadline = Date.now() + 2500;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw Error('browser environment admission deadline');
        await Bun.sleep(10);
      }
    };
    try {
      await until(() => f.executorCalls.length === 1);
      await until(async () =>
        (await f.store.listExecutions('second')).some(
          (row) => row.definitionId === 'browser.execute' && row.status === 'dispatching',
        ),
      );
      expect(f.states).toHaveLength(1);
      expect((await f.store.listExecutions('second')).filter((row) => row.kind === 'job')).toEqual(
        [],
      );
      if (ending === 'cancelled') {
        await f.runtime.cancelCommand({
          expectedStoreId: (await f.store.getMetadata()).storeId,
          subjectId: 'owner',
          sessionId: 'second',
          commandId: 'cancel-second',
          targetCommandId: 'second-work',
        });
        await f.runtime.waitForCommand('second-work');
      }
      release();
      await f.runtime.waitForCommand('work', { timeoutMs: 4000 });
      if (ending === 'completed') {
        await f.runtime.waitForCommand('second-work', { timeoutMs: 4000 });
        expect(f.executorCalls).toHaveLength(2);
        expect(f.owners).toBe(2);
        for (const sessionId of ['session', 'second'])
          expect((await f.store.getView(sessionId)).runs[0]!.status).toBe('completed');
      } else {
        if (ending === 'unknown') {
          await until(async () =>
            (await f.store.listExecutions('session')).some(
              (row) =>
                row.definitionId === 'browser.code_session' && row.status === 'outcome_unknown',
            ),
          );
          expect(f.runtime.getLifecycleState().busy).toBe(true);
          await f.runtime.cancelCommand({
            expectedStoreId: (await f.store.getMetadata()).storeId,
            subjectId: 'owner',
            sessionId: 'second',
            commandId: 'cancel-second',
            targetCommandId: 'second-work',
          });
          await f.runtime.waitForCommand('second-work');
        }
        await Bun.sleep(30);
        expect(f.executorCalls).toHaveLength(1);
        expect(
          (await f.store.listExecutions('second')).filter((row) => row.kind === 'job'),
        ).toEqual([]);
        expect((await f.store.getView('second')).runs[0]!.status).toBe('cancelled');
      }
    } finally {
      release();
      await f.close();
    }
  });

test('ended Browser Job business unknown preserves both original results without retaining a closed environment ticket', async () => {
  const f = await fixture([open, open], {
    processConcurrency: 2,
    additionalSession: true,
    waitForCompletion: false,
    earlyBrowserOutcome: 'outcome_unknown',
  });
  try {
    await f.runtime.waitForCommand('work', { timeoutMs: 4000 });
    await f.runtime.waitForCommand('second-work', { timeoutMs: 4000 });
    expect(f.states).toHaveLength(2);
    expect(f.executorCloses).toBe(2);
    expect(f.owners).toBe(0);
    for (const sessionId of ['session', 'second']) {
      const rows = await f.store.listExecutions(sessionId);
      expect(rows.find((row) => row.definitionId === 'browser.execute')).toMatchObject({
        status: 'outcome_unknown',
      });
      expect(rows.find((row) => row.definitionId === 'browser.session')).toMatchObject({
        status: 'outcome_unknown',
        result: { content: 'original_outcome_unknown_before_controller' },
      });
      expect((await f.store.getView(sessionId)).runs[0]!.status).toBe('completed');
    }
  } finally {
    await f.close();
  }
});

const open: Program = async (batch, state) => {
  state.page = await batch.call('open', { url: 'https://example.test/' });
  const observed = obj(await pageCall(batch, state, 'snapshot'));
  state.ref = obj((observed.elements as Json[])[0]!).ref!;
  return observed;
};
const fill: Program = async (batch, state) => {
  await pageCall(batch, state, 'fill', [state.ref!, 'Ada']);
  const verified = await pageCall(batch, state, 'snapshot');
  await pageCall(batch, state, 'close');
  return verified;
};

test('a failed formal observation preserves its exact read error and never becomes a website-effect unknown', async () => {
  const f = await fixture(
    [
      open,
      async (batch, state) => {
        try {
          await pageCall(batch, state, 'screenshot');
        } catch {}
        try {
          await pageCall(batch, state, 'fill', [state.ref!, 'forbidden']);
        } catch {}
        return null;
      },
    ],
    { failImage: true },
  );
  try {
    const executions = await f.store.listExecutions('session');
    const image = executions.find((entry) => entry.definitionId === 'browser.image')!;
    const batch = executions.find((entry) => entry.id === image.parentExecutionId)!;
    expect(image.status).toBe('failed');
    expect((image.result as unknown as ToolResult).content).toBe('desktop_browser_read_stale');
    expect(batch.status).toBe('failed');
    expect(obj((batch.result as unknown as ToolResult).details!).code).toBe(
      'desktop_browser_read_stale',
    );
    expect(f.native.filter((value) => obj(value).action === 'fill')).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('a normally completed Run closes its code Job without opening a page or relying on configuration disposal', async () => {
  const f = await fixture([async () => ({ complete: true })]);
  try {
    const until = Date.now() + 2000;
    while (f.runtime.getLifecycleState().busy && Date.now() < until) await Bun.sleep(20);
    const executions = await f.store.listExecutions('session');
    const batch = executions.find((entry) => entry.definitionId === 'browser.execute')!;
    const job = executions.find((entry) => entry.definitionId === 'browser.code_session')!;
    expect((await f.store.getRun(batch.runId!))?.status).toBe('completed');
    expect(batch.status).toBe('succeeded');
    expect(job.parentExecutionId).toBe(batch.id);
    expect(job.status).toBe('cancelled');
    expect(f.executorCloses).toBe(1);
    expect(f.owners).toBe(0);
    expect(f.transportCloses).toBe(0);
    expect(f.runtime.getLifecycleState()).toMatchObject({ busy: false, reasons: [] });
  } finally {
    await f.close();
  }
});

test('normal Run completion releases its exact browser lease when the model omits page.close', async () => {
  const f = await fixture([open]);
  try {
    const until = Date.now() + 2000;
    while (f.runtime.getLifecycleState().busy && Date.now() < until) await Bun.sleep(20);
    const executions = await f.store.listExecutions('session');
    const batch = executions.find((entry) => entry.definitionId === 'browser.execute')!;
    expect((await f.store.getRun(batch.runId!))?.status).toBe('completed');
    expect(executions.find((entry) => entry.definitionId === 'browser.code_session')?.status).toBe(
      'cancelled',
    );
    expect(executions.find((entry) => entry.definitionId === 'browser.session')?.status).toBe(
      'cancelled',
    );
    expect(executions.some((entry) => entry.definitionId === 'browser.close')).toBe(false);
    expect(f.controller.view('session')?.state).toBe('closed');
    expect(f.executorCloses).toBe(1);
    expect(f.transportCloses).toBe(1);
    expect(f.runtime.getLifecycleState()).toMatchObject({ busy: false, reasons: [] });
  } finally {
    await f.close();
  }
});

test('parallel model calls in one Run queue against one environment and preserve dependent page state', async () => {
  const f = await fixture(
    [
      async (batch, state) => {
        const result = await open(batch, state);
        await Bun.sleep(50);
        return result;
      },
      fill,
    ],
    { parallel: true },
  );
  try {
    const until = Date.now() + 2000;
    while (f.runtime.getLifecycleState().busy && Date.now() < until) await Bun.sleep(20);
    const executions = await f.store.listExecutions('session');
    const batches = executions.filter((entry) => entry.definitionId === 'browser.execute');
    expect(f.states).toHaveLength(1);
    expect(f.executorCalls).toEqual(['0', '1']);
    expect(batches.map((entry) => entry.status)).toEqual(['succeeded', 'succeeded']);
    expect(
      executions.filter((entry) => entry.definitionId === 'browser.code_session'),
    ).toHaveLength(1);
    expect(f.native.filter((value) => obj(value).action === 'fill')).toHaveLength(1);
    expect(f.executorCloses).toBe(1);
    expect(f.transportCloses).toBe(1);
    expect(f.runtime.getLifecycleState()).toMatchObject({ busy: false, reasons: [] });
  } finally {
    await f.close();
  }
});

test('open returns without a hidden snapshot; an explicit failed read keeps the page until the Run ends', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finalEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = await fixture(
    [
      async (batch, state) => {
        state.page = await batch.call('open', { url: 'https://example.test/' });
        return state.page;
      },
      async (batch, state) => pageCall(batch, state, 'snapshot'),
    ],
    {
      failSnapshot: true,
      waitForCompletion: false,
      async beforeFinal() {
        entered();
        await gate;
      },
    },
  );
  try {
    await finalEntered;
    const beforeFinal = await f.store.listExecutions('session');
    expect(
      beforeFinal
        .filter((entry) => entry.definitionId === 'browser.execute')
        .map((entry) => entry.status),
    ).toEqual(['succeeded', 'failed']);
    const first = beforeFinal.find((entry) => entry.definitionId === 'browser.execute')!;
    expect(
      beforeFinal
        .filter((entry) => entry.kind === 'tool' && entry.parentExecutionId === first.id)
        .map((entry) => entry.definitionId),
    ).toEqual(['browser.open']);
    expect(beforeFinal.find((entry) => entry.definitionId === 'browser.open')?.status).toBe(
      'succeeded',
    );
    expect(beforeFinal.find((entry) => entry.definitionId === 'browser.snapshot')?.status).toBe(
      'failed',
    );
    expect(f.native.filter((value) => obj(value).action === 'snapshot')).toHaveLength(1);
    expect(beforeFinal.find((entry) => entry.definitionId === 'browser.session')?.status).toBe(
      'running',
    );
    expect(f.controller.view('session')?.state).toBe('agent');
    expect(f.transportCloses).toBe(0);
    release();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    const until = Date.now() + 2000;
    while (f.runtime.getLifecycleState().busy && Date.now() < until) await Bun.sleep(20);
    expect(
      (await f.store.listExecutions('session')).find(
        (entry) => entry.definitionId === 'browser.session',
      )?.status,
    ).toBe('cancelled');
    expect(f.controller.view('session')?.state).toBe('closed');
    expect(f.transportCloses).toBe(1);
    expect(f.runtime.getLifecycleState()).toMatchObject({ busy: false, reasons: [] });
  } finally {
    release();
    await f.close();
  }
});

test('an ordinary executor TypeError closes only its VM and the next Model continues on the same live page', async () => {
  const f = await fixture(
    [
      open,
      async () => {
        throw new TypeError('fixture_vm_type_error');
      },
      async (batch, state) => {
        const pages = (await batch.call('pages', {})) as Json[];
        state.page = obj(pages[0]!).id!;
        const observed = obj(await pageCall(batch, state, 'snapshot'));
        state.ref = obj((observed.elements as Json[])[0]!).ref!;
        await pageCall(batch, state, 'fill', [state.ref!, 'continued']);
        return observed;
      },
    ],
    { processConcurrency: 2 },
  );
  try {
    const rows = await f.store.listExecutions('session');
    const batches = rows.filter((row) => row.definitionId === 'browser.execute');
    expect(batches.map((row) => row.status)).toEqual(['succeeded', 'failed', 'succeeded']);
    expect((batches[1]!.result as unknown as ToolResult).content).toContain(
      'fixture_vm_type_error',
    );
    expect(
      f.model.requests[2]!.messages.find((message) => message.toolCallId === 'batch-1'),
    ).toMatchObject({
      sourceIds: [batches[1]!.id],
      content: (batches[1]!.result as unknown as ToolResult).content,
    });
    expect(f.states).toHaveLength(2);
    expect(f.states[1]!.page).not.toBe(f.states[0]!.page);
    expect(rows.filter((row) => row.definitionId === 'browser.session')).toHaveLength(1);
    expect(f.owners).toBe(1);
    expect(f.native.filter((value) => obj(value).action === 'navigate')).toHaveLength(1);
    expect(f.native.filter((value) => obj(value).action === 'fill')).toEqual([
      { action: 'fill', selector: '@e1', value: 'continued' },
    ]);
    expect(await f.store.getRun(batches[0]!.runId!)).toMatchObject({
      status: 'completed',
      isActive: false,
    });
    const until = Date.now() + 2000;
    while (f.runtime.getLifecycleState().busy && Date.now() < until) await Bun.sleep(20);
    expect(f.executorCloses).toBe(2);
    expect(f.transportCloses).toBe(1);
    expect(f.runtime.getLifecycleState()).toMatchObject({ busy: false, reasons: [] });
  } finally {
    await f.close();
  }
});

test('process capacity one returns exact unavailable before either Job and the Loop explains normally', async () => {
  const explanation = 'The browser requires two process slots, so it was not started.';
  const f = await fixture([open], { processConcurrency: 1, finalContent: explanation });
  try {
    const executions = await f.store.listExecutions('session');
    const tool = executions.find((entry) => entry.definitionId === 'browser.execute')!;
    expect(tool).toMatchObject({
      status: 'failed',
      result: { outcome: 'failed', content: 'browser_resource_capacity_unavailable' },
    });
    expect(executions.filter((entry) => entry.kind === 'job')).toEqual([]);
    expect(f.authorizations).not.toContain('browser.code_session');
    expect(f.authorizations).not.toContain('browser.session');
    expect(f.states).toEqual([]);
    expect(f.executorCalls).toEqual([]);
    expect(f.owners).toBe(0);
    expect(f.native).toEqual([]);
    expect(f.model.requests).toHaveLength(2);
    expect(f.model.requests[1]!.messages.find((entry) => entry.role === 'tool')).toMatchObject({
      toolCallId: tool.callId,
      sourceIds: [tool.id],
      content: 'browser_resource_capacity_unavailable',
    });
    expect(await f.store.getRun(tool.runId!)).toMatchObject({ status: 'completed' });
    expect(
      (await f.store.listMessages('session')).some(
        (entry) => entry.role === 'assistant' && entry.content === explanation,
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('capacity two with an externally occupied slot waits and cancels without late navigation', async () => {
  const f = await fixture([open], {
    processConcurrency: 2,
    occupyProcessSlot: true,
    waitForCompletion: false,
  });
  try {
    const admission = Date.now() + 2000;
    while (!f.authorizations.includes('browser.session') && Date.now() < admission)
      await Bun.sleep(10);
    expect(f.authorizations).toContain('browser.session');
    const before = (await f.store.listExecutions('session')).find(
      (entry) => entry.definitionId === 'browser.session',
    )!;
    expect(before.status).toBe('planned');
    expect(f.owners).toBe(0);
    const work = (await f.store.getCommand('work'))!;
    await f.runtime.cancelRun({
      expectedStoreId: work.originStoreId,
      sessionId: 'session',
      subjectId: 'owner',
      commandId: 'cancel-slot-wait',
      runId: (work.receipt as { runId: string }).runId,
    });
    await f.runtime.waitForCommand('work', { timeoutMs: 3000 });
    f.releaseProcessSlot();
    await Bun.sleep(50);
    const until = Date.now() + 2000;
    while (f.runtime.getLifecycleState().busy && Date.now() < until) await Bun.sleep(20);
    const executions = await f.store.listExecutions('session');
    expect(executions.find((entry) => entry.definitionId === 'browser.execute')?.status).toBe(
      'cancelled',
    );
    expect(executions.find((entry) => entry.definitionId === 'browser.session')?.status).toBe(
      'cancelled',
    );
    expect(f.owners).toBe(0);
    expect(f.native).toEqual([]);
    expect(f.executorCloses).toBe(1);
    expect(f.runtime.getLifecycleState()).toMatchObject({ busy: false, reasons: [] });
  } finally {
    await f.close();
  }
});

test('original browser Job authorization can exceed five seconds and still open once', async () => {
  const f = await fixture([open, fill], {
    deferBrowserAuthorization: true,
    waitForCompletion: false,
  });
  try {
    await f.browserAuthorizationEntered;
    expect(f.owners).toBe(0);
    await Bun.sleep(5200);
    const before = await f.store.listExecutions('session');
    expect(before.find((entry) => entry.definitionId === 'browser.execute')?.status).toBe(
      'dispatching',
    );
    expect(before.find((entry) => entry.definitionId === 'browser.session')?.status).toBe(
      'planned',
    );
    expect(f.controller.view('session')).toBeNull();
    expect(f.native).toEqual([]);
    f.releaseBrowserAuthorization();
    await f.runtime.waitForCommand('work', { timeoutMs: 3000 });
    const until = Date.now() + 2000;
    while (f.runtime.getLifecycleState().busy && Date.now() < until) await Bun.sleep(20);
    const after = await f.store.listExecutions('session');
    expect(
      after
        .filter((entry) => entry.definitionId === 'browser.execute')
        .map((entry) => entry.status),
    ).toEqual(['succeeded', 'succeeded']);
    expect(after.filter((entry) => entry.definitionId === 'browser.session')).toHaveLength(1);
    expect(f.owners).toBe(1);
    expect(f.native.filter((value) => obj(value).action === 'fill')).toHaveLength(1);
    expect(f.runtime.getLifecycleState()).toMatchObject({ busy: false, reasons: [] });
  } finally {
    f.releaseBrowserAuthorization();
    await f.close();
  }
}, 12000);

test('cancelling original browser Job authorization prevents a late allow from starting it', async () => {
  const f = await fixture([open], { deferBrowserAuthorization: true, waitForCompletion: false });
  try {
    await f.browserAuthorizationEntered;
    const work = (await f.store.getCommand('work'))!;
    await f.runtime.cancelRun({
      expectedStoreId: work.originStoreId,
      sessionId: 'session',
      subjectId: 'owner',
      commandId: 'cancel-authorization-wait',
      runId: (work.receipt as { runId: string }).runId,
    });
    await f.runtime.waitForCommand('work', { timeoutMs: 3000 });
    f.releaseBrowserAuthorization();
    const until = Date.now() + 2000;
    while (f.runtime.getLifecycleState().busy && Date.now() < until) await Bun.sleep(20);
    const executions = await f.store.listExecutions('session');
    expect(executions.find((entry) => entry.definitionId === 'browser.execute')?.status).toBe(
      'cancelled',
    );
    expect(executions.find((entry) => entry.definitionId === 'browser.session')?.status).toBe(
      'cancelled',
    );
    expect(f.owners).toBe(0);
    expect(f.native).toEqual([]);
    expect(f.runtime.getLifecycleState()).toMatchObject({ busy: false, reasons: [] });
  } finally {
    f.releaseBrowserAuthorization();
    await f.close();
  }
});

async function startingDecision(f: Awaited<ReturnType<typeof fixture>>, beforeNavigate = false) {
  await (beforeNavigate ? f.transportCreated : f.navigationEntered);
  const end = Date.now() + 2000;
  while (f.startingChecks < 2 && !f.authorizations.includes('browser.snapshot')) {
    if (Date.now() > end) throw Error('starting_decision_fixture_timeout');
    await Bun.sleep(5);
  }
}

test('open waits for actual Agent control and dispatches no snapshot while the original page is starting', async () => {
  const f = await fixture(
    [
      async (batch, state) => {
        await open(batch, state);
        return pageCall(batch, state, 'close');
      },
    ],
    { deferNavigation: true, waitForCompletion: false },
  );
  try {
    await startingDecision(f);
    expect(f.controller.view('session')?.state).toBe('starting');
    expect(f.authorizations).not.toContain('browser.snapshot');
    expect(
      (await f.store.listExecutions('session')).some(
        (row) => row.definitionId === 'browser.snapshot',
      ),
    ).toBe(false);
    f.releaseNavigation();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(f.native.filter((value) => obj(value).action === 'navigate')).toHaveLength(1);
    expect(
      (await f.store.listExecutions('session')).find(
        (row) => row.definitionId === 'browser.execute',
      )?.status,
    ).toBe('succeeded');
  } finally {
    f.releaseNavigation();
    await f.close();
  }
});

test('startup unknown after a visible starting page preserves the original Job result and reaches the next Model', async () => {
  const f = await fixture([open], {
    deferNavigation: true,
    failNavigation: true,
    unconfirmedTransportClose: true,
    waitForCompletion: false,
  });
  try {
    await startingDecision(f);
    f.releaseNavigation();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    const rows = await f.store.listExecutions('session');
    const original = rows.find((row) => row.definitionId === 'browser.session')!,
      outer = rows.find((row) => row.definitionId === 'browser.execute')!;
    expect(original.status).toBe('outcome_unknown');
    expect(outer.status).toBe('outcome_unknown');
    expect((outer.result as unknown as ToolResult).content).toContain(
      (original.result as unknown as ToolResult).content,
    );
    expect((outer.result as unknown as ToolResult).content).toContain(
      'did not confirm that automation stopped',
    );
    expect((outer.result as unknown as ToolResult).content).toContain(
      'Diagnostic code: job_stop_unconfirmed; cause: browser_stop_unconfirmed',
    );
    expect((outer.result as unknown as ToolResult).content).not.toContain(
      'browser_startup_outcome_unknown',
    );
    const retained = obj(obj((outer.result as unknown as ToolResult).details!).original!)
      .originalJob!;
    expect(obj(retained).executionId).toBe(original.id);
    expect(obj(obj(retained).ref!).executionId).toBe(original.id);
    expect(obj(retained).result).toEqual(original.result);
    expect(rows.some((row) => row.definitionId === 'browser.snapshot')).toBe(false);
    expect(f.model.requests).toHaveLength(2);
    expect(f.model.requests[1]!.messages.find((row) => row.toolCallId === 'batch-0')).toMatchObject(
      { sourceIds: [outer.id], content: (outer.result as unknown as ToolResult).content },
    );
    expect(f.native.filter((value) => obj(value).action === 'navigate')).toHaveLength(1);
    expect(f.executorCalls).toEqual(['0']);
  } finally {
    f.releaseNavigation();
    await f.close();
  }
});

test('an explicit read stays a known failure while its already bound Browser Job retains the exact original unknown', async () => {
  const f = await fixture([open], { endBeforeSnapshot: true });
  try {
    const rows = await f.store.listExecutions('session');
    const original = rows.find((row) => row.definitionId === 'browser.session')!,
      outer = rows.find((row) => row.definitionId === 'browser.execute')!,
      opened = rows.find((row) => row.definitionId === 'browser.open')!,
      snapshot = rows.find((row) => row.definitionId === 'browser.snapshot')!;
    expect(snapshot.status).toBe('failed');
    expect(original.status).toBe('outcome_unknown');
    expect({
      id: original.id,
      resultRevision: original.resultRevision,
      result: original.result,
    }).toEqual(f.endedOriginal!);
    expect(opened.status).toBe('succeeded');
    expect(opened.parentExecutionId).toBe(outer.id);
    expect(original.parentExecutionId).toBe(opened.id);
    expect(obj(obj((opened.result as unknown as ToolResult).details!).ref!).executionId).toBe(
      original.id,
    );
    expect(outer.status).toBe('failed');
    expect(snapshot.result).toMatchObject({
      outcome: 'failed',
      content: 'cancelled_before_dispatch',
      details: { adapterAttempted: false, dispatchCommitted: false },
    });
    expect(outer.result).toMatchObject({
      outcome: 'failed',
      content: expect.any(String),
      details: { executorStopped: true },
    });
    expect((outer.result as unknown as ToolResult).content).not.toBe(
      (original.result as unknown as ToolResult).content,
    );
    expect(snapshot.parentExecutionId).toBe(outer.id);
    const operations = obj((outer.result as unknown as ToolResult).details!).operations as Json[];
    expect(
      operations.some(
        (operation) =>
          obj(operation).executionId === snapshot.id && obj(operation).outcome === 'failed',
      ),
    ).toBe(true);
    expect(f.model.requests).toHaveLength(2);
    expect(f.model.requests[1]!.messages.find((row) => row.toolCallId === 'batch-0')).toMatchObject(
      { content: (outer.result as unknown as ToolResult).content, sourceIds: [outer.id] },
    );
    expect(f.native.filter((value) => obj(value).action === 'snapshot')).toHaveLength(0);
    expect(f.native.filter((value) => obj(value).action === 'navigate')).toHaveLength(1);
    expect(
      f.native.filter((value) => ['fill', 'click', 'scroll'].includes(String(obj(value).action))),
    ).toHaveLength(0);
    expect(f.owners).toBe(1);
    expect(rows.filter((row) => row.definitionId === 'browser.open')).toHaveLength(1);
    expect(rows.filter((row) => row.definitionId === 'browser.session')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

for (const beforeNavigate of [true, false])
  test(`cancelling startup preserves its exact original result without a premature snapshot (beforeNavigate=${beforeNavigate})`, async () => {
    const f = await fixture([open], {
      deferNavigation: !beforeNavigate,
      deferReady: beforeNavigate,
      waitForCompletion: false,
    });
    try {
      await startingDecision(f, beforeNavigate);
      expect(f.authorizations).not.toContain('browser.snapshot');
      await f.runtime.cancelCommand({
        expectedStoreId: (await f.store.getMetadata()).storeId,
        subjectId: 'owner',
        sessionId: 'session',
        commandId: 'cancel-startup',
        targetCommandId: 'work',
      });
      await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      f.releaseNavigation();
      const rows = await f.store.listExecutions('session');
      const original = rows.find((row) => row.definitionId === 'browser.session')!,
        outer = rows.find((row) => row.definitionId === 'browser.execute')!;
      expect(original.status).toBe(beforeNavigate ? 'cancelled' : 'outcome_unknown');
      expect(outer.status).toBe(original.status);
      expect((outer.result as unknown as ToolResult).content).toContain(
        beforeNavigate
          ? (original.result as unknown as ToolResult).content
          : 'Diagnostic code: browser_startup_outcome_unknown',
      );
      if (!beforeNavigate) {
        expect((outer.result as unknown as ToolResult).content).toContain('result remains unknown');
        expect((outer.result as unknown as ToolResult).content).toContain('Do not replay');
        expect(obj((outer.result as unknown as ToolResult).details!).diagnostic).toMatchObject({
          originalContent: (original.result as unknown as ToolResult).content,
        });
      }
      const retained = obj(obj((outer.result as unknown as ToolResult).details!).original!)
        .originalJob!;
      expect(obj(retained).executionId).toBe(original.id);
      expect(obj(retained).result).toEqual(original.result);
      expect(rows.some((row) => row.definitionId === 'browser.snapshot')).toBe(false);
      expect(f.model.requests).toHaveLength(1);
      expect(
        f.native.filter((value) =>
          ['snapshot', 'fill', 'click'].includes(String(obj(value).action)),
        ),
      ).toHaveLength(0);
    } finally {
      f.releaseNavigation();
      await f.close();
    }
  });

for (const outcome of ['failed', 'outcome_unknown'] as const)
  test(`original browser Job ${outcome} before Controller admission remains the actual open result`, async () => {
    const f = await fixture([open], { earlyBrowserOutcome: outcome });
    try {
      const executions = await f.store.listExecutions('session');
      const outer = executions.find((entry) => entry.definitionId === 'browser.execute')!;
      const original = executions.find((entry) => entry.definitionId === 'browser.session')!;
      expect(original.status).toBe(outcome);
      expect(outer.status).toBe(outcome);
      expect((outer.result as unknown as ToolResult).content).toContain(
        (original.result as unknown as ToolResult).content,
      );
      const retained = obj(obj((outer.result as unknown as ToolResult).details!).original!)
        .originalJob!;
      expect(obj(retained).executionId).toBe(original.id);
      expect(obj(obj(retained).ref!).executionId).toBe(original.id);
      expect(obj(retained).result).toEqual(original.result);
      expect(executions.some((entry) => entry.definitionId === 'browser.snapshot')).toBe(false);
      expect(f.owners).toBe(0);
      expect(f.native).toEqual([]);
    } finally {
      await f.close();
    }
  });

test('Run cancellation during dispatched input stops code and original browser without dependent operations', async () => {
  const f = await fixture([open, fill], { cancelDuringFill: true });
  try {
    const until = Date.now() + 2000;
    while (f.runtime.getLifecycleState().busy && Date.now() < until) await Bun.sleep(20);
    const executions = await f.store.listExecutions('session');
    const batches = executions.filter((entry) => entry.definitionId === 'browser.execute');
    const affected = batches[1]!;
    expect((await f.store.getRun(affected.runId!))?.status).toBe('cancelled');
    expect(['cancelled', 'outcome_unknown'], JSON.stringify(affected.result)).toContain(
      affected.status,
    );
    expect(
      executions
        .filter((entry) => entry.parentExecutionId === affected.id)
        .map((entry) => entry.definitionId),
    ).toEqual(['browser.fill']);
    expect(executions.find((entry) => entry.definitionId === 'browser.code_session')?.status).toBe(
      'cancelled',
    );
    expect(executions.find((entry) => entry.definitionId === 'browser.session')?.status).not.toBe(
      'running',
    );
    expect(f.native.filter((value) => obj(value).action === 'fill')).toHaveLength(1);
    expect(f.executorCloses).toBe(1);
    expect(f.transportCloses).toBe(1);
    expect(f.runtime.getLifecycleState()).toMatchObject({ busy: false, reasons: [] });
  } finally {
    await f.close();
  }
});

test('one code batch opens, observes, fills, verifies and closes through independently authorized child operations', async () => {
  const f = await fixture([
    async (batch, state) => {
      await open(batch, state);
      return fill(batch, state);
    },
  ]);
  try {
    expect(f.executorCalls).toEqual(['0']);
    expect(f.states).toHaveLength(1);
    expect(f.owners).toBe(1);
    const executions = await f.store.listExecutions('session');
    const batches = executions.filter((entry) => entry.definitionId === 'browser.execute');
    expect(batches).toHaveLength(1);
    expect(batches[0]!.status).toBe('succeeded');
    const children = executions.filter(
      (entry) => entry.kind === 'tool' && entry.parentExecutionId === batches[0]!.id,
    );
    expect(children.map((entry) => entry.definitionId)).toEqual([
      'browser.open',
      'browser.snapshot',
      'browser.fill',
      'browser.snapshot',
      'browser.close',
    ]);
    expect(children.every((entry) => f.authorizations.includes(entry.definitionId))).toBe(true);
    expect(f.native.filter((value) => obj(value).action === 'fill')).toEqual([
      { action: 'fill', selector: '@e1', value: 'Ada' },
    ]);
    expect(f.model.requests).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('real Runtime executes each browser API as an original child Tool while reusing one Run environment', async () => {
  const f = await fixture([open, fill], { processConcurrency: 2 });
  try {
    expect(f.states).toHaveLength(1);
    expect(f.executorCalls).toEqual(['0', '1']);
    expect(f.owners).toBe(1);
    expect(f.states[0]!.page).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.states[0]!.ref).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.states[0]!.ref).not.toBe('e1');
    const executions = await f.store.listExecutions('session');
    const batches = executions.filter((entry) => entry.definitionId === 'browser.execute');
    expect(batches).toHaveLength(2);
    expect(batches.every((entry) => entry.status === 'succeeded')).toBe(true);
    const childTools = executions.filter(
      (entry) => entry.kind === 'tool' && entry.definitionId !== 'browser.execute',
    );
    expect(childTools.map((entry) => entry.definitionId)).toEqual([
      'browser.open',
      'browser.snapshot',
      'browser.fill',
      'browser.snapshot',
      'browser.close',
    ]);
    for (const child of childTools) {
      expect(batches.some((batch) => batch.id === child.parentExecutionId)).toBe(true);
      expect(child.originStoreId).toBe(batches[0]!.originStoreId);
      expect(child.rootWorkCommandId).toBe('work');
      expect(child.rootWorkSeq).toBe(batches[0]!.rootWorkSeq);
      expect(f.authorizations).toContain(child.definitionId);
    }
    const job = executions.find((entry) => entry.definitionId === 'browser.session')!;
    expect(job.parentExecutionId).toBe(childTools[0]!.id);
    expect(job.status).toBe('cancelled');
    expect(f.native.filter((value) => obj(value).action === 'fill')).toEqual([
      { action: 'fill', selector: '@e1', value: 'Ada' },
    ]);
    const close = childTools.find((entry) => entry.definitionId === 'browser.close')!;
    expect((close.result as unknown as ToolResult).outcome).toBe('succeeded');
    expect(f.controller.view('session')?.state).toBe('closed');
    expect(f.transportCloses).toBe(1);
    expect(f.executorCloses).toBe(1);
  } finally {
    await f.close();
  }
});

for (const scenario of ['stale', 'denied', 'unknown'] as const)
  test(`${scenario} Browser API failure latches the batch even if generated code catches and continues`, async () => {
    const attack: Program = async (batch, state) => {
      if (scenario === 'stale') await pageCall(batch, state, 'snapshot');
      try {
        await pageCall(batch, state, 'fill', [state.ref!, 'Ada']);
      } catch {}
      try {
        await pageCall(batch, state, 'snapshot');
      } catch {}
      return { attemptedContinuation: true };
    };
    const f = await fixture([open, attack], {
      denyFill: scenario === 'denied',
      unknownFill: scenario === 'unknown',
    });
    try {
      const executions = await f.store.listExecutions('session');
      const batches = executions.filter((entry) => entry.definitionId === 'browser.execute');
      const affected = batches[1]!;
      expect(affected.status, JSON.stringify(affected.result)).toBe(
        scenario === 'unknown' ? 'outcome_unknown' : 'failed',
      );
      const children = executions.filter((entry) => entry.parentExecutionId === affected.id);
      expect(children.map((entry) => entry.definitionId)).toEqual(
        scenario === 'stale' ? ['browser.snapshot'] : ['browser.fill'],
      );
      expect(f.native.filter((value) => obj(value).action === 'fill')).toHaveLength(
        scenario === 'unknown' ? 1 : 0,
      );
      expect(f.apiFailures).toContain('browser_batch_stopped');
      expect((affected.result as unknown as ToolResult).details).toHaveProperty('operations');
    } finally {
      await f.close();
    }
  });

test('refused page consent creates no browser Job or dependent observation even after catch', async () => {
  const f = await fixture(
    [
      async (batch) => {
        try {
          await batch.call('open', { url: 'https://example.test/' });
        } catch {}
        try {
          await batch.call('open', { url: 'https://other.test/' });
        } catch {}
        return null;
      },
    ],
    { refuseOpen: true },
  );
  try {
    const executions = await f.store.listExecutions('session');
    expect(executions.filter((entry) => entry.definitionId === 'browser.open')).toHaveLength(1);
    expect(executions.some((entry) => entry.definitionId === 'browser.session')).toBe(false);
    expect(executions.some((entry) => entry.definitionId === 'browser.snapshot')).toBe(false);
    expect(f.native).toEqual([]);
    expect(f.owners).toBe(0);
    expect(executions.find((entry) => entry.definitionId === 'browser.execute')?.status).toBe(
      'failed',
    );
  } finally {
    await f.close();
  }
});

test('formal PNG is republished in the outer execution scope and reaches the next actual model request', async () => {
  const f = await fixture([
    async (batch, state) => {
      await open(batch, state);
      const image = await pageCall(batch, state, 'screenshot');
      await pageCall(batch, state, 'close');
      return image;
    },
  ]);
  try {
    const executions = await f.store.listExecutions('session');
    const outer = executions.find((entry) => entry.definitionId === 'browser.execute')!;
    const inner = executions.find((entry) => entry.definitionId === 'browser.image')!;
    expect(outer.status).toBe('succeeded');
    const outerRef = (outer.result as unknown as ToolResult).modelImages![0]!;
    const innerRef = (inner.result as unknown as ToolResult).modelImages![0]!;
    expect(outerRef.scope).toEqual({ kind: 'execution', id: outer.id });
    expect(innerRef.scope).toEqual({ kind: 'execution', id: inner.id });
    expect(outerRef.id).not.toBe(innerRef.id);
    const message = f.model.requests[1]!.messages.find((entry) => entry.toolCallId === 'batch-0')!;
    expect(message.role).toBe('tool');
    expect(message.sourceIds).toEqual([outer.id]);
    expect(message.images).toEqual([{ mediaType: 'image/png', data: png }]);
    expect(
      f.model.requests[1]!.messages.some((entry) => entry.role === 'user' && entry.images?.length),
    ).toBe(false);
    const messages = await f.store.listMessages('session');
    expect(messages.filter((entry) => entry.role === 'user')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('a failed Browser Job reaches the next main Model as its paired tool result and permits a visible explanation', async () => {
  const explanation = '浏览器未能完成打开，原任务没有网页操作结果。';
  const f = await fixture([open], {
    earlyBrowserOutcome: 'failed',
    finalContent: explanation,
    internalAuthorizationCheck: true,
  });
  try {
    const executions = await f.store.listExecutions('session');
    const outer = executions.find((entry) => entry.definitionId === 'browser.execute')!;
    const original = executions.find((entry) => entry.definitionId === 'browser.session')!;
    const internal = executions.find(
      (entry) => entry.kind === 'model' && entry.parentExecutionId === original.id,
    )!;
    expect(outer.status).toBe('failed');
    expect(original.status).toBe('failed');
    expect(internal.status).toBe('succeeded');
    expect(JSON.stringify(internal.result)).toContain(f.authorizationMarker);
    expect(f.checker.requests).toHaveLength(1);
    expect(f.model.requests).toHaveLength(2);
    const request = f.model.requests[1]!;
    const paired = request.messages.filter(
      (entry) => entry.role === 'tool' && entry.toolCallId === 'batch-0',
    );
    expect(paired).toHaveLength(1);
    expect(paired[0]!.sourceIds).toEqual([outer.id]);
    expect(paired[0]!.content).toContain((original.result as unknown as ToolResult).content);
    expect(
      request.messages.some(
        (entry) =>
          entry.role === 'assistant' && entry.toolCalls?.some((call) => call.id === 'batch-0'),
      ),
    ).toBe(true);
    expect(JSON.stringify(f.model.requests)).not.toContain(f.authorizationMarker);
    const messages = await f.store.listMessages('session');
    expect(
      messages.some(
        (entry) =>
          entry.role === 'assistant' &&
          entry.content === explanation &&
          entry.status === 'complete',
      ),
    ).toBe(true);
    expect(JSON.stringify(messages)).not.toContain(f.authorizationMarker);
    expect((await f.store.getRun(outer.runId!))?.status).toBe('completed');
    expect(
      executions.filter((entry) => entry.kind === 'model' && entry.runId === outer.runId),
    ).toHaveLength(2);
    expect(f.executorCalls).toEqual(['0']);
    expect(f.native).toEqual([]);
  } finally {
    await f.close();
  }
});

test('an ended nested Browser Job remains unknown while the original Tool result reaches a completed explanation', async () => {
  const explanation = 'The Browser Job outcome remains unknown. It was not retried.';
  const f = await fixture([open], {
    earlyBrowserOutcome: 'outcome_unknown',
    finalContent: explanation,
    internalAuthorizationCheck: true,
  });
  try {
    const executions = await f.store.listExecutions('session');
    const outer = executions.find((entry) => entry.definitionId === 'browser.execute')!;
    const original = executions.find((entry) => entry.definitionId === 'browser.session')!;
    const internal = executions.find(
      (entry) => entry.kind === 'model' && entry.parentExecutionId === original.id,
    )!;
    expect(outer.status).toBe('outcome_unknown');
    expect(original.status).toBe('outcome_unknown');
    expect((outer.result as unknown as ToolResult).content).toContain(
      (original.result as unknown as ToolResult).content,
    );
    expect(internal.status).toBe('succeeded');
    expect(JSON.stringify(internal.result)).toContain(f.authorizationMarker);
    expect(f.checker.requests).toHaveLength(1);
    expect(f.model.requests).toHaveLength(2);
    expect(original.runId).toBeNull();
    expect((await f.store.getRun(outer.runId!))?.status).toBe('completed');
    expect(
      executions.filter((entry) => entry.kind === 'model' && entry.runId === outer.runId),
    ).toHaveLength(2);
    expect(
      f.model.requests[1]!.messages.find(
        (entry) => entry.role === 'tool' && entry.toolCallId === 'batch-0',
      ),
    ).toMatchObject({
      content: (outer.result as unknown as ToolResult).content,
      sourceIds: [outer.id],
    });
    const messages = await f.store.listMessages('session');
    const tool = messages.find((entry) => entry.role === 'tool' && entry.toolCallId === 'batch-0')!;
    expect(tool.sourceIds).toEqual([outer.id]);
    expect(tool.content).toContain((original.result as unknown as ToolResult).content);
    expect(
      messages.some((entry) => entry.role === 'assistant' && entry.content === explanation),
    ).toBe(true);
    expect(JSON.stringify(messages)).not.toContain(f.authorizationMarker);
    expect(f.executorCalls).toEqual(['0']);
    expect(f.native).toEqual([]);
  } finally {
    await f.close();
  }
});

const realTest = process.platform === 'darwin' ? test : test.skip;
const realOpen =
  'var page = await browser.open("https://example.test/"); var retained = 19; var observation = await page.snapshot(); var previousRef = observation.elements[0].ref;';

for (const unconfirmedTransportClose of [false, true])
  realTest(
    `a real worker startup navigation losing confirmation reaches the next Model without replacement (unconfirmedStop=${unconfirmedTransportClose})`,
    async () => {
      const code =
        'try { var page = await browser.open("https://example.test/hang"); await page.snapshot(); } catch {} try { await browser.open("https://example.test/replacement"); } catch {}';
      const f = await fixture([async () => null], {
        realCodes: [code],
        deferNavigation: true,
        failNavigation: true,
        unconfirmedTransportClose,
        waitForCompletion: false,
        processConcurrency: 2,
        finalContent:
          'The page binding lost confirmation; I cannot confirm whether navigation completed.',
      });
      try {
        await startingDecision(f);
        expect(f.controller.view('session')?.state).toBe('starting');
        expect(f.model.requests).toHaveLength(1);
        expect(f.native.filter((value) => obj(value).action === 'navigate')).toHaveLength(1);
        f.releaseNavigation();
        await f.runtime.waitForCommand('work', { timeoutMs: 6000 });
        const rows = await f.store.listExecutions('session');
        const original = rows.find((row) => row.definitionId === 'browser.session')!;
        const opened = rows.find((row) => row.definitionId === 'browser.open')!;
        const outer = rows.find((row) => row.definitionId === 'browser.execute')!;
        expect(original.status).toBe('outcome_unknown');
        expect(opened.status).toBe('succeeded');
        expect(original.parentExecutionId).toBe(opened.id);
        expect(opened.parentExecutionId).toBe(outer.id);
        const originalResult = JSON.parse(JSON.stringify(original.result)) as Json;
        expect(original.result).toMatchObject(
          unconfirmedTransportClose
            ? {
                outcome: 'outcome_unknown',
                content: 'job_stop_unconfirmed',
                details: {
                  actualResult: {
                    outcome: 'outcome_unknown',
                    details: { code: 'browser_stop_unconfirmed' },
                  },
                },
              }
            : {
                outcome: 'outcome_unknown',
                content: expect.stringContaining('browser_startup_outcome_unknown'),
                details: { code: 'browser_startup_outcome_unknown' },
              },
        );
        const result = outer.result as unknown as ToolResult;
        expect(outer.status).toBe('outcome_unknown');
        const diagnosticCode = unconfirmedTransportClose
          ? 'job_stop_unconfirmed'
          : 'browser_startup_outcome_unknown';
        expect(obj(result.details!).code).toBe(diagnosticCode);
        const retained = obj(obj(result.details!).original!).originalJob!;
        expect(obj(retained).executionId).toBe(original.id);
        expect(obj(obj(retained).ref!).executionId).toBe(original.id);
        expect(obj(retained).definitionId).toBe('browser.session');
        expect(obj(retained).definitionVersion).toBe('1');
        expect(obj(retained).result).toEqual(originalResult);
        expect(f.model.requests).toHaveLength(2);
        const delivered = f.model.requests[1]!.messages.find(
          (message) => message.toolCallId === 'batch-0',
        )!;
        expect(delivered).toMatchObject({ sourceIds: [outer.id], content: result.content });
        if (unconfirmedTransportClose) {
          expect(delivered.content).toContain('did not confirm that automation stopped');
          expect(delivered.content).toContain('cause: browser_stop_unconfirmed');
          expect(delivered.content).not.toContain('browser_startup_outcome_unknown');
        } else {
          expect(delivered.content).toContain('binding the target page or starting its navigation');
          expect(delivered.content).toContain('may have closed');
        }
        expect(delivered.content).toContain('may or may not have completed');
        expect(delivered.content).toContain('Do not replay');
        expect(delivered.content).toContain(`Diagnostic code: ${diagnosticCode}`);
        expect(delivered.content).not.toContain('user closed');
        expect(delivered.content).not.toContain('was not executed');
        expect(rows.filter((row) => row.definitionId === 'browser.session')).toHaveLength(1);
        expect(rows.filter((row) => row.definitionId === 'browser.open')).toHaveLength(1);
        expect(rows.filter((row) => row.definitionId === 'browser.snapshot')).toHaveLength(0);
        expect(f.native.filter((value) => obj(value).action === 'navigate')).toEqual([
          expect.objectContaining({ url: 'https://example.test/hang' }),
        ]);
        expect(
          f.native.filter((value) => ['fill', 'click'].includes(String(obj(value).action))),
        ).toHaveLength(0);
        expect(f.owners).toBe(1);
        expect(f.executorCalls).toEqual([code]);
        const interpreter = rows.find((row) => row.definitionId === 'browser.code_session')!;
        expect(interpreter.status).toBe('cancelled');
        expect(interpreter.result).toMatchObject({ outcome: 'cancelled' });
        const deliveredScope = f.model.requests[1]!.messages.find((message) =>
          message.content.includes(interpreter.id),
        )!;
        expect(deliveredScope.content).toContain('only the code environment lifecycle result');
        expect(deliveredScope.content).toContain('does not establish whether the user cancelled');
        expect(deliveredScope.content).toContain('whether any browser action completed');
        expect(deliveredScope.content).toContain('"outcome":"cancelled"');
        const saved = await f.store.getExecution(original.id);
        expect(saved?.resultRevision).toBe(original.resultRevision);
        expect(saved?.result).toEqual(originalResult);
        expect(await f.store.getRun(outer.runId!)).toMatchObject({
          status: 'completed',
          isActive: false,
        });
      } finally {
        f.releaseNavigation();
        await f.close();
      }
    },
    15000,
  );

for (const failure of [
  'stale',
  'parameter',
  'pointer-null',
  'pointer-image',
  'read',
  'denied',
] as const)
  realTest(
    `real worker and Runtime preserve the original page after known ${failure} failure`,
    async () => {
      const code =
        failure === 'stale'
          ? 'await page.snapshot(); try { await page.fill(previousRef, "Ada"); } catch {} try { await page.click(previousRef); } catch {}'
          : failure === 'parameter'
            ? 'await page.fill("", "Ada")'
            : failure === 'pointer-null'
              ? 'await page.pointer(null)'
              : failure === 'pointer-image'
                ? 'await page.pointer({imageRef:null})'
                : failure === 'read'
                  ? 'await page.screenshot()'
                  : 'await page.fill(previousRef, "Ada")';
      const codes = [
        realOpen,
        code,
        'console.log(retained); await page.snapshot()',
        'await page.close()',
      ];
      const f = await fixture(
        codes.map(() => async () => null),
        { realCodes: codes, failImage: failure === 'read', denyFill: failure === 'denied' },
      );
      try {
        const rows = await f.store.listExecutions('session');
        const batches = rows.filter((row) => row.definitionId === 'browser.execute');
        expect(batches.map((row) => row.status)).toEqual([
          'succeeded',
          'failed',
          'succeeded',
          'succeeded',
        ]);
        expect(f.realBoundaries.slice(0, 3).map((entry) => entry.state)).toEqual([
          'agent',
          'agent',
          'agent',
        ]);
        expect(f.realBoundaries.slice(0, 3).map((entry) => entry.closes)).toEqual([0, 0, 0]);
        expect(
          new Set(f.realBoundaries.slice(0, 3).flatMap((entry) => entry.jobs.map((job) => job.id)))
            .size,
        ).toBe(1);
        expect(
          f.realBoundaries.slice(0, 3).flatMap((entry) => entry.jobs.map((job) => job.status)),
        ).toEqual(['running', 'running', 'running']);
        expect(
          f.native.filter((value) => ['fill', 'click'].includes(String(obj(value).action))),
        ).toHaveLength(0);
        expect((batches[2]!.result as unknown as ToolResult).content).toContain('19');
        expect(
          f.model.requests[2]!.messages.find(
            (entry) => entry.role === 'tool' && entry.toolCallId === batches[1]!.callId,
          ),
        ).toMatchObject({
          sourceIds: [batches[1]!.id],
          content: (batches[1]!.result as unknown as ToolResult).content,
        });
        expect(await f.store.getRun(batches[0]!.runId!)).toMatchObject({ status: 'completed' });
        expect(rows.filter((row) => row.definitionId === 'browser.code_session')).toHaveLength(1);
        expect(f.executorCloses).toBe(1);
      } finally {
        await f.close();
      }
    },
  );

realTest(
  'real worker and Runtime preserve variables after evaluation, syntax and UTF8 input failures',
  async () => {
    const codes = [
      realOpen,
      'throw new TypeError("recoverable_evaluation")',
      'var incomplete = ;',
      `//${'雪'.repeat(6000)}`,
      'console.log(retained); await page.snapshot()',
      'await page.close()',
    ];
    const f = await fixture(
      codes.map(() => async () => null),
      { realCodes: codes },
    );
    try {
      const rows = await f.store.listExecutions('session');
      const batches = rows.filter((row) => row.definitionId === 'browser.execute');
      expect(batches.map((row) => row.status)).toEqual([
        'succeeded',
        'failed',
        'failed',
        'failed',
        'succeeded',
        'succeeded',
      ]);
      expect(batches[3]!.result).toMatchObject({
        outcome: 'failed',
        content: 'browser_executor_code_limit',
      });
      expect(f.executorCalls).not.toContain(codes[3]!);
      expect(f.realBoundaries.slice(0, 4).map((entry) => entry.state)).toEqual([
        'agent',
        'agent',
        'agent',
        'agent',
      ]);
      expect(f.realBoundaries.slice(0, 4).map((entry) => entry.closes)).toEqual([0, 0, 0, 0]);
      expect((batches[4]!.result as unknown as ToolResult).content).toContain('19');
      expect(rows.filter((row) => row.definitionId === 'browser.session')).toHaveLength(1);
      expect(rows.filter((row) => row.definitionId === 'browser.code_session')).toHaveLength(1);
      expect(f.executorCloses).toBe(1);
      expect(await f.store.getRun(batches[0]!.runId!)).toMatchObject({ status: 'completed' });
    } finally {
      await f.close();
    }
  },
);

realTest('large valid snapshots fit Host and worker frames without ending the page', async () => {
  const codes = [
    'var page = await browser.open("https://example.test/"); var retained = 19;',
    'await page.snapshot()',
    'var next = await page.snapshot(); ({retained, page: page.id, truncated: next.truncated})',
    'await page.close()',
  ];
  const f = await fixture(
    codes.map(() => async () => null),
    { realCodes: codes, largeSnapshot: true },
  );
  try {
    const rows = await f.store.listExecutions('session');
    const batches = rows.filter((row) => row.definitionId === 'browser.execute');
    expect(batches.map((row) => row.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    const observation = obj(obj((batches[1]!.result as unknown as ToolResult).details!).value!);
    expect(observation.truncated).toBe(true);
    expect(largeSnapshot.url.startsWith(String(observation.url))).toBe(true);
    expect(String(observation.url).length).toBeLessThan(largeSnapshot.url.length);
    expect(String(observation.url)).toContain('😀');
    expect(Buffer.from(String(observation.url)).toString() === observation.url).toBe(true);
    expect(largeSnapshot.title.startsWith(String(observation.title))).toBe(true);
    expect(String(observation.title).length).toBeLessThan(largeSnapshot.title.length);
    expect(typeof observation.snapshot).toBe('string');
    expect(String(observation.snapshot).length).toBeLessThan(65536);
    expect(largeSnapshot.snapshot.length).toBe(65536);
    const elements = observation.elements as Json[];
    expect(elements.length).toBeGreaterThan(0);
    expect(elements.length).toBeLessThan(20);
    expect(elements.every((element) => /^[0-9a-f-]{36}$/.test(String(obj(element).ref)))).toBe(
      true,
    );
    expect(elements.every((element) => obj(element).name === largeSnapshot.name)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(observation))).toBeLessThanOrEqual(48 * 1024);
    expect(
      Buffer.byteLength(JSON.stringify({ type: 'result', batch: 2, id: 3, value: observation })),
    ).toBeLessThan(131000);
    expect(
      Buffer.byteLength(JSON.stringify({ type: 'done', batch: 2, pending: 0, value: observation })),
    ).toBeLessThan(65536);
    expect(obj(obj((batches[2]!.result as unknown as ToolResult).details!).value!)).toMatchObject({
      retained: 19,
      truncated: true,
    });
    expect(f.realBoundaries.slice(0, 3).map((entry) => entry.state)).toEqual([
      'agent',
      'agent',
      'agent',
    ]);
    expect(f.realBoundaries.slice(0, 3).map((entry) => entry.closes)).toEqual([0, 0, 0]);
    expect(
      new Set(f.realBoundaries.slice(0, 3).flatMap((entry) => entry.jobs.map((job) => job.id)))
        .size,
    ).toBe(1);
    expect(
      f.native.filter((command) =>
        ['fill', 'click', 'scroll'].includes(String(obj(command).action)),
      ),
    ).toHaveLength(0);
    expect(f.native.filter((command) => obj(command).action === 'navigate')).toHaveLength(1);
    expect(f.native.filter((command) => obj(command).action === 'snapshot')).toHaveLength(2);
    expect(rows.filter((row) => row.definitionId === 'browser.code_session')).toHaveLength(1);
    expect(rows.filter((row) => row.definitionId === 'browser.session')).toHaveLength(1);
    expect(f.executorCloses).toBe(1);
    expect(f.transportCloses).toBe(1);
    expect(await f.store.getRun(batches[0]!.runId!)).toMatchObject({ status: 'completed' });
  } finally {
    await f.close();
  }
});

realTest('real worker unknown remains original unknown and stops all dependent calls', async () => {
  const codes = [
    realOpen,
    'try { await page.fill(previousRef, "Ada"); } catch {} try { await page.snapshot(); } catch {}',
  ];
  const f = await fixture(
    codes.map(() => async () => null),
    { realCodes: codes, unknownFill: true },
  );
  try {
    const rows = await f.store.listExecutions('session');
    const affected = rows.filter((row) => row.definitionId === 'browser.execute')[1]!;
    const source = rows.find(
      (row) => row.parentExecutionId === affected.id && row.definitionId === 'browser.fill',
    )!;
    expect(source.status).toBe('outcome_unknown');
    expect(affected.status).toBe('outcome_unknown');
    expect(
      rows.filter((row) => row.parentExecutionId === affected.id).map((row) => row.definitionId),
    ).toEqual(['browser.fill']);
    expect(f.native.filter((value) => obj(value).action === 'fill')).toHaveLength(1);
    expect(f.executorCloses).toBe(1);
    expect(await f.store.getRun(affected.runId!)).toMatchObject({ status: 'completed' });
  } finally {
    await f.close();
  }
});

realTest(
  'real worker explicit observation failure keeps the opened page until normal final',
  async () => {
    const codes = [
      'var page = await browser.open("https://example.test/")',
      'await page.snapshot()',
    ];
    const f = await fixture(
      codes.map(() => async () => null),
      { realCodes: codes, failSnapshot: true },
    );
    try {
      const rows = await f.store.listExecutions('session');
      expect(
        rows.filter((row) => row.definitionId === 'browser.execute').map((row) => row.status),
      ).toEqual(['succeeded', 'failed']);
      expect(f.realBoundaries.map((entry) => entry.state)).toEqual(['agent', 'agent']);
      expect(f.realBoundaries.map((entry) => entry.closes)).toEqual([0, 0]);
      const until = Date.now() + 2000;
      while (f.runtime.getLifecycleState().busy && Date.now() < until) await Bun.sleep(20);
      expect(
        (await f.store.listExecutions('session'))
          .filter((row) => row.definitionId === 'browser.session')
          .map((row) => row.status),
      ).toEqual(['cancelled']);
      expect(f.executorCloses).toBe(1);
      expect(f.transportCloses).toBe(1);
    } finally {
      await f.close();
    }
  },
);

realTest(
  'a real worker timeout replaces only the VM and the next Model observes the same page',
  async () => {
    const timeoutCode = 'while (true) {}';
    const codes = [
      realOpen,
      timeoutCode,
      'var available = await browser.pages(); var page = browser.page(available[0].id); var observed = await page.snapshot(); ({page: page.id, observed: observed.snapshot})',
    ];
    const f = await fixture(
      codes.map(() => async () => null),
      { realCodes: codes, timeoutCode, processConcurrency: 2 },
    );
    try {
      const rows = await f.store.listExecutions('session');
      const batches = rows.filter((row) => row.definitionId === 'browser.execute');
      expect(batches.map((row) => row.status)).toEqual(['succeeded', 'failed', 'succeeded']);
      expect(obj((batches[1]!.result as unknown as ToolResult).details!).code).toBe(
        'browser_executor_timeout',
      );
      expect(
        f.model.requests[2]!.messages.find((message) => message.toolCallId === 'batch-1'),
      ).toMatchObject({
        sourceIds: [batches[1]!.id],
        content: (batches[1]!.result as unknown as ToolResult).content,
      });
      expect(rows.filter((row) => row.definitionId === 'browser.code_session')).toHaveLength(2);
      expect(rows.filter((row) => row.definitionId === 'browser.session')).toHaveLength(1);
      expect(f.realBoundaries.map((entry) => entry.state)).toEqual(['agent', 'agent']);
      expect(f.realBoundaries.map((entry) => entry.closes)).toEqual([0, 0]);
      expect(
        new Set(f.realBoundaries.flatMap((entry) => entry.jobs.map((job) => job.id))).size,
      ).toBe(1);
      expect(f.native.filter((value) => obj(value).action === 'navigate')).toHaveLength(1);
      expect(
        f.native.filter((value) => ['fill', 'click'].includes(String(obj(value).action))),
      ).toHaveLength(0);
      expect(await f.store.getRun(batches[0]!.runId!)).toMatchObject({
        status: 'completed',
        isActive: false,
      });
      const until = Date.now() + 2000;
      while (f.runtime.getLifecycleState().busy && Date.now() < until) await Bun.sleep(20);
      expect(f.executorCloses).toBe(2);
      expect(f.transportCloses).toBe(1);
      expect(f.runtime.getLifecycleState()).toMatchObject({ busy: false, reasons: [] });
    } finally {
      await f.close();
    }
  },
  15000,
);

for (const failure of ['read', 'code'] as const)
  realTest(
    `after a reported ${failure} failure a new message discovers released metadata before explicitly rebinding the same Main page`,
    async () => {
      const codes = [
        'var page = await browser.open("https://example.test/"); var observed = await page.snapshot(); await page.click(observed.elements[0].ref); var verified = await page.snapshot(); ({page: page.id, ref: verified.elements[0].ref})',
        failure === 'read'
          ? 'await page.screenshot()'
          : 'throw new TypeError("first_run_code_failure")',
        'var known = await browser.pages(); var candidate = browser.page(known[0].id); ({known, candidateId: candidate.id})',
        'var page = candidate; var observed = await page.snapshot(); ({page: page.id, ref: observed.elements[0].ref, text: observed.snapshot})',
        'replaced after the first Run reveals its opaque page id',
        'replaced after the first Run reveals its opaque ref',
        'var fresh = await page.snapshot(); await page.fill(fresh.elements[0].ref, "second-run"); await page.snapshot()',
      ];
      const f = await fixture(
        codes.map(() => async () => null),
        {
          realCodes: codes,
          followupFrom: 2,
          sharedPage: true,
          processConcurrency: 2,
          failImage: failure === 'read',
          finalContent: 'The result is reported and this task is finished.',
        },
      );
      try {
        const firstRows = await f.store.listExecutions('session');
        const firstBatches = firstRows.filter((row) => row.definitionId === 'browser.execute');
        expect(firstBatches.map((row) => row.status)).toEqual(['succeeded', 'failed']);
        const firstRun = await f.store.getRun(firstBatches[0]!.runId!);
        expect(firstRun).toMatchObject({ status: 'completed', isActive: false });
        const old = obj(obj((firstBatches[0]!.result as unknown as ToolResult).details!).value!);
        expect(
          f.model.requests[2]!.messages.find((message) => message.toolCallId === 'batch-1'),
        ).toMatchObject({
          sourceIds: [firstBatches[1]!.id],
          content: (firstBatches[1]!.result as unknown as ToolResult).content,
        });
        expect(f.model.requests).toHaveLength(3);
        expect(f.mainPage.clicks).toBe(1);
        expect(JSON.stringify(f.model.requests)).not.toContain(f.mainIdentity.pageId);
        expect(JSON.stringify(f.model.requests)).not.toContain(f.mainIdentity.incarnation);
        f.mainPage.value = 'manual-user-edit';
        f.setCode(4, `await browser.page(${JSON.stringify(old.page)}).snapshot()`);
        f.setCode(5, `await page.fill(${JSON.stringify(old.ref)}, "forbidden-old-ref")`);
        // No close/dispose/stop or idle wait between user messages. pages() must
        // describe the released last-known target without acquiring a new lease.
        await f.startNewRun();
        await f.runtime.waitForCommand('next-work', { timeoutMs: 6000 });
        expect(JSON.stringify(f.model.requests)).not.toContain(f.mainIdentity.pageId);
        expect(JSON.stringify(f.model.requests)).not.toContain(f.mainIdentity.incarnation);
        const rows = await f.store.listExecutions('session');
        const batches = rows.filter((row) => row.definitionId === 'browser.execute');
        expect(batches.map((row) => row.status)).toEqual([
          'succeeded',
          'failed',
          'succeeded',
          'succeeded',
          'failed',
          'failed',
          'succeeded',
        ]);
        const secondRun = await f.store.getRun(batches[2]!.runId!);
        expect(secondRun).toMatchObject({ status: 'completed', isActive: false });
        expect(secondRun!.id).not.toBe(firstRun!.id);
        expect(secondRun!.originCommandId).toBe('next-work');
        const listed = obj(obj((batches[2]!.result as unknown as ToolResult).details!).value!);
        const known = listed.known as Json[];
        expect(known).toHaveLength(1);
        expect(known[0]).toMatchObject({
          state: 'released',
          bindingRequired: true,
          lastKnown: true,
          url: 'https://example.test/',
          title: 'Local form',
        });
        expect(Object.keys(obj(known[0]!)).sort()).toEqual([
          'bindingRequired',
          'guidance',
          'id',
          'lastKnown',
          'state',
          'title',
          'url',
        ]);
        expect(String(obj(known[0]!).guidance)).toContain('current existence is unverified');
        expect(listed.candidateId).toBe(obj(known[0]!).id);
        expect(listed.candidateId).not.toBe(old.page);
        expect(f.realBoundaries[2]).toMatchObject({ state: 'closed', closes: 1 });
        expect(f.realBoundaries[2]!.jobs).toHaveLength(1);
        expect(f.realBoundaries[2]!.jobs[0]!.status).toBe('cancelled');
        expect(
          rows.filter((row) => row.kind === 'tool' && row.parentExecutionId === batches[2]!.id),
        ).toEqual([]);
        expect(
          f.model.requests[4]!.messages.find((message) => message.toolCallId === 'batch-2'),
        ).toMatchObject({ sourceIds: [batches[2]!.id] });
        expect(
          f.model.requests[4]!.messages.find((message) => message.toolCallId === 'batch-2')!
            .content,
        ).toContain('"bindingRequired":true');
        expect(JSON.stringify(f.model.requests[3]!.tools)).toContain('bindingRequired:true');
        const fresh = obj(obj((batches[3]!.result as unknown as ToolResult).details!).value!);
        expect(fresh.page).not.toBe(old.page);
        expect(fresh.ref).not.toBe(old.ref);
        expect(fresh.text).toContain('manual-user-edit');
        expect(fresh.text).toContain('Clicks: 1');
        expect(obj((batches[4]!.result as unknown as ToolResult).details!).code).toBe(
          'browser_page_stale',
        );
        expect(obj((batches[5]!.result as unknown as ToolResult).details!).code).toBe(
          'browser_stale_element',
        );
        expect(
          rows.filter((row) =>
            [batches[4]!.id, batches[5]!.id].includes(row.parentExecutionId ?? ''),
          ),
        ).toEqual([]);
        expect(f.native.filter((value) => obj(value).action === 'fill')).toEqual([
          { action: 'fill', selector: '@e1', value: 'second-run' },
        ]);
        expect(f.native.filter((value) => obj(value).action === 'click')).toEqual([
          { action: 'click', selector: '@e1' },
        ]);
        expect(f.native.filter((value) => obj(value).action === 'navigate')).toHaveLength(1);
        expect(f.mainPage.clicks).toBe(1);
        expect(new Set(f.nativePages)).toEqual(new Set(['retained-main-page']));
        expect(f.owners).toBe(2);
        const browserJobs = rows.filter((row) => row.definitionId === 'browser.session');
        expect(browserJobs).toHaveLength(2);
        expect(browserJobs.map((row) => row.rootWorkCommandId)).toEqual(['work', 'next-work']);
        expect(browserJobs[1]!.id).not.toBe(browserJobs[0]!.id);
        expect(browserJobs[1]!.rootWorkSeq).not.toBe(browserJobs[0]!.rootWorkSeq);
        const humanRecords = await f.store.listExtensionRecords({
          extensionId: 'builtin.browser',
          sessionId: 'session',
          afterKey: 'human/',
          limit: 100,
        });
        expect(humanRecords.filter((record) => record.key.startsWith('human/'))).toEqual([]);
        expect(
          rows.filter((row) =>
            [
              'browser.close',
              'browser.request_human',
              'browser.human_wait',
              'builtin.browser/browser.respond_human',
            ].includes(row.definitionId),
          ),
        ).toEqual([]);
        expect(
          (
            await f.runtime.listInteractions({
              expectedStoreId: (await f.store.getMetadata()).storeId,
              sessionId: 'session',
            })
          ).interactions,
        ).toEqual([]);
        expect(f.model.requests).toHaveLength(9);
        expect(
          (await f.store.listMessages('session')).filter((message) => message.role === 'user'),
        ).toHaveLength(2);
        expect(f.mainPage.value).toBe('second-run');
        expect(f.controller.releasedPage!('another-session')).toBeNull();
        const until = Date.now() + 2000;
        while (f.runtime.getLifecycleState().busy && Date.now() < until) await Bun.sleep(20);
        expect(f.transportCloses).toBe(2);
        expect(f.executorCloses).toBe(2);
        expect(f.runtime.getLifecycleState()).toMatchObject({ busy: false, reasons: [] });
      } finally {
        await f.close();
      }
    },
    20000,
  );

realTest(
  'three real Runs retain A and B and select the original A by canonical URL with fresh refs',
  async () => {
    const finalContent = 'The requested page result is verified and this task is finished.';
    const codes = [
      'var page = await browser.open("https://EXAMPLE.test:443/a"); var seen = await page.snapshot(); await page.fill(seen.elements[0].ref, "retained-A"); var seen = await page.snapshot(); ({page:page.id, ref:seen.elements[0].ref, text:seen.snapshot})',
      'var beforeB = await browser.pages(); var page = await browser.open("https://example.test/b"); var seen = await page.snapshot(); var activePages = await browser.pages(); var again = await browser.pages(); await browser.page(activePages[0].id).fill(seen.elements[0].ref, "retained-B"); var seen = await page.snapshot(); ({beforeB, activePages, again, page:page.id, ref:seen.elements[0].ref, text:seen.snapshot})',
      'var known = await browser.pages(); var again = await browser.pages(); var matches = known.filter(candidate => new URL(candidate.url).href === new URL("https://EXAMPLE.test:443/a").href); if(matches.length !== 1) throw Error("intended page is not unique"); var [candidate] = matches; var page = browser.page(candidate.id); ({known, again, page:page.id})',
      'var seen = await page.snapshot(); var activePages = await browser.pages(); var again = await browser.pages(); ({activePages, again, page:page.id, ref:seen.elements[0].ref, text:seen.snapshot})',
      'replaced with the original Run page id',
      'replaced with the original Run ref',
      'var seen = await page.snapshot(); await page.fill(seen.elements[0].ref, "finished-A"); var verified = await page.snapshot(); ({ref:verified.elements[0].ref, text:verified.snapshot})',
    ];
    const f = await fixture(
      codes.map(() => async () => null),
      {
        realCodes: codes,
        sharedPage: true,
        multipleSharedPages: true,
        runBreaks: [1, 2],
        processConcurrency: 2,
        finalContent,
      },
    );
    try {
      const first = (await f.store.listExecutions('session')).find(
        (row) => row.definitionId === 'browser.execute',
      )!;
      const old = obj(obj((first.result as unknown as ToolResult).details!).value!);
      expect(old.text).toContain('retained-A');
      const originalA = structuredClone(f.retainedMainPages[0]!);
      f.mainPage.value = 'human-edited-A';
      await f.startNewRun('second-work');
      await f.runtime.waitForCommand('second-work', { timeoutMs: 6000 });
      expect(f.retainedMainPages).toHaveLength(2);
      expect(f.mainPage).toMatchObject({
        id: originalA.page.id,
        url: 'https://example.test/a',
        value: 'human-edited-A',
        clicks: 0,
      });
      expect(f.retainedMainPages[1]!.page).toMatchObject({
        url: 'https://example.test/b',
        value: 'retained-B',
        clicks: 0,
      });
      f.setCode(4, `await browser.page(${JSON.stringify(old.page)}).snapshot()`);
      f.setCode(5, `await page.fill(${JSON.stringify(old.ref)}, "forbidden-old-ref")`);
      await f.startNewRun('third-work');
      await f.runtime.waitForCommand('third-work', { timeoutMs: 6000 });
      const rows = await f.store.listExecutions('session');
      const batches = rows.filter((row) => row.definitionId === 'browser.execute');
      expect(batches.map((row) => row.status)).toEqual([
        'succeeded',
        'succeeded',
        'succeeded',
        'succeeded',
        'failed',
        'failed',
        'succeeded',
      ]);
      const onB = obj(obj((batches[1]!.result as unknown as ToolResult).details!).value!);
      const activeB = onB.activePages as Json[];
      expect(activeB).toHaveLength(2);
      expect(onB.again).toEqual(activeB);
      expect(activeB[0]).toEqual({
        id: onB.page!,
        url: 'https://example.test/b',
        title: 'Local form',
      });
      expect(activeB[1]).toMatchObject({
        url: 'https://example.test/a',
        state: 'released',
        bindingRequired: true,
        lastKnown: true,
      });
      expect(new Set(activeB.map((page) => obj(page).id)).size).toBe(2);
      const listed = obj(obj((batches[2]!.result as unknown as ToolResult).details!).value!);
      const known = listed.known as Json[];
      expect(known).toHaveLength(2);
      expect(known.map((page) => obj(page).url)).toEqual([
        'https://example.test/a',
        'https://example.test/b',
      ]);
      expect(listed.again).toEqual(known);
      expect(listed.page).toBe(obj(known[0]!).id);
      expect(new Set(known.map((page) => obj(page).id)).size).toBe(2);
      expect(known.every((page) => obj(page).bindingRequired === true)).toBe(true);
      expect(
        rows.filter((row) => row.kind === 'tool' && row.parentExecutionId === batches[2]!.id),
      ).toEqual([]);
      expect(f.realBoundaries[2]).toMatchObject({ state: 'closed', closes: 2 });
      const rebound = obj(obj((batches[3]!.result as unknown as ToolResult).details!).value!);
      const activeA = rebound.activePages as Json[];
      expect(activeA).toHaveLength(2);
      expect(rebound.again).toEqual(activeA);
      expect(activeA[0]).toEqual({
        id: rebound.page!,
        url: 'https://example.test/a',
        title: 'Local form',
      });
      expect(activeA[1]).toMatchObject({
        url: 'https://example.test/b',
        state: 'released',
        bindingRequired: true,
        lastKnown: true,
      });
      expect(rebound.page).toBe(listed.page);
      expect(rebound.page).not.toBe(old.page);
      expect(rebound.ref).not.toBe(old.ref);
      expect(rebound.text).toContain('human-edited-A');
      expect(rebound.text).toContain('Clicks: 0');
      for (const [index, code] of [
        [4, 'browser_page_stale'],
        [5, 'browser_stale_element'],
      ] as const) {
        expect(obj((batches[index]!.result as unknown as ToolResult).details!).code).toBe(code);
        expect(rows.filter((row) => row.parentExecutionId === batches[index]!.id)).toEqual([]);
      }
      expect(f.controller.releasedPage!('session', 'https://EXAMPLE.test:443/a')).toMatchObject({
        identity: originalA.identity,
      });
      expect(f.retainedMainPages[0]!.identity).toEqual(originalA.identity);
      expect(f.mainPage.value).toBe('finished-A');
      expect(f.retainedMainPages[1]!.page.value).toBe('retained-B');
      expect(f.native.filter((command) => obj(command).action === 'navigate')).toEqual([
        { action: 'navigate', url: 'https://example.test/a', waitUntil: 'domcontentloaded' },
        { action: 'navigate', url: 'https://example.test/b', waitUntil: 'domcontentloaded' },
      ]);
      expect(f.native.filter((command) => obj(command).action === 'fill')).toEqual([
        { action: 'fill', selector: '@e1', value: 'retained-A' },
        { action: 'fill', selector: '@e1', value: 'retained-B' },
        { action: 'fill', selector: '@e1', value: 'finished-A' },
      ]);
      expect(f.native.filter((command) => obj(command).action === 'click')).toEqual([]);
      for (const { identity } of f.retainedMainPages) {
        expect(JSON.stringify(f.model.requests)).not.toContain(identity.pageId);
        expect(JSON.stringify(f.model.requests)).not.toContain(identity.incarnation);
      }
      expect(rows.filter((row) => row.definitionId === 'browser.session')).toHaveLength(3);
      expect(f.owners).toBe(3);
      expect(f.checker.requests).toEqual([]);
      expect(
        (
          await f.runtime.listInteractions({
            expectedStoreId: (await f.store.getMetadata()).storeId,
            sessionId: 'session',
          })
        ).interactions,
      ).toEqual([]);
      expect(new Set(batches.map((row) => row.runId)).size).toBe(3);
      for (const runId of new Set(batches.map((row) => row.runId)))
        expect(await f.store.getRun(runId!)).toMatchObject({
          status: 'completed',
          isActive: false,
        });
      const messages = await f.store.listMessages('session');
      expect(messages.filter((message) => message.role === 'user')).toHaveLength(3);
      expect(
        messages.filter(
          (message) => message.role === 'assistant' && message.content === finalContent,
        ),
      ).toHaveLength(3);
      expect(f.model.requests.at(-1)!.messages.at(-1)!.content).toContain('finished-A');
    } finally {
      await f.close();
    }
  },
  20000,
);

realTest(
  'a released A candidate stays passive while B is active and cannot replace its binding',
  async () => {
    const codes = [
      'var page = await browser.open("https://example.test/a"); await page.snapshot()',
      'var page = await browser.open("https://example.test/b"); var seen = await page.snapshot(); var known = await browser.pages(); ({known, page:page.id, ref:seen.elements[0].ref})',
      'var candidate = known.find(candidate => candidate.bindingRequired); await browser.page(candidate.id).snapshot()',
      'await page.fill(seen.elements[0].ref, "still-B"); var verified = await page.snapshot(); ({known:await browser.pages(), text:verified.snapshot})',
    ];
    const f = await fixture(
      codes.map(() => async () => null),
      {
        realCodes: codes,
        sharedPage: true,
        multipleSharedPages: true,
        followupFrom: 1,
        processConcurrency: 2,
      },
    );
    try {
      await f.startNewRun();
      await f.runtime.waitForCommand('next-work', { timeoutMs: 6000 });
      const rows = await f.store.listExecutions('session');
      const batches = rows.filter((row) => row.definitionId === 'browser.execute');
      expect(batches.map((row) => row.status)).toEqual([
        'succeeded',
        'succeeded',
        'failed',
        'succeeded',
      ]);
      expect(obj((batches[2]!.result as unknown as ToolResult).details!).code).toBe(
        'browser_page_already_open',
      );
      expect((batches[2]!.result as unknown as ToolResult).content).toContain(
        'did not acquire the requested candidate',
      );
      expect(rows.filter((row) => row.parentExecutionId === batches[2]!.id)).toEqual([]);
      expect(rows.filter((row) => row.definitionId === 'browser.open')).toHaveLength(2);
      expect(f.owners).toBe(2);
      expect(f.states).toHaveLength(2);
      const onB = obj(obj((batches[1]!.result as unknown as ToolResult).details!).value!);
      const verified = obj(obj((batches[3]!.result as unknown as ToolResult).details!).value!);
      expect(verified.known).toEqual(onB.known);
      expect(verified.text).toContain('still-B');
      expect(f.retainedMainPages).toHaveLength(2);
      expect(f.retainedMainPages[0]!.page.value).toBe('');
      expect(f.retainedMainPages[1]!.page.value).toBe('still-B');
      expect(f.native.filter((command) => obj(command).action === 'navigate')).toEqual([
        { action: 'navigate', url: 'https://example.test/a', waitUntil: 'domcontentloaded' },
        { action: 'navigate', url: 'https://example.test/b', waitUntil: 'domcontentloaded' },
      ]);
      expect(f.native.filter((command) => obj(command).action === 'fill')).toEqual([
        { action: 'fill', selector: '@e1', value: 'still-B' },
      ]);
    } finally {
      await f.close();
    }
  },
  15000,
);

realTest(
  'an active handle and eight released candidates share the UTF8 observation and done-frame budget',
  async () => {
    const codes = [
      realOpen,
      'var page = await browser.open("https://example.test/b"); await page.snapshot(); await browser.pages()',
    ];
    const f = await fixture(
      codes.map(() => async () => null),
      {
        realCodes: codes,
        followupFrom: 1,
        sharedPage: true,
        multipleSharedPages: true,
        largeSnapshot: true,
        duplicateReleasedCandidate: 8,
        processConcurrency: 2,
      },
    );
    try {
      await f.startNewRun();
      await f.runtime.waitForCommand('next-work', { timeoutMs: 6000 });
      const batches = (await f.store.listExecutions('session')).filter(
        (row) => row.definitionId === 'browser.execute',
      );
      expect(batches.map((row) => row.status)).toEqual(['succeeded', 'succeeded']);
      const listed = obj((batches[1]!.result as unknown as ToolResult).details!).value as Json[];
      expect(listed).toHaveLength(9);
      expect(obj(listed[0]!).bindingRequired).toBeUndefined();
      expect(listed.slice(1).every((page) => obj(page).bindingRequired === true)).toBe(true);
      expect(new Set(listed.map((page) => obj(page).id)).size).toBe(9);
      expect(Buffer.byteLength(JSON.stringify(listed))).toBeLessThanOrEqual(48 * 1024);
      expect(f.owners).toBe(2);
      expect(f.native.filter((command) => obj(command).action === 'navigate')).toHaveLength(2);
      expect(f.native.filter((command) => obj(command).action === 'fill')).toHaveLength(0);
    } finally {
      await f.close();
    }
  },
  15000,
);

realTest(
  'legacy single releasedPage controllers still list and bind one candidate',
  async () => {
    const codes = [
      realOpen,
      'var known = await browser.pages(); var [candidate] = known; var page = browser.page(candidate.id); var seen = await page.snapshot(); ({known, text:seen.snapshot})',
    ];
    const f = await fixture(
      codes.map(() => async () => null),
      {
        realCodes: codes,
        sharedPage: true,
        legacyReleasedPage: true,
        followupFrom: 1,
        processConcurrency: 2,
      },
    );
    try {
      await f.startNewRun();
      await f.runtime.waitForCommand('next-work', { timeoutMs: 6000 });
      const batches = (await f.store.listExecutions('session')).filter(
        (row) => row.definitionId === 'browser.execute',
      );
      expect(batches.map((row) => row.status)).toEqual(['succeeded', 'succeeded']);
      const value = obj(obj((batches[1]!.result as unknown as ToolResult).details!).value!);
      expect(value.known).toHaveLength(1);
      expect(value.text).toContain('Clicks: 0');
      expect(f.owners).toBe(2);
      expect(f.native.filter((command) => obj(command).action === 'navigate')).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
  15000,
);

for (const method of ['snapshot', 'open'] as const)
  realTest(
    `same-URL released candidates reject ${method} before any new open dispatch`,
    async () => {
      const codes = [
        realOpen,
        'var known = await browser.pages(); ({known, again:await browser.pages()})',
        method === 'snapshot'
          ? 'var [candidate] = known; var page = browser.page(candidate.id); try { await page.snapshot(); } catch {} try { await browser.open(candidate.url); } catch {}'
          : 'try { await browser.open("https://EXAMPLE.test:443/"); } catch {} try { await browser.open("https://example.test/alternative"); } catch {}',
      ];
      const f = await fixture(
        codes.map(() => async () => null),
        {
          realCodes: codes,
          sharedPage: true,
          duplicateReleasedCandidate: true,
          followupFrom: 1,
          processConcurrency: 2,
          finalContent: 'The intended page is ambiguous, so this task is finished.',
        },
      );
      try {
        await f.startNewRun();
        await f.runtime.waitForCommand('next-work', { timeoutMs: 6000 });
        const rows = await f.store.listExecutions('session');
        const batches = rows.filter((row) => row.definitionId === 'browser.execute');
        expect(batches.map((row) => row.status)).toEqual(['succeeded', 'succeeded', 'failed']);
        const value = obj(obj((batches[1]!.result as unknown as ToolResult).details!).value!);
        const known = value.known as Json[];
        expect(known).toHaveLength(2);
        expect(value.again).toEqual(known);
        expect(new Set(known.map((page) => obj(page).id)).size).toBe(2);
        expect(new Set(known.map((page) => obj(page).url))).toEqual(
          new Set(['https://example.test/']),
        );
        expect((batches[2]!.result as unknown as ToolResult).content).toContain(
          'Multiple existing pages match this address',
        );
        expect(obj((batches[2]!.result as unknown as ToolResult).details!).code).toBe(
          'browser_page_existing_ambiguous',
        );
        expect(rows.filter((row) => row.parentExecutionId === batches[2]!.id)).toEqual([]);
        expect(rows.filter((row) => row.definitionId === 'browser.open')).toHaveLength(1);
        expect(rows.filter((row) => row.definitionId === 'browser.session')).toHaveLength(1);
        expect(f.owners).toBe(1);
        expect(f.native.filter((command) => obj(command).action === 'navigate')).toHaveLength(1);
        expect(f.native.filter((command) => obj(command).action === 'fill')).toEqual([]);
        expect(JSON.stringify(f.model.requests)).not.toContain('duplicate-main-page');
        expect(JSON.stringify(f.model.requests)).not.toContain('duplicate-inc');
        expect(f.checker.requests).toEqual([]);
        expect(await f.store.getRun(batches[2]!.runId!)).toMatchObject({
          status: 'completed',
          isActive: false,
        });
      } finally {
        await f.close();
      }
    },
    15000,
  );

realTest(
  'standalone closed browser pages expose no retained-page descriptor in a new Run',
  async () => {
    const codes = [realOpen, 'await browser.pages()'];
    const f = await fixture(
      codes.map(() => async () => null),
      { realCodes: codes, followupFrom: 1, processConcurrency: 2 },
    );
    try {
      await f.startNewRun();
      await f.runtime.waitForCommand('next-work', { timeoutMs: 6000 });
      const batches = (await f.store.listExecutions('session')).filter(
        (row) => row.definitionId === 'browser.execute',
      );
      expect(batches.map((row) => row.status)).toEqual(['succeeded', 'succeeded']);
      expect(obj((batches[1]!.result as unknown as ToolResult).details!).value).toEqual([]);
      expect(f.controller.releasedPage!('session')).toBeNull();
      expect(f.owners).toBe(1);
      expect(f.native.filter((value) => obj(value).action === 'navigate')).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
  15000,
);

for (const count of [1, 8])
  realTest(
    `${count} released shared binding candidates stay bounded and perform no binding while listed`,
    async () => {
      const codes = [realOpen, 'await browser.pages()'];
      const f = await fixture(
        codes.map(() => async () => null),
        {
          realCodes: codes,
          followupFrom: 1,
          sharedPage: true,
          largeSnapshot: true,
          duplicateReleasedCandidate: count > 1 ? count : false,
          processConcurrency: 2,
        },
      );
      try {
        await f.startNewRun();
        await f.runtime.waitForCommand('next-work', { timeoutMs: 6000 });
        const batches = (await f.store.listExecutions('session')).filter(
          (row) => row.definitionId === 'browser.execute',
        );
        expect(batches.map((row) => row.status)).toEqual(['succeeded', 'succeeded']);
        const listed = obj((batches[1]!.result as unknown as ToolResult).details!).value as Json[];
        expect(listed).toHaveLength(count);
        for (const page of listed) {
          expect(obj(page).bindingRequired).toBe(true);
          expect(String(obj(page).url).length).toBeLessThanOrEqual(8192);
          expect(String(obj(page).title).length).toBeLessThanOrEqual(256);
          expect(String(obj(page).id)).toMatch(/^[0-9a-f-]{36}$/);
        }
        expect(Buffer.byteLength(JSON.stringify(listed))).toBeLessThanOrEqual(48 * 1024);
        expect(f.owners).toBe(1);
      } finally {
        await f.close();
      }
    },
    15000,
  );

realTest(
  'a pending retained-page candidate rejects input before binding and then snapshots the existing page',
  async () => {
    const codes = [
      realOpen,
      'var page = browser.page((await browser.pages())[0].id); page.id',
      'try { await page.fill("missing-ref", "forbidden"); } catch {} try { await page.click("missing-ref"); } catch {}',
      'var observed = await page.snapshot(); ({page: page.id, ref: observed.elements[0].ref})',
    ];
    const f = await fixture(
      codes.map(() => async () => null),
      { realCodes: codes, followupFrom: 1, sharedPage: true, processConcurrency: 2 },
    );
    try {
      await f.startNewRun();
      await f.runtime.waitForCommand('next-work', { timeoutMs: 6000 });
      const rows = await f.store.listExecutions('session');
      const batches = rows.filter((row) => row.definitionId === 'browser.execute');
      expect(batches.map((row) => row.status)).toEqual([
        'succeeded',
        'succeeded',
        'failed',
        'succeeded',
      ]);
      expect(obj((batches[2]!.result as unknown as ToolResult).details!).code).toBe(
        'browser_page_binding_required',
      );
      expect(rows.filter((row) => row.parentExecutionId === batches[2]!.id)).toEqual([]);
      expect(f.realBoundaries[1]).toMatchObject({ state: 'closed', closes: 1 });
      expect(f.realBoundaries[2]).toMatchObject({ state: 'closed', closes: 1 });
      expect(f.realBoundaries[2]!.jobs).toHaveLength(1);
      expect(
        rows
          .filter((row) => row.kind === 'tool' && row.parentExecutionId === batches[3]!.id)
          .map((row) => row.definitionId),
      ).toEqual(['browser.open', 'browser.snapshot']);
      expect(f.owners).toBe(2);
      expect(f.native.filter((value) => obj(value).action === 'navigate')).toHaveLength(1);
      expect(
        f.native.filter((value) => ['fill', 'click'].includes(String(obj(value).action))),
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  },
  15000,
);

realTest(
  'a new Run observes the exact released redirected page without replaying an unknown initial navigation',
  async () => {
    const codes = [
      'var page = await browser.open("https://example.test/requested");',
      'var known = await browser.pages(); var recovery = known.filter(p => p.observationRequired); if(recovery.length !== 1) throw Error("No unique original page"); ({known, candidate:recovery[0].id});',
      'await browser.open("https://example.test/requested");',
      'var page = browser.page(recovery[0].id); var seen = await page.snapshot(); await page.fill(seen.elements[0].ref, "new-task-input"); var verified = await page.snapshot(); ({text:verified.snapshot, page:page.id});',
      'await page.close();',
    ];
    const f = await fixture(
      codes.map(() => async () => null),
      {
        realCodes: codes,
        sharedPage: true,
        recoverInitialNavigation: true,
        followupFrom: 1,
        processConcurrency: 2,
      },
    );
    try {
      const before = await f.store.listExecutions('session');
      const original = before.find((row) => row.definitionId === 'browser.session')!;
      const originalResult = structuredClone(original.result);
      expect(original.status).toBe('outcome_unknown');
      expect(f.controller.view('session')?.state).toBe('outcome_unknown');
      await f.startNewRun();
      await f.runtime.waitForCommand('next-work', { timeoutMs: 6000 });
      const rows = await f.store.listExecutions('session');
      const batches = rows.filter((row) => row.definitionId === 'browser.execute');
      expect(batches.map((row) => row.status)).toEqual([
        'outcome_unknown',
        'succeeded',
        'failed',
        'succeeded',
        'succeeded',
      ]);
      const candidates = obj(obj((batches[1]!.result as unknown as ToolResult).details!).value!);
      const listed = candidates.known as Json[];
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        url: 'https://example.test/redirected',
        observationRequired: true,
        lastKnown: true,
        bindingRequired: true,
      });
      expect(JSON.stringify(listed)).not.toContain(f.mainIdentity.incarnation);
      expect(obj((batches[2]!.result as unknown as ToolResult).details!).code).toBe(
        'browser_page_recovery_required',
      );
      expect(rows.filter((row) => row.definitionId === 'browser.session')).toHaveLength(2);
      expect((await f.store.getExecution(original.id))?.result).toEqual(originalResult);
      expect(f.native.filter((command) => obj(command).action === 'navigate')).toEqual([
        {
          action: 'navigate',
          url: 'https://example.test/requested',
          waitUntil: 'domcontentloaded',
        },
      ]);
      expect(f.native.filter((command) => obj(command).action === 'fill')).toEqual([
        { action: 'fill', selector: '@e1', value: 'new-task-input' },
      ]);
      expect(f.mainPage).toMatchObject({
        url: 'https://example.test/redirected',
        value: 'new-task-input',
      });
      expect(new Set(f.nativePages)).toEqual(new Set([f.mainPage.id]));
      expect(f.owners).toBe(2);
    } finally {
      await f.close();
    }
  },
  15000,
);

realTest(
  'confirmed missing binding retires its old candidate and a later explicit opening gets a fresh page without replay',
  async () => {
    const codes = [
      'var page = await browser.open("https://example.test/"); var seen = await page.snapshot(); await page.fill(seen.elements[0].ref, "completed-before-closure");',
      'var candidate = (await browser.pages())[0]; var oldPage = browser.page(candidate.id); await oldPage.snapshot();',
      'await oldPage.snapshot();',
      'var page = await browser.open("https://example.test/"); var seen = await page.snapshot(); ({page:page.id, text:seen.snapshot});',
    ];
    const f = await fixture(
      codes.map(() => async () => null),
      {
        realCodes: codes,
        followupFrom: 1,
        sharedPage: true,
        multipleSharedPages: true,
        confirmedMissingRetainedOnce: true,
        processConcurrency: 2,
      },
    );
    try {
      await f.startNewRun();
      await f.runtime.waitForCommand('next-work', { timeoutMs: 6000 });
      const rows = await f.store.listExecutions('session');
      const batches = rows.filter((row) => row.definitionId === 'browser.execute');
      expect(batches.map((row) => row.status)).toEqual([
        'succeeded',
        'failed',
        'failed',
        'succeeded',
      ]);
      expect(obj((batches[1]!.result as unknown as ToolResult).details!).code).toBe(
        'browser_page_existing_missing',
      );
      expect(obj((batches[2]!.result as unknown as ToolResult).details!).code).toBe(
        'browser_page_stale',
      );
      expect(rows.filter((row) => row.parentExecutionId === batches[2]!.id)).toEqual([]);
      expect(rows.filter((row) => row.definitionId === 'browser.session')).toHaveLength(2);
      expect(f.native.filter((value) => obj(value).action === 'navigate')).toHaveLength(2);
      expect(f.native.filter((value) => obj(value).action === 'fill')).toEqual([
        { action: 'fill', selector: '@e1', value: 'completed-before-closure' },
      ]);
      expect(f.retainedMainPages).toHaveLength(1);
      expect(f.retainedMainPages[0]!.identity).not.toEqual(f.mainIdentity);
      expect(f.retainedMainPages[0]!.page).toMatchObject({ value: '', clicks: 0 });
      expect(f.owners).toBe(2);
    } finally {
      await f.close();
    }
  },
  15000,
);

realTest(
  'one confirmed missing candidate leaves the other original page bindable in the same Run',
  async () => {
    const codes = [
      'var page = await browser.open("https://example.test/"); var seen = await page.snapshot(); await page.fill(seen.elements[0].ref, "old-page-value");',
      'var page = await browser.open("https://example.test/current"); var seen = await page.snapshot(); await page.fill(seen.elements[0].ref, "current-page-value");',
      'var known = await browser.pages(); var missing = known.find(p => p.url === "https://example.test/"); var oldPage = browser.page(missing.id); await oldPage.snapshot();',
      'var remaining = await browser.pages(); if(remaining.length !== 1 || remaining[0].url !== "https://example.test/current") throw Error("remaining original target missing"); var page = browser.page(remaining[0].id); var seen = await page.snapshot(); ({remaining, text:seen.snapshot})',
      'await page.close();',
    ];
    const f = await fixture(
      codes.map(() => async () => null),
      {
        realCodes: codes,
        runBreaks: [1, 2],
        sharedPage: true,
        multipleSharedPages: true,
        confirmedMissingRetainedOnce: true,
        processConcurrency: 2,
      },
    );
    try {
      await f.startNewRun('second-work');
      await f.runtime.waitForCommand('second-work', { timeoutMs: 6000 });
      expect(f.retainedMainPages).toHaveLength(2);
      const currentPage = structuredClone(f.retainedMainPages[1]!);
      await f.startNewRun();
      await f.runtime.waitForCommand('next-work', { timeoutMs: 6000 });
      const rows = await f.store.listExecutions('session');
      const batches = rows.filter((row) => row.definitionId === 'browser.execute');
      expect(batches.map((row) => row.status)).toEqual([
        'succeeded',
        'succeeded',
        'failed',
        'succeeded',
        'succeeded',
      ]);
      expect(obj((batches[2]!.result as unknown as ToolResult).details!).code).toBe(
        'browser_page_existing_missing',
      );
      const rebound = obj(obj((batches[3]!.result as unknown as ToolResult).details!).value!);
      expect(rebound.text).toContain('current-page-value');
      expect(rebound.remaining).toMatchObject([
        { url: 'https://example.test/current', bindingRequired: true },
      ]);
      expect(f.retainedMainPages).toEqual([currentPage]);
      expect(f.native.filter((value) => obj(value).action === 'navigate')).toHaveLength(2);
      expect(f.native.filter((value) => obj(value).action === 'fill')).toEqual([
        { action: 'fill', selector: '@e1', value: 'old-page-value' },
        { action: 'fill', selector: '@e1', value: 'current-page-value' },
      ]);
      expect(f.owners).toBe(3);
    } finally {
      await f.close();
    }
  },
  15000,
);

realTest(
  'a missing retained page never falls back to another open or a replacement page',
  async () => {
    const codes = [
      realOpen,
      'var known = await browser.pages(); var page = browser.page(known[0].id); try { await page.snapshot(); } catch {} try { await browser.open(known[0].url); } catch {}',
    ];
    const f = await fixture(
      codes.map(() => async () => null),
      {
        realCodes: codes,
        followupFrom: 1,
        sharedPage: true,
        missingRetained: true,
        processConcurrency: 2,
      },
    );
    try {
      await f.startNewRun();
      await f.runtime.waitForCommand('next-work', { timeoutMs: 6000 });
      const rows = await f.store.listExecutions('session');
      const batches = rows.filter((row) => row.definitionId === 'browser.execute');
      expect(batches.map((row) => row.status)).toEqual(['succeeded', 'failed']);
      expect(obj((batches[1]!.result as unknown as ToolResult).details!).code).toBe(
        'browser_existing_page_unavailable',
      );
      expect(
        rows
          .filter((row) => row.kind === 'tool' && row.parentExecutionId === batches[1]!.id)
          .map((row) => row.definitionId),
      ).toEqual(['browser.open']);
      expect(rows.filter((row) => row.definitionId === 'browser.session')).toHaveLength(1);
      expect(f.owners).toBe(1);
      expect(f.native.filter((value) => obj(value).action === 'navigate')).toHaveLength(1);
      expect(
        f.native.filter((value) => ['fill', 'click'].includes(String(obj(value).action))),
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  },
  15000,
);

for (const code of ['browser_page_existing_missing', 'browser_page_existing_mismatch'] as const)
  realTest(
    `the next Model receives a readable ${code} explanation after the retained page cannot be bound`,
    async () => {
      const codes = [
        realOpen,
        'var page = browser.page((await browser.pages())[0].id); try { await page.snapshot(); } catch {} try { await browser.open("https://example.test/"); } catch {}',
      ];
      const f = await fixture(
        codes.map(() => async () => null),
        {
          realCodes: codes,
          followupFrom: 1,
          sharedPage: true,
          retainedFailure: code,
          processConcurrency: 2,
          finalContent: 'The retained page could not be used; no replacement was opened.',
        },
      );
      try {
        await f.startNewRun();
        await f.runtime.waitForCommand('next-work', { timeoutMs: 6000 });
        const rows = await f.store.listExecutions('session');
        const batch = rows.filter((row) => row.definitionId === 'browser.execute')[1]!;
        const original = rows.find(
          (row) => row.parentExecutionId === batch.id && row.definitionId === 'browser.open',
        )!;
        expect(batch.status).toBe('failed');
        expect(original.status).toBe('failed');
        expect((original.result as unknown as ToolResult).content).toBe(code);
        const result = batch.result as unknown as ToolResult;
        expect(obj(result.details!).code).toBe(code);
        expect(result.content).toContain(
          code === 'browser_page_existing_missing'
            ? 'closed or unavailable'
            : 'address, identity or navigation state changed',
        );
        expect(result.content).toContain(
          'did not create or refresh a replacement page or navigate back',
        );
        const delivered = f.model.requests[3]!.messages.find(
          (message) => message.toolCallId === 'batch-1',
        )!;
        expect(delivered).toMatchObject({ sourceIds: [batch.id], content: result.content });
        expect(delivered.content).toContain(`Diagnostic code: ${code}`);
        expect(rows.filter((row) => row.definitionId === 'browser.session')).toHaveLength(1);
        expect(
          rows.filter((row) => row.kind === 'tool' && row.parentExecutionId === batch.id),
        ).toHaveLength(1);
        expect(f.owners).toBe(1);
        expect(f.native.filter((value) => obj(value).action === 'navigate')).toHaveLength(1);
        expect(
          f.native.filter((value) => ['fill', 'click'].includes(String(obj(value).action))),
        ).toHaveLength(0);
        expect(await f.store.getRun(batch.runId!)).toMatchObject({
          status: 'completed',
          isActive: false,
        });
      } finally {
        await f.close();
      }
    },
    15000,
  );

realTest(
  'the next Model receives page/control-loss uncertainty without replaying dispatched input',
  async () => {
    const codes = [
      realOpen,
      'var page = browser.page((await browser.pages())[0].id); var observed = await page.snapshot(); try { await page.fill(observed.elements[0].ref, "once"); } catch {} try { await page.click(observed.elements[0].ref); } catch {}',
    ];
    const f = await fixture(
      codes.map(() => async () => null),
      {
        realCodes: codes,
        followupFrom: 1,
        sharedPage: true,
        unknownFill: true,
        processConcurrency: 2,
        finalContent: 'The browser lost confirmation; I cannot say whether the input completed.',
      },
    );
    try {
      await f.startNewRun();
      await f.runtime.waitForCommand('next-work', { timeoutMs: 6000 });
      const rows = await f.store.listExecutions('session');
      const batch = rows.filter((row) => row.definitionId === 'browser.execute')[1]!;
      const original = rows.find((row) => row.definitionId === 'browser.fill')!;
      const result = batch.result as unknown as ToolResult;
      expect(batch.status).toBe('outcome_unknown');
      expect(original.status).toBe('outcome_unknown');
      expect((original.result as unknown as ToolResult).content).toContain(
        'browser_action_outcome_unknown',
      );
      expect(obj((original.result as unknown as ToolResult).details!).code).toBe(
        'browser_action_outcome_unknown',
      );
      expect(obj(result.details!).code).toBe('browser_action_outcome_unknown');
      const delivered = f.model.requests[3]!.messages.find(
        (message) => message.toolCallId === 'batch-1',
      )!;
      expect(delivered).toMatchObject({ sourceIds: [batch.id], content: result.content });
      expect(delivered.content).toContain('target page or its control connection may have ended');
      expect(delivered.content).toContain('may or may not have completed');
      expect(delivered.content).toContain('Do not replay');
      expect(delivered.content).toContain('Diagnostic code: browser_action_outcome_unknown');
      expect(delivered.content).not.toContain('was not executed');
      expect(delivered.content).not.toContain('user closed');
      expect(f.native.filter((value) => obj(value).action === 'fill')).toHaveLength(1);
      expect(f.native.filter((value) => obj(value).action === 'click')).toHaveLength(0);
      expect(f.native.filter((value) => obj(value).action === 'navigate')).toHaveLength(1);
      const saved = await f.store.getExecution(original.id);
      expect(saved?.resultRevision).toBe(original.resultRevision);
      expect(saved?.result).toEqual(original.result);
      expect(await f.store.getRun(batch.runId!)).toMatchObject({
        status: 'completed',
        isActive: false,
      });
    } finally {
      await f.close();
    }
  },
  15000,
);

realTest(
  'released metadata cannot bypass the original same-Run close fence',
  async () => {
    const codes = [realOpen, 'await page.close()', 'await browser.pages()'];
    const f = await fixture(
      codes.map(() => async () => null),
      { realCodes: codes, sharedPage: true, processConcurrency: 2 },
    );
    try {
      const batches = (await f.store.listExecutions('session')).filter(
        (row) => row.definitionId === 'browser.execute',
      );
      expect(batches.map((row) => row.status)).toEqual(['succeeded', 'succeeded', 'failed']);
      expect(obj((batches[2]!.result as unknown as ToolResult).details!).code).toBe(
        'browser_control_released',
      );
      expect(f.owners).toBe(1);
      expect(f.states).toHaveLength(1);
      expect(f.native.filter((value) => obj(value).action === 'navigate')).toHaveLength(1);
      expect(
        f.native.filter((value) => ['click', 'fill'].includes(String(obj(value).action))),
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  },
  15000,
);

test('a shared transport cancelled before Agent admission exposes no retained metadata', async () => {
  const f = await fixture([open], { sharedPage: true, deferReady: true, waitForCompletion: false });
  try {
    await f.transportCreated;
    expect(f.controller.view('session')?.state).toBe('starting');
    await f.runtime.cancelCommand({
      expectedStoreId: (await f.store.getMetadata()).storeId,
      sessionId: 'session',
      subjectId: 'owner',
      commandId: 'cancel-never-bound-page',
      targetCommandId: 'work',
    });
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(f.controller.releasedPage!('session')).toBeNull();
    expect(f.native.filter((value) => obj(value).action === 'navigate')).toHaveLength(0);
  } finally {
    f.releaseNavigation();
    await f.close();
  }
});

test('a previously bound shared page with an unknown effect exposes no released descriptor', async () => {
  const f = await fixture([open, fill], { sharedPage: true, unknownFill: true });
  try {
    expect(f.controller.view('session')?.state).toBe('outcome_unknown');
    expect(f.controller.releasedPage!('session')).toBeNull();
    const affected = (await f.store.listExecutions('session')).find(
      (row) => row.definitionId === 'browser.fill',
    )!;
    expect(affected.status).toBe('outcome_unknown');
    expect(f.native.filter((value) => obj(value).action === 'fill')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

realTest('UTF8 code limit is rejected before any environment or process admission', async () => {
  const codes = [`//${'雪'.repeat(6000)}`];
  const f = await fixture(
    codes.map(() => async () => null),
    { realCodes: codes },
  );
  try {
    const rows = await f.store.listExecutions('session');
    expect(rows.filter((row) => row.definitionId === 'browser.execute')[0]!.result).toMatchObject({
      outcome: 'failed',
      content: 'browser_executor_code_limit',
    });
    expect(rows.filter((row) => row.kind === 'job')).toEqual([]);
    expect(f.executorCalls).toEqual([]);
    expect(f.native).toEqual([]);
  } finally {
    await f.close();
  }
});
