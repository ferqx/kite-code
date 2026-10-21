import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type AgentRuntime, createRuntime } from '@kite-ai/agent';
import { createSessionTitleExtension } from '@kite-ai/agent/session-title';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import {
  readableSessionTitle,
  sessionTitleInstructions,
} from '../../../../packages/agent/src/business/session-title/title';
import { saveLiveCanonicalModelEvidence } from './live-canonical-evidence';

export type CollaborationTitleCaseId = 'S01' | 'S02' | 'S03';
export interface CollaborationTitleOptions {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly CollaborationTitleCaseId[];
  /** Exact, absent, absolute private root. One case per explicitly named root. */
  evidenceRoot?: string;
}
export interface CollaborationTitleResult {
  caseId: CollaborationTitleCaseId;
  status: 'passed' | 'failed' | 'inconclusive';
  assertions: string[];
  coverage: string[];
  providerRequests: number;
  inputProcessingRequests: number;
  namingRequests: number;
  failureCategory: 'oracle' | 'branch_not_hit' | 'aborted' | 'execution' | 'cleanup' | null;
  cleanup: 'closed' | 'failed';
  canonicalEvidenceRetained: boolean;
  canonicalModelEvidence?: { file: string; sha256: string; models: number; complete: boolean };
}

class TitleCaseBoundary extends Error {
  readonly category: 'oracle' | 'branch_not_hit';
  readonly assertion: string;
  constructor(category: 'oracle' | 'branch_not_hit', assertion: string) {
    super(assertion);
    this.category = category;
    this.assertion = assertion;
  }
}
const fields = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const isNaming = (request: ModelRequest) =>
  request.messages.some(
    (message) => message.role === 'system' && message.content === sessionTitleInstructions,
  );
const isProcessing = (request: ModelRequest) =>
  request.messages.some(
    (message) => message.role === 'system' && message.content.includes('Original input identity:'),
  );
// Independent oracle: no production title-normalization helper is used to derive expected fallback.
const fallback = (content: string) =>
  Array.from(content.replace(/\s+/gu, ' ').trim()).slice(0, 10).join('').trimEnd() || '新会话';
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, promise };
}
async function waitSignal(promise: Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  let cancel!: () => void;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        cancel = () => reject(new Error('live_title_aborted'));
        signal.addEventListener('abort', cancel, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

/** Only the caller's selected/budgeted adapter may contact a Provider. */
export async function runCollaborationTitleCases(
  options: CollaborationTitleOptions,
): Promise<CollaborationTitleResult[]> {
  const ids = options.caseIds ?? ['S01', 'S02', 'S03'];
  if (options.evidenceRoot !== undefined && (!isAbsolute(options.evidenceRoot) || ids.length !== 1))
    throw new Error('live_title_evidence_requires_absolute_new_single_case_root');
  const results: CollaborationTitleResult[] = [];
  for (const id of ids) {
    if (options.signal.aborted) break;
    results.push(await runTitleCase(id, options));
  }
  return results;
}

async function runTitleCase(
  caseId: CollaborationTitleCaseId,
  options: CollaborationTitleOptions,
): Promise<CollaborationTitleResult> {
  const result: CollaborationTitleResult = {
    caseId,
    status: 'inconclusive',
    assertions: [],
    coverage:
      caseId === 'S01'
        ? ['nonempty_unresolved_metadata', 'whitespace_public_admission']
        : caseId === 'S02'
          ? ['nonempty_clarification_business_naming_boundary']
          : ['manual_rename_after_real_naming_first_event'],
    providerRequests: 0,
    inputProcessingRequests: 0,
    namingRequests: 0,
    failureCategory: null,
    cleanup: 'closed',
    canonicalEvidenceRetained: false,
  };
  const firstRequest = options.requests().length;
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, options.signal]);
  const namingEntered = deferred(),
    namingRelease = deferred();
  const root = options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-title-'));
  if (options.evidenceRoot) {
    try {
      mkdirSync(root, { mode: 0o700 });
    } catch {
      throw new Error('live_title_evidence_new_root_creation_failed');
    }
  }
  const canonicalRoot = realpathSync(root);
  const selected = { dataRoot: join(canonicalRoot, 'data'), profile: 'live' };
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: AgentRuntime | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  const namingBoundaries: { runId: string | null; active: boolean; ordinarySucceeded: boolean }[] =
    [];
  let namingBody = '',
    pausedNaming = false;
  const assert = (condition: unknown, name: string) => {
    if (!condition) throw new TitleCaseBoundary('oracle', name);
    result.assertions.push(name);
  };
  const branch = (condition: unknown, name: string) => {
    if (!condition) throw new TitleCaseBoundary('branch_not_hit', name);
  };
  async function until<T>(read: () => Promise<T | undefined>, name: string): Promise<T> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      signal.throwIfAborted();
      const value = await read();
      if (value !== undefined) return value;
      if (Date.now() >= deadline) throw new TitleCaseBoundary('branch_not_hit', name);
      await waitSignal(new Promise<void>((resolve) => setTimeout(resolve, 20)), signal);
    }
  }
  try {
    mkdirSync(join(canonicalRoot, 'workspace'), { mode: 0o700 });
    store = await openSqliteStore(selected);
    const ownedStore = store;
    const model: ModelAdapter = {
      ...(options.model.describeRequest
        ? {
            describeRequest: options.model.describeRequest.bind(options.model),
          }
        : {}),
      async *stream(request, context) {
        const combined = AbortSignal.any([context.signal, signal]);
        const naming = isNaming(request);
        if (naming) {
          const view = await ownedStore.getView('root');
          const active = view.runs.find(
            (run) =>
              run.isActive &&
              fields(fields(run.configuration).snapshot).kind !== 'human_input_processing',
          );
          namingBoundaries.push({
            runId: active?.id ?? null,
            active: !!active,
            ordinarySucceeded:
              !!active &&
              view.executions.some(
                (execution) =>
                  execution.runId === active.id &&
                  execution.kind === 'model' &&
                  execution.status === 'succeeded',
              ),
          });
        }
        // Every event is forwarded unchanged, once, in order. S03 holds one genuine event
        // after a real naming response begins, solely to establish the manual-CAS race.
        for await (const event of options.model.stream(request, { signal: combined })) {
          if (naming && event.type === 'text_delta') {
            namingBody += event.text;
            if (caseId === 'S03' && !pausedNaming && event.text.length > 0) {
              pausedNaming = true;
              namingEntered.release();
              await waitSignal(namingRelease.promise, combined);
            }
          }
          yield event;
        }
      },
    };
    const titles = createSessionTitleExtension({
      runtime: () => {
        if (!runtime) throw new Error('live_title_runtime_not_ready');
        return runtime;
      },
      resolveModel: async () => ({ model, modelId: options.modelId, toolIds: [], snapshot: null }),
    });
    runtime = createRuntime({
      store: ownedStore,
      model,
      modelId: options.modelId,
      modelConcurrency: 2,
      extensions: [titles.extension],
      childConfigurations: [titles.childConfiguration],
      resolveChildRunConfiguration: titles.resolveChild,
      sessionInputMetadata: { preserve: (command) => titles.preserveInputFallback(command) },
      // Explicit metadata/model-only fixture, not a default authorization-policy claim.
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'owned-live-title-fixture' };
        },
      },
    });
    const expectedStoreId = (await ownedStore.getMetadata()).storeId;
    const profile = {
      dataRoot: realpathSync(selected.dataRoot),
      name: selected.profile,
      accessKey: resolveProfile(selected).profileAccessKey,
    };
    service = await startService({
      runtime,
      profile,
      buildId: 'live-collaboration-titles',
      subjectId: 'live-title-owner',
    });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: { profile, apiMajor: 1, requiredCapabilities: ['commands'] },
    });
    const ownedClient = client;
    await ownedClient.connect();
    await ownedClient.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Owned title case',
      rootUri: pathToFileURL(join(canonicalRoot, 'workspace')).href,
    });
    async function createSession(sessionId: string) {
      await ownedClient.createSession({
        expectedStoreId,
        sessionId,
        workspaceId: 'w',
        commandId: `create-${sessionId}`,
        title: '',
      });
    }
    async function start(sessionId: string, commandId: string, content: string) {
      return ownedClient.startRun(
        sessionId,
        { expectedStoreId, commandId, kind: 'run.start', content },
        { signal },
      );
    }
    async function settled(sessionId: string, commandId: string) {
      return until(async () => {
        const command = await ownedStore.getCommand(commandId);
        if (!command || fields(command.receipt).pending) return undefined;
        const receipt = fields(command.receipt);
        const directRun =
          command.status === 'applied' &&
          command.kind === 'run.start' &&
          typeof receipt.runId === 'string' &&
          receipt.humanInputCommandId === undefined &&
          receipt.decisionCommandId === undefined &&
          (await ownedStore.getRun(receipt.runId))?.originCommandId === command.id;
        if (
          !directRun &&
          !['human_input_unresolved', 'human_input_applied', 'human_input_observed'].includes(
            String(receipt.outcome),
          )
        )
          return undefined;
        if (receipt.outcome === 'human_input_applied' && typeof receipt.runId !== 'string')
          return undefined;
        const view = await ownedStore.getView(sessionId);
        return view.runs.every((run) => !run.isActive) ? command : undefined;
      }, 'public_input_did_not_settle');
    }
    const scope = (sessionId: string) => ({
      expectedStoreId,
      sessionId,
      subjectId: 'live-title-owner',
    });
    const caseRequests = () => options.requests().slice(firstRequest);
    const namingRequests = () => caseRequests().filter(isNaming);
    async function assertUnresolved(sessionId: string, commandId: string, content: string) {
      const command = await settled(sessionId, commandId);
      const receipt = fields(command.receipt);
      branch(receipt.outcome === 'human_input_unresolved', 'public_unresolved_branch_not_entered');
      const raw =
        typeof receipt.humanInputCommandId === 'string'
          ? await ownedStore.getCommand(receipt.humanInputCommandId)
          : null;
      assert(
        raw?.kind === 'human.input' && fields(raw.request).content === content,
        'first_raw_content_exact',
      );
      assert(fields(command.request).content === content, 'first_public_content_exact');
      assert(
        receipt.runId === null && receipt.businessCommandId === null,
        'unresolved_has_no_business_run',
      );
      assert(
        (await ownedStore.readHumanWorkState(scope(sessionId))).selectedWork === null,
        'unresolved_has_no_work_selection',
      );
      const view = await ownedStore.getView(sessionId);
      assert(
        view.runs.every(
          (run) => fields(fields(run.configuration).snapshot).kind === 'human_input_processing',
        ),
        'only_readonly_processing_run',
      );
      assert(
        view.executions.every((execution) => execution.kind === 'model'),
        'no_business_action_tool_job',
      );
      assert(view.session.title === fallback(content), 'exact_raw_fallback_title');
      assert(namingRequests().length === 0, 'unresolved_has_zero_naming_requests');
      return { command, raw: raw! };
    }
    await createSession('root');
    const original = ' \t> 这份配色资料还缺一项确认 🪁\r\n> 请先处理这个，不要猜测目标。  ';
    let firstRawId: string | undefined;
    if (caseId !== 'S03') {
      await start('root', 'first', original);
      const first = await assertUnresolved('root', 'first', original);
      firstRawId = first.raw.id;
      const processing = caseRequests().filter(isProcessing);
      branch(processing.length > 0, 'real_interpretation_not_observed');
      assert(
        processing.every((request) => request.tools.length === 0),
        'interpretation_tool_free',
      );
    }
    if (caseId === 'S01') {
      const before = options.requests().length;
      await ownedClient.getCommand('first', { signal });
      await ownedClient.getView('root', { signal });
      assert(options.requests().length === before, 'public_reread_zero_provider');
      await createSession('blank');
      const blank = ' \t\r\n\u3000\u00a0';
      await start('blank', 'blank-first', blank);
      await assertUnresolved('blank', 'blank-first', blank);
      assert((await ownedStore.getSession('blank'))?.title === '新会话', 'blank_visible_fallback');
    } else if (caseId === 'S02') {
      const marker = randomUUID();
      const clarification = `我现在明确回答第一条输入的澄清：那两行只是引用资料。我的任务是确认蓝色配色资料，记住合成编号 ${marker}，只回复已收到这个编号即可，不修改任何文件。`;
      await start('root', 'clarification', clarification);
      const done = await settled('root', 'clarification');
      const receipt = fields(done.receipt);
      branch(typeof receipt.runId === 'string', 'clarification_did_not_admit_business');
      const business = await ownedStore.getRun(receipt.runId as string);
      assert(business?.status === 'completed', 'clarified_business_completed');
      const originalRaw = await ownedStore.getCommand(firstRawId!);
      assert(
        fields(originalRaw?.receipt).state === 'clarified',
        'original_pending_input_clarified',
      );
      assert(
        fields(originalRaw?.receipt).clarifyingInputId === receipt.humanInputCommandId,
        'real_clarification_links_exact_first_input',
      );
      // Strict handbook oracle: a completed business without this naming attempt is a failure.
      assert(namingRequests().length === 1, 'one_naming_after_clarified_first_input');
      assert(
        namingRequests()[0]!.modelId === options.modelId && namingRequests()[0]!.tools.length === 0,
        'naming_uses_selected_adapter_binding_without_tools',
      );
      assert(
        namingBoundaries.length === 1 &&
          namingBoundaries[0]!.runId === business?.id &&
          namingBoundaries[0]!.active &&
          namingBoundaries[0]!.ordinarySucceeded,
        'naming_after_ordinary_model_before_success_cas',
      );
      const generated = (await ownedStore.getSession('root'))?.title ?? '';
      assert(
        generated.length > 0 && Array.from(generated).length <= 10 && !/[\r\n]/u.test(generated),
        'generated_title_single_line_ten_codepoints',
      );
      assert(/\p{Script=Han}/u.test(generated), 'chinese_input_has_chinese_title');
      assert(
        readableSessionTitle(namingBody) === generated,
        'saved_title_matches_real_naming_result',
      );
      const view = await ownedStore.getView('root');
      assert(
        !view.messages.some((message) => message.content === generated),
        'title_not_conversation_message',
      );
      const before = options.requests().length;
      await ownedClient.getCommand('clarification', { signal });
      await ownedClient.getView('root', { signal });
      assert(options.requests().length === before, 'completed_reread_zero_provider');
    } else {
      const content = `请确认这份合成配色资料：蓝色已经确认，编号 ${randomUUID()}。只需简短确认收到，不修改任何文件。`;
      await start('root', 'business', content);
      await until(
        async () => (pausedNaming ? true : undefined),
        'real_naming_first_event_not_reached',
      );
      // The real response event is held by the isolated wrapper, without rewriting it.
      await namingEntered.promise;
      const before = (await ownedStore.getSession('root'))!;
      await ownedClient.renameSession(
        'root',
        {
          expectedStoreId,
          commandId: 'manual',
          ifRevision: before.controlRevision,
          title: '人工确认名称',
        },
        { signal },
      );
      assert(
        (await ownedStore.getSession('root'))?.title === '人工确认名称',
        'manual_name_durable_before_naming_finish',
      );
      namingRelease.release();
      const done = await settled('root', 'business');
      const runId = fields(done.receipt).runId;
      branch(typeof runId === 'string', 'ordinary_business_run_missing');
      assert(
        (await ownedStore.getRun(runId as string))?.status === 'completed',
        'business_success_despite_title_cas_race',
      );
      branch(readableSessionTitle(namingBody) !== null, 'readable_real_title_not_returned');
      assert(namingRequests().length === 1, 'manual_race_has_one_real_naming_request');
      assert(
        (await ownedStore.getSession('root'))?.title === '人工确认名称',
        'late_real_title_cannot_overwrite_manual',
      );
      const beforeRead = options.requests().length;
      await ownedClient.getView('root', { signal });
      await ownedClient.getCommand('manual', { signal });
      assert(options.requests().length === beforeRead, 'manual_title_reread_zero_provider');
    }
    result.status = 'passed';
  } catch (error) {
    result.status =
      error instanceof TitleCaseBoundary && error.category === 'oracle' ? 'failed' : 'inconclusive';
    result.failureCategory = signal.aborted
      ? 'aborted'
      : error instanceof TitleCaseBoundary
        ? error.category
        : 'execution';
    if (error instanceof TitleCaseBoundary)
      result.assertions.push(`not_satisfied:${error.assertion}`);
  } finally {
    if (runtime && store && options.evidenceRoot) {
      try {
        result.canonicalModelEvidence = await saveLiveCanonicalModelEvidence({
          runtime,
          store,
          requests: options.requests().slice(firstRequest),
          root: canonicalRoot,
          subjectId: 'live-title-owner',
        });
        if (result.status === 'passed' && !result.canonicalModelEvidence.complete) {
          result.status = 'failed';
          result.failureCategory = 'execution';
          result.assertions.push('not_satisfied:complete_canonical_Model_inspector_evidence');
        }
      } catch {
        if (result.status === 'passed') {
          result.status = 'failed';
          result.failureCategory = 'execution';
        }
        result.assertions.push('not_satisfied:canonical_Model_inspector_evidence_not_saved');
      }
    }
    abort.abort();
    namingRelease.release();
    client?.disposeNetwork();
    let cleanupFailed = false;
    try {
      if (service) await service.close();
      else await runtime?.close();
    } catch {
      cleanupFailed = true;
      try {
        await runtime?.close();
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      await store?.close();
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) {
      result.status = 'failed';
      result.failureCategory = 'cleanup';
      result.cleanup = 'failed';
    }
    if (options.evidenceRoot) {
      result.canonicalEvidenceRetained = existsSync(canonicalRoot);
    } else {
      try {
        rmSync(canonicalRoot, { recursive: true, force: true });
      } catch {
        result.status = 'failed';
        result.failureCategory = 'cleanup';
        result.cleanup = 'failed';
        result.canonicalEvidenceRetained = !!options.evidenceRoot && existsSync(canonicalRoot);
      }
    }
    const requests = options.requests().slice(firstRequest);
    result.providerRequests = requests.length;
    result.namingRequests = requests.filter(isNaming).length;
    result.inputProcessingRequests = requests.filter(isProcessing).length;
  }
  return result;
}
