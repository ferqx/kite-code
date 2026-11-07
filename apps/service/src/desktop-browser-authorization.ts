import { createHash, randomUUID } from 'node:crypto';
import type { AgentRuntime } from '@kite-ai/agent';
import {
  type BrowserSharedPageIdentity,
  browserExtensionId,
  browserModelIntentKey,
} from '@kite-ai/agent/browser';
import type {
  AcceptedInformation,
  ExtensionRecord,
  JobContext,
  Json,
  ToolContext,
  ToolResult,
} from '@kite-ai/agent/extensions';

type Host = Pick<
  AgentRuntime,
  | 'getExecution'
  | 'getRun'
  | 'getCommand'
  | 'getInteraction'
  | 'readRunExtensionRecord'
  | 'getSession'
  | 'listMessages'
  | 'beginSessionExport'
  | 'readSessionExportPage'
>;
type Intent = { key: string; url: string };
type Proposal = {
  requestId: string;
  state: 'question' | 'ready' | 'committed' | 'cancelled' | 'expired';
  page: { kind: 'existing' | 'new'; id?: string; title: string; url: string };
  url: string;
  requireExisting?: true;
  existingPage?: BrowserSharedPageIdentity;
};
type DispatchProof = {
  digest: string;
  inputDigest: string;
  revision: string;
  policyDigest?: string;
};
type Saved = {
  requestId: string;
  executionId: string;
  sessionId: string;
  storeId: string;
  runId: string | null;
  /** Actual owning Run for the bounded browser.execute -> runless browser.open path. */
  taskRunId?: string;
  attempt: number;
  key: string;
  url: string;
  /** This exact new dispatch may only rebind the retained Main page. */
  requireExisting?: true;
  existingPage?: BrowserSharedPageIdentity;
  state: 'preparing' | 'asking' | 'committing' | 'ready' | 'denied' | 'cancelled' | 'unknown';
  failure?: string;
  cause?: string;
  question?: Json;
  questionCommandCursor?: string;
  questionRootSessionId?: string;
  rootWorkCommandId?: string;
  rootWorkSeq?: string;
  subjectId?: string;
  accepted?: AcceptedInformation;
  resolution?: 'allowed' | 'failed';
  receipt?: { interactionId: string; decisionRevision: string };
  dispatch?: DispatchProof;
};
/** Time-bound private Main request identity; persisted once and never refreshed on retry. */
export function createBrowserGrantRequestId() {
  const time = Date.now().toString(16).padStart(12, '0');
  const random = randomUUID();
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(15)}`;
}
const recordType = 'application/vnd.kite.browser-grant+json';
const refusalType = 'application/vnd.kite.browser-refusal+json';
type Work = {
  sessionId: string;
  originStoreId: string;
  rootWorkCommandId: string;
  rootWorkSeq: string;
  subjectId: string;
};
type WorkMarker = Work & {
  phase: 'pending' | 'resolved';
  executionId: string;
  runId: string | null;
  /** Actual owning Run for the bounded browser.execute -> runless browser.open path. */
  taskRunId?: string;
  attempt: number;
  grantId: string;
};
type Refusal = Work & {
  phase?: 'refused';
  executionId: string;
  runId: string | null;
  /** Actual owning Run for the bounded browser.execute -> runless browser.open path. */
  taskRunId?: string;
  attempt: number;
  upperSeq: string;
  boundarySessionId: string;
  answerCommandId: string;
  accepted: AcceptedInformation;
};
const workDigest = (work: Omit<Work, 'subjectId'>) =>
  createHash('sha256')
    .update(
      canonical([work.originStoreId, work.sessionId, work.rootWorkCommandId, work.rootWorkSeq]),
    )
    .digest('hex');
const refusalKey = (work: Work) => `grant/refusal/${workDigest(work)}`;
const grantPrefix = (work: Omit<Work, 'subjectId'>) => `grant/work/${workDigest(work)}/`;
const decimal = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value);
const sameWork = (value: Omit<Work, 'subjectId'>, work: Work) =>
  value.sessionId === work.sessionId &&
  value.originStoreId === work.originStoreId &&
  value.rootWorkCommandId === work.rootWorkCommandId &&
  value.rootWorkSeq === work.rootWorkSeq;

// These prepare-only denials precede creation/reservation of this exact intent.
// Never apply this list to commit, inspect, or a response whose delivery is unknown.
const prepareDenials = new Set([
  'page_request_invalid',
  'browser_page_grant_intent_conflict',
  'browser_page_grant_capacity',
  'browser_page_grant_expired',
  'browser_page_grant_pending',
  'browser_session_page_already_bound',
  'browser_page_scope_denied',
  'browser_page_capacity',
  'browser_page_existing_missing',
  'browser_page_existing_mismatch',
  'browser_page_existing_ambiguous',
]);
// Main expires these exact creation intents before any arm/lease is committed.
const commitFailures = new Set([
  'browser_page_grant_create_failed',
  'browser_page_initialization_failed',
  'browser_page_grant_changed',
  'browser_page_existing_missing',
  'browser_page_existing_mismatch',
]);
const keyFor = (executionId: string, work?: Omit<Work, 'subjectId'>) =>
  work ? `${grantPrefix(work)}${executionId}` : `grant/${executionId}`;
const savedKey = (saved: Saved) =>
  saved.rootWorkCommandId && saved.rootWorkSeq
    ? keyFor(saved.executionId, {
        originStoreId: saved.storeId,
        sessionId: saved.sessionId,
        rootWorkCommandId: saved.rootWorkCommandId,
        rootWorkSeq: saved.rootWorkSeq,
      })
    : keyFor(saved.executionId);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function pageIdentity(value: unknown): value is BrowserSharedPageIdentity {
  return (
    object(value) &&
    Object.keys(value).sort().join(',') === 'incarnation,pageId' &&
    ['pageId', 'incarnation'].every(
      (key) => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 128,
    )
  );
}
function samePageIdentity(left: unknown, right: BrowserSharedPageIdentity | undefined) {
  return right === undefined
    ? left === undefined
    : pageIdentity(left) && left.pageId === right.pageId && left.incarnation === right.incarnation;
}
const json = (value: unknown) => value as Json;
function normalizedUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, entry) =>
    object(entry)
      ? Object.fromEntries(
          Object.keys(entry)
            .sort()
            .map((key) => [key, entry[key]]),
        )
      : entry,
  );
const sameDispatch = (left: DispatchProof, right: DispatchProof) =>
  left.digest === right.digest &&
  left.inputDigest === right.inputDigest &&
  left.revision === right.revision;
const result = (code: string, unknown = false, cause?: string): ToolResult => ({
  outcome: unknown ? 'outcome_unknown' : 'failed',
  content: ['browser_page_grant_expired', 'browser_page_grant_changed'].includes(code)
    ? `${code}: 原请求的页面授权或选择已经失效。停止本次尝试，不要更换 key、网址或改用 ask_user 重问；需要用户新的明确指令后才能重新申请。`
    : code === 'browser_page_grant_denied'
      ? `${code}: 用户已拒绝本次工作的浏览器接管。结束这次尝试，不要更换 key、网址或改用 ask_user 再次请求。只有用户新的明确业务指令才可重新请求页面授权。`
      : code,
  details: { code, ...(cause ? { cause } : {}) },
});
function parseProposal(value: unknown, saved: Saved): Proposal {
  if (
    !object(value) ||
    value.requestId !== saved.requestId ||
    value.url !== saved.url ||
    typeof value.state !== 'string' ||
    !['question', 'ready', 'committed', 'cancelled', 'expired'].includes(value.state) ||
    !object(value.page) ||
    typeof value.page.kind !== 'string' ||
    !['existing', 'new'].includes(value.page.kind) ||
    typeof value.page.title !== 'string' ||
    typeof value.page.url !== 'string' ||
    (value.page.kind === 'existing' && typeof value.page.id !== 'string') ||
    value.requireExisting !== saved.requireExisting ||
    !samePageIdentity(value.existingPage, saved.existingPage) ||
    (saved.existingPage !== undefined && value.page.id !== saved.existingPage.pageId) ||
    (saved.requireExisting === true &&
      (value.page.kind !== 'existing' || normalizedUrl(value.page.url) !== saved.url))
  )
    throw Error('browser_page_grant_response_invalid');
  return value as unknown as Proposal;
}
function readSaved(record: ExtensionRecord | null): Saved | null {
  if (!record) return null;
  const value = record.value;
  if (
    record.extensionId !== browserExtensionId ||
    record.contentType !== recordType ||
    record.contentVersion !== 1 ||
    record.forkProvenance ||
    !object(value) ||
    !['requestId', 'executionId', 'sessionId', 'storeId', 'key', 'url', 'state'].every(
      (key) => typeof value[key] === 'string',
    ) ||
    (typeof value.runId !== 'string' && value.runId !== null) ||
    (value.taskRunId !== undefined && typeof value.taskRunId !== 'string') ||
    (value.requireExisting !== undefined && value.requireExisting !== true) ||
    (value.existingPage !== undefined &&
      (value.requireExisting !== true || !pageIdentity(value.existingPage))) ||
    typeof value.attempt !== 'number' ||
    (value.dispatch !== undefined &&
      (!object(value.dispatch) ||
        Object.keys(value.dispatch).some(
          (key) => !['digest', 'inputDigest', 'revision', 'policyDigest'].includes(key),
        ) ||
        !/^[a-f0-9]{64}$/.test(String(value.dispatch.digest)) ||
        !/^[a-f0-9]{64}$/.test(String(value.dispatch.inputDigest)) ||
        typeof value.dispatch.revision !== 'string' ||
        !value.dispatch.revision ||
        (value.dispatch.policyDigest !== undefined &&
          !/^[a-f0-9]{64}$/.test(String(value.dispatch.policyDigest)))))
  )
    throw Error('browser_page_grant_record_invalid');
  return value as unknown as Saved;
}

/** Bind the original accepted Tool dispatch to one exact Main-owned page intent. */
export function createDesktopBrowserAuthorization(options: {
  runtime(): Host;
  call(input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  releasedPage?(
    sessionId: string,
    url?: string,
  ): Readonly<{ url: string; identity?: BrowserSharedPageIdentity }> | null | undefined;
  invalidateMissingReleasedPage?(sessionId: string, identity: BrowserSharedPageIdentity): void;
}) {
  const cleanup = new WeakMap<ToolContext, () => Promise<unknown>>();
  /** Keep the child/Question runId truthful; only this exact direct parent binds a Run. */
  async function executionRunId(
    execution: NonNullable<Awaited<ReturnType<Host['getExecution']>>>,
    live = false,
  ): Promise<string> {
    if (execution.runId) return execution.runId;
    const host = options.runtime();
    const parent = execution.parentExecutionId
      ? await host.getExecution(execution.parentExecutionId)
      : null;
    if (
      parent?.kind !== 'tool' ||
      parent.definitionId !== 'browser.execute' ||
      parent.definitionVersion !== '1' ||
      !parent.runId ||
      parent.sessionId !== execution.sessionId ||
      parent.originStoreId !== execution.originStoreId ||
      parent.rootWorkCommandId !== execution.rootWorkCommandId ||
      parent.rootWorkSeq !== execution.rootWorkSeq ||
      (live &&
        (parent.cancelRequestedAt !== null || !['dispatching', 'running'].includes(parent.status)))
    )
      throw Error('browser_page_grant_scope_invalid');
    const run = await host.getRun(parent.runId);
    if (
      !run ||
      run.originCommandId !== parent.originCommandId ||
      run.sessionId !== execution.sessionId ||
      run.originStoreId !== execution.originStoreId ||
      run.rootWorkCommandId !== execution.rootWorkCommandId ||
      run.rootWorkSeq !== execution.rootWorkSeq ||
      (live && !run.isActive)
    )
      throw Error('browser_page_grant_scope_invalid');
    return run.id;
  }
  async function ownScope(context: ToolContext, intent: Intent) {
    const host = options.runtime();
    const own = await host.getExecution(context.executionId);
    const taskRunId = own ? await executionRunId(own, true) : null;
    const run = taskRunId ? await host.getRun(taskRunId) : null;
    const origin = run ? await host.getCommand(run.originCommandId) : null;
    if (
      !own ||
      !run?.isActive ||
      !origin?.subjectId ||
      own.id !== context.executionId ||
      own.kind !== 'tool' ||
      own.definitionId !== 'browser.open' ||
      own.definitionVersion !== '1' ||
      own.sessionId !== context.sessionId ||
      run.sessionId !== context.sessionId ||
      own.runId !== context.runId ||
      own.originStoreId !== origin.originStoreId ||
      own.rootWorkCommandId !== run.rootWorkCommandId ||
      own.rootWorkSeq !== run.rootWorkSeq ||
      own.rootWorkCommandId !== origin.rootWorkCommandId ||
      own.rootWorkSeq !== origin.rootWorkSeq ||
      !decimal(own.rootWorkSeq) ||
      run.originStoreId !== own.originStoreId ||
      !['dispatching', 'running'].includes(own.status) ||
      own.cancelRequestedAt !== null ||
      !object(own.input) ||
      (own.input.key ?? browserModelIntentKey(own.id)) !== intent.key ||
      normalizedUrl(own.input.url) !== intent.url
    )
      throw Error('browser_page_grant_scope_invalid');
    context.signal.throwIfAborted();
    const root = await host.getCommand(own.rootWorkCommandId);
    if (
      !root ||
      root.id !== own.rootWorkCommandId ||
      root.originStoreId !== own.originStoreId ||
      root.rootWorkCommandId !== root.id ||
      root.rootWorkSeq !== own.rootWorkSeq ||
      root.subjectId !== origin.subjectId
    )
      throw Error('browser_page_grant_scope_invalid');
    return { ...own, taskRunId: run.id, subjectId: origin.subjectId };
  }
  async function dispatchProof(
    context: ToolContext,
    own: Awaited<ReturnType<typeof ownScope>>,
  ): Promise<DispatchProof> {
    const authorization = context.dispatchAuthorization;
    if (!authorization?.revision || own.authorization?.dispatched !== true)
      throw Error('browser_page_dispatch_authorization_unavailable');
    const inputDigest = createHash('sha256').update(canonical(own.input)).digest('hex');
    const digest = createHash('sha256')
      .update(
        canonical({
          executionId: own.id,
          attempt: own.attempt,
          definitionId: own.definitionId,
          definitionVersion: own.definitionVersion,
          sessionId: own.sessionId,
          originStoreId: own.originStoreId,
          originCommandId: own.originCommandId,
          rootWorkCommandId: own.rootWorkCommandId,
          rootWorkSeq: own.rootWorkSeq,
          runId: own.runId,
          taskRunId: own.taskRunId,
          inputDigest,
          authorization,
        }),
      )
      .digest('hex');
    return {
      digest,
      inputDigest,
      revision: authorization.revision,
    };
  }
  async function validateRefusal(
    record: ExtensionRecord,
    work: Work,
    control = 'deny',
  ): Promise<Refusal> {
    const value = record.value;
    if (
      record.contentType !== refusalType ||
      record.contentVersion !== 1 ||
      record.forkProvenance ||
      record.originStoreId !== work.originStoreId ||
      record.sessionId !== work.sessionId ||
      record.extensionId !== browserExtensionId ||
      !object(value) ||
      !sameWork(value as unknown as Work, work) ||
      value.subjectId !== work.subjectId ||
      !decimal(value.upperSeq) ||
      typeof value.boundarySessionId !== 'string' ||
      typeof value.answerCommandId !== 'string' ||
      typeof value.executionId !== 'string' ||
      (typeof value.runId !== 'string' && value.runId !== null) ||
      (value.taskRunId !== undefined && typeof value.taskRunId !== 'string') ||
      typeof value.attempt !== 'number' ||
      !object(value.accepted)
    )
      throw Error('browser_page_grant_refusal_unconfirmed');
    const refusal = value as unknown as Refusal,
      host = options.runtime();
    const original = await host.getExecution(refusal.executionId);
    const taskRunId = original ? await executionRunId(original) : null;
    const run = taskRunId ? await host.getRun(taskRunId) : null;
    const accepted = refusal.accepted;
    const answer = await host.getCommand(refusal.answerCommandId);
    const interaction = await host.getInteraction({
      expectedStoreId: work.originStoreId,
      sessionId: work.sessionId,
      interactionId: accepted.interactionId,
    });
    if (
      original?.kind !== 'tool' ||
      original.definitionId !== 'browser.open' ||
      original.definitionVersion !== '1' ||
      !sameWork(original, work) ||
      original.runId !== refusal.runId ||
      taskRunId !== (refusal.taskRunId ?? refusal.runId) ||
      original.attempt !== refusal.attempt ||
      !run ||
      !sameWork(run, work) ||
      !validReceipt(
        accepted,
        {
          executionId: original.id,
          sessionId: work.sessionId,
          storeId: work.originStoreId,
          runId: refusal.runId,
          attempt: refusal.attempt,
        } as Saved,
        accepted.request,
      ) ||
      !validAnswerCommand(answer, refusal, accepted) ||
      accepted.answer.kind !== 'question' ||
      !object(accepted.answer.answers) ||
      accepted.answer.answers.control !== control ||
      !interaction ||
      interaction.kind !== 'question' ||
      interaction.state !== 'answered' ||
      interaction.originStoreId !== work.originStoreId ||
      interaction.sessionId !== work.sessionId ||
      interaction.subjectId !== work.subjectId ||
      interaction.presentationSessionId !== refusal.boundarySessionId ||
      interaction.runId !== refusal.runId ||
      interaction.executionId !== original.id ||
      interaction.attempt !== refusal.attempt ||
      interaction.definitionId !== 'browser.open' ||
      interaction.definitionVersion !== '1' ||
      interaction.acceptedDecisionRevision !== accepted.decisionRevision ||
      canonical(interaction.request) !== canonical(accepted.request) ||
      canonical(interaction.answer) !== canonical(accepted.answer)
    )
      throw Error('browser_page_grant_refusal_unconfirmed');
    return refusal;
  }
  async function newHumanBusiness(work: Work, refusal: Refusal) {
    const host = options.runtime(),
      session = await host.getSession(work.sessionId);
    if (
      !session ||
      session.id !== work.sessionId ||
      !decimal(session.nextSeq) ||
      BigInt(session.nextSeq) < BigInt(refusal.upperSeq)
    )
      throw Error('browser_page_grant_refusal_unconfirmed');
    if (session.id !== refusal.boundarySessionId) return false;
    let afterSeq = refusal.upperSeq;
    for (let page = 0; page < 4; page++) {
      const messages = await host.listMessages(work.sessionId, {
        afterSeq,
        upperSeq: session.nextSeq,
        limit: 200,
      });
      for (const message of messages) {
        if (
          !decimal(message.seq) ||
          BigInt(message.seq) <= BigInt(afterSeq) ||
          BigInt(message.seq) > BigInt(session.nextSeq) ||
          message.sessionId !== work.sessionId
        )
          throw Error('browser_page_grant_refusal_unconfirmed');
        afterSeq = message.seq;
        if (
          message.role !== 'user' ||
          !['input.steer', 'input.follow_up'].includes(message.inputKind ?? '') ||
          !message.originCommandId ||
          !message.runId ||
          message.status !== 'complete' ||
          message.sourceIds?.length !== 1 ||
          message.sourceIds[0] !== message.originCommandId
        )
          continue;
        const command = await host.getCommand(message.originCommandId),
          run = await host.getRun(message.runId);
        if (
          !command ||
          !sameWork(command, work) ||
          command.subjectId !== work.subjectId ||
          command.status !== 'applied' ||
          command.cancelRequestedAt !== null ||
          command.kind !== message.inputKind ||
          !decimal(command.seq) ||
          BigInt(command.seq) <= BigInt(refusal.upperSeq) ||
          !object(command.receipt) ||
          command.receipt.outcome !== 'input_applied' ||
          command.receipt.messageId !== message.id ||
          command.receipt.runId !== message.runId ||
          command.receipt.contextSelectionId !== message.contextSelectionId ||
          !object(command.request) ||
          command.request.kind !== message.inputKind ||
          command.request.contextSelectionId !== message.contextSelectionId ||
          (command.kind === 'input.steer' && command.request.targetRunId !== message.runId) ||
          !run ||
          !sameWork(run, work) ||
          run.contextSelectionId !== message.contextSelectionId
        )
          continue;
        const inputId = command.receipt.humanInputCommandId;
        if (typeof inputId === 'string') {
          const human = await host.getCommand(inputId);
          const decisionId = command.receipt.decisionCommandId;
          const decision =
            typeof decisionId === 'string' ? await host.getCommand(decisionId) : null;
          if (
            human?.kind !== 'human.input' ||
            human.originStoreId !== work.originStoreId ||
            human.sessionId !== work.sessionId ||
            human.subjectId !== work.subjectId ||
            !decimal(human.seq) ||
            BigInt(human.seq) <= BigInt(refusal.upperSeq) ||
            human.cancelRequestedAt !== null ||
            !object(human.receipt) ||
            human.receipt.applicationState !== 'applied' ||
            human.receipt.businessCommandId !== command.id ||
            human.receipt.messageId !== message.id ||
            human.receipt.runId !== message.runId ||
            !decision ||
            decision.kind !== 'human.input.decision' ||
            decision.status !== 'applied' ||
            !sameWork(decision, work) ||
            decision.subjectId !== work.subjectId ||
            !object(decision.request) ||
            decision.request.inputCommandId !== human.id ||
            decision.request.inputDigest !== human.requestDigest ||
            !object(decision.receipt) ||
            decision.receipt.businessCommandId !== command.id ||
            !['work', 'continue', 'replace'].includes(String(decision.receipt.purpose))
          )
            continue;
          return true;
        }
        // Current ordinary input bypasses the retired interpreter. Core accepts
        // direct human input at group roots; operation-derived steers only target
        // owned child Sessions, and Agent mail is projected as a system message.
        if (session.parentSessionId === null && session.rootSessionId === session.id) return true;
      }
      if (messages.length < 200 || afterSeq === session.nextSeq) return false;
    }
    throw Error('browser_page_grant_refusal_unconfirmed');
  }
  function markerValue(record: ExtensionRecord, work: Work) {
    const value = record.value;
    if (
      record.contentType !== refusalType ||
      record.contentVersion !== 1 ||
      record.forkProvenance ||
      record.originStoreId !== work.originStoreId ||
      record.sessionId !== work.sessionId ||
      record.extensionId !== browserExtensionId ||
      !object(value) ||
      !sameWork(value as unknown as Work, work) ||
      value.subjectId !== work.subjectId
    )
      throw Error('browser_page_grant_refusal_unconfirmed');
    return value;
  }
  async function markerSource(context: ToolContext, work: Work, marker: Record<string, unknown>) {
    if (
      typeof marker.executionId !== 'string' ||
      (typeof marker.runId !== 'string' && marker.runId !== null) ||
      (marker.taskRunId !== undefined && typeof marker.taskRunId !== 'string') ||
      typeof marker.attempt !== 'number' ||
      typeof marker.grantId !== 'string'
    )
      throw Error('browser_page_grant_refusal_unconfirmed');
    const original = await options.runtime().getExecution(marker.executionId);
    const record =
      (await context.records.get(keyFor(marker.executionId, work))) ??
      (await context.records.get(keyFor(marker.executionId)));
    const saved = readSaved(record);
    if (
      original?.kind !== 'tool' ||
      original.definitionId !== 'browser.open' ||
      original.definitionVersion !== '1' ||
      !sameWork(original, work) ||
      original.runId !== marker.runId ||
      (await executionRunId(original)) !== (marker.taskRunId ?? marker.runId) ||
      original.attempt !== marker.attempt ||
      !saved ||
      record?.originStoreId !== work.originStoreId ||
      record.sessionId !== work.sessionId ||
      saved.executionId !== original.id ||
      saved.sessionId !== work.sessionId ||
      saved.storeId !== work.originStoreId ||
      saved.runId !== original.runId ||
      (saved.taskRunId ?? saved.runId) !== (marker.taskRunId ?? marker.runId) ||
      saved.attempt !== original.attempt ||
      saved.requestId !== marker.grantId ||
      !object(original.input) ||
      (original.input.key ?? browserModelIntentKey(original.id)) !== saved.key ||
      normalizedUrl(original.input.url) !== saved.url
    )
      throw Error('browser_page_grant_refusal_unconfirmed');
    return { saved, original, record };
  }
  const resolved = (saved: Saved) =>
    (saved.state === 'ready' && saved.resolution === 'allowed') ||
    (['denied', 'cancelled'].includes(saved.state) && saved.resolution === 'failed');
  async function pendingBlock(
    work: Work,
    saved: Saved,
    original: Awaited<ReturnType<Host['getExecution']>> & {},
    record: ExtensionRecord,
  ) {
    if (resolved(saved)) return undefined;
    if (saved.accepted && saved.question) {
      const accepted = saved.accepted;
      const answer = await refusalAnswer(
        { ...original, taskRunId: await executionRunId(original), subjectId: work.subjectId },
        accepted,
        saved,
      );
      const proof: Refusal = {
        ...work,
        executionId: original.id,
        runId: saved.runId,
        ...(saved.taskRunId ? { taskRunId: saved.taskRunId } : {}),
        attempt: saved.attempt,
        upperSeq: answer.seq,
        boundarySessionId: answer.sessionId,
        answerCommandId: answer.id,
        accepted,
      };
      const choice =
        accepted.answer.kind === 'question' && object(accepted.answer.answers)
          ? accepted.answer.answers.control
          : null;
      if (choice !== 'allow' && choice !== 'deny')
        throw Error('browser_page_grant_refusal_unconfirmed');
      await validateRefusal(
        { ...record, contentType: refusalType, value: json(proof) },
        work,
        choice,
      );
      if (await newHumanBusiness(work, proof)) return undefined;
    }
    if (
      ['dispatching', 'running'].includes(original.status) &&
      ['preparing', 'asking'].includes(saved.state) &&
      !saved.accepted
    )
      return result('browser_page_grant_pending');
    return saved.failure === 'browser_page_grant_cancel_unconfirmed'
      ? result(saved.failure, true, saved.cause)
      : result('browser_page_grant_refusal_unconfirmed', true);
  }
  async function refused(context: ToolContext, work: Work) {
    try {
      const record = await context.records.get(refusalKey(work));
      if (record) {
        const value = markerValue(record, work);
        if (value.phase === 'pending' || value.phase === 'resolved') {
          const source = await markerSource(context, work, value);
          return pendingBlock(work, source.saved, source.original, source.record);
        }
        const refusal = await validateRefusal(record, work);
        return (await newHumanBusiness(work, refusal))
          ? undefined
          : result('browser_page_grant_denied');
      }
      // Only this work's indexed original intents are relevant. Unrelated
      // Session history never creates a new browser history limit.
      const prefix = grantPrefix(work);
      let afterKey = prefix;
      for (let page = 0; page < 4; page++) {
        const records = await context.records.list({
          afterKey,
          contentType: recordType,
          limit: 200,
        });
        for (const prior of records) {
          if (!prior.key.startsWith(prefix)) return undefined;
          afterKey = prior.key;
          const saved = readSaved(prior);
          if (
            !saved ||
            prior.originStoreId !== work.originStoreId ||
            prior.sessionId !== work.sessionId ||
            saved.rootWorkCommandId !== work.rootWorkCommandId ||
            saved.rootWorkSeq !== work.rootWorkSeq ||
            saved.subjectId !== work.subjectId
          )
            throw Error('browser_page_grant_refusal_unconfirmed');
          const source = await markerSource(context, work, {
            executionId: saved.executionId,
            runId: saved.runId,
            ...(saved.taskRunId ? { taskRunId: saved.taskRunId } : {}),
            attempt: saved.attempt,
            grantId: saved.requestId,
          });
          const blocked = await pendingBlock(work, saved, source.original, prior);
          if (blocked) return blocked;
        }
        if (records.length < 200) return undefined;
      }
      throw Error('browser_page_grant_refusal_unconfirmed');
    } catch {
      throw Error('browser_page_grant_refusal_unconfirmed');
    }
  }
  async function claimWork(
    context: ToolContext,
    own: Awaited<ReturnType<typeof ownScope>>,
    saved: Saved,
  ) {
    const key = refusalKey(own),
      prior = await context.records.get(key);
    if (prior) {
      const priorValue = markerValue(prior, own);
      if (priorValue.phase === 'pending' || priorValue.phase === 'resolved') {
        const source = await markerSource(context, own, priorValue);
        if (await pendingBlock(own, source.saved, source.original, source.record))
          throw Error('browser_page_grant_refusal_unconfirmed');
      } else {
        const refusal = await validateRefusal(prior, own);
        if (!(await newHumanBusiness(own, refusal)))
          throw Error('browser_page_grant_refusal_unconfirmed');
      }
    }
    const value: WorkMarker = {
      phase: 'pending',
      sessionId: own.sessionId,
      originStoreId: own.originStoreId,
      rootWorkCommandId: own.rootWorkCommandId,
      rootWorkSeq: own.rootWorkSeq,
      subjectId: own.subjectId,
      executionId: own.id,
      runId: own.runId,
      ...(own.runId === null ? { taskRunId: own.taskRunId } : {}),
      attempt: own.attempt,
      grantId: saved.requestId,
    };
    try {
      await context.records.write({
        key,
        expectedRevision: prior?.revision ?? null,
        contentType: refusalType,
        contentVersion: 1,
        executable: true,
        value: json(value),
      });
    } catch {
      const actual = await context.records.get(key);
      if (!actual || canonical(markerValue(actual, own)) !== canonical(value))
        throw Error('browser_page_grant_refusal_unconfirmed');
    }
  }
  async function settleWork(context: ToolContext, saved: Saved) {
    if (!saved.rootWorkCommandId || !saved.rootWorkSeq || !saved.subjectId)
      throw Error('browser_page_grant_refusal_unconfirmed');
    const work: Work = {
      originStoreId: saved.storeId,
      sessionId: saved.sessionId,
      rootWorkCommandId: saved.rootWorkCommandId,
      rootWorkSeq: saved.rootWorkSeq,
      subjectId: saved.subjectId,
    };
    const key = refusalKey(work),
      current = await context.records.get(key);
    if (!current) throw Error('browser_page_grant_refusal_unconfirmed');
    const value = markerValue(current, work);
    if (
      value.phase === 'resolved' &&
      value.executionId === saved.executionId &&
      value.grantId === saved.requestId
    )
      return;
    if (
      value.phase !== 'pending' ||
      value.executionId !== saved.executionId ||
      value.grantId !== saved.requestId
    )
      throw Error('browser_page_grant_refusal_unconfirmed');
    try {
      await context.records.write({
        key,
        expectedRevision: current.revision,
        contentType: refusalType,
        contentVersion: 1,
        executable: true,
        value: json({ ...value, phase: 'resolved' }),
      });
    } catch {
      const actual = await context.records.get(key);
      if (
        !actual ||
        canonical(markerValue(actual, work)) !== canonical({ ...value, phase: 'resolved' })
      )
        throw Error('browser_page_grant_refusal_unconfirmed');
    }
  }
  function validAnswerCommand(
    command: Awaited<ReturnType<Host['getCommand']>>,
    refusal: Pick<
      Refusal,
      | 'originStoreId'
      | 'rootWorkCommandId'
      | 'rootWorkSeq'
      | 'subjectId'
      | 'boundarySessionId'
      | 'upperSeq'
    >,
    accepted: AcceptedInformation,
  ) {
    return (
      !!command &&
      command.kind === 'interaction.answer' &&
      command.status === 'applied' &&
      command.originStoreId === refusal.originStoreId &&
      command.subjectId === refusal.subjectId &&
      command.rootWorkCommandId === refusal.rootWorkCommandId &&
      command.rootWorkSeq === refusal.rootWorkSeq &&
      command.sessionId === refusal.boundarySessionId &&
      command.seq === refusal.upperSeq &&
      command.cancelRequestedAt === null &&
      object(command.request) &&
      command.request.kind === 'interaction.answer' &&
      command.request.interactionId === accepted.interactionId &&
      canonical(command.request.answer) === canonical(accepted.answer) &&
      object(command.receipt) &&
      command.receipt.interactionId === accepted.interactionId &&
      command.receipt.decisionRevision === accepted.decisionRevision &&
      command.receipt.outcome === 'answer_saved' &&
      command.receipt.cancelled === false
    );
  }
  async function refusalAnswer(
    own: Awaited<ReturnType<typeof ownScope>>,
    accepted: AcceptedInformation,
    saved: Saved,
  ) {
    if (!saved.questionRootSessionId || !decimal(saved.questionCommandCursor))
      throw Error('browser_page_grant_refusal_unconfirmed');
    const host = options.runtime();
    const scope = {
      expectedStoreId: own.originStoreId,
      sessionId: saved.questionRootSessionId,
      subjectId: own.subjectId,
    };
    for (let retry = 0; retry < 3; retry++) {
      try {
        const manifest = await host.beginSessionExport(scope);
        if (manifest.storeId !== own.originStoreId || manifest.rootSessionId !== scope.sessionId)
          throw Error('browser_page_grant_refusal_unconfirmed');
        let afterSeq = saved.questionCommandCursor;
        for (let page = 0; page < 4; page++) {
          const entries = await host.readSessionExportPage({
            ...scope,
            manifest,
            section: 'commands',
            afterSeq,
            limit: 200,
          });
          for (const entry of entries.records) {
            if (!object(entry.record) || entry.record.kind !== 'interaction.answer') continue;
            const command = await host.getCommand(entry.id);
            if (!command || !decimal(command.seq)) continue;
            const boundary = { ...own, boundarySessionId: scope.sessionId, upperSeq: command.seq };
            if (validAnswerCommand(command, boundary, accepted)) return command;
          }
          if (!entries.nextAfterSeq) break;
          afterSeq = entries.nextAfterSeq;
        }
        throw Error('browser_page_grant_refusal_unconfirmed');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'export_changed')
          throw error;
      }
    }
    throw Error('browser_page_grant_refusal_unconfirmed');
  }
  async function cancel(requestId: string) {
    const reply = await options.call({ op: 'cancelGrant', requestId });
    if (!object(reply) || reply.requestId !== requestId)
      throw Error('browser_page_grant_cancel_unconfirmed');
    return reply;
  }
  async function cancelOpen(context: ToolContext): Promise<ToolResult | undefined> {
    try {
      const current = cleanup.get(context);
      if (current) {
        await current();
        return undefined;
      }
      const original = await options.runtime().getExecution(context.executionId);
      const saved = readSaved(
        (await context.records.get(keyFor(context.executionId, original ?? undefined))) ??
          (await context.records.get(keyFor(context.executionId))),
      );
      if (
        saved &&
        saved.executionId === context.executionId &&
        saved.sessionId === context.sessionId
      )
        await cancel(saved.requestId);
    } catch {
      return result('browser_page_grant_cancel_unconfirmed', true);
    }
    return undefined;
  }
  async function prepareOpen(
    context: ToolContext,
    intent: Intent,
  ): Promise<ToolResult | undefined> {
    let record: ExtensionRecord | null = null;
    let saved: Saved | null = null;
    let cancelPromise: Promise<unknown> | undefined;
    let remoteIntentPossible = false;
    const abort = () => {
      if (saved && remoteIntentPossible && !cancelPromise) {
        cancelPromise = cancel(saved.requestId);
        void cancelPromise.catch(() => {});
      }
    };
    const write = async () => {
      record = await context.records.write({
        key: saved ? savedKey(saved) : keyFor(context.executionId),
        expectedRevision: record?.revision ?? null,
        contentType: recordType,
        contentVersion: 1,
        executable: true,
        value: json(saved),
      });
    };
    const inspect = async () =>
      parseProposal(
        await options.call({ op: 'inspectGrant', requestId: saved!.requestId }),
        saved!,
      );
    try {
      const own = await ownScope(context, intent);
      const authorized = await dispatchProof(context, own);
      const blocked = await refused(context, own);
      if (blocked) return blocked;
      record =
        (await context.records.get(keyFor(own.id, own))) ??
        (await context.records.get(keyFor(own.id)));
      saved = readSaved(record);
      if (
        saved &&
        (record?.originStoreId !== own.originStoreId ||
          record.sessionId !== own.sessionId ||
          saved.executionId !== own.id ||
          saved.sessionId !== own.sessionId ||
          saved.storeId !== own.originStoreId ||
          saved.runId !== own.runId ||
          (saved.taskRunId ?? saved.runId) !== own.taskRunId ||
          saved.attempt !== own.attempt ||
          saved.key !== intent.key ||
          saved.url !== intent.url ||
          (saved.dispatch !== undefined && !sameDispatch(saved.dispatch, authorized)))
      )
        return result('browser_page_grant_intent_conflict');
      // Historical consent/unknown records are observations, never a fresh grant.
      // A new browser request uses only its own exact live dispatch proof.
      if (
        saved &&
        (!saved.dispatch ||
          saved.state === 'asking' ||
          saved.state === 'unknown' ||
          saved.question !== undefined ||
          saved.accepted !== undefined)
      )
        return result(saved.failure ?? 'browser_page_grant_unconfirmed', true, saved.cause);
      const first = saved === null;
      remoteIntentPossible = !first;
      if (!saved) {
        let released:
          | Readonly<{ url: string; identity?: BrowserSharedPageIdentity }>
          | null
          | undefined;
        try {
          released = options.releasedPage?.(own.sessionId, intent.url);
        } catch (error) {
          // The trusted metadata lookup is passive and runs before any remote intent.
          if (
            error instanceof Error &&
            ['browser_page_existing_ambiguous', 'browser_page_recovery_required'].includes(
              error.message,
            )
          )
            return result(error.message);
          throw error;
        }
        const requireExisting = normalizedUrl(released?.url) === intent.url,
          existingPage =
            requireExisting && pageIdentity(released?.identity)
              ? { ...released.identity }
              : undefined;
        saved = {
          requestId: createBrowserGrantRequestId(),
          executionId: own.id,
          sessionId: own.sessionId,
          storeId: own.originStoreId,
          runId: own.runId,
          ...(own.runId === null ? { taskRunId: own.taskRunId } : {}),
          attempt: own.attempt,
          rootWorkCommandId: own.rootWorkCommandId,
          rootWorkSeq: own.rootWorkSeq,
          subjectId: own.subjectId,
          ...intent,
          ...(requireExisting ? { requireExisting: true as const } : {}),
          ...(existingPage ? { existingPage } : {}),
          state: 'preparing',
          dispatch: authorized,
        };
        await write();
        await claimWork(context, own, saved);
        if (requireExisting && !existingPage) {
          saved.state = 'denied';
          saved.failure = 'browser_page_existing_mismatch';
          saved.resolution = 'failed';
          await write();
          await settleWork(context, saved);
          return result(saved.failure);
        }
      }
      // Cleanup retains only this live original request identity. It cannot grant a
      // permit or bypass persistent parent/receipt checks after a Service restart.
      cleanup.set(context, () => {
        abort();
        return cancelPromise ?? Promise.resolve();
      });
      context.signal.addEventListener('abort', abort, { once: true });
      context.signal.throwIfAborted();
      if (saved.state === 'denied') return result(saved.failure ?? 'browser_page_grant_denied');
      if (saved.state === 'cancelled') return result('browser_page_grant_cancelled');
      if (saved.state === 'unknown' && saved.failure === 'browser_page_grant_cancel_unconfirmed')
        return result(saved.failure, true, saved.cause);
      let proposal: Proposal;
      if (first) {
        try {
          remoteIntentPossible = true;
          proposal = parseProposal(
            await options.call(
              {
                op: 'prepareGrant',
                requestId: saved.requestId,
                storeId: saved.storeId,
                sessionId: saved.sessionId,
                executionId: saved.executionId,
                browserId: saved.key,
                url: saved.url,
                ...(saved.requireExisting ? { requireExisting: true } : {}),
                ...(saved.existingPage ? { existingPage: { ...saved.existingPage } } : {}),
              },
              context.signal,
            ),
            saved,
          );
        } catch (error) {
          if (error instanceof Error && prepareDenials.has(error.message)) {
            remoteIntentPossible = false;
            saved.state = 'denied';
            saved.failure = error.message;
            saved.resolution = 'failed';
            await write();
            await settleWork(context, saved);
            if (error.message === 'browser_page_existing_missing' && saved.existingPage)
              options.invalidateMissingReleasedPage?.(saved.sessionId, saved.existingPage);
            return result(error.message);
          }
          // A lost response never creates a fresh consent intent or repeats a mutating POST.
          proposal = await inspect();
        }
      } else proposal = await inspect();
      context.signal.throwIfAborted();
      if (proposal.state === 'cancelled' || proposal.state === 'expired') {
        saved.state = 'cancelled';
        saved.resolution = 'failed';
        await write();
        await settleWork(context, saved);
        return result(`browser_page_grant_${proposal.state}`);
      }
      if (proposal.state === 'ready' || proposal.state === 'committed') {
        if (
          !sameDispatch(await dispatchProof(context, await ownScope(context, intent)), authorized)
        )
          throw Error('browser_page_grant_scope_invalid');
        saved.state = 'ready';
        saved.resolution = 'allowed';
        await write();
        await settleWork(context, saved);
        return;
      }
      if (saved.state !== 'preparing') return result('browser_page_grant_unconfirmed', true);
      // Browser operations require no review or approval. The original dispatch
      // still binds this reservation to its exact live task and Main-owned page.
      if (!saved.dispatch) return result('browser_page_grant_unconfirmed', true);
      saved.state = 'committing';
      await write();
      if (!sameDispatch(await dispatchProof(context, await ownScope(context, intent)), authorized))
        throw Error('browser_page_grant_scope_invalid');
      try {
        proposal = parseProposal(
          await options.call(
            {
              op: 'commitGrant',
              requestId: saved.requestId,
              executionId: own.id,
              authorizationDigest: authorized.digest,
            },
            context.signal,
          ),
          saved,
        );
      } catch (error) {
        if (error instanceof Error && commitFailures.has(error.message)) {
          const cause = error.message;
          try {
            await cancel(saved.requestId);
          } catch {
            saved.state = 'unknown';
            saved.failure = 'browser_page_grant_cancel_unconfirmed';
            saved.cause = cause;
            await write().catch(() => {});
            return result(saved.failure, true, cause);
          }
          saved.state = 'denied';
          saved.failure = cause;
          saved.resolution = 'failed';
          await write();
          await settleWork(context, saved);
          if (cause === 'browser_page_existing_missing' && saved.existingPage)
            options.invalidateMissingReleasedPage?.(saved.sessionId, saved.existingPage);
          return result(cause);
        }
        proposal = await inspect();
      }
      if (!sameDispatch(await dispatchProof(context, await ownScope(context, intent)), authorized))
        throw Error('browser_page_grant_scope_invalid');
      if (proposal.state !== 'committed' && proposal.state !== 'ready') {
        await cancel(saved.requestId);
        saved.state = 'cancelled';
        saved.resolution = 'failed';
        await write();
        await settleWork(context, saved);
        return result(`browser_page_grant_${proposal.state}`);
      }
      saved.state = 'ready';
      saved.resolution = 'allowed';
      await write();
      await settleWork(context, saved);
      return;
    } catch (error) {
      if (saved && context.signal.aborted) {
        abort();
        try {
          await cancelPromise;
          return { outcome: 'cancelled', content: 'browser_page_grant_cancelled' };
        } catch {
          return result('browser_page_grant_cancel_unconfirmed', true);
        }
      }
      if (
        saved &&
        (saved.state === 'asking' ||
          (error instanceof Error &&
            [
              'browser_page_grant_scope_invalid',
              'browser_page_dispatch_authorization_unavailable',
            ].includes(error.message)))
      ) {
        try {
          await cancel(saved.requestId);
          saved.state = 'cancelled';
          await write();
        } catch {
          return result('browser_page_grant_cancel_unconfirmed', true);
        }
        if (error instanceof Error && error.message === 'browser_page_grant_refusal_unconfirmed')
          return result(error.message, true);
        return result(
          error instanceof Error && error.message === 'browser_page_grant_receipt_invalid'
            ? error.message
            : 'browser_page_grant_scope_changed',
        );
      }
      if (saved) {
        saved.state = 'unknown';
        await write().catch(() => {});
        return result('browser_page_grant_unconfirmed', true);
      }
      if (error instanceof Error && error.message === 'browser_page_grant_refusal_unconfirmed')
        return result(error.message, true);
      return context.signal.aborted
        ? { outcome: 'cancelled', content: 'browser_page_grant_cancelled' }
        : result(
            error instanceof Error &&
              error.message === 'browser_page_dispatch_authorization_unavailable'
              ? error.message
              : 'browser_page_grant_scope_invalid',
          );
    }
  }
  async function readJobGrant(
    context: Pick<JobContext, 'signal' | 'executionId' | 'sessionId'>,
    browserId: string,
    preparing = false,
  ) {
    context.signal.throwIfAborted();
    const host = options.runtime();
    const job = await host.getExecution(context.executionId);
    const parent = job?.parentExecutionId ? await host.getExecution(job.parentExecutionId) : null;
    if (
      job?.kind !== 'job' ||
      job.definitionId !== 'browser.session' ||
      job.definitionVersion !== '1' ||
      job.sessionId !== context.sessionId ||
      !(preparing ? ['planned', 'dispatching', 'running'] : ['dispatching', 'running']).includes(
        job.status,
      ) ||
      job.cancelRequestedAt !== null ||
      !parent ||
      parent.kind !== 'tool' ||
      parent.definitionId !== 'browser.open' ||
      parent.definitionVersion !== '1' ||
      parent.sessionId !== job.sessionId ||
      parent.authorization?.dispatched !== true ||
      parent.originStoreId !== job.originStoreId ||
      parent.rootWorkCommandId !== job.rootWorkCommandId ||
      parent.rootWorkSeq !== job.rootWorkSeq ||
      parent.cancelRequestedAt !== null ||
      !['dispatching', 'running', 'succeeded'].includes(parent.status) ||
      !object(job.input) ||
      !object(parent.input) ||
      job.input.browserId !== browserId ||
      (parent.input.key ?? browserModelIntentKey(parent.id)) !== browserId ||
      job.input.url !== normalizedUrl(parent.input.url)
    )
      throw Error('browser_page_grant_scope_invalid');
    const taskRunId = await executionRunId(parent, true);
    const run = await host.getRun(taskRunId);
    if (
      !run?.isActive ||
      run.sessionId !== parent.sessionId ||
      run.originStoreId !== parent.originStoreId ||
      run.rootWorkCommandId !== parent.rootWorkCommandId ||
      run.rootWorkSeq !== parent.rootWorkSeq
    )
      throw Error('browser_page_grant_scope_invalid');
    const record =
      (await host.readRunExtensionRecord({
        sessionId: parent.sessionId,
        runId: taskRunId,
        extensionId: browserExtensionId,
        key: keyFor(parent.id, parent),
      })) ??
      (await host.readRunExtensionRecord({
        sessionId: parent.sessionId,
        runId: taskRunId,
        extensionId: browserExtensionId,
        key: keyFor(parent.id),
      }));
    const saved = readSaved(record);
    if (
      !saved ||
      record?.originStoreId !== parent.originStoreId ||
      record.sessionId !== parent.sessionId ||
      saved.state !== 'ready' ||
      saved.executionId !== parent.id ||
      saved.sessionId !== parent.sessionId ||
      saved.storeId !== parent.originStoreId ||
      saved.runId !== parent.runId ||
      (saved.taskRunId ?? saved.runId) !== taskRunId ||
      saved.attempt !== parent.attempt ||
      saved.key !== browserId ||
      saved.url !== job.input.url ||
      (saved.dispatch !== undefined &&
        saved.dispatch.inputDigest !==
          createHash('sha256').update(canonical(parent.input)).digest('hex'))
    )
      throw Error('browser_page_explicit_grant_required');
    context.signal.throwIfAborted();
    return { saved, parent, job };
  }
  async function grantForJob(context: JobContext, browserId: string) {
    const { saved, parent } = await readJobGrant(context, browserId);
    return { grantId: saved.requestId, grantExecutionId: parent.id };
  }
  return { prepareOpen, grantForJob, cancelOpen };
}
function validReceipt(accepted: AcceptedInformation, saved: Saved, request: Json) {
  return (
    accepted.executionId === saved.executionId &&
    accepted.sessionId === saved.sessionId &&
    accepted.originStoreId === saved.storeId &&
    accepted.runId === saved.runId &&
    accepted.attempt === saved.attempt &&
    accepted.decisionRevision.length > 0 &&
    canonical(accepted.request) === canonical(request)
  );
}
