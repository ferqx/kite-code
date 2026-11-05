import { randomUUID } from 'node:crypto';
import { registerBrowserSessionSource } from '../../execution/host-control';
import type {
  JobContext,
  JobEvent,
  JobHandle,
  Json,
  StopConfirmation,
  ToolResult,
} from '../../extensions';
import { canonicalJson } from '../../json';
import type { AgentRuntime } from '../../runtime';
import {
  BrowserTransportError,
  createNativeBrowserTransport,
  type NativeBrowserTransport,
  type NativeBrowserTransportOptions,
} from './native';
import { browserPressKeyPattern } from './page-api';
import {
  asJson,
  type BrowserAnnotation,
  type BrowserCommand,
  type BrowserController,
  type BrowserControlOperation,
  type BrowserElement,
  type BrowserReleasedPage,
  type BrowserSharedPageIdentity,
  type BrowserTarget,
  type BrowserView,
  browserJobId,
} from './types';

const object = (value: unknown): Record<string, Json> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
const failed = (code: string): ToolResult => ({
  outcome: 'failed',
  content: code,
  details: { code },
});
const transportCode = (error: unknown, fallback: string) =>
  error instanceof BrowserTransportError && /^[a-z][a-z0-9_]{1,127}$/.test(error.message)
    ? error.message
    : fallback;
// The paired host confirms these acquire denials happened before any page lease.
// Do not apply this allowlist after transport readiness or to dispatched failures.
const startupAdmissionErrors = new Set([
  'browser_page_explicit_grant_required',
  'browser_page_grant_changed',
  'page_request_invalid',
  'browser_page_capacity',
]);
const startupErrors = new Set([
  ...startupAdmissionErrors,
  'browser_startup_failed',
  'browser_page_existing_mismatch',
  'browser_runtime_unavailable',
  'browser_control_released',
]);
function closedStartupFailure(view: BrowserView | undefined, target: BrowserTarget) {
  return view?.browserId === target.browserId &&
    view.generation === target.generation &&
    view.state === 'unavailable' &&
    view.error &&
    startupErrors.has(view.error)
    ? failed(view.error)
    : undefined;
}
const unknown = (code: string, cause?: string): ToolResult => ({
  outcome: 'outcome_unknown',
  content: `${code}.${cause ? ` Diagnostic cause: ${cause}.` : ''} The original action must not be retried; inspect this browser or close it.`,
  details: { code, ...(cause ? { cause } : {}) },
});
const succeeded = (details: Json): ToolResult => ({
  outcome: 'succeeded',
  content: canonicalJson(details),
  details,
});
const publicStatus = (view: BrowserView) => ({
  browserId: view.browserId,
  generation: view.generation,
  seq: view.seq,
  state: view.state,
  url: view.url,
  title: view.title,
  annotations: view.annotations,
  selectedAnnotation: view.selectedAnnotation,
  ...(view.error ? { error: view.error } : {}),
  ...(view.state === 'human' && view.humanRequest ? { humanRequest: view.humanRequest } : {}),
});
interface Session {
  view: BrowserView;
  context: JobContext;
  transport?: NativeBrowserTransport;
  abort: AbortController;
  ready: Promise<void>;
  tail: Promise<void>;
  terminal?: JobEvent & { type: 'terminal' };
  wake?: () => void;
  observed: boolean;
  stopping?: Promise<StopConfirmation>;
  timer?: ReturnType<typeof setTimeout>;
  frames: number;
  previewAt: number;
  previewing: boolean;
  uncertain: boolean;
  startupFailure?: string;
  startupDiagnostic?: { phase: 'navigation'; cause?: string; dispatched?: boolean };
  transportFailure?: string;
  enteredAgent?: true;
  recoveryObservationRequired?: true;
  transportAvailable: Promise<void>;
  startupInterrupted?: boolean;
  disposal?: Promise<void>;
  released?: true;
  sharedPageBound?: true;
  sharedPageIdentity?: BrowserSharedPageIdentity;
  owner?: {
    runId: string;
    storeId: string;
    commandId: string;
    rootWorkCommandId: string;
    rootWorkSeq: string;
    selectionId: string;
    subjectId: string;
  };
  queued: number;
  refs: Set<string>;
  removeAbort: () => void;
  controlListeners: Set<() => void>;
  observationMode: 'preview' | 'on-demand';
  semanticRefs: Map<string, BrowserElement>;
}
/** The injectable transport is trusted test/host assembly, never Extension input. */
export function createBrowserController(options: {
  createTransport(
    context: JobContext,
    binding: { browserId: string; generation: string; url: string },
  ): NativeBrowserTransport;
  sharedPage?: true;
  captureIntervalMs?: number;
  /** Trusted Job/Run selection, never a public Tool parameter. */
  observationMode?: (context: JobContext) => Promise<'preview' | 'on-demand'>;
  /** Trusted assembly only. The original Browser Job owns its Run-bound lease. */
  runtime?: () => Pick<AgentRuntime, 'getExecution' | 'getRun' | 'getCommand'>;
}): BrowserController {
  const sessions = new Map<string, Session>();
  const closedViews = new Map<
    string,
    {
      view: BrowserView;
      releasedRunId?: string;
      sharedPageBound?: true;
      sharedPageIdentity?: BrowserSharedPageIdentity;
      cleanupConfirmed?: true;
      recovery?: {
        page: BrowserReleasedPage;
        owner: NonNullable<Session['owner']>;
        activated?: true;
      };
    }
  >();
  const releasedPages = new Map<string, BrowserReleasedPage[]>();
  const canonicalUrl = (value: string) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        ? url.href
        : undefined;
    } catch {
      return undefined;
    }
  };
  const copyReleased = (page: BrowserReleasedPage): BrowserReleasedPage => ({
    url: page.url,
    title: page.title,
    ...(page.identity ? { identity: { ...page.identity } } : {}),
    ...(page.observationRequired ? { observationRequired: true } : {}),
  });
  const rememberPage = (sessionId: string, page: BrowserReleasedPage) => {
    const identity = page.identity;
    const pages = (releasedPages.get(sessionId) ?? []).filter(
      (page) =>
        !identity ||
        page.identity?.pageId !== identity.pageId ||
        page.identity.incarnation !== identity.incarnation,
    );
    pages.push(copyReleased(page));
    releasedPages.delete(sessionId);
    releasedPages.set(sessionId, pages.slice(-8));
    if (releasedPages.size > 128) releasedPages.delete(releasedPages.keys().next().value!);
  };
  const rememberReleased = (state: Session) => {
    if (state.view.state !== 'closed' || !state.sharedPageBound) return;
    const url = canonicalUrl(state.view.url);
    if (!url) return;
    rememberPage(state.context.sessionId, {
      url,
      title: state.view.title.slice(0, 256),
      ...(state.sharedPageIdentity ? { identity: { ...state.sharedPageIdentity } } : {}),
      ...(state.recoveryObservationRequired ? { observationRequired: true } : {}),
    });
  };
  const knownReleased = (sessionId: string) => {
    const current = sessions.get(sessionId) ?? closedViews.get(sessionId);
    return current?.view.state === 'outcome_unknown' &&
      !closedViews.get(sessionId)?.recovery?.activated
      ? []
      : (releasedPages.get(sessionId) ?? []);
  };
  const releasedPage = (sessionId: string, url?: string) => {
    const recovery = closedViews.get(sessionId)?.recovery;
    if (url !== undefined) {
      if (recovery && !recovery.activated) throw Error('browser_page_recovery_required');
      const required = (releasedPages.get(sessionId) ?? []).filter(
        (page) => page.observationRequired,
      );
      if (required.length && !required.some((page) => page.url === canonicalUrl(url)))
        throw Error('browser_page_recovery_required');
    }
    if (url === undefined) {
      const state = sessions.get(sessionId) ?? closedViews.get(sessionId);
      if (state?.view.state === 'outcome_unknown' && recovery?.activated)
        return (
          knownReleased(sessionId)
            .filter(
              (page) =>
                page.identity?.pageId === recovery.page.identity?.pageId &&
                page.identity?.incarnation === recovery.page.identity?.incarnation,
            )
            .map(copyReleased)[0] ?? null
        );
      if (state?.view.state !== 'closed' || !state.sharedPageBound) return null;
      // A trusted missing-page receipt can retire this exact metadata without
      // changing the old closed view, Run fence or durable lifetime result.
      if (
        !knownReleased(sessionId).some((page) =>
          state.sharedPageIdentity
            ? page.identity?.pageId === state.sharedPageIdentity.pageId &&
              page.identity.incarnation === state.sharedPageIdentity.incarnation
            : page.url === canonicalUrl(state.view.url),
        )
      )
        return null;
      return {
        url: state.view.url.slice(0, 8192),
        title: state.view.title.slice(0, 256),
        ...(state.sharedPageIdentity ? { identity: { ...state.sharedPageIdentity } } : {}),
      };
    }
    const normalized = canonicalUrl(url);
    if (!normalized) return null;
    const matches = knownReleased(sessionId).filter((page) => page.url === normalized);
    if (matches.length > 1) throw Error('browser_page_existing_ambiguous');
    return matches[0] ? copyReleased(matches[0]) : null;
  };
  const handles = new WeakMap<JobHandle, Session>();
  const interval = options.captureIntervalMs ?? 300;
  if (!Number.isSafeInteger(interval) || interval < 100 || interval > 60000)
    throw Error('browser_capture_interval_invalid');
  const advance = (state: Session) => {
    state.view.seq = String(BigInt(state.view.seq) + 1n);
  };
  const invalidate = (state: Session) => {
    state.refs.clear();
    state.semanticRefs.clear();
    state.view.annotations = [];
    state.view.selectedAnnotation = null;
    advance(state);
  };
  const terminal = (state: Session, result: ToolResult, confirmed: boolean) => {
    if (state.terminal) return;
    if (state.timer) clearTimeout(state.timer);
    state.removeAbort();
    state.view.state =
      result.outcome === 'outcome_unknown' || !confirmed
        ? 'outcome_unknown'
        : result.outcome === 'failed'
          ? 'unavailable'
          : 'closed';
    state.view.frame = null;
    delete state.view.humanRequest;
    invalidate(state);
    state.terminal = {
      type: 'terminal',
      result: state.startupDiagnostic
        ? { ...result, details: { ...object(result.details), startup: state.startupDiagnostic } }
        : result,
      supervision: confirmed ? 'ended' : 'unknown',
    };
    rememberReleased(state);
    for (const wake of [...state.controlListeners]) wake();
    state.wake?.();
  };
  const serial = async <T>(state: Session, run: () => Promise<T>): Promise<T> => {
    state.queued++;
    const before = state.tail;
    let release!: () => void;
    state.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    try {
      return await run();
    } finally {
      state.queued--;
      release();
    }
  };
  const get = (sessionId: string, target: BrowserTarget) => {
    const state = sessions.get(sessionId);
    return state &&
      state.view.browserId === target.browserId &&
      state.view.generation === target.generation
      ? state
      : undefined;
  };
  const stop = (state: Session): Promise<StopConfirmation> => {
    if (state.stopping) return state.stopping;
    state.released = true;
    state.view.state = state.uncertain ? 'outcome_unknown' : 'closing';
    invalidate(state);
    for (const wake of [...state.controlListeners]) wake();
    if (state.timer) clearTimeout(state.timer);
    state.abort.abort();
    state.stopping = (async () => {
      if (!state.transport) {
        terminal(
          state,
          state.uncertain
            ? unknown('browser_action_outcome_unknown')
            : { outcome: 'cancelled', content: 'Browser stopped before startup.' },
          true,
        );
        return { status: 'stopped' };
      }
      try {
        const closed = await state.transport.close();
        const confirmed = closed.confirmed;
        await state.ready;
        await state.tail;
        terminal(
          state,
          state.uncertain || !confirmed
            ? unknown(
                confirmed
                  ? (state.view.error ?? 'browser_action_outcome_unknown')
                  : 'browser_stop_unconfirmed',
                state.transportFailure,
              )
            : state.startupFailure
              ? failed(state.startupFailure)
              : {
                  outcome: 'cancelled',
                  content: 'Managed browser stopped; owned process-tree cleanup confirmed.',
                },
          confirmed,
        );
        return { status: confirmed ? 'stopped' : 'unknown' };
      } catch {
        terminal(state, unknown('browser_stop_unconfirmed', state.transportFailure), false);
        return { status: 'unknown' };
      }
    })();
    return state.stopping;
  };
  const lose = (
    state: Session,
    code: string,
    startup?: Session['startupDiagnostic'],
    cause?: string,
  ) => {
    if (startup) state.startupDiagnostic = startup;
    if (cause) state.transportFailure = cause;
    delete state.view.humanRequest;
    state.uncertain = true;
    state.view.state = 'outcome_unknown';
    state.view.error = code;
    for (const wake of [...state.controlListeners]) wake();
    invalidate(state);
    void stop(state);
  };
  const refresh = async (state: Session, signal = state.abort.signal, current?: () => boolean) => {
    if (!state.transport || state.abort.signal.aborted || state.recoveryObservationRequired) return;
    state.previewAt = performance.now();
    state.previewing = true;
    try {
      const captured = await state.transport.capture(AbortSignal.any([signal, state.abort.signal]));
      if (
        signal.aborted ||
        current?.() === false ||
        state.abort.signal.aborted ||
        !['agent', 'human', 'pausing', 'starting'].includes(state.view.state)
      )
        return;
      const annotations: BrowserAnnotation[] = captured.annotations.slice(0, 200);
      if (
        (captured.url !== undefined && captured.url !== state.view.url) ||
        (captured.title !== undefined && captured.title !== state.view.title) ||
        canonicalJson(asJson(annotations)) !== canonicalJson(asJson(state.view.annotations))
      ) {
        advance(state);
        state.view.selectedAnnotation = null;
      }
      if (captured.url !== undefined) state.view.url = captured.url;
      if (captured.title !== undefined) state.view.title = captured.title;
      state.view.annotations = annotations;
      state.refs = new Set(annotations.map((annotation) => annotation.ref.replace(/^@/, '')));
      state.view.frame = { ...captured.frame, seq: String(++state.frames) };
      if (state.view.error === 'browser_frame_unavailable') delete state.view.error;
    } catch {
      // Observation failure never retries the preceding effect or fabricates a fresh image.
      state.view.frame = null;
      invalidate(state);
      state.view.error = 'browser_frame_unavailable';
    } finally {
      state.previewing = false;
    }
  };
  const ownerState = async (state: Pick<Session, 'owner'> & { context: { sessionId: string } }) => {
    if (!state.owner) return undefined;
    const owner = state.owner,
      host = options.runtime!(),
      run = await host.getRun(owner.runId),
      command = await host.getCommand(owner.commandId);
    if (
      run?.id !== owner.runId ||
      run.sessionId !== state.context.sessionId ||
      run.originStoreId !== owner.storeId ||
      run.originCommandId !== owner.commandId ||
      run.rootWorkCommandId !== owner.rootWorkCommandId ||
      run.rootWorkSeq !== owner.rootWorkSeq ||
      run.contextSelectionId !== owner.selectionId ||
      command?.id !== owner.commandId ||
      command.originStoreId !== owner.storeId ||
      command.subjectId !== owner.subjectId
    )
      throw Error('browser_owner_run_unverifiable');
    return { run, command };
  };
  const ownerCurrent = async (state: Session) => {
    const current = await ownerState(state);
    return !current || (current.run.isActive && current.command.cancelRequestedAt === null);
  };
  const ownerEnded = async (state: Pick<Session, 'owner'> & { context: { sessionId: string } }) => {
    const current = await ownerState(state);
    return (
      current !== undefined &&
      !current.run.isActive &&
      ['completed', 'failed', 'cancelled'].includes(current.run.status)
    );
  };
  const schedule = (state: Session) => {
    if (
      (state.observationMode === 'on-demand' && !state.owner) ||
      state.terminal ||
      state.stopping ||
      state.abort.signal.aborted
    )
      return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(
      () => {
        state.timer = undefined;
        void (async () => {
          if (state.owner) {
            let valid = false;
            try {
              valid = await ownerCurrent(state);
            } catch {
              state.view.error = 'browser_owner_run_unverifiable';
            }
            if (!valid) {
              void stop(state);
              return;
            }
          }
          if (
            state.observationMode === 'preview' &&
            !state.previewing &&
            state.queued < 16 &&
            performance.now() - state.previewAt >= interval
          )
            await serial(state, async () => {
              if (['agent', 'human'].includes(state.view.state)) await refresh(state);
            });
        })().finally(() => schedule(state));
      },
      state.owner ? Math.min(interval, 300) : interval,
    );
  };
  const bindOwner = async (context: JobContext): Promise<Session['owner']> => {
    if (!options.runtime) return;
    const host = options.runtime(),
      own = await host.getExecution(context.executionId);
    if (
      own?.id !== context.executionId ||
      own.kind !== 'job' ||
      own.definitionId !== browserJobId ||
      own.definitionVersion !== '1' ||
      own.sessionId !== context.sessionId
    )
      throw Error('browser_owner_source_invalid');
    const command = await host.getCommand(own.originCommandId);
    if (
      !command ||
      command.originStoreId !== own.originStoreId ||
      command.cancelRequestedAt !== null
    )
      throw Error('browser_owner_source_invalid');
    let current = own;
    const seen = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      if (
        seen.has(current.id) ||
        current.originStoreId !== own.originStoreId ||
        current.sessionId !== own.sessionId ||
        current.rootWorkCommandId !== own.rootWorkCommandId ||
        current.rootWorkSeq !== own.rootWorkSeq ||
        current.cancelRequestedAt !== null ||
        !['planned', 'dispatching', 'running', 'succeeded'].includes(current.status)
      )
        throw Error('browser_owner_source_invalid');
      seen.add(current.id);
      const source = await host.getCommand(current.originCommandId);
      if (
        !source ||
        source.originStoreId !== own.originStoreId ||
        source.subjectId !== command.subjectId ||
        source.cancelRequestedAt !== null
      )
        throw Error('browser_owner_source_invalid');
      if (current.runId) {
        const run = await host.getRun(current.runId);
        if (
          !run?.isActive ||
          run.originStoreId !== own.originStoreId ||
          run.sessionId !== own.sessionId ||
          run.originCommandId !== current.originCommandId ||
          run.rootWorkCommandId !== own.rootWorkCommandId ||
          run.rootWorkSeq !== own.rootWorkSeq
        )
          throw Error('browser_owner_source_invalid');
        return {
          runId: run.id,
          storeId: run.originStoreId,
          commandId: run.originCommandId,
          rootWorkCommandId: run.rootWorkCommandId,
          rootWorkSeq: run.rootWorkSeq,
          selectionId: run.contextSelectionId,
          subjectId: source.subjectId,
        };
      }
      if (!current.parentExecutionId) return;
      const parent = await host.getExecution(current.parentExecutionId);
      if (parent?.kind !== 'tool') throw Error('browser_owner_source_invalid');
      current = parent;
    }
    throw Error('browser_owner_source_invalid');
  };
  const response = async (state: Session, input: Record<string, Json>, signal: AbortSignal) => {
    if (!state.transport) throw Error('browser_transport_unavailable');
    const answer = object(await state.transport.request(input, signal));
    if (answer.success !== true || object(answer.data).confirmation_required === true) {
      const diagnostic = typeof answer.code === 'string' ? answer.code : answer.error;
      // A daemon response is a diagnostic, never proof that no page effect was
      // dispatched. Only the trusted transport can establish that boundary.
      throw new BrowserTransportError(
        typeof diagnostic === 'string' && /^[a-z][a-z0-9_]{1,127}$/.test(diagnostic)
          ? diagnostic
          : 'browser_native_action_failed',
        true,
      );
    }
    return object(answer.data);
  };
  const disposeState = (state: Session) =>
    (state.disposal ??= (async () => {
      if (state.terminal?.supervision !== 'ended') throw Error('browser_cleanup_unconfirmed');
      await state.ready;
      await state.tail;
      await state.transport?.dispose();
      let recovery: { page: BrowserReleasedPage; owner: NonNullable<Session['owner']> } | undefined;
      if (
        options.sharedPage &&
        state.transport?.sharedPage &&
        state.startupDiagnostic?.phase === 'navigation' &&
        state.uncertain &&
        !state.enteredAgent &&
        state.owner &&
        state.sharedPageIdentity
      ) {
        try {
          const page = state.transport.releasedSharedPage?.();
          const url =
            typeof page?.url === 'string' && page.url.length <= 8192
              ? canonicalUrl(page.url)
              : undefined;
          if (
            url &&
            typeof page?.title === 'string' &&
            page.title.length <= 256 &&
            page.identity?.pageId === state.sharedPageIdentity.pageId &&
            page.identity.incarnation === state.sharedPageIdentity.incarnation
          )
            recovery = {
              page: {
                url,
                title: page.title,
                identity: { ...state.sharedPageIdentity },
                observationRequired: true,
              },
              owner: { ...state.owner },
            };
        } catch {
          // Missing passive metadata cannot prove recovery. It does not undo a
          // separately confirmed transport disposal or invent a cleanup failure.
        }
      }
      state.removeAbort();
      if (sessions.get(state.context.sessionId) === state) {
        sessions.delete(state.context.sessionId);
        closedViews.delete(state.context.sessionId);
        closedViews.set(state.context.sessionId, {
          view: structuredClone(state.view),
          ...(state.sharedPageBound ? { sharedPageBound: true } : {}),
          ...(state.sharedPageIdentity
            ? { sharedPageIdentity: { ...state.sharedPageIdentity } }
            : {}),
          ...(state.released && state.owner ? { releasedRunId: state.owner.runId } : {}),
          cleanupConfirmed: true,
          ...(recovery ? { recovery } : {}),
        });
        if (closedViews.size > 128) closedViews.delete(closedViews.keys().next().value!);
      }
    })());
  const prepareOwner = async (sessionId: string, runId?: string): Promise<void> => {
    const prior = sessions.get(sessionId);
    if (!prior) {
      const closed = closedViews.get(sessionId);
      if (runId !== undefined && closed?.releasedRunId === runId)
        throw Error('browser_control_released');
      if (closed?.view.state === 'outcome_unknown') {
        if (
          !closed.cleanupConfirmed ||
          !closed.recovery ||
          !(await ownerEnded({ owner: closed.recovery.owner, context: { sessionId } }))
        )
          throw Error('browser_previous_cleanup_unconfirmed');
        if (!closed.recovery.activated) {
          rememberPage(sessionId, closed.recovery.page);
          closed.recovery.activated = true;
        } else if (
          !(releasedPages.get(sessionId) ?? []).some(
            (page) =>
              page.identity?.pageId === closed.recovery!.page.identity?.pageId &&
              page.identity?.incarnation === closed.recovery!.page.identity?.incarnation,
          )
        )
          throw Error('browser_previous_cleanup_unconfirmed');
      }
      return;
    }
    if (prior.uncertain || prior.terminal?.result.outcome === 'outcome_unknown') {
      if (
        !options.sharedPage ||
        !prior.transport?.sharedPage ||
        prior.startupDiagnostic?.phase !== 'navigation' ||
        prior.enteredAgent ||
        !prior.owner ||
        !(await ownerEnded(prior))
      )
        throw Error('browser_previous_cleanup_unconfirmed');
      if (runId === prior.owner.runId) throw Error('browser_control_released');
      const ended = await stop(prior);
      if (ended.status !== 'stopped') throw Error('browser_previous_cleanup_unconfirmed');
      try {
        await disposeState(prior);
      } catch {
        throw Error('browser_previous_cleanup_unconfirmed');
      }
      await prepareOwner(sessionId, runId);
      return;
    }
    if (runId !== undefined && prior.released && prior.owner?.runId === runId)
      throw Error('browser_control_released');
    if (!prior.owner) return;
    let active: boolean;
    try {
      active = await ownerCurrent(prior);
    } catch {
      throw Error('browser_owner_run_unverifiable');
    }
    if (active) {
      if (runId !== undefined && runId !== prior.owner.runId)
        throw Error('browser_session_already_owned');
      return;
    }
    const ended = await stop(prior);
    if (ended.status !== 'stopped' || prior.uncertain)
      throw Error('browser_previous_cleanup_unconfirmed');
    await disposeState(prior);
    if (sessions.has(sessionId)) throw Error('browser_session_already_owned');
    if (runId === prior.owner.runId) throw Error('browser_control_released');
  };
  const job: BrowserController['job'] = {
    id: browserJobId,
    version: '1',
    description: options.sharedPage
      ? 'Own the automation daemon and a revocable lease of one Native browser page; the Native page owner retains the renderer.'
      : 'Own one isolated agent-browser lifetime and its complete supervised process tree.',
    inputSchema: {
      type: 'object',
      properties: {
        browserId: { type: 'string', minLength: 1, maxLength: 128 },
        url: { type: 'string', minLength: 1, maxLength: 8192 },
      },
      required: ['browserId', 'url'],
      additionalProperties: false,
    },
    resources: { slot: 'process' },
    async start(input, context) {
      const value = object(input);
      if (typeof value.browserId !== 'string' || typeof value.url !== 'string')
        throw Error('browser_invalid_arguments');
      const destination = new URL(value.url);
      if (
        !['http:', 'https:'].includes(destination.protocol) ||
        destination.username ||
        destination.password
      )
        throw Error('browser_url_denied');
      // Backstop for legacy direct open. Code execution calls the same barrier
      // before reserving its process slot, so a prior Run cannot occupy both slots.
      await prepareOwner(context.sessionId);
      if (sessions.has(context.sessionId)) throw Error('browser_session_already_owned');
      const released = closedViews.get(context.sessionId);
      const previouslyReleasedRun = released?.releasedRunId;
      const existingOnly = options.sharedPage
        ? releasedPage(context.sessionId, destination.href)
        : null;
      if (sessions.size >= 8) throw Error('browser_session_capacity');
      let transportAvailable!: () => void;
      const state: Session = {
        view: {
          browserId: value.browserId,
          generation: randomUUID(),
          seq: '1',
          state: 'starting',
          url: value.url,
          title: '',
          frame: null,
          annotations: [],
          selectedAnnotation: null,
        },
        context,
        abort: new AbortController(),
        ready: Promise.resolve(),
        transportAvailable: new Promise<void>((resolve) => {
          transportAvailable = resolve;
        }),
        tail: Promise.resolve(),
        observed: false,
        uncertain: false,
        queued: 0,
        frames: 0,
        previewAt: 0,
        previewing: false,
        refs: new Set(),
        removeAbort: () => {},
        controlListeners: new Set(),
        observationMode: 'preview',
        semanticRefs: new Map(),
        ...(existingOnly?.observationRequired ? { recoveryObservationRequired: true } : {}),
      };
      const handle: JobHandle = {
        reference: {
          browserId: value.browserId,
          generation: state.view.generation,
          sessionId: context.sessionId,
        },
      };
      sessions.set(context.sessionId, state);
      closedViews.delete(context.sessionId);
      handles.set(handle, state);
      const abort = () => {
        void stop(state);
      };
      context.signal.addEventListener('abort', abort, { once: true });
      state.removeAbort = () => context.signal.removeEventListener('abort', abort);
      // A lifetime handle exists before any owned process acquisition, including failed startup.
      state.ready = (async () => {
        let navigationIssued = false,
          navigationAcknowledged = false,
          transportReady = false;
        try {
          context.signal.throwIfAborted();
          state.observationMode = (await options.observationMode?.(context)) ?? 'preview';
          if (!['preview', 'on-demand'].includes(state.observationMode))
            throw Error('browser_observation_mode_invalid');
          state.owner = await bindOwner(context);
          if (state.owner?.runId === previouslyReleasedRun && previouslyReleasedRun !== undefined) {
            state.released = true;
            state.startupFailure = 'browser_control_released';
            throw Error('browser_control_released');
          }
          if (state.owner) schedule(state);
          context.signal.throwIfAborted();
          state.transport = options.createTransport(context, {
            browserId: state.view.browserId,
            generation: state.view.generation,
            url: state.view.url,
          });
          transportAvailable();
          void state.transport.completion.then(async (end) => {
            await state.ready;
            await state.tail;
            if (!state.stopping && !state.terminal)
              terminal(
                state,
                end.confirmed
                  ? { outcome: 'succeeded', content: 'Managed browser lifetime ended.' }
                  : unknown('browser_process_outcome_unknown'),
                end.confirmed,
              );
          });
          await state.transport.ready;
          transportReady = true;
          if (options.sharedPage && state.transport.sharedPage) {
            const identity = state.transport.sharedPageIdentity?.();
            if (
              identity &&
              [identity.pageId, identity.incarnation].every(
                (value) => typeof value === 'string' && value.length > 0 && value.length <= 128,
              )
            )
              state.sharedPageIdentity = {
                pageId: identity.pageId,
                incarnation: identity.incarnation,
              };
          }
          if (existingOnly) {
            const acquired = state.transport.sharedPageIdentity?.();
            if (
              !existingOnly.identity ||
              acquired?.pageId !== existingOnly.identity.pageId ||
              acquired.incarnation !== existingOnly.identity.incarnation
            )
              throw new BrowserTransportError('browser_page_existing_mismatch', false);
          }
          if (state.startupInterrupted) return;
          state.abort.signal.throwIfAborted();
          await response(
            state,
            { action: 'launch', headless: true, engine: 'chrome', webmcp: false },
            state.abort.signal,
          );
          if (state.startupInterrupted) return;
          if (!state.transport.sharedPage)
            await response(
              state,
              { action: 'viewport', width: 960, height: 540, deviceScaleFactor: 1, mobile: false },
              state.abort.signal,
            );
          if (state.startupInterrupted) return;
          const existing = state.transport.sharedPage
            ? await response(state, { action: 'url' }, state.abort.signal)
            : {};
          if (state.startupInterrupted) return;
          const samePage =
            typeof existing.url === 'string' && new URL(existing.url).href === destination.href;
          if (existingOnly && !samePage)
            throw new BrowserTransportError('browser_page_existing_mismatch', false);
          let data = existing;
          if (!samePage) {
            navigationIssued = true;
            data = await response(
              state,
              { action: 'navigate', url: value.url!, waitUntil: 'domcontentloaded' },
              state.abort.signal,
            );
            navigationAcknowledged = true;
          }
          if (state.startupInterrupted) return;
          if (typeof data.url === 'string') state.view.url = data.url.slice(0, 8192);
          if (typeof data.title === 'string') state.view.title = data.title.slice(0, 512);
          state.abort.signal.throwIfAborted();
          state.view.state = 'agent';
          state.enteredAgent = true;
          if (options.sharedPage && state.transport.sharedPage) {
            state.sharedPageBound = true;
          }
          advance(state);
          if (state.observationMode === 'preview') await refresh(state);
          schedule(state);
        } catch (error) {
          // The explicit handoff owns this transition. Its transport confirms
          // revocation/drain before publishing human control; an interrupted
          // startup must not overwrite that transition with a second close.
          if (
            state.startupInterrupted &&
            (state.view.state === 'pausing' || state.view.state === 'human')
          )
            return;
          const admissionError =
            error instanceof BrowserTransportError &&
            error.dispatched === false &&
            ((!transportReady && startupAdmissionErrors.has(error.message)) ||
              (existingOnly && error.message === 'browser_page_existing_mismatch'))
              ? error.message
              : undefined;
          if (!state.transport) {
            if (context.signal.aborted)
              terminal(
                state,
                { outcome: 'cancelled', content: 'Browser cancelled before startup.' },
                true,
              );
            else {
              state.startupFailure ??= admissionError ?? 'browser_runtime_unavailable';
              state.view.error = state.startupFailure;
              terminal(state, failed(state.startupFailure), true);
            }
          } else if (
            navigationIssued &&
            !navigationAcknowledged &&
            !(error instanceof BrowserTransportError && error.dispatched === false)
          ) {
            lose(state, 'browser_startup_outcome_unknown', {
              phase: 'navigation',
              ...(error instanceof BrowserTransportError &&
              /^[a-z][a-z0-9_]{1,127}$/.test(error.message)
                ? { cause: error.message, dispatched: error.dispatched }
                : {}),
            });
          } else if (!state.stopping) {
            state.startupFailure = admissionError ?? 'browser_startup_failed';
            state.view.error = state.startupFailure;
            void stop(state);
          }
        } finally {
          transportAvailable();
        }
      })();
      if (context.signal.aborted) abort();
      return handle;
    },
    async *observe(handle) {
      const state = handles.get(handle);
      if (!state || state.observed) throw Error('browser_handle_invalid');
      state.observed = true;
      yield { type: 'progress', value: asJson(publicStatus(state.view)) };
      while (!state.terminal)
        await new Promise<void>((resolve) => {
          state.wake = resolve;
          if (state.terminal) resolve();
        });
      yield state.terminal;
    },
    async cancel(handle) {
      const state = handles.get(handle);
      if (!state) throw Error('browser_handle_invalid');
      return stop(state);
    },
    async dispose(handle) {
      const state = handles.get(handle);
      if (!state) throw Error('browser_handle_invalid');
      await disposeState(state);
      handles.delete(handle);
    },
  };
  const semanticSnapshot = (data: Record<string, Json>) => {
    if (
      typeof data.snapshot !== 'string' ||
      !data.refs ||
      typeof data.refs !== 'object' ||
      Array.isArray(data.refs)
    )
      throw Error('browser_snapshot_invalid');
    const byRef = new Map<string, BrowserElement>();
    for (const [ref, raw] of Object.entries(data.refs)) {
      const value = object(raw);
      if (
        !/^e[1-9][0-9]{0,12}$/.test(ref) ||
        typeof value.role !== 'string' ||
        value.role.length > 128 ||
        typeof value.name !== 'string'
      )
        throw Error('browser_snapshot_invalid');
      byRef.set(ref, { ref: `@${ref}`, role: value.role, name: value.name.slice(0, 1000) });
    }
    // JSON object order is not page order. Prefer the snapshot's actual traversal
    // before clipping; descriptive markers without backend metadata grant no ref.
    const ordered = new Set<string>();
    for (const match of data.snapshot.matchAll(/\[ref=(e[1-9][0-9]{0,12})\]/g))
      if (byRef.has(match[1]!)) ordered.add(match[1]!);
    // Some backends also supply refs omitted from their text. Keep that metadata
    // compatible, but deterministic, after the refs with known document order.
    for (const ref of [...byRef.keys()].sort()) ordered.add(ref);
    const elements = [...ordered].slice(0, 200).map((ref) => byRef.get(ref)!);
    return {
      elements,
      snapshot: data.snapshot.slice(0, 65536),
      truncated: data.snapshot.length > 65536 || Object.keys(data.refs).length > 200,
    };
  };
  const recoveredObservation = (state: Session) => {
    if (!state.recoveryObservationRequired) return;
    delete state.recoveryObservationRequired;
    const identity = state.sharedPageIdentity;
    const pages = releasedPages.get(state.context.sessionId);
    if (!identity || !pages) return;
    releasedPages.set(
      state.context.sessionId,
      pages.map((page) =>
        page.identity?.pageId === identity.pageId &&
        page.identity.incarnation === identity.incarnation
          ? { url: page.url, title: page.title, identity: { ...identity } }
          : page,
      ),
    );
  };
  const dispatch = async (
    sessionId: string,
    target: BrowserTarget,
    command: BrowserCommand | BrowserControlOperation,
    signal: AbortSignal,
    human = false,
    semantic = false,
  ): Promise<ToolResult> => {
    if (
      (command.action === 'press' && !new RegExp(browserPressKeyPattern).test(command.key)) ||
      (command.action === 'wait' &&
        (!Number.isInteger(command.timeoutMs) ||
          command.timeoutMs < 1 ||
          command.timeoutMs > 10000 ||
          !command.text ||
          command.text.length > 1024)) ||
      (command.action === 'select' &&
        (!Array.isArray(command.values) ||
          !command.values.length ||
          command.values.length > 16 ||
          command.values.some((value) => typeof value !== 'string' || value.length > 1024)))
    )
      return failed('browser_control_arguments_invalid');
    const state = get(sessionId, target);
    if (!state)
      return (
        closedStartupFailure(closedViews.get(sessionId)?.view, target) ??
        failed('browser_stale_or_foreign_target')
      );
    await state.ready;
    if (state.startupFailure) {
      if (signal.aborted)
        return { outcome: 'cancelled', content: 'Browser action cancelled before dispatch.' };
      await state.stopping;
      if (state.terminal) return structuredClone(state.terminal.result);
    }
    if (state.queued >= 16) return failed('browser_command_capacity');
    return serial(state, async () => {
      if (signal.aborted)
        return { outcome: 'cancelled', content: 'Browser action cancelled before dispatch.' };
      if (get(sessionId, target) !== state || state.view.state !== (human ? 'human' : 'agent'))
        return failed('browser_control_not_owned');
      if (state.recoveryObservationRequired && command.action !== 'snapshot')
        return failed('browser_page_observation_required');
      const element = 'ref' in command ? command.ref.replace(/^@/, '') : undefined;
      if (
        element &&
        (('seq' in command && command.seq !== state.view.seq) || !state.refs.has(element))
      )
        return failed('browser_stale_element');
      const combined = AbortSignal.any([signal, state.abort.signal]);
      const reading = ['snapshot', 'capture', 'wait', 'dialogs'].includes(command.action);
      let effectRequested = false;
      try {
        if (command.action === 'dialogs') {
          if (!state.transport?.dialogs) return failed('browser_dialog_unavailable');
          const dialogs = await state.transport.dialogs(combined);
          if (combined.aborted || get(sessionId, target) !== state || state.view.state !== 'agent')
            return failed('browser_observation_stale');
          return succeeded(asJson({ dialogs }));
        }
        if (element && state.semanticRefs.has(element)) {
          // Refresh the fixed backend's ref map before it can apply its role/name
          // fallback to a replaced node. Never map an old host reference to a new id.
          const refreshed = await response(
            state,
            { action: 'snapshot', interactive: false },
            combined,
          );
          const latest = semanticSnapshot(refreshed);
          const actual = latest.elements.find((value) => value.ref === `@${element}`);
          if (
            (typeof refreshed.origin === 'string' && refreshed.origin !== state.view.url) ||
            !actual ||
            canonicalJson(asJson(actual)) !== canonicalJson(asJson(state.semanticRefs.get(element)))
          ) {
            invalidate(state);
            state.view.frame = null;
            return failed('browser_stale_element');
          }
          if (
            get(sessionId, target) !== state ||
            state.view.state !== (human ? 'human' : 'agent') ||
            combined.aborted
          )
            return failed('browser_control_not_owned');
        }
        if (command.action === 'capture') {
          invalidate(state);
          await refresh(
            state,
            signal,
            () =>
              get(sessionId, target) === state && state.view.state === (human ? 'human' : 'agent'),
          );
          if (signal.aborted)
            return { outcome: 'cancelled', content: 'Browser observation cancelled.' };
          if (get(sessionId, target) !== state || state.view.state !== (human ? 'human' : 'agent'))
            return failed('browser_observation_stale');
          return state.view.frame
            ? succeeded(asJson(publicStatus(state.view)))
            : failed('browser_frame_unavailable');
        }
        const native: Record<string, Json> =
          command.action === 'navigate'
            ? { action: 'navigate', url: command.url, waitUntil: 'domcontentloaded' }
            : command.action === 'snapshot'
              ? {
                  action: 'snapshot',
                  interactive: !(semantic || state.observationMode === 'on-demand'),
                }
              : command.action === 'scroll'
                ? { action: 'scroll', direction: command.direction, amount: command.amount }
                : command.action === 'fill'
                  ? { action: 'fill', selector: `@${element}`, value: command.value }
                  : command.action === 'click' || command.action === 'hover'
                    ? { action: command.action, selector: `@${element}` }
                    : command.action === 'select'
                      ? { action: 'select', selector: `@${element}`, values: command.values }
                      : command.action === 'press'
                        ? { action: 'press', key: command.key }
                        : command.action === 'wait'
                          ? { action: 'wait', text: command.text, timeout: command.timeoutMs }
                          : { action: command.action };
        let data: Record<string, Json>;
        if (command.action === 'pointer') {
          if (!state.transport?.pointer) return failed('browser_pointer_unavailable');
          const { action: _, ...input } = command;
          effectRequested = true;
          await state.transport.pointer(input, combined);
          data = {};
        } else if (command.action === 'dialog') {
          if (!state.transport?.dialog) return failed('browser_dialog_unavailable');
          effectRequested = true;
          await state.transport.dialog(
            { dialogRef: command.dialogRef, response: command.response },
            combined,
          );
          data = {};
        } else {
          effectRequested = !reading;
          data = await response(state, native, combined);
        }
        if (state.abort.signal.aborted)
          return reading
            ? failed('browser_observation_stale')
            : unknown('browser_action_interrupted');
        if (
          reading &&
          (get(sessionId, target) !== state || state.view.state !== (human ? 'human' : 'agent'))
        )
          return failed('browser_observation_stale');
        invalidate(state);
        if (state.observationMode === 'on-demand') state.view.frame = null;
        if (command.action === 'navigate') state.view.url = command.url;
        if (typeof data.url === 'string') state.view.url = data.url.slice(0, 8192);
        if (typeof data.title === 'string') state.view.title = data.title.slice(0, 512);
        if (command.action === 'snapshot' && (semantic || state.observationMode === 'on-demand')) {
          const snapshot = semanticSnapshot(data);
          if (typeof data.origin === 'string') state.view.url = data.origin.slice(0, 8192);
          for (const entry of snapshot.elements) {
            const ref = entry.ref.slice(1);
            state.refs.add(ref);
            state.semanticRefs.set(ref, entry);
          }
          recoveredObservation(state);
          return succeeded(asJson({ ...publicStatus(state.view), ...snapshot }));
        }
        if (command.action === 'snapshot' && state.recoveryObservationRequired) {
          if (typeof data.snapshot !== 'string') throw Error('browser_snapshot_invalid');
          recoveredObservation(state);
        }
        if (!semantic && state.observationMode === 'preview') await refresh(state);
        const snapshot =
          typeof data.snapshot === 'string' ? data.snapshot.slice(0, 65536) : undefined;
        return succeeded(
          asJson({
            ...publicStatus(state.view),
            ...(data.dialogOpened === true ? { dialogOpened: true } : {}),
            ...(snapshot
              ? { snapshot, truncated: snapshot.length !== String(data.snapshot).length }
              : {}),
          }),
        );
      } catch (error) {
        if (reading) {
          invalidate(state);
          state.view.frame = null;
          return signal.aborted
            ? { outcome: 'cancelled', content: 'Browser observation cancelled.' }
            : failed(
                transportCode(
                  error,
                  command.action === 'wait' ? 'browser_wait_failed' : 'browser_snapshot_failed',
                ),
              );
        }
        if (!effectRequested) {
          invalidate(state);
          state.view.frame = null;
          return failed(transportCode(error, 'browser_reference_observation_failed'));
        }
        if (error instanceof BrowserTransportError && error.dispatched === false)
          return failed(transportCode(error, 'browser_action_not_dispatched'));
        const cause = transportCode(error, '') || undefined;
        lose(state, 'browser_action_outcome_unknown', undefined, cause);
        return unknown('browser_action_outcome_unknown', cause);
      }
    });
  };
  const handoff: BrowserController['handoff'] = async (sessionId, target, _signal, reason) => {
    if (
      reason !== undefined &&
      (typeof reason !== 'string' ||
        !reason.trim() ||
        reason.length > 1000 ||
        reason.includes('\0'))
    )
      return failed('browser_human_reason_invalid');
    const state = get(sessionId, target);
    if (!state || !['agent', 'starting'].includes(state.view.state))
      return failed('browser_control_not_owned');
    // Legacy coordinated requestHuman carries its explicit reason and owns a
    // separate finite continuation receipt. Ordinary user takeover ends this Run's control.
    if (reason === undefined) state.released = true;
    if (state.view.state === 'starting') state.startupInterrupted = true;
    state.view.state = 'pausing';
    state.view.generation = randomUUID();
    invalidate(state);
    for (const wake of [...state.controlListeners]) wake();
    return serial(state, async () => {
      if (state.view.state !== 'pausing') return failed('browser_handoff_incomplete');
      try {
        await state.transportAvailable;
        if (state.view.state !== 'pausing' || state.abort.signal.aborted)
          return unknown('browser_handoff_interrupted');
        if (!state.transport) throw Error('browser_transport_unavailable');
        await state.transport?.handoff?.(state.abort.signal);
      } catch {
        lose(state, 'browser_handoff_unknown');
        return unknown('browser_handoff_unknown');
      }
      if (state.abort.signal.aborted) return unknown('browser_handoff_interrupted');
      state.view.state = 'human';
      if (reason !== undefined) state.view.humanRequest = reason;
      advance(state);
      for (const wake of [...state.controlListeners]) wake();
      if (state.observationMode === 'preview') await refresh(state);
      return succeeded(asJson(publicStatus(state.view)));
    });
  };
  const controller: BrowserController = {
    job,
    prepareRun: prepareOwner,
    async image(sessionId, target, signal) {
      const state = get(sessionId, target);
      if (!state) throw Error('browser_stale_or_foreign_target');
      await state.ready;
      return serial(state, async () => {
        signal.throwIfAborted();
        if (state.recoveryObservationRequired) throw Error('browser_page_observation_required');
        if (
          get(sessionId, target) !== state ||
          state.view.state !== 'agent' ||
          !state.transport?.capturePng
        )
          throw Error('browser_image_unavailable');
        const seq = state.view.seq;
        const image = await state.transport.capturePng(
          AbortSignal.any([signal, state.abort.signal]),
        );
        signal.throwIfAborted();
        if (
          get(sessionId, target) !== state ||
          state.view.state !== 'agent' ||
          seq !== state.view.seq
        )
          throw Error('browser_image_stale');
        return { ...image, seq };
      });
    },
    view(sessionId) {
      const view = sessions.get(sessionId)?.view ?? closedViews.get(sessionId)?.view;
      return view ? structuredClone(view) : null;
    },
    releasedPage,
    invalidateMissingReleasedPage(sessionId, identity) {
      const pages = releasedPages.get(sessionId);
      if (!pages) return false;
      const retained = pages.filter(
        (page) =>
          page.identity?.pageId !== identity.pageId ||
          page.identity.incarnation !== identity.incarnation,
      );
      if (retained.length === pages.length) return false;
      if (retained.length) releasedPages.set(sessionId, retained);
      else releasedPages.delete(sessionId);
      return true;
    },
    releasedPages(sessionId) {
      const current = sessions.get(sessionId);
      const active = current?.view.state === 'agent' ? current.sharedPageIdentity : undefined;
      return knownReleased(sessionId)
        .filter(
          (page) =>
            !active ||
            page.identity?.pageId !== active.pageId ||
            page.identity.incarnation !== active.incarnation,
        )
        .map(copyReleased);
    },
    command: dispatch,
    captureNote: (sessionId, target, signal) =>
      dispatch(
        sessionId,
        target,
        { action: 'capture' },
        signal,
        get(sessionId, target)?.view.state === 'human',
        true,
      ),
    observe: (sessionId, target, signal) =>
      dispatch(sessionId, target, { action: 'snapshot' }, signal, false, true),
    control: (sessionId, target, operation, signal) =>
      dispatch(sessionId, target, operation, signal, false, true),
    handoff,
    watchControl(sessionId, target, listener) {
      const state = get(sessionId, target);
      if (!state) {
        listener('unavailable');
        return () => {};
      }
      const wake = () => listener(state.view.state);
      state.controlListeners.add(wake);
      wake();
      return () => state.controlListeners.delete(wake);
    },
    async resume(sessionId, target, signal) {
      const state = get(sessionId, target);
      if (state?.view.state !== 'human') return failed('browser_control_not_owned');
      const cancelled = (): ToolResult => ({
        outcome: 'cancelled',
        content: 'browser_resume_cancelled',
      });
      if (signal.aborted) return cancelled();
      state.view.state = 'pausing';
      state.view.generation = randomUUID();
      invalidate(state);
      return serial(state, async () => {
        if (state.view.state !== 'pausing') return failed('browser_resume_incomplete');
        if (signal.aborted) {
          state.view.state = 'human';
          return cancelled();
        }
        try {
          await state.transport?.resume?.(AbortSignal.any([state.abort.signal, signal]));
        } catch {
          lose(state, 'browser_resume_unknown');
          return unknown('browser_resume_unknown');
        }
        if (state.abort.signal.aborted) return unknown('browser_resume_interrupted');
        // Keep commands inadmissible through the observation await. A cancelled
        // response must never publish agent control after its transport ACK.
        if (state.observationMode === 'preview') await refresh(state);
        if (state.abort.signal.aborted) return unknown('browser_resume_interrupted');
        if (signal.aborted) {
          try {
            await state.transport?.handoff?.(state.abort.signal);
          } catch {
            lose(state, 'browser_resume_return_unknown');
            return unknown('browser_resume_return_unknown');
          }
          if (state.abort.signal.aborted) return unknown('browser_resume_interrupted');
          state.view.state = 'human';
          invalidate(state);
          for (const wake of [...state.controlListeners]) wake();
          return cancelled();
        }
        state.view.state = 'agent';
        delete state.view.humanRequest;
        advance(state);
        for (const wake of [...state.controlListeners]) wake();
        return succeeded(asJson(publicStatus(state.view)));
      });
    },
    async select(sessionId, target, seq, ref) {
      const state = get(sessionId, target);
      if (!state || state.view.seq !== seq || !['agent', 'human'].includes(state.view.state))
        return failed('browser_stale_element');
      const annotation =
        ref === null
          ? null
          : state.view.annotations.find(
              (value) => value.ref.replace(/^@/, '') === ref.replace(/^@/, ''),
            );
      if (annotation === undefined) return failed('browser_stale_element');
      state.view.selectedAnnotation = annotation;
      return succeeded(asJson(publicStatus(state.view)));
    },
    async close(sessionId, target) {
      const state = get(sessionId, target);
      if (!state) return failed('browser_stale_or_foreign_target');
      const confirmation = await stop(state);
      return confirmation.status === 'stopped'
        ? succeeded({ closed: true, browserId: target.browserId })
        : unknown('browser_stop_unconfirmed');
    },
  };
  registerBrowserSessionSource(controller, (sessionId, target) => {
    const state = get(sessionId, target);
    return state && state.view.state === 'human' && !state.terminal && !state.abort.signal.aborted
      ? { executionId: state.context.executionId, signal: state.abort.signal }
      : undefined;
  });
  return controller;
}
export function createAgentBrowserController(
  options: NativeBrowserTransportOptions,
): BrowserController {
  return createBrowserController({
    createTransport: (context) => createNativeBrowserTransport(options, context),
  });
}
export function createUnavailableBrowserController(
  reason = 'browser_runtime_unavailable',
): BrowserController {
  const controller = createBrowserController({
    createTransport() {
      throw Error('browser_runtime_unavailable');
    },
  });
  return {
    ...controller,
    view(sessionId) {
      return (
        controller.view(sessionId) ?? {
          browserId: '',
          generation: '',
          seq: '0',
          state: 'unavailable',
          url: '',
          title: '',
          frame: null,
          annotations: [],
          selectedAnnotation: null,
          error: reason.slice(0, 128),
        }
      );
    },
  };
}
