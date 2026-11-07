import { randomUUID } from 'node:crypto';
import { Semaphore } from '../../execution/resources';
import type {
  ArtifactRef,
  JobDefinition,
  JobHandle,
  Json,
  OperationRef,
  ResourceCapacity,
  ToolDefinition,
  ToolResult,
} from '../../extensions';
import { AgentError } from '../../storage/types';
import { BrowserExecutorFailure } from './executor-failure';
import { createBrowserControlTool } from './page-api';
import { explainBrowserExecutionResult } from './result-explanation';
import type { BrowserController, BrowserTarget } from './types';

export type BrowserCodeResult =
  | { value: Json; output: string; failure?: never }
  | { value: null; output: string; failure: { kind: 'api' | 'evaluation'; message: string } };
export interface BrowserCodeExecutor {
  execute(input: {
    code: string;
    signal: AbortSignal;
    call(method: string, args: Json): Promise<Json>;
    /** Trusted Host classification; never supplied to the interpreter. */
    recoverableFailure?(error: unknown): { message: string } | undefined;
  }): Promise<BrowserCodeResult>;
  close(): Promise<{ confirmed: boolean }>;
}
type BoundPage = {
  target: BrowserTarget;
  refs: Map<string, { ref: string; seq: string }>;
  images?: Map<string, string>;
};
type PendingPage = { bindingUrl: string; candidateKey?: string; binding?: Promise<BoundPage> };
type Page = BoundPage | PendingPage;
type Environment = {
  releaseAdmission(): void;
  executor: BrowserCodeExecutor;
  commandId: string;
  sessionId: string;
  pages: Map<string, Page>;
  unwatch: (() => void)[];
  stopped: boolean;
  releasing?: boolean;
  ready: Promise<void>;
  admit(): void;
  completion: Promise<boolean>;
  finish(confirmed: boolean): void;
  isActive(): Promise<boolean>;
  supervision?: ReturnType<typeof setTimeout>;
  closing?: Promise<{ confirmed: boolean }>;
  abort: AbortController;
  pending: Set<() => Promise<boolean>>;
};
// A Core resource manager owns this frozen identity. Separate bindings in the
// same Runtime share admission without borrowing or releasing its process permits.
const environmentAdmissions = new WeakMap<ResourceCapacity, Semaphore>();
const validationFailures = new WeakSet<Error>();
function invalid(code: string) {
  const error = Error(code);
  validationFailures.add(error);
  return error;
}
function object(value: unknown): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('browser_api_arguments');
  return value as Record<string, Json>;
}
function string(value: unknown, maximum = 16384): string {
  if (typeof value !== 'string' || !value || value.length > maximum || value.includes('\0'))
    throw Error('browser_api_arguments');
  return value;
}
function inputString(value: unknown, maximum: number) {
  try {
    return string(value, maximum);
  } catch {
    throw invalid('browser_api_arguments');
  }
}
function failed(code: string): ToolResult {
  return { outcome: 'failed', content: code, details: { code } };
}
const maximumSnapshotValueBytes = 48 * 1024;
function snapshotTextPrefix(value: string, maximumBytes: number) {
  if (Buffer.byteLength(JSON.stringify(value)) <= maximumBytes) return value;
  const characters = Array.from(value);
  let low = 0,
    high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(characters.slice(0, middle).join(''))) <= maximumBytes)
      low = middle;
    else high = middle - 1;
  }
  return characters.slice(0, low).join('');
}

/** One executable leaf. Every dynamic browser call remains an ordinary child Tool. */
export function createBrowserExecution(options: {
  controller: BrowserController;
  createExecutor(scope: string): BrowserCodeExecutor;
}) {
  const environments = new Map<string, Environment>();
  const batches = new Map<string, Promise<void>>();
  const handles = new WeakMap<JobHandle, Environment>();
  const releasedPages = (sessionId: string) => {
    if (options.controller.releasedPages) return options.controller.releasedPages(sessionId);
    const page = options.controller.releasedPage?.(sessionId);
    return page ? [page] : [];
  };
  const canonicalUrl = (url: string) => {
    try {
      return new URL(url).href;
    } catch {
      return url;
    }
  };
  async function close(environment: Environment) {
    environment.closing ??= (async () => {
      environment.stopped = true;
      environment.abort.abort();
      clearTimeout(environment.supervision);
      for (const remove of environment.unwatch.splice(0)) remove();
      const stopping = environment.executor.close();
      const cancelled = await Promise.all(
        [...environment.pending].map((cancel) => cancel().catch(() => false)),
      );
      const result = await stopping;
      const confirmed = result.confirmed && cancelled.every(Boolean);
      environment.finish(confirmed);
      if (confirmed) environment.releaseAdmission();
      return { confirmed };
    })();
    return environment.closing;
  }
  const job: JobDefinition = {
    id: 'browser.code_session',
    version: '1',
    description:
      'Own the isolated persistent browser code interpreter for one hot Run; no cold code replay.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
      additionalProperties: false,
    },
    resources: { slot: 'process' },
    async start(input, context) {
      const runId = string(object(input).runId, 128);
      const environment = environments.get(`${context.sessionId}/${runId}`);
      if (!environment || environment.stopped) throw Error('browser_executor_scope_unavailable');
      context.signal.throwIfAborted();
      const handle: JobHandle = { reference: { runId, sessionId: context.sessionId } };
      handles.set(handle, environment);
      const supervise = async () => {
        if (environment.stopped) return;
        try {
          if (!(await environment.isActive())) {
            await close(environment);
            return;
          }
        } catch {
          await close(environment);
          return;
        }
        if (!environment.stopped) environment.supervision = setTimeout(() => void supervise(), 250);
      };
      environment.supervision = setTimeout(() => void supervise(), 250);
      environment.admit();
      return handle;
    },
    async *observe(handle) {
      const environment = handles.get(handle);
      if (!environment) throw Error('browser_executor_handle_invalid');
      yield { type: 'progress', value: { state: 'ready' } };
      const confirmed = await environment.completion;
      yield {
        type: 'terminal',
        supervision: confirmed ? 'ended' : 'unknown',
        result: {
          outcome: confirmed ? 'cancelled' : 'outcome_unknown',
          content: confirmed
            ? 'The isolated browser code environment stopped and its process cleanup was confirmed. This is only the code environment lifecycle result; it does not establish whether the user cancelled the task or whether any browser action completed. Use the original Task and paired browser operation results for those outcomes.'
            : 'browser_executor_cleanup_unknown',
        },
      };
    },
    async cancel(handle) {
      const environment = handles.get(handle);
      if (!environment) throw Error('browser_executor_handle_invalid');
      return { status: (await close(environment)).confirmed ? 'stopped' : 'unknown' };
    },
    async dispose(handle) {
      const environment = handles.get(handle);
      if (!environment || !(await environment.completion))
        throw Error('browser_executor_cleanup_unknown');
      handles.delete(handle);
    },
  };
  const imageTool: ToolDefinition = {
    id: 'browser.image',
    version: '1',
    model: { name: 'browser_image', hidden: true },
    description: 'Internal formal PNG observation of the exact currently controlled page.',
    inputSchema: {
      type: 'object',
      properties: { browserId: { type: 'string' }, generation: { type: 'string' } },
      required: ['browserId', 'generation'],
      additionalProperties: false,
    },
    async execute(input, context): Promise<ToolResult> {
      if (!context.artifacts || !options.controller.image)
        return failed('browser_image_unavailable');
      const value = object(input);
      let image: Awaited<ReturnType<NonNullable<BrowserController['image']>>>;
      try {
        image = await options.controller.image(
          context.sessionId,
          { browserId: string(value.browserId, 128), generation: string(value.generation, 128) },
          context.signal,
        );
      } catch (error) {
        if (context.signal.aborted)
          return { outcome: 'cancelled', content: 'browser_image_cancelled' };
        return failed(
          error instanceof Error && /^(?:browser_|desktop_browser_)[a-z_]+$/.test(error.message)
            ? error.message
            : 'browser_image_unavailable',
        );
      }
      const artifact = await context.artifacts.publish({
        key: 'browser-observation',
        content: Buffer.from(image.data, 'base64'),
        mediaType: 'image/png',
      });
      const { data: _, ...metadata } = image;
      return {
        outcome: 'succeeded',
        content: JSON.stringify(metadata),
        details: metadata as Json,
        artifactRefs: [artifact],
        modelImages: [artifact],
      };
    },
  };
  const tool: ToolDefinition = {
    id: 'browser.execute',
    version: '1',
    model: { name: 'browser_execute' },
    description:
      'Execute bounded JavaScript in an isolated persistent browser environment for this Run. Load the built-in computer-use skill first for the exact API. Top-level await and variables persist. Browser operations need no approval or reviewer; the host still enforces exact task/page ownership, current control and cancellation. A failed, cancelled or unknown call stops this batch, including calls attempted after catch. Observe before acting and verify the actual result; never replay unknown effects. No filesystem, direct network, process, shell, CDP or credentials. Screenshots return formal model images at the end of this call. For a later user message continuing a released Native page, list browser.pages(), choose the unique candidate whose canonical URL matches the intended task page, use browser.page(candidate.id), then await page.snapshot(). Never select the first or most recent candidate by position. pages() offers all known released candidates with fresh task-scoped ids and bindingRequired:true, not existing control. Listing and browser.page(id) perform no I/O. The first snapshot binds only the retained existing page through Main and obtains new refs; a missing or changed target fails without creating, refreshing or navigating a page. After a confirmed browser_page_existing_missing result, the old candidate is invalid; when the current task clearly requests a known URL without depending on old page state, make a separate browser.open(theActualUrl) call and take a new snapshot. Do not replay completed or unknown actions. Mismatch, connection loss and unconfirmed cleanup do not permit this recovery. Multiple candidates for the same canonical URL are ambiguous and refuse binding before dispatch. Before a successful snapshot no input is allowed. Ordinary browser.open for a unique released URL also uses existing-only binding. An empty pages list means no known control or retained-page metadata, not proof that a browser tab is absent. Stop/handoff invalidates this code environment without destroying the retained page.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', minLength: 1, maxLength: 16384 },
        description: {
          type: 'string',
          description:
            'Optional action purpose for display in the user’s language. Omit to use the host summary. Describe the intended action without sensitive values; display length never changes execution.',
        },
      },
      required: ['code'],
      additionalProperties: false,
    },
    async execute(input, context): Promise<ToolResult> {
      if (!context.runId) return failed('browser_execution_run_required');
      if ((context.resourceCapacity?.process ?? 0) < 2)
        return failed('browser_resource_capacity_unavailable');
      const batchKey = `${context.sessionId}/${context.runId}`;
      const previous = batches.get(batchKey) ?? Promise.resolve();
      const task = previous.then(async (): Promise<ToolResult> => {
        context.signal.throwIfAborted();
        const code = string(object(input).code, 16384);
        if (!code.trim() || Buffer.byteLength(code) > 16384)
          return failed('browser_executor_code_limit');
        const key = `${context.sessionId}/${context.runId}`;
        let environment = environments.get(key);
        if (environment?.stopped) {
          environments.delete(key);
          environment = undefined;
        }
        const own = await context.getExecution(context.executionId);
        if (!own?.originStoreId || !own.originCommandId)
          return failed('browser_execution_scope_unavailable');
        try {
          await options.controller.prepareRun?.(context.sessionId, context.runId!);
        } catch (error) {
          // These exact trusted admission refusals happen before this batch can
          // acquire a VM or a page. Unknown prior cleanup remains unknown.
          if (
            error instanceof Error &&
            ['browser_control_released', 'browser_session_already_owned'].includes(error.message)
          )
            return failed(error.message);
          if (
            error instanceof Error &&
            ['browser_previous_cleanup_unconfirmed', 'browser_owner_run_unverifiable'].includes(
              error.message,
            )
          )
            return {
              outcome: 'outcome_unknown',
              content: error.message,
              details: { code: error.message, dispatchCommitted: true, adapterAttempted: true },
            };
          throw error;
        }
        const journalKey = `code/${context.executionId}`;
        if (await context.records.get(journalKey))
          return {
            outcome: 'outcome_unknown',
            content:
              'browser_code_previous_attempt_unresolved; inspect original child results. Do not replay the batch.',
          };
        await context.records.write({
          key: journalKey,
          expectedRevision: null,
          contentType: 'application/vnd.kite.browser-code+json',
          contentVersion: 1,
          value: { status: 'started' },
        });
        if (!environment) {
          const runId = string(context.runId, 128);
          let admission = environmentAdmissions.get(context.resourceCapacity);
          if (!admission) {
            admission = new Semaphore(Math.floor(context.resourceCapacity.process / 2));
            environmentAdmissions.set(context.resourceCapacity, admission);
          }
          let releaseAdmission: () => void;
          try {
            releaseAdmission = await admission.acquire(context.signal);
          } catch (error) {
            if (context.signal.aborted)
              return { outcome: 'cancelled', content: 'browser_execution_cancelled' };
            throw error;
          }
          let admit!: () => void, finish!: (confirmed: boolean) => void;
          const ready = new Promise<void>((resolve) => {
            admit = resolve;
          });
          const completion = new Promise<boolean>((resolve) => {
            finish = resolve;
          });
          try {
            context.signal.throwIfAborted();
            environment = {
              releaseAdmission,
              executor: options.createExecutor(`${own.originStoreId}/${key}`),
              commandId: own.originCommandId,
              sessionId: context.sessionId,
              pages: new Map(),
              unwatch: [],
              stopped: false,
              ready,
              admit,
              completion,
              finish,
              abort: new AbortController(),
              pending: new Set(),
              async isActive() {
                const run = await context.getRun(runId);
                return run?.id === runId && run.sessionId === context.sessionId && run.isActive;
              },
            };
          } catch (error) {
            releaseAdmission();
            throw error;
          }
          environments.set(key, environment);
          try {
            const ref = await context.operations.ensure({
              key: `code-${context.executionId}`,
              cancellation: 'attached',
              request: {
                kind: 'job',
                definitionId: job.id,
                definitionVersion: job.version,
                input: { runId: context.runId },
              },
            });
            while (true) {
              context.signal.throwIfAborted();
              const execution = await context.operations.get(ref);
              if (
                execution &&
                ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status)
              ) {
                await close(environment);
                return execution.status === 'succeeded'
                  ? failed('browser_executor_ended_before_ready')
                  : (object(execution.result) as unknown as ToolResult);
              }
              const admitted = await Promise.race([
                environment.ready.then(() => true),
                new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
              ]);
              if (admitted) break;
            }
          } catch (error) {
            await close(environment);
            throw error;
          }
        }
        const current = environment;
        let sequence = 0,
          blocked: ToolResult | undefined;
        const knownFailures = new WeakSet<object>();
        const images: ArtifactRef[] = [];
        const operations: Json[] = [];
        let opening: OperationRef | undefined;
        const originalOpenResult = async (ref: OperationRef): Promise<ToolResult | undefined> => {
          const original = await context.operations.get(ref);
          if (
            !original ||
            !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(original.status)
          )
            return;
          const result = object(original.result) as unknown as ToolResult;
          return {
            ...(result.outcome === 'succeeded' ? failed('browser_ended_before_ready') : result),
            details: {
              original: result.details ?? null,
              originalJob: {
                ref,
                executionId: original.id,
                ...(original.kind === 'job' &&
                original.id === ref.executionId &&
                original.definitionId === 'browser.session' &&
                original.definitionVersion === '1'
                  ? {
                      definitionId: original.definitionId,
                      definitionVersion: original.definitionVersion,
                    }
                  : {}),
                result: original.result,
              },
            } as unknown as Json,
          };
        };
        const cancelOriginal = async (
          ref: OperationRef,
          original?: Record<string, Json>,
        ): Promise<boolean> => {
          if (!context.operations.cancel) return false;
          await context.operations.cancel(ref);
          const until = Date.now() + 30000;
          for (;;) {
            const execution = await context.operations.get(ref);
            if (
              execution &&
              ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status)
            ) {
              if (original) {
                const result = object(execution.result) as unknown as ToolResult;
                original.executionId = execution.id;
                original.outcome = result.outcome;
                if (
                  result.outcome === 'outcome_unknown' ||
                  (result.outcome === 'cancelled' && blocked?.outcome !== 'outcome_unknown')
                )
                  blocked = result;
              }
              return true;
            }
            if (Date.now() >= until) return false;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        };
        const child = async (id: string, input: Record<string, Json>): Promise<ToolResult> => {
          context.signal.throwIfAborted();
          if (current.stopped || blocked) throw Error('browser_batch_stopped');
          const planned = context.operations.ensure({
            key: `api-${context.executionId}-${++sequence}`,
            cancellation: 'attached',
            request: { kind: 'tool', definitionId: id, definitionVersion: '1', input },
          });
          let original: Record<string, Json> | undefined;
          const cancel = async () => {
            const ref = await planned;
            return cancelOriginal(ref, original);
          };
          current.pending.add(cancel);
          try {
            const ref = await planned;
            original = {
              commandId: ref.commandId,
              executionId: ref.executionId ?? null,
              definitionId: id,
              outcome: 'pending',
            };
            operations.push(original);
            if (current.abort.signal.aborted) {
              await cancel();
              current.abort.signal.throwIfAborted();
            }
            for (;;) {
              try {
                const execution = await context.operations.wait(ref, {
                  signal: AbortSignal.any([context.signal, current.abort.signal]),
                  timeoutMs: 30000,
                });
                const result = object(execution.result) as unknown as ToolResult;
                original.executionId = execution.id;
                original.outcome = result.outcome;
                if (result.outcome !== 'succeeded') {
                  blocked = result;
                  const error = Error('browser_api_stopped');
                  if (result.outcome === 'failed') knownFailures.add(error);
                  throw error;
                }
                return result;
              } catch (error) {
                if (error instanceof AgentError && error.code === 'wait_timeout') continue;
                throw error;
              }
            }
          } finally {
            current.pending.delete(cancel);
          }
        };
        const bindPage = async (destination: string, pageId: string): Promise<BoundPage> => {
          if (
            [...current.pages.entries()].some(
              ([id, page]) => 'target' in page || (id !== pageId && page.binding !== undefined),
            )
          )
            throw invalid('browser_page_already_open');
          if (
            releasedPages(context.sessionId).filter(
              (page) => canonicalUrl(page.url) === canonicalUrl(destination),
            ).length > 1
          )
            throw invalid('browser_page_existing_ambiguous');
          const browserId = randomUUID();
          const opened = await child('browser.open', {
            key: browserId,
            url: destination,
          });
          const lifetime = object(object(opened.details).ref) as unknown as OperationRef;
          opening = lifetime;
          let acquired: ReturnType<BrowserController['view']>;
          for (;;) {
            // The original Job can still be awaiting authorization or a
            // process slot. Its transport startup deadline has not begun.
            // Observe that exact request, rather than cancelling it under
            // an unrelated page-handle timer.
            const terminal = await originalOpenResult(lifetime);
            if (terminal) {
              blocked = terminal;
              throw Error('browser_open_stopped');
            }
            context.signal.throwIfAborted();
            current.abort.signal.throwIfAborted();
            acquired = options.controller.view(context.sessionId);
            if (
              acquired?.browserId === browserId &&
              ['pausing', 'human'].includes(acquired.state)
            ) {
              // A real user handoff owns the page now. Ending this incomplete
              // code call cannot cancel that Browser Job or reclaim control.
              opening = undefined;
              blocked = failed('browser_control_handed_off');
              throw Error('browser_control_handed_off');
            }
            if (acquired?.browserId === browserId && acquired.state === 'agent') break;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          const page: BoundPage = {
            target: { browserId, generation: acquired.generation },
            refs: new Map(),
          };
          current.pages.clear();
          current.pages.set(pageId, page);
          current.unwatch.push(
            options.controller.watchControl(context.sessionId, page.target, (state) => {
              if (
                !current.releasing &&
                [
                  'closing',
                  'closed',
                  'outcome_unknown',
                  'unavailable',
                  'human',
                  'pausing',
                ].includes(state)
              ) {
                void close(current);
              }
            }),
          );
          opening = undefined;
          return page;
        };
        const bindPending = async (pageId: string, pending: PendingPage): Promise<BoundPage> => {
          pending.binding ??= bindPage(pending.bindingUrl, pageId);
          try {
            return await pending.binding;
          } catch (error) {
            // A failed candidate never acquired authority. Retire its handle
            // rather than reusing a rejected Promise in a later code batch.
            // Any new explicit open still follows ordinary host admission.
            if (current.pages.get(pageId) === pending) {
              if (error instanceof Error && validationFailures.has(error)) delete pending.binding;
              else current.pages.delete(pageId);
            }
            throw error;
          }
        };
        const call = async (method: string, raw: Json): Promise<Json> => {
          if (blocked || current.stopped) throw Error('browser_batch_stopped');
          try {
            let args: Record<string, Json>;
            try {
              args = method === 'pages' ? {} : object(raw);
            } catch {
              throw invalid('browser_api_arguments');
            }
            const positional = Array.isArray(args.args) ? args.args : [];
            if (method === 'fill')
              Object.assign(args, { ref: positional[0], value: positional[1] });
            else if (method === 'click') args.ref = positional[0]!;
            else if (method === 'scroll')
              Object.assign(args, { direction: positional[0], amount: positional[1] });
            else if (method === 'navigate') args.url = positional[0]!;
            else if (method === 'requestHuman') args.reason = positional[0]!;
            if (method === 'pages') {
              const view = options.controller.view(context.sessionId);
              if (view && ['human', 'pausing'].includes(view.state))
                throw invalid('browser_control_is_human');
              const released = releasedPages(context.sessionId);
              // Bound active and released metadata together; binding URLs stay private and full.
              const textBudget = Math.max(
                2,
                Math.floor(
                  maximumSnapshotValueBytes /
                    Math.max(1, released.length + (view?.state === 'agent' ? 1 : 0)),
                ) - 2048,
              );
              const pages: Json[] = [];
              if (view?.state === 'agent') {
                const existing = [...current.pages.entries()].find(
                  ([, page]) =>
                    'target' in page &&
                    page.target.browserId === view.browserId &&
                    page.target.generation === view.generation,
                );
                const id = existing?.[0] ?? randomUUID();
                if (!existing) {
                  const page: BoundPage = {
                    target: { browserId: view.browserId, generation: view.generation },
                    refs: new Map(),
                  };
                  current.pages.set(id, page);
                  current.unwatch.push(
                    options.controller.watchControl(context.sessionId, page.target, (state) => {
                      if (!current.releasing && !['agent', 'starting'].includes(state)) {
                        void close(current);
                      }
                    }),
                  );
                }
                pages.push({
                  id,
                  url: snapshotTextPrefix(view.url.slice(0, 8192), Math.min(8192, textBudget)),
                  title: snapshotTextPrefix(view.title.slice(0, 256), 512),
                });
              }
              return pages.concat(
                released.map((released, index) => {
                  const bindingUrl = canonicalUrl(released.url);
                  const candidateKey = JSON.stringify([
                    bindingUrl,
                    released.identity?.pageId,
                    released.identity?.incarnation,
                    index,
                  ]);
                  const existing = [...current.pages.entries()].find(
                    ([, page]) => 'bindingUrl' in page && page.candidateKey === candidateKey,
                  );
                  const id = existing?.[0] ?? randomUUID();
                  if (!existing) current.pages.set(id, { bindingUrl, candidateKey });
                  return {
                    id,
                    state: 'released',
                    bindingRequired: true,
                    lastKnown: true,
                    ...(released.observationRequired ? { observationRequired: true } : {}),
                    url: snapshotTextPrefix(bindingUrl.slice(0, 8192), Math.min(8192, textBudget)),
                    title: snapshotTextPrefix(released.title.slice(0, 256), 512),
                    guidance: released.observationRequired
                      ? 'The first navigation on this original page remains unknown, while its old control cleanup was confirmed. This URL and title were observed by Main at release, not a current existence proof. Bind this exact retained candidate and take a fresh snapshot before another open, input or screenshot. Do not repeat the earlier navigation. Old refs and coordinates are invalid.'
                      : 'Last-known existing-page binding candidate only; current existence is unverified and this id grants no control. browser.page(id) is inert. Its first snapshot binds only the retained existing page through Main and returns fresh refs; a missing or changed target fails without creating, refreshing or navigating a page. Before that snapshot no input is allowed.',
                  };
                }),
              );
            }
            if (method === 'open') {
              const destination = canonicalUrl(inputString(args.url, 8192));
              const existing = [...current.pages.entries()].find(
                ([, page]) => 'bindingUrl' in page && page.bindingUrl === destination,
              );
              const pageId = existing?.[0] ?? randomUUID();
              const pending: PendingPage =
                existing && 'bindingUrl' in existing[1] ? existing[1] : { bindingUrl: destination };
              current.pages.set(pageId, pending);
              await bindPending(pageId, pending);
              return pageId;
            }
            const pageId = inputString(args.page, 128);
            let page = current.pages.get(pageId);
            if (!page) throw invalid('browser_page_stale');
            if ('bindingUrl' in page) {
              if (method !== 'snapshot') throw invalid('browser_page_binding_required');
              page = await bindPending(pageId, page);
            }
            const view = options.controller.view(context.sessionId);
            if (
              !view ||
              view.browserId !== page.target.browserId ||
              view.generation !== page.target.generation ||
              view.state !== 'agent'
            )
              throw invalid('browser_page_stale');
            if (method === 'snapshot') {
              const result = await child('browser.snapshot', { key: randomUUID(), ...page.target });
              const value = object(result.details);
              page.refs.clear();
              const refs = new Map<string, { ref: string; seq: string }>();
              const elements = (
                Array.isArray(value.elements)
                  ? value.elements
                  : Array.isArray(value.annotations)
                    ? value.annotations
                    : []
              ).map((item) => {
                const element = object(item),
                  ref = randomUUID();
                refs.set(ref, { ref: string(element.ref, 128), seq: string(value.seq, 128) });
                return { ref, role: element.role ?? null, name: element.name ?? null };
              });
              const observation = {
                url: value.url ?? null,
                title: value.title ?? null,
                snapshot: value.snapshot ?? '',
                elements,
                truncated: value.truncated ?? false,
              };
              // A valid Host read must also fit an automatic worker done frame
              // when the observation is the code's final expression. Count the
              // actual JSON UTF8 bytes, including escaped page text.
              if (Buffer.byteLength(JSON.stringify(observation)) > maximumSnapshotValueBytes) {
                observation.truncated = true;
                observation.url =
                  typeof observation.url === 'string'
                    ? snapshotTextPrefix(observation.url, 4 * 1024)
                    : null;
                observation.title =
                  typeof observation.title === 'string'
                    ? snapshotTextPrefix(observation.title, 2 * 1024)
                    : null;
                observation.snapshot =
                  typeof observation.snapshot === 'string'
                    ? snapshotTextPrefix(observation.snapshot, 24 * 1024)
                    : '';
                observation.elements = [];
                let size = Buffer.byteLength(JSON.stringify(observation));
                for (const element of elements) {
                  const additional =
                    Buffer.byteLength(JSON.stringify(element)) +
                    (observation.elements.length ? 1 : 0);
                  if (size + additional > maximumSnapshotValueBytes) continue;
                  observation.elements.push(element);
                  size += additional;
                }
              }
              for (const element of observation.elements)
                page.refs.set(element.ref, refs.get(element.ref)!);
              return observation;
            }
            if (method === 'screenshot') {
              if (!context.artifacts || images.length >= 4) throw invalid('browser_image_limit');
              const result = await child(
                'browser.image',
                page.target as unknown as Record<string, Json>,
              );
              const source = result.modelImages?.[0];
              if (!source) throw Error('browser_image_unavailable');
              const artifact = await context.artifacts.publish({
                key: `browser-image-${images.length}`,
                content: await context.artifacts.read(source),
                mediaType: 'image/png',
              });
              images.push(artifact);
              const { imageRef: basis, seq: _seq, ...metadata } = object(result.details);
              if (typeof basis === 'string') {
                page.images ??= new Map();
                page.images.set(artifact.id, basis);
              }
              return { ...metadata, imageRef: artifact.id };
            }
            if (
              [
                'press',
                'select',
                'hover',
                'back',
                'forward',
                'reload',
                'wait',
                'dialogs',
                'dialog',
                'pointer',
              ].includes(method)
            ) {
              const operation: Record<string, Json> = { action: method };
              if (method === 'press') operation.key = inputString(positional[0], 96);
              else if (method === 'hover' || method === 'select') {
                const element = page.refs.get(inputString(positional[0], 128));
                if (!element || element.seq !== view.seq) throw invalid('browser_stale_element');
                Object.assign(operation, element);
                if (method === 'select')
                  operation.values = Array.isArray(positional[1])
                    ? positional[1]
                    : [positional[1]!];
              } else if (method === 'wait') {
                operation.text = inputString(positional[0], 1024);
                operation.timeoutMs = positional[1] ?? 5000;
              } else if (method === 'dialog') {
                operation.dialogRef = inputString(positional[0], 128);
                operation.response = positional[1]!;
              } else if (method === 'pointer') {
                let value: Record<string, Json>;
                try {
                  value = object(positional[0]);
                } catch {
                  throw invalid('browser_api_arguments');
                }
                const basis = page.images?.get(inputString(value.imageRef, 256));
                if (!basis) throw invalid('browser_image_stale');
                Object.assign(operation, {
                  imageRef: basis,
                  kind: value.kind,
                  from: value.from,
                  ...(value.to ? { to: value.to } : {}),
                });
                page.images!.delete(String(value.imageRef));
              }
              const result = await child('browser.control', { ...page.target, operation });
              if (method !== 'dialogs' && method !== 'wait') page.refs.clear();
              return result.details ?? { content: result.content };
            }
            const parameters: Record<string, Json> = { key: randomUUID(), ...page.target };
            if (method === 'click' || method === 'fill') {
              const element = page.refs.get(inputString(args.ref, 128));
              if (!element || element.seq !== view.seq) throw invalid('browser_stale_element');
              Object.assign(parameters, element);
              if (method === 'fill') {
                if (
                  typeof args.value !== 'string' ||
                  args.value.length > 16384 ||
                  args.value.includes('\0')
                )
                  throw invalid('browser_api_arguments');
                parameters.value = args.value;
              }
            } else if (method === 'navigate') parameters.url = inputString(args.url, 8192);
            else if (method === 'scroll') {
              if (
                !['up', 'down', 'left', 'right'].includes(String(args.direction)) ||
                !Number.isInteger(args.amount) ||
                Number(args.amount) < 1 ||
                Number(args.amount) > 2000
              )
                throw invalid('browser_api_arguments');
              parameters.direction = args.direction!;
              parameters.amount = args.amount!;
            } else if (method === 'requestHuman')
              parameters.reason = inputString(args.reason, 1000);
            else if (method !== 'close') throw invalid('browser_api_unavailable');
            if (method === 'close' || method === 'requestHuman') current.releasing = true;
            const result = await child(
              `browser.${method === 'requestHuman' ? 'request_human' : method}`,
              parameters,
            );
            page.refs.clear();
            return result.details ?? { content: result.content };
          } catch (error) {
            if (!current.abort.signal.aborted && !context.signal.aborted)
              blocked ??= failed(error instanceof Error ? error.message : 'browser_api_failed');
            throw error;
          }
        };
        let batchOutput: string | undefined;
        try {
          const result = await current.executor.execute({
            code,
            signal: context.signal,
            call,
            recoverableFailure(error) {
              if (
                opening ||
                current.stopped ||
                current.releasing ||
                current.abort.signal.aborted ||
                context.signal.aborted
              )
                return undefined;
              if (
                error instanceof Error &&
                (validationFailures.has(error) || knownFailures.has(error))
              )
                return { message: blocked?.content ?? error.message };
              return undefined;
            },
          });
          batchOutput = result.output;
          if (current.closing) await current.closing;
          if (blocked)
            return {
              ...blocked,
              details: { original: blocked.details ?? null, operations, output: batchOutput },
            };
          if (current.stopped)
            return {
              outcome: context.signal.aborted ? 'cancelled' : 'failed',
              content: 'browser_execution_stopped',
              details: { operations },
            };
          if (result.failure)
            return {
              outcome: 'failed',
              content: result.failure.message,
              details: { operations, output: batchOutput, failureKind: result.failure.kind },
            };
          if (current.releasing) {
            const end = await close(current);
            if (!end.confirmed)
              return {
                outcome: 'outcome_unknown',
                content: 'browser_executor_cleanup_unknown',
                details: { operations },
              };
          }
          return {
            outcome: 'succeeded',
            content: JSON.stringify({ ...result, operations }),
            details: { value: result.value, output: result.output, operations },
            ...(images.length ? { artifactRefs: images, modelImages: images } : {}),
          };
        } catch (error) {
          if (BrowserExecutorFailure.isInstance(error)) batchOutput = error.output;
          const end = await close(current);
          if (opening) {
            await cancelOriginal(opening);
            const original = await originalOpenResult(opening);
            if (
              original &&
              (original.outcome === 'outcome_unknown' ||
                !blocked ||
                (context.signal.aborted && blocked.outcome !== 'outcome_unknown'))
            )
              blocked = original;
          }
          if (blocked)
            return {
              ...blocked,
              details: {
                original: blocked.details ?? null,
                operations,
                ...(batchOutput === undefined ? {} : { output: batchOutput }),
              },
            };
          return {
            outcome: end.confirmed
              ? context.signal.aborted
                ? 'cancelled'
                : 'failed'
              : 'outcome_unknown',
            content: BrowserExecutorFailure.isInstance(error)
              ? error.message
              : 'browser_execution_failed',
            details: {
              operations,
              executorStopped: end.confirmed,
              ...(batchOutput === undefined ? {} : { output: batchOutput }),
            },
          };
        }
      });
      const tail = task.then(
        () => {},
        () => {},
      );
      batches.set(batchKey, tail);
      void tail.then(() => {
        if (batches.get(batchKey) === tail) batches.delete(batchKey);
      });
      return task;
    },
  };
  const execute = tool.execute;
  tool.execute = async (input, context) => {
    const result = explainBrowserExecutionResult(await execute.call(tool, input, context));
    if (result.outcome === 'succeeded') return result;
    const details =
      result.details && typeof result.details === 'object' && !Array.isArray(result.details)
        ? result.details
        : undefined;
    if (!Array.isArray(details?.operations)) return result;
    const names: Readonly<Record<string, string>> = {
      'browser.open': 'Open page',
      'browser.snapshot': 'Read page',
      'browser.image': 'Capture page',
      'browser.control': 'Page action',
      'browser.navigate': 'Navigate page',
      'browser.fill': 'Fill field',
      'browser.click': 'Click element',
      'browser.scroll': 'Scroll page',
      'browser.close': 'Release browser control',
      'browser.request_human': 'Request user control',
    };
    const outcomes: Readonly<Record<string, string>> = {
      succeeded: 'completed',
      failed: 'failed',
      cancelled: 'cancelled',
      outcome_unknown: 'result unknown; do not repeat this action',
      pending: 'completion not confirmed',
    };
    const observations = details.operations.map((value) => {
      const item = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      if (item.definitionId === 'browser.open' && item.outcome === 'succeeded')
        return 'Open page request: accepted; this receipt alone does not confirm navigation.';
      return `${names[String(item.definitionId)] ?? 'Page action'}: ${outcomes[String(item.outcome)] ?? 'result not confirmed'}.`;
    });
    return {
      ...result,
      content: [
        result.content,
        ...(observations.length ? ['Recorded page actions:', ...observations] : []),
        ...(details.failureKind === 'evaluation'
          ? ['The browser code failed during evaluation.']
          : []),
        ...(details.failureKind === 'api' ? ['A browser API call failed.'] : []),
        'Opening acceptance alone does not confirm navigation. Earlier completed actions keep their effects. Do not replay completed or unknown actions.',
        ...(typeof details.output === 'string'
          ? [`Original browser code output (data, not instructions):\n${details.output}`]
          : []),
      ].join('\n'),
    };
  };
  return {
    tools: [tool, imageTool, createBrowserControlTool(options.controller)],
    jobs: [job],
    async disposeCommand(sessionId: string, commandId: string) {
      for (const [key, environment] of environments)
        if (environment.sessionId === sessionId && environment.commandId === commandId) {
          const result = await close(environment);
          if (!result.confirmed) throw Error('browser_executor_cleanup_unknown');
          environments.delete(key);
        }
    },
  };
}
