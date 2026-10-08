import { type AgentClient, ClientError, type Message } from '@kite-ai/client';
import {
  modelUsageMessageKey,
  type NativeModelUsagePage,
  type NativeToolMessagePage,
  type NativeToolMessageRequest,
  type NativeToolMessageScope,
  type NativeToolRunPage,
  presentableRun,
} from '../src/tool-messages-bridge';

type Lease = { readId: string; scope: NativeToolMessageScope; abort: AbortController };
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const source = (message: Message) =>
  message.originMessage
    ? { sessionId: message.originMessage.sessionId, runId: message.originMessage.runId }
    : { sessionId: message.sessionId, runId: message.runId };

/** Result identity is established by the Execution, never by a repeated toolCallId. */
export class NativeToolMessages {
  private readonly reads = new Map<string, Lease>();
  private readonly client: AgentClient;
  private readonly current: () => NativeToolMessageScope | undefined;
  private readonly messages: () => ReadonlyMap<string, Message>;
  constructor(
    client: AgentClient,
    current: () => NativeToolMessageScope | undefined,
    messages: () => ReadonlyMap<string, Message>,
  ) {
    this.client = client;
    this.current = current;
    this.messages = messages;
  }
  private check(lease: Lease) {
    const now = this.current();
    if (
      this.reads.get(lease.readId) !== lease ||
      lease.abort.signal.aborted ||
      !now ||
      Object.keys(lease.scope).some(
        (key) =>
          now[key as keyof NativeToolMessageScope] !==
          lease.scope[key as keyof NativeToolMessageScope],
      )
    )
      throw new ClientError('native_selection_changed');
  }
  private callInput(message: Message, definitionId: string, scope: NativeToolMessageScope) {
    if (!message.toolCallId) return undefined;
    const original = source(message);
    const calls = [...this.messages().values()].flatMap((candidate) => {
      const origin = source(candidate);
      return candidate.role === 'assistant' &&
        candidate.status === 'complete' &&
        candidate.contentFormat !== 'unsupported' &&
        candidate.sessionId === scope.sessionId &&
        (!candidate.originMessage || candidate.originMessage.storeId === scope.storeId) &&
        origin.sessionId === original.sessionId &&
        origin.runId === original.runId &&
        BigInt(candidate.seq) < BigInt(message.seq)
        ? (candidate.toolCalls ?? []).filter((call) => call.id === message.toolCallId)
        : [];
    });
    if (calls.length !== 1 || calls[0]!.name !== definitionId) return undefined;
    try {
      return object(JSON.parse(calls[0]!.arguments));
    } catch {
      return undefined;
    }
  }
  private target(input: Record<string, unknown> | undefined, definitionId: string) {
    const key =
      definitionId === 'shell.launch'
        ? 'command'
        : definitionId.startsWith('shell.')
          ? 'shellId'
          : definitionId === 'files.glob'
            ? 'pattern'
            : definitionId === 'files.search'
              ? 'text'
              : definitionId.startsWith('files.')
                ? 'path'
                : undefined;
    const target = key ? input?.[key] : undefined;
    // A request target remains text; even a known Files request does not grant a file action.
    if (typeof target !== 'string') return undefined;
    const points = [...target];
    return points.slice(0, 4096).join('') + (points.length > 4096 ? '…' : '');
  }
  private ask(input: Record<string, unknown> | undefined, content: string) {
    let result: Record<string, unknown> | undefined;
    try {
      result = object(JSON.parse(content));
    } catch {
      return;
    }
    if (!result) return;
    const questions =
      Array.isArray(input?.questions) && input.questions.length >= 1 && input.questions.length <= 3
        ? input.questions.flatMap((value, index) => {
            const question = object(value);
            return typeof question?.question === 'string' && question.question.trim()
              ? [{ id: `q${index + 1}`, question: question.question.trim() }]
              : [];
          })
        : [];
    if (result.cancelled === true && Object.keys(result).length === 1)
      return { questions, cancelled: true };
    const answers = object(result.answers);
    if (
      Object.keys(result).length !== 2 ||
      typeof result.answer !== 'string' ||
      !answers ||
      Object.entries(answers).some(
        ([key, value]) => !/^q[1-3]$/.test(key) || typeof value !== 'string',
      ) ||
      !Object.keys(answers).length ||
      (questions.length &&
        (Object.keys(answers).length !== questions.length ||
          questions.some((question) => !Object.hasOwn(answers, question.id))))
    )
      return;
    return { questions, summary: result.answer, answers: answers as Record<string, string> };
  }
  private open(input: Extract<NativeToolMessageRequest, { messageIds: string[] }>): Lease {
    if (
      input.messageIds.length < 1 ||
      input.messageIds.length > 32 ||
      new Set(input.messageIds).size !== input.messageIds.length
    )
      throw new ClientError('invalid_native_request');
    const scope = this.current();
    if (
      !scope ||
      scope.viewSelection !== input.viewSelection ||
      scope.historyEpoch !== input.historyEpoch
    )
      throw new ClientError('native_selection_changed');
    if (this.reads.has(input.readId) || this.reads.size >= 64)
      throw new ClientError('tool_message_read_busy');
    const lease = { readId: input.readId, scope: { ...scope }, abort: new AbortController() };
    this.reads.set(input.readId, lease);
    return lease;
  }
  async runs(
    input: Extract<NativeToolMessageRequest, { method: 'toolMessages.runs' }>,
  ): Promise<NativeToolRunPage> {
    const lease = this.open(input),
      { scope } = lease;
    try {
      await this.client.verifyConnection({ signal: lease.abort.signal });
      this.check(lease);
      const runs: NativeToolRunPage['runs'] = [],
        read = new Set<string>();
      for (const id of input.messageIds) {
        const message = this.messages().get(id);
        if (!message || message.sessionId !== scope.sessionId)
          throw new ClientError('tool_message_unavailable');
        // A sealed Fork/Include has a fixed historical boundary. A later source Run is not its terminal fact.
        if (message.originMessage || !message.runId || read.has(message.runId)) continue;
        read.add(message.runId);
        const run = await this.client.getRun(message.runId, { signal: lease.abort.signal });
        this.check(lease);
        const current = this.messages().get(id);
        if (
          !current ||
          current.runId !== message.runId ||
          current.originMessage ||
          current.sessionId !== scope.sessionId
        )
          throw new ClientError('native_selection_changed');
        if (run.id !== message.runId || run.sessionId !== scope.sessionId)
          throw new ClientError('tool_message_identity_mismatch');
        if (presentableRun(run, scope.storeId, scope.sessionId))
          runs.push({
            id: run.id,
            originStoreId: run.originStoreId,
            sessionId: run.sessionId,
            status: run.status,
            isActive: run.isActive,
            createdAt: run.createdAt,
            finishedAt: run.finishedAt,
            reason: run.reason,
          });
      }
      await this.client.verifyConnection({ signal: lease.abort.signal });
      this.check(lease);
      return { kind: 'toolMessages.runs', readId: input.readId, scope: { ...scope }, runs };
    } finally {
      this.close(input.readId);
    }
  }
  async usage(
    input: Extract<NativeToolMessageRequest, { method: 'toolMessages.usage' }>,
  ): Promise<NativeModelUsagePage> {
    const lease = this.open(input),
      { scope } = lease;
    try {
      await this.client.verifyConnection({ signal: lease.abort.signal });
      this.check(lease);
      const entries: NativeModelUsagePage['entries'] = [];
      const observed = new Map<string, { key: string; content: string }>();
      for (const id of input.messageIds) {
        const message = this.messages().get(id);
        if (!message || message.sessionId !== scope.sessionId)
          throw new ClientError('tool_message_unavailable');
        const key = modelUsageMessageKey(message),
          content = message.content;
        observed.set(id, { key, content });
        const origin = source(message);
        if (
          message.role !== 'assistant' ||
          message.status !== 'complete' ||
          message.contentFormat === 'unsupported' ||
          !origin.runId ||
          message.sourceIds?.length !== 1
        )
          continue;
        const execution = await this.client.getExecution(message.sourceIds[0]!, {
          signal: lease.abort.signal,
        });
        this.check(lease);
        const current = this.messages().get(id);
        if (!current || modelUsageMessageKey(current) !== key || current.content !== content)
          throw new ClientError('native_selection_changed');
        if (
          execution.id !== message.sourceIds[0] ||
          execution.sessionId !== origin.sessionId ||
          execution.runId !== origin.runId ||
          (message.originMessage && execution.originStoreId !== message.originMessage.storeId)
        )
          throw new ClientError('model_usage_identity_mismatch');
        if (execution.originStoreId !== scope.storeId) {
          const run = await this.client.getRun(origin.runId, { signal: lease.abort.signal });
          this.check(lease);
          if (
            run.id !== origin.runId ||
            run.originStoreId !== execution.originStoreId ||
            !presentableRun(run, scope.storeId, origin.sessionId) ||
            run.isActive
          )
            throw new ClientError('model_usage_identity_mismatch');
        }
        const result = object(execution.result),
          usage = object(result?.usage);
        if (
          execution.kind !== 'model' ||
          execution.status !== 'succeeded' ||
          result?.content !== content ||
          !usage ||
          usage.cachedInputTokens === undefined
        )
          continue;
        const total = usage.inputTokens,
          cached = usage.cachedInputTokens;
        if (
          typeof total !== 'number' ||
          typeof cached !== 'number' ||
          !Number.isSafeInteger(total) ||
          !Number.isSafeInteger(cached) ||
          total < 0 ||
          cached < 0 ||
          cached > total
        )
          throw new ClientError('model_usage_unavailable');
        if (total > 0)
          entries.push({
            messageId: message.id,
            executionId: execution.id,
            originStoreId: execution.originStoreId,
            cacheHitTokens: cached,
            cacheMissTokens: total - cached,
          });
      }
      await this.client.verifyConnection({ signal: lease.abort.signal });
      this.check(lease);
      for (const [id, receipt] of observed) {
        const message = this.messages().get(id);
        if (
          !message ||
          modelUsageMessageKey(message) !== receipt.key ||
          message.content !== receipt.content
        )
          throw new ClientError('native_selection_changed');
      }
      return { kind: 'toolMessages.usage', readId: input.readId, scope: { ...scope }, entries };
    } finally {
      this.close(input.readId);
    }
  }
  async list(
    input: Extract<NativeToolMessageRequest, { method: 'toolMessages.list' }>,
  ): Promise<NativeToolMessagePage> {
    const lease = this.open(input),
      { scope } = lease;
    try {
      await this.client.verifyConnection({ signal: lease.abort.signal });
      this.check(lease);
      const entries: NativeToolMessagePage['entries'] = [];
      for (const id of input.messageIds) {
        const message = this.messages().get(id);
        if (!message || message.sessionId !== scope.sessionId)
          throw new ClientError('tool_message_unavailable');
        const origin = source(message);
        if (
          message.role !== 'tool' ||
          message.status !== 'complete' ||
          message.sourceIds?.length !== 1 ||
          message.contentFormat === 'unsupported' ||
          !origin.runId ||
          (message.originMessage && message.originMessage.storeId !== scope.storeId)
        )
          continue;
        const execution = await this.client.getExecution(message.sourceIds[0]!, {
          signal: lease.abort.signal,
        });
        this.check(lease);
        if (
          execution.id !== message.sourceIds[0] ||
          execution.originStoreId !== scope.storeId ||
          execution.sessionId !== origin.sessionId ||
          execution.runId !== origin.runId
        )
          throw new ClientError('tool_message_identity_mismatch');
        const result = object(execution.result);
        if (
          execution.kind !== 'tool' ||
          !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status) ||
          result?.outcome !== execution.status ||
          result.content !== message.content
        )
          continue;
        const call = this.callInput(message, execution.definitionId, scope);
        entries.push({
          messageId: message.id,
          executionId: execution.id,
          definitionId: execution.definitionId,
          definitionVersion: execution.definitionVersion,
          status: execution.status,
          resultRevision: execution.resultRevision,
          target: this.target(call, execution.definitionId),
          ...(!message.originMessage && execution.authorization
            ? { authorization: execution.authorization }
            : {}),
          ...(execution.definitionId === 'ask_user' &&
          execution.definitionVersion === '1' &&
          execution.status === 'succeeded'
            ? { ask: this.ask(call, message.content) }
            : {}),
        });
      }
      await this.client.verifyConnection({ signal: lease.abort.signal });
      this.check(lease);
      return { kind: 'toolMessages.page', readId: input.readId, scope: { ...scope }, entries };
    } finally {
      this.close(input.readId);
    }
  }
  close(readId: string) {
    this.reads.get(readId)?.abort.abort();
    this.reads.delete(readId);
  }
  release() {
    for (const readId of this.reads.keys()) this.close(readId);
  }
}
