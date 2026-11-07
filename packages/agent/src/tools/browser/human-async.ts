import { sealBrowserContinuationAction } from '../../execution/host-control';
import type {
  ActionContext,
  ActionDefinition,
  JobDefinition,
  JobEvent,
  JobHandle,
  Json,
  NecessaryConditions,
  OperationRef,
  ReadContext,
  RecordDefinition,
  ToolContext,
  ToolResult,
} from '../../extensions';
import type { AgentRuntime } from '../../runtime';
import { AgentError, type RequirementEvaluation } from '../../storage/types';
import { browserPageReference } from './model-reference';
import type { BrowserController, BrowserTarget } from './types';

const contentType = 'application/vnd.kite.browser-human-request+json';
const obligationType = 'application/vnd.kite.browser-human-obligation+json';
const jobId = 'browser.human_wait';
const object = (value: Json): Record<string, Json> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AgentError('browser_human_request_invalid');
  return value;
};
const failed = (code: string): ToolResult => ({
  outcome: 'failed',
  content: code,
  details: { code },
});
type Host = Pick<
  AgentRuntime,
  'getExecution' | 'getRun' | 'getSession' | 'getCommand' | 'includeResult' | 'readWorkEligibility'
>;
type Request = {
  id: string;
  sessionId: string;
  storeId: string;
  toolId: string;
  runId: string | null;
  taskRunId: string;
  selection: string;
  workId: string;
  workSeq: string;
  subject: string;
  target: BrowserTarget;
  reason: string;
  expiresAt: number;
  ref?: OperationRef;
  ready: boolean;
  abort: AbortController;
  removeAbort?: () => void;
  result?: ToolResult;
  responseComplete?: boolean;
  responseUnknown?: boolean;
  done: Promise<ToolResult>;
  finish(result: ToolResult): void;
  timer?: ReturnType<typeof setTimeout>;
  unwatch?: () => void;
};

/** A request Job owns only one finite response/result receipt, never the page,
 * browser daemon, another process, or an independent message transport. */
export function createBrowserHumanCoordinator(options: {
  controller: BrowserController;
  runtime(): Host;
}) {
  const requests = new Map<string, Request>();
  const handles = new WeakMap<JobHandle, Request>();
  /** Runless child Tools retain their real identity; only a direct execute Tool binds the Run. */
  const taskRun = async (
    own: NonNullable<Awaited<ReturnType<Host['getExecution']>>>,
    live: boolean,
  ) => {
    const host = options.runtime();
    let runId = own.runId;
    if (!runId) {
      const parent = own.parentExecutionId ? await host.getExecution(own.parentExecutionId) : null;
      if (
        parent?.kind !== 'tool' ||
        parent.definitionId !== 'browser.execute' ||
        parent.definitionVersion !== '1' ||
        !parent.runId ||
        parent.sessionId !== own.sessionId ||
        parent.originStoreId !== own.originStoreId ||
        parent.rootWorkCommandId !== own.rootWorkCommandId ||
        parent.rootWorkSeq !== own.rootWorkSeq ||
        parent.cancelRequestedAt !== null ||
        !(live ? ['dispatching', 'running'] : ['dispatching', 'running', 'succeeded']).includes(
          parent.status,
        )
      )
        throw new AgentError('browser_human_scope_invalid');
      runId = parent.runId;
      const run = await host.getRun(runId);
      if (run?.originCommandId !== parent.originCommandId)
        throw new AgentError('browser_human_scope_invalid');
    }
    const run = await host.getRun(runId);
    if (
      !run?.isActive ||
      run.sessionId !== own.sessionId ||
      run.originStoreId !== own.originStoreId ||
      run.rootWorkCommandId !== own.rootWorkCommandId ||
      run.rootWorkSeq !== own.rootWorkSeq
    )
      throw new AgentError('browser_human_scope_invalid');
    return run;
  };
  const verifyRequestSource = async (pending: Request) => {
    const own = await options.runtime().getExecution(pending.toolId);
    if (
      own?.kind !== 'tool' ||
      own.definitionId !== 'browser.request_human' ||
      own.definitionVersion !== '1' ||
      own.runId !== pending.runId ||
      own.originStoreId !== pending.storeId ||
      own.sessionId !== pending.sessionId ||
      own.rootWorkCommandId !== pending.workId ||
      own.rootWorkSeq !== pending.workSeq ||
      own.cancelRequestedAt !== null ||
      !['dispatching', 'running', 'succeeded'].includes(own.status)
    )
      throw new AgentError('browser_human_scope_invalid');
    const run = await taskRun(own, false);
    if (run.id !== pending.taskRunId || run.contextSelectionId !== pending.selection)
      throw new AgentError('browser_human_scope_invalid');
  };
  const key = (id: string) => `human/${id}`;
  const settle = (request: Request, result: ToolResult) => {
    if (result.outcome !== 'succeeded') request.abort.abort();
    if (request.result) return;
    request.result = result;
    clearTimeout(request.timer);
    request.unwatch?.();
    request.finish(result);
  };
  const owns = (sessionId: string, target: BrowserTarget) => {
    const request = requests.get(sessionId);
    return !!request && request.target.browserId === target.browserId && !request.responseComplete;
  };
  const job: JobDefinition = {
    id: jobId,
    version: '1',
    description:
      'Own a bounded human-response result receipt for one browser request; no page or process ownership.',
    inputSchema: {
      type: 'object',
      properties: { requestId: { type: 'string', minLength: 1, maxLength: 128 } },
      required: ['requestId'],
      additionalProperties: false,
    },
    async start(input, context) {
      const id = object(input).requestId;
      const request = requests.get(context.sessionId);
      const actual = await options.runtime().getExecution(context.executionId);
      if (
        !request ||
        request.id !== id ||
        actual?.definitionId !== jobId ||
        actual.parentExecutionId !== request.toolId ||
        actual.originStoreId !== request.storeId
      )
        throw new AgentError('browser_human_request_unbound');
      request.ready = true;
      const cancelled = () =>
        settle(request, { outcome: 'cancelled', content: 'browser_human_request_cancelled' });
      context.signal.addEventListener('abort', cancelled, { once: true });
      request.removeAbort = () => context.signal.removeEventListener('abort', cancelled);
      if (context.signal.aborted) cancelled();
      const handle: JobHandle = { reference: { requestId: request.id } };
      handles.set(handle, request);
      return handle;
    },
    async *observe(handle): AsyncIterable<JobEvent> {
      const request = handles.get(handle);
      if (!request) throw new AgentError('browser_human_request_unbound');
      const result = await request.done;
      yield { type: 'terminal', result, supervision: 'ended' };
    },
    async cancel(handle) {
      const request = handles.get(handle);
      if (request)
        settle(request, { outcome: 'cancelled', content: 'browser_human_request_cancelled' });
      return { status: 'stopped' };
    },
    async dispose(handle) {
      const request = handles.get(handle);
      if (request && !request.result) throw new AgentError('browser_human_request_pending');
      request?.removeAbort?.();
      handles.delete(handle);
    },
  };
  const records: RecordDefinition[] = [
    {
      contentType: obligationType,
      contentVersion: 1,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { const: 'browser_human_receipt' },
          ...Object.fromEntries(
            [
              'requestId',
              'executionId',
              'sessionId',
              'runId',
              'parentExecutionId',
              'originStoreId',
              'originCommandId',
              'rootWorkCommandId',
              'rootWorkSeq',
              'contextSelectionId',
            ].map((key) => [key, { type: 'string' }]),
          ),
        },
        required: [
          'kind',
          'requestId',
          'executionId',
          'sessionId',
          'runId',
          'parentExecutionId',
          'originStoreId',
          'originCommandId',
          'rootWorkCommandId',
          'rootWorkSeq',
          'contextSelectionId',
        ],
      },
    },
    {
      contentType,
      contentVersion: 1,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requestId: { type: 'string' },
          toolId: { type: 'string' },
          runId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          taskRunId: { type: 'string' },
          contextSelectionId: { type: 'string' },
          rootWorkCommandId: { type: 'string' },
          rootWorkSeq: { type: 'string' },
          browserId: { type: 'string' },
          generation: { type: 'string' },
          reason: { type: 'string' },
          expiresAt: { type: 'number' },
          state: { enum: ['pending', 'responding', 'resolved', 'unknown'] },
          job: { type: 'object' },
          responseExecutionId: { type: 'string' },
        },
        required: [
          'requestId',
          'toolId',
          'runId',
          'contextSelectionId',
          'browserId',
          'generation',
          'reason',
          'expiresAt',
          'state',
          'job',
        ],
      },
    },
  ];
  const conditions: NecessaryConditions = {
    async evaluate(refs, phase, context) {
      if (!context) throw new AgentError('necessary_condition_context_missing');
      return Promise.all(
        refs.map(async (ref): Promise<RequirementEvaluation> => {
          const read = await context.forRequirement(ref);
          const record = await read.records.get(ref.recordKey);
          const value = record ? object(record.value) : null;
          const evaluation = {
            requirement: ref,
            recordRevision: record?.revision ?? ref.revision,
            outcome: 'unsatisfied' as 'satisfied' | 'unsatisfied',
            evidence: {} as Json,
          };
          if (
            !record ||
            record.contentType !== obligationType ||
            record.contentVersion !== 1 ||
            record.revision !== ref.revision ||
            record.originStoreId !== ref.originStoreId ||
            value?.kind !== 'browser_human_receipt' ||
            value.runId !== ref.runId ||
            value.sessionId !== ref.sessionId ||
            value.originStoreId !== ref.originStoreId
          )
            return { ...evaluation, evidence: { reason: 'browser_human_receipt_unverifiable' } };
          if (
            phase !== 'completion' ||
            context.boundary.runId !== ref.runId ||
            context.boundary.executionId !== null
          )
            return {
              ...evaluation,
              outcome: 'satisfied' as const,
              evidence: { reason: 'nonapplicable_run_boundary' },
            };
          const execution = await read.getExecution(String(value.executionId));
          if (
            execution?.kind !== 'job' ||
            execution.definitionId !== jobId ||
            execution.definitionVersion !== '1' ||
            execution.originStoreId !== ref.originStoreId ||
            execution.sessionId !== ref.sessionId ||
            execution.parentExecutionId !== value.parentExecutionId ||
            execution.originCommandId !== value.originCommandId ||
            execution.rootWorkCommandId !== value.rootWorkCommandId ||
            execution.rootWorkSeq !== value.rootWorkSeq
          )
            return { ...evaluation, evidence: { reason: 'browser_human_receipt_unverifiable' } };
          const source = execution.parentExecutionId
            ? await read.getExecution(execution.parentExecutionId)
            : null;
          const bound = (entry: typeof source) =>
            entry?.kind === 'tool' &&
            entry.originStoreId === ref.originStoreId &&
            entry.sessionId === ref.sessionId &&
            entry.rootWorkCommandId === value.rootWorkCommandId &&
            entry.rootWorkSeq === value.rootWorkSeq &&
            ['dispatching', 'running', 'succeeded'].includes(entry.status);
          const ancestor =
            source?.runId === null && source.parentExecutionId
              ? await read.getExecution(source.parentExecutionId)
              : null;
          if (
            !bound(source) ||
            source?.definitionId !== 'browser.request_human' ||
            source.definitionVersion !== '1' ||
            (source.runId !== ref.runId &&
              !(
                source.runId === null &&
                bound(ancestor) &&
                ancestor?.definitionId === 'browser.execute' &&
                ancestor.definitionVersion === '1' &&
                ancestor.runId === ref.runId
              ))
          )
            return { ...evaluation, evidence: { reason: 'browser_human_receipt_unverifiable' } };
          const accepted = execution.resultAcceptance;
          if (
            execution.status === 'succeeded' &&
            accepted?.runId === ref.runId &&
            accepted.selectionId === value.contextSelectionId &&
            accepted.resultRevision === execution.resultRevision
          )
            return {
              ...evaluation,
              outcome: 'satisfied' as const,
              evidence: {
                reason: 'browser_human_receipt_accepted',
                executionId: execution.id,
                sourceId: accepted.sourceId,
                resultRevision: accepted.resultRevision,
              },
            };
          const request = await read.records.get(key(String(value.requestId)));
          const head = request ? object(request.value) : null;
          if (
            !request ||
            request.contentType !== contentType ||
            request.originStoreId !== ref.originStoreId ||
            !head ||
            head.requestId !== value.requestId ||
            head.toolId !== value.parentExecutionId ||
            (head.taskRunId ?? head.runId) !== ref.runId ||
            head.contextSelectionId !== value.contextSelectionId ||
            typeof head.expiresAt !== 'number' ||
            head.expiresAt <= Date.now() ||
            head.state === 'unknown' ||
            !['planned', 'dispatching', 'running', 'succeeded'].includes(execution.status)
          )
            return {
              ...evaluation,
              evidence: {
                reason: 'browser_human_receipt_unconfirmed',
                executionId: execution.id,
                status: execution.status,
              },
            };
          return {
            ...evaluation,
            evidence: { reason: 'browser_human_receipt_pending', executionId: execution.id },
            wait: { executionIds: [execution.id] },
          };
        }),
      );
    },
  };
  const request = async (
    context: ToolContext,
    target: BrowserTarget,
    reason: string,
  ): Promise<ToolResult> => {
    const host = options.runtime(),
      own = await host.getExecution(context.executionId);
    const run = own ? await taskRun(own, true) : null;
    const origin = run ? await host.getCommand(run.originCommandId) : null;
    if (
      !own ||
      !run?.isActive ||
      !origin ||
      own.definitionId !== 'browser.request_human' ||
      own.definitionVersion !== '1' ||
      own.cancelRequestedAt !== null ||
      !['dispatching', 'running'].includes(own.status) ||
      own.kind !== 'tool' ||
      own.sessionId !== context.sessionId ||
      own.runId !== context.runId
    )
      throw new AgentError('browser_human_scope_invalid');
    for (const [session, old] of requests) {
      const view = options.controller.view(session);
      if (
        !view ||
        view.browserId !== old.target.browserId ||
        ['closed', 'unavailable'].includes(view.state)
      )
        requests.delete(session);
    }
    if (requests.size >= 8 && !requests.has(context.sessionId))
      return failed('browser_human_request_capacity');
    const previous = requests.get(context.sessionId);
    if (previous && !previous.result) return failed('browser_human_request_pending');
    const yielded = await options.controller.handoff(
      context.sessionId,
      target,
      context.signal,
      reason,
    );
    if (yielded.outcome !== 'succeeded') return yielded;
    const human = options.controller.view(context.sessionId);
    if (human?.state !== 'human' || human.browserId !== target.browserId)
      return failed('browser_human_target_changed');
    let finish!: (result: ToolResult) => void;
    const done = new Promise<ToolResult>((resolve) => {
      finish = resolve;
    });
    const pending: Request = {
      id: `human-${own.id}`,
      sessionId: own.sessionId,
      storeId: own.originStoreId,
      toolId: own.id,
      runId: own.runId,
      taskRunId: run.id,
      selection: run.contextSelectionId,
      workId: run.rootWorkCommandId,
      workSeq: run.rootWorkSeq,
      subject: origin.subjectId,
      target: { browserId: human.browserId, generation: human.generation },
      reason,
      expiresAt: Math.min(Date.now() + 600000, run.deadlineAt ?? Number.MAX_SAFE_INTEGER),
      ready: false,
      abort: new AbortController(),
      done,
      finish,
    };
    requests.set(context.sessionId, pending);
    pending.timer = setTimeout(
      () => settle(pending, failed('browser_human_request_expired')),
      Math.max(0, pending.expiresAt - Date.now()),
    );
    pending.unwatch = options.controller.watchControl(
      context.sessionId,
      pending.target,
      (state) => {
        if (state !== 'human') settle(pending, failed('browser_human_page_changed'));
      },
    );
    try {
      const ref = await context.operations.ensure({
        key: pending.id,
        request: {
          kind: 'job',
          definitionId: jobId,
          definitionVersion: '1',
          input: { requestId: pending.id },
        },
        cancellation: 'attached',
      });
      pending.ref = ref;
      await context.records.write({
        key: key(pending.id),
        expectedRevision: null,
        contentType,
        contentVersion: 1,
        executable: true,
        value: {
          requestId: pending.id,
          toolId: own.id,
          runId: own.runId,
          ...(own.runId === null ? { taskRunId: run.id } : {}),
          contextSelectionId: run.contextSelectionId,
          rootWorkCommandId: pending.workId,
          rootWorkSeq: pending.workSeq,
          ...pending.target,
          reason,
          expiresAt: pending.expiresAt,
          state: 'pending',
          job: ref as unknown as Json,
        },
      });
      const carrier = ref.executionId ? await host.getExecution(ref.executionId) : null;
      if (
        carrier?.kind !== 'job' ||
        carrier.definitionId !== jobId ||
        carrier.parentExecutionId !== own.id ||
        carrier.originStoreId !== own.originStoreId ||
        carrier.sessionId !== own.sessionId ||
        carrier.rootWorkCommandId !== own.rootWorkCommandId ||
        carrier.rootWorkSeq !== own.rootWorkSeq ||
        !context.requirements
      )
        throw new AgentError('browser_human_request_unbound');
      const obligation = await context.records.write({
        key: `run/${run.id}/browser-human/${own.id}`,
        expectedRevision: null,
        contentType: obligationType,
        contentVersion: 1,
        executable: true,
        value: {
          kind: 'browser_human_receipt',
          requestId: pending.id,
          executionId: carrier.id,
          sessionId: own.sessionId,
          runId: run.id,
          parentExecutionId: own.id,
          originStoreId: own.originStoreId,
          originCommandId: carrier.originCommandId,
          rootWorkCommandId: own.rootWorkCommandId,
          rootWorkSeq: own.rootWorkSeq,
          contextSelectionId: run.contextSelectionId,
        },
      });
      await context.requirements.register([
        {
          definitionVersion: '1',
          requirementId: `browser-human-${own.id}`,
          revision: obligation.revision,
          phase: 'completion',
          recordKey: obligation.key,
        },
      ]);
      const details = {
        state: 'pending',
        requestId: pending.id,
        expiresAt: pending.expiresAt,
        originRunId: pending.taskRunId,
        ...pending.target,
        ref: ref as unknown as Json,
      };
      return { outcome: 'succeeded', content: JSON.stringify(details), details };
    } catch (error) {
      settle(pending, failed('browser_human_registration_failed'));
      throw error;
    }
  };
  const read = async (context: ReadContext) => {
    const pending = requests.get(context.sessionId);
    if (!pending) return undefined;
    if (pending.responseComplete) return undefined;
    const row = await context.records.get(key(pending.id));
    if (!row || row.contentType !== contentType || row.originStoreId !== pending.storeId)
      return undefined;
    const value = object(row.value),
      run = await context.getRun(pending.taskRunId);
    const carrier = pending.ref?.executionId
      ? await context.getExecution(pending.ref.executionId)
      : null;
    const state =
      value.state === 'unknown' || pending.responseUnknown
        ? 'unknown'
        : pending.expiresAt <= Date.now() || !run?.isActive
          ? 'expired'
          : value.state === 'resolved'
            ? 'resolved'
            : pending.abort.signal.aborted
              ? 'finished'
              : value.state === 'responding'
                ? 'responding'
                : pending.result ||
                    (carrier &&
                      ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(
                        carrier.status,
                      ))
                  ? 'finished'
                  : !pending.ready
                    ? 'starting'
                    : value.state;
    return { requestId: pending.id, revision: row.revision, state, expiresAt: pending.expiresAt };
  };
  const response: ActionDefinition = {
    id: 'browser.respond_human',
    version: '1',
    runControl: true,
    description:
      'Explicit human Continue-and-notify or Stop response to one exact pending browser request. Never model callable.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', minLength: 1, maxLength: 128 },
        expectedRevision: { type: 'string', pattern: '^[1-9][0-9]*$' },
        browserId: { type: 'string' },
        generation: { type: 'string' },
        choice: { enum: ['continue', 'stop'] },
      },
      required: ['requestId', 'expectedRevision', 'browserId', 'generation', 'choice'],
      additionalProperties: false,
    },
    async prepare(input, context) {
      const value = object(input),
        pending = requests.get(context.sessionId);
      const row =
        typeof value.requestId === 'string'
          ? await context.records.get(key(value.requestId))
          : null;
      const run = pending ? await context.getRun(pending.taskRunId) : null;
      const carrier = pending?.ref?.executionId
        ? await context.getExecution(pending.ref.executionId)
        : null;
      if (
        !pending ||
        pending.id !== value.requestId ||
        pending.result ||
        !pending.ready ||
        pending.expiresAt <= Date.now() ||
        !run?.isActive ||
        !row ||
        row.originStoreId !== pending.storeId ||
        row.revision !== value.expectedRevision ||
        object(row.value).state !== 'pending' ||
        carrier?.definitionId !== jobId ||
        carrier.parentExecutionId !== pending.toolId ||
        carrier.status !== 'running' ||
        value.browserId !== pending.target.browserId ||
        value.generation !== pending.target.generation
      )
        throw new AgentError('browser_human_request_expired_or_changed');
      if (row.forkProvenance) throw new AgentError('browser_human_request_expired_or_changed');
      await verifyRequestSource(pending);
      return input;
    },
    async execute(input, context: ActionContext) {
      const value = object(input),
        pending = requests.get(context.sessionId)!;
      const assertPending = () => {
        if (
          !pending ||
          requests.get(context.sessionId) !== pending ||
          pending.id !== value.requestId ||
          pending.result ||
          pending.abort.signal.aborted ||
          !pending.ready ||
          pending.expiresAt <= Date.now() ||
          pending.target.browserId !== value.browserId ||
          pending.target.generation !== value.generation
        )
          throw new AgentError('browser_human_request_expired_or_changed');
        context.signal.throwIfAborted();
      };
      assertPending();
      await verifyRequestSource(pending);
      assertPending();
      const host = options.runtime(),
        actual = await host.getExecution(context.executionId);
      assertPending();
      const actor = actual ? await host.getCommand(actual.originCommandId) : null;
      assertPending();
      const run = await host.getRun(pending.taskRunId);
      assertPending();
      const session = await host.getSession(pending.sessionId);
      assertPending();
      const work = await host.readWorkEligibility({
        expectedStoreId: pending.storeId,
        sessionId: pending.sessionId,
        subjectId: pending.subject,
        rootWorkCommandId: pending.workId,
        rootWorkSeq: pending.workSeq,
        contextSelectionId: pending.selection,
      });
      assertPending();
      if (
        !actor ||
        actual?.kind !== 'job' ||
        actual.runId !== null ||
        actual.parentExecutionId !== null ||
        actual.definitionId !== 'builtin.browser/browser.respond_human' ||
        actual.definitionVersion !== '1' ||
        actor.kind !== 'extension.invoke' ||
        actor.subjectId !== pending.subject ||
        actor.originStoreId !== pending.storeId ||
        !run?.isActive ||
        run.contextSelectionId !== pending.selection ||
        session?.contextSelectionId !== pending.selection ||
        work.state !== 'eligible'
      )
        return failed('browser_human_request_expired_or_changed');
      const row = await context.records.get(key(pending.id));
      assertPending();
      if (
        !row ||
        row.forkProvenance ||
        row.originStoreId !== pending.storeId ||
        row.revision !== value.expectedRevision ||
        object(row.value).state !== 'pending'
      )
        return failed('browser_human_request_expired_or_changed');
      const marked = await context.records.write({
        key: row.key,
        expectedRevision: row.revision,
        contentType,
        contentVersion: 1,
        executable: true,
        value: {
          ...object(row.value),
          state: 'responding',
          responseExecutionId: context.executionId,
        },
      });
      assertPending();
      const carrier = pending.ref?.executionId
        ? await host.getExecution(pending.ref.executionId)
        : null;
      assertPending();
      if (
        carrier?.status !== 'running' ||
        carrier.cancelRequestedAt !== null ||
        carrier.definitionId !== jobId ||
        carrier.parentExecutionId !== pending.toolId ||
        carrier.originStoreId !== pending.storeId
      )
        return failed('browser_human_request_expired_or_changed');
      await verifyRequestSource(pending);
      assertPending();
      pending.unwatch?.(); // this explicit response now owns the finite transition
      const responseSignal = AbortSignal.any([context.signal, pending.abort.signal]);
      const result =
        value.choice === 'continue'
          ? await options.controller.resume(context.sessionId, pending.target, responseSignal)
          : await options.controller.close(context.sessionId, pending.target);
      const status =
        result.details && typeof result.details === 'object' && !Array.isArray(result.details)
          ? result.details
          : {};
      const resumedTarget =
        typeof status.browserId === 'string' && typeof status.generation === 'string'
          ? { browserId: status.browserId, generation: status.generation }
          : undefined;
      const relinquish = async (): Promise<ToolResult | null> => {
        const view = options.controller.view(context.sessionId);
        if (value.choice !== 'continue' || !resumedTarget) return null;
        if (view?.state === 'outcome_unknown')
          return { outcome: 'outcome_unknown', content: 'browser_human_return_unconfirmed' };
        if (
          view?.state !== 'agent' ||
          view.browserId !== resumedTarget.browserId ||
          view.generation !== resumedTarget.generation
        )
          return null;
        const returned = await options.controller.handoff(
          context.sessionId,
          resumedTarget,
          new AbortController().signal,
        );
        return returned.outcome === 'succeeded' ? null : returned;
      };
      const markUnknown = async () => {
        pending.responseUnknown = true;
        try {
          await context.records.write({
            key: row.key,
            expectedRevision: marked.revision,
            contentType,
            contentVersion: 1,
            executable: true,
            value: { ...object(marked.value), state: 'unknown' },
          });
          return true;
        } catch {
          return false;
        }
      };
      const returnWithoutNotification = async (failure: ToolResult): Promise<ToolResult> => {
        // Control cleanup must not depend on a successful diagnostic write. No
        // inclusion has been sent here, so only this exact resumed lease is returned.
        const returned = await relinquish().catch(() => ({
          outcome: 'outcome_unknown' as const,
          content: 'browser_human_return_unconfirmed',
        }));
        const final = returned ?? failure;
        settle(pending, final);
        if (!(await markUnknown()) && final.outcome !== 'outcome_unknown')
          return { outcome: 'outcome_unknown', content: 'browser_human_record_unconfirmed' };
        return final;
      };
      if (result.outcome !== 'succeeded') return returnWithoutNotification(result);
      try {
        await verifyRequestSource(pending);
      } catch {
        return returnWithoutNotification(failed('browser_human_source_changed'));
      }
      const current = await Promise.all([
        host.getRun(pending.taskRunId),
        host.getSession(pending.sessionId),
        host.readWorkEligibility({
          expectedStoreId: pending.storeId,
          sessionId: pending.sessionId,
          subjectId: pending.subject,
          rootWorkCommandId: pending.workId,
          rootWorkSeq: pending.workSeq,
          contextSelectionId: pending.selection,
        }),
      ]).catch(() => null);
      if (!current) return returnWithoutNotification(failed('browser_human_recheck_failed'));
      const [currentRun, currentSession, currentWork] = current;
      if (
        !currentRun?.isActive ||
        pending.abort.signal.aborted ||
        context.signal.aborted ||
        requests.get(context.sessionId) !== pending ||
        pending.expiresAt <= Date.now() ||
        currentRun.contextSelectionId !== pending.selection ||
        currentSession?.contextSelectionId !== pending.selection ||
        currentWork.state !== 'eligible'
      ) {
        return returnWithoutNotification(failed('browser_human_request_expired'));
      }
      const details = {
        requestId: pending.id,
        responseExecutionId: context.executionId,
        choice: value.choice!,
        browserId: pending.target.browserId,
        state: value.choice === 'continue' ? 'agent' : 'closed',
        ...(value.choice === 'continue' && resumedTarget
          ? {
              generation: resumedTarget.generation,
              page_ref: browserPageReference(
                {
                  storeId: pending.storeId,
                  sessionId: pending.sessionId,
                  runId: pending.taskRunId,
                },
                resumedTarget,
              ),
            }
          : {}),
      };
      settle(pending, { outcome: 'succeeded', content: JSON.stringify(details), details });
      const terminal = await context.operations
        .wait(pending.ref!, {
          timeoutMs: 5000,
          signal: context.signal,
        })
        .catch(() => null);
      if (
        terminal?.status !== 'succeeded' ||
        pending.abort.signal.aborted ||
        context.signal.aborted
      ) {
        return returnWithoutNotification({
          outcome: 'outcome_unknown',
          content: 'browser_human_result_unconfirmed',
        });
      }
      // This is the actual human response's explicit inclusion of a real Job
      // result, not a synthesized user message or after_turn subscription.
      let notified: Awaited<ReturnType<Host['includeResult']>>;
      try {
        notified = await host.includeResult({
          expectedStoreId: pending.storeId,
          sessionId: pending.sessionId,
          subjectId: actor.subjectId,
          commandId: `human-result-${pending.id}`,
          expectedContextSelectionId: pending.selection,
          executionId: terminal.id,
          resultRevision: terminal.resultRevision,
          targetRunId: pending.taskRunId,
        });
      } catch (error) {
        // A transport/storage error may follow committed inclusion. Never send
        // another notice or call it resolved. Known pre-commit eligibility
        // failures can relinquish only the exact lease this response resumed.
        if (
          error instanceof AgentError &&
          ['input_target_stopped', 'input_target_changed', 'context_selection_changed'].includes(
            error.code,
          )
        ) {
          return returnWithoutNotification(failed('browser_human_notification_expired'));
        }
        await markUnknown();
        return { outcome: 'outcome_unknown', content: 'browser_human_notification_unconfirmed' };
      }
      try {
        await context.records.write({
          key: row.key,
          expectedRevision: marked.revision,
          contentType,
          contentVersion: 1,
          executable: true,
          value: { ...object(marked.value), state: 'resolved' },
        });
      } catch {
        // Inclusion is already committed. A lost record receipt must not invite
        // another notice or pretend that the response was definitely rejected.
        pending.responseUnknown = true;
        return { outcome: 'outcome_unknown', content: 'browser_human_record_unconfirmed' };
      }
      pending.responseComplete = true;
      return {
        outcome: 'succeeded',
        content: JSON.stringify({ ...details, notificationCommandId: notified.command.id }),
        details: { ...details, notificationCommandId: notified.command.id },
      };
    },
  };
  const boundResponse = sealBrowserContinuationAction(response, async (command) => {
    const value = object(object(command.request).input!);
    if (value.choice !== 'continue') return undefined;
    const pending = requests.get(command.sessionId);
    const assertSource = () => {
      if (
        !pending ||
        requests.get(command.sessionId) !== pending ||
        pending.storeId !== command.originStoreId ||
        pending.subject !== command.subjectId ||
        pending.id !== value.requestId ||
        pending.target.browserId !== value.browserId ||
        pending.target.generation !== value.generation ||
        pending.result ||
        !pending.ready ||
        pending.abort.signal.aborted ||
        pending.expiresAt <= Date.now()
      )
        throw new AgentError('browser_human_request_expired_or_changed');
      return pending;
    };
    await verifyRequestSource(assertSource());
    const original = assertSource();
    return {
      runId: original.taskRunId,
      signal: original.abort.signal,
      purpose: {
        operation: 'continue_and_notify',
        requestId: original.id,
        reason: original.reason,
        browserId: original.target.browserId,
        generation: original.target.generation,
        effect:
          'Return automation control of this same granted page and include this exact human-response receipt into the original active task. This Continue itself does not navigate, click, fill or submit the page. Later page operations retain independent permission checks.',
      },
    };
  });
  return { job, records, conditions, request, response: boundResponse, read, owns };
}
export type BrowserHumanCoordinator = ReturnType<typeof createBrowserHumanCoordinator>;
