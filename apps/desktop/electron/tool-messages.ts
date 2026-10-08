import { type AgentClient, ClientError, type Message } from '@kite-ai/client';
import type {
  NativeToolMessagePage,
  NativeToolMessageRequest,
  NativeToolMessageScope,
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
  private target(message: Message, definitionId: string, scope: NativeToolMessageScope) {
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
    let input: Record<string, unknown> | undefined;
    try {
      input = object(JSON.parse(calls[0]!.arguments));
    } catch {
      return undefined;
    }
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
  async list(
    input: Extract<NativeToolMessageRequest, { method: 'toolMessages.list' }>,
  ): Promise<NativeToolMessagePage> {
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
        entries.push({
          messageId: message.id,
          executionId: execution.id,
          definitionId: execution.definitionId,
          definitionVersion: execution.definitionVersion,
          status: execution.status,
          resultRevision: execution.resultRevision,
          target: this.target(message, execution.definitionId, scope),
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
