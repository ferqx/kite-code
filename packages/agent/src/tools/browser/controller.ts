import { randomUUID } from 'node:crypto';
import type {
  JobContext,
  JobEvent,
  JobHandle,
  Json,
  StopConfirmation,
  ToolResult,
} from '../../extensions';
import { canonicalJson } from '../../json';
import {
  createNativeBrowserTransport,
  type NativeBrowserTransport,
  type NativeBrowserTransportOptions,
} from './native';
import {
  asJson,
  type BrowserAnnotation,
  type BrowserController,
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
const unknown = (code: string): ToolResult => ({
  outcome: 'outcome_unknown',
  content: `${code}. The original action must not be retried; inspect this browser or close it.`,
  details: { code },
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
  uncertain: boolean;
  startupFailure?: string;
  queued: number;
  refs: Set<string>;
  removeAbort: () => void;
}
/** The injectable transport is trusted test/host assembly, never Extension input. */
export function createBrowserController(options: {
  createTransport(context: JobContext): NativeBrowserTransport;
  captureIntervalMs?: number;
}): BrowserController {
  const sessions = new Map<string, Session>();
  const closedViews = new Map<string, BrowserView>();
  const handles = new WeakMap<JobHandle, Session>();
  const interval = options.captureIntervalMs ?? 300;
  if (!Number.isSafeInteger(interval) || interval < 100 || interval > 60000)
    throw Error('browser_capture_interval_invalid');
  const advance = (state: Session) => {
    state.view.seq = String(BigInt(state.view.seq) + 1n);
  };
  const invalidate = (state: Session) => {
    state.refs.clear();
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
    invalidate(state);
    state.terminal = { type: 'terminal', result, supervision: confirmed ? 'ended' : 'unknown' };
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
    state.view.state = state.uncertain ? 'outcome_unknown' : 'closing';
    invalidate(state);
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
        terminal(state, unknown('browser_stop_unconfirmed'), false);
        return { status: 'unknown' };
      }
    })();
    return state.stopping;
  };
  const lose = (state: Session, code: string) => {
    state.uncertain = true;
    state.view.state = 'outcome_unknown';
    state.view.error = code;
    invalidate(state);
    void stop(state);
  };
  const refresh = async (state: Session) => {
    if (!state.transport || state.abort.signal.aborted) return;
    try {
      const captured = await state.transport.capture(state.abort.signal);
      if (
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
    }
  };
  const schedule = (state: Session) => {
    if (state.terminal || state.abort.signal.aborted) return;
    state.timer = setTimeout(() => {
      if (state.queued >= 16) {
        schedule(state);
        return;
      }
      void serial(state, async () => {
        if (['agent', 'human'].includes(state.view.state)) await refresh(state);
      }).finally(() => schedule(state));
    }, interval);
  };
  const response = async (state: Session, input: Record<string, Json>, signal: AbortSignal) => {
    if (!state.transport) throw Error('browser_transport_unavailable');
    const answer = object(await state.transport.request(input, signal));
    if (answer.success !== true || object(answer.data).confirmation_required === true)
      throw Error('browser_native_action_failed');
    return object(answer.data);
  };
  const job: BrowserController['job'] = {
    id: browserJobId,
    version: '1',
    description:
      'Own one isolated agent-browser lifetime and its complete supervised process tree.',
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
      const prior = sessions.get(context.sessionId);
      if (prior) throw Error('browser_session_already_owned');
      if (sessions.size >= 8) throw Error('browser_session_capacity');
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
        tail: Promise.resolve(),
        observed: false,
        uncertain: false,
        queued: 0,
        frames: 0,
        refs: new Set(),
        removeAbort: () => {},
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
          navigationAcknowledged = false;
        try {
          context.signal.throwIfAborted();
          state.transport = options.createTransport(context);
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
          state.abort.signal.throwIfAborted();
          await response(
            state,
            { action: 'launch', headless: true, engine: 'chrome', webmcp: false },
            state.abort.signal,
          );
          await response(
            state,
            { action: 'viewport', width: 960, height: 540, deviceScaleFactor: 1, mobile: false },
            state.abort.signal,
          );
          navigationIssued = true;
          const data = await response(
            state,
            { action: 'navigate', url: value.url!, waitUntil: 'domcontentloaded' },
            state.abort.signal,
          );
          navigationAcknowledged = true;
          if (typeof data.url === 'string') state.view.url = data.url.slice(0, 8192);
          if (typeof data.title === 'string') state.view.title = data.title.slice(0, 512);
          state.abort.signal.throwIfAborted();
          state.view.state = 'agent';
          advance(state);
          await refresh(state);
          schedule(state);
        } catch (error) {
          if (!state.transport) {
            if (context.signal.aborted)
              terminal(
                state,
                { outcome: 'cancelled', content: 'Browser cancelled before startup.' },
                true,
              );
            else {
              state.view.error = 'browser_runtime_unavailable';
              terminal(state, failed('browser_runtime_unavailable'), true);
            }
          } else if (
            navigationIssued &&
            !navigationAcknowledged &&
            object(error).dispatched !== false
          ) {
            lose(state, 'browser_startup_outcome_unknown');
          } else if (!state.stopping) {
            state.view.error = 'browser_startup_failed';
            state.startupFailure = 'browser_startup_failed';
            void stop(state);
          }
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
      if (state.terminal?.supervision !== 'ended') throw Error('browser_cleanup_unconfirmed');
      await state.ready;
      await state.tail;
      await state.transport?.dispose();
      state.removeAbort();
      handles.delete(handle);
      if (sessions.get(state.context.sessionId) === state) sessions.delete(state.context.sessionId);
      closedViews.delete(state.context.sessionId);
      closedViews.set(state.context.sessionId, structuredClone(state.view));
      if (closedViews.size > 128) closedViews.delete(closedViews.keys().next().value!);
    },
  };
  return {
    job,
    view(sessionId) {
      const view = sessions.get(sessionId)?.view ?? closedViews.get(sessionId);
      return view ? structuredClone(view) : null;
    },
    async command(sessionId, target, command, signal, human = false) {
      const state = get(sessionId, target);
      if (!state) return failed('browser_stale_or_foreign_target');
      await state.ready;
      if (state.queued >= 16) return failed('browser_command_capacity');
      return serial(state, async () => {
        if (signal.aborted)
          return { outcome: 'cancelled', content: 'Browser action cancelled before dispatch.' };
        if (get(sessionId, target) !== state || state.view.state !== (human ? 'human' : 'agent'))
          return failed('browser_control_not_owned');
        if (
          (command.action === 'click' || command.action === 'fill') &&
          (command.seq !== state.view.seq || !state.refs.has(command.ref.replace(/^@/, '')))
        )
          return failed('browser_stale_element');
        const native: Record<string, Json> =
          command.action === 'navigate'
            ? { action: 'navigate', url: command.url, waitUntil: 'domcontentloaded' }
            : command.action === 'snapshot'
              ? { action: 'snapshot', interactive: true }
              : command.action === 'scroll'
                ? { action: 'scroll', direction: command.direction, amount: command.amount }
                : command.action === 'fill'
                  ? {
                      action: 'fill',
                      selector: `@${command.ref.replace(/^@/, '')}`,
                      value: command.value,
                    }
                  : { action: 'click', selector: `@${command.ref.replace(/^@/, '')}` };
        try {
          const data = await response(state, native, AbortSignal.any([signal, state.abort.signal]));
          if (state.abort.signal.aborted) return unknown('browser_action_interrupted');
          invalidate(state);
          if (command.action === 'navigate') state.view.url = command.url;
          if (typeof data.url === 'string') state.view.url = data.url.slice(0, 8192);
          if (typeof data.title === 'string') state.view.title = data.title.slice(0, 512);
          await refresh(state);
          const snapshot =
            typeof data.snapshot === 'string' ? data.snapshot.slice(0, 65536) : undefined;
          return succeeded(
            asJson({
              ...publicStatus(state.view),
              ...(snapshot
                ? { snapshot, truncated: snapshot.length !== String(data.snapshot).length }
                : {}),
            }),
          );
        } catch (error) {
          if (command.action === 'snapshot') return failed('browser_snapshot_failed');
          if (object(error).dispatched === false) return failed('browser_action_not_dispatched');
          lose(state, 'browser_action_outcome_unknown');
          return unknown('browser_action_outcome_unknown');
        }
      });
    },
    async handoff(sessionId, target, _signal) {
      const state = get(sessionId, target);
      if (state?.view.state !== 'agent') return failed('browser_control_not_owned');
      state.view.state = 'pausing';
      state.view.generation = randomUUID();
      invalidate(state);
      return serial(state, async () => {
        if (state.view.state !== 'pausing') return failed('browser_handoff_incomplete');
        state.view.state = 'human';
        advance(state);
        await refresh(state);
        return succeeded(asJson(publicStatus(state.view)));
      });
    },
    async resume(sessionId, target, _signal) {
      const state = get(sessionId, target);
      if (state?.view.state !== 'human') return failed('browser_control_not_owned');
      state.view.state = 'pausing';
      state.view.generation = randomUUID();
      invalidate(state);
      return serial(state, async () => {
        if (state.view.state !== 'pausing') return failed('browser_resume_incomplete');
        state.view.state = 'agent';
        advance(state);
        await refresh(state);
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
