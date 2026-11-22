import {
  type AgentClient,
  ClientError,
  type Execution,
  type Message,
  type Run,
} from '@kite-ai/client';
import {
  modelUsageMessageKey,
  type NativeContextUsagePage,
  type NativeModelUsagePage,
  type NativeToolMessagePage,
  type NativeToolMessageRequest,
  type NativeToolMessageScope,
  type NativeToolRunPage,
  nativeShellJobMatches,
  nativeShellJobSettlement,
  nativeShellOutputPageBytes,
  nativeToolMessagePageBytes,
  presentableRun,
} from '../src/tool-messages-bridge';
import { NativeMcpToolLabelBudget, nativeMcpToolLabel } from './mcp-tool-label';
import {
  nativeFileCreationCandidate,
  nativeLegacyShellOutput,
  nativeLiveShellInputFact,
  nativeToolMessageEligible,
  nativeToolMessageFact,
  nativeWebFetchBatchCandidate,
} from './tool-message-fact';

type Lease = { readId: string; scope: NativeToolMessageScope; abort: AbortController };
type ShellJobScope = Omit<NativeToolMessageScope, 'workspaceId'>;
const shellJobScopeKey = (scope: ShellJobScope) =>
  JSON.stringify([
    scope.generation,
    scope.storeId,
    scope.sessionId,
    scope.viewSelection,
    scope.historyEpoch,
  ]);
const shellJobWatchLimit = 128;
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
  private shellJobs?: { key: string; watches: Map<string, { cursor?: string }> };
  private readonly client: AgentClient;
  private readonly current: () => NativeToolMessageScope | undefined;
  private readonly messages: () => ReadonlyMap<string, Message>;
  private readonly liveExecutions: () => readonly Execution[];
  constructor(
    client: AgentClient,
    current: () => NativeToolMessageScope | undefined,
    messages: () => ReadonlyMap<string, Message>,
    liveExecutions: () => readonly Execution[] = () => [],
  ) {
    this.client = client;
    this.current = current;
    this.messages = messages;
    this.liveExecutions = liveExecutions;
  }
  private watchShellJob(scope: NativeToolMessageScope, id: string) {
    if (id.length > 256) return;
    const key = shellJobScopeKey(scope);
    if (this.shellJobs?.key !== key) this.shellJobs = { key, watches: new Map() };
    const watches = this.shellJobs.watches;
    if (!watches.has(id)) {
      if (watches.size >= shellJobWatchLimit) {
        const oldest =
          [...watches].find(([, watch]) => watch.cursor)?.[0] ?? watches.keys().next().value;
        if (oldest) watches.delete(oldest);
      }
      watches.set(id, {});
    }
    const watch = watches.get(id)!;
    return (discard: 'mismatch' | 'terminal') => {
      if ((discard === 'mismatch' || !watch.cursor) && watches.get(id) === watch)
        watches.delete(id);
    };
  }
  observeShellJobFinished(scope: ShellJobScope, id: string, cursor: string) {
    const watch =
      this.shellJobs?.key === shellJobScopeKey(scope) ? this.shellJobs.watches.get(id) : undefined;
    if (watch && (!watch.cursor || BigInt(watch.cursor) < BigInt(cursor))) watch.cursor = cursor;
  }
  shellJobCompletions(
    scope: ShellJobScope,
    observedCursor: string,
  ): readonly (readonly [string, string])[] {
    if (this.shellJobs?.key !== shellJobScopeKey(scope)) return [];
    return [...this.shellJobs.watches].flatMap(([id, watch]) =>
      watch.cursor && BigInt(watch.cursor) <= BigInt(observedCursor)
        ? [[id, watch.cursor] as const]
        : [],
    );
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
  private open(input: Extract<NativeToolMessageRequest, { messageIds: string[] }>): Lease {
    const ids =
      'executionIds' in input && input.executionIds !== undefined
        ? input.executionIds
        : input.messageIds;
    if (
      ids.length < 1 ||
      ids.length > 32 ||
      new Set(ids).size !== ids.length ||
      ('executionIds' in input && input.executionIds !== undefined && input.messageIds.length !== 0)
    )
      throw new ClientError('invalid_native_request');
    const scope = this.current();
    if (
      !scope ||
      scope.generation !== input.generation ||
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
  /** Numeric forecast of the current selected context, separate from cumulative cache receipts. */
  async contextUsage(
    input: Extract<NativeToolMessageRequest, { method: 'toolMessages.contextUsage' }>,
  ): Promise<NativeContextUsagePage> {
    if (input.messageIds.length !== 1) throw new ClientError('invalid_native_request');
    const lease = this.open(input),
      { scope } = lease;
    try {
      const page: NativeContextUsagePage = {
        kind: 'toolMessages.contextUsage',
        readId: input.readId,
        scope: { ...scope },
      };
      await this.client.verifyConnection({ signal: lease.abort.signal });
      this.check(lease);
      const message = this.messages().get(input.messageIds[0]!);
      if (!message || message.sessionId !== scope.sessionId)
        throw new ClientError('tool_message_unavailable');
      if (
        message.role !== 'assistant' ||
        message.status !== 'complete' ||
        message.originMessage ||
        message.compression ||
        message.contentFormat === 'unsupported' ||
        !message.runId ||
        message.sourceIds?.length !== 1
      )
        return page;
      const key = modelUsageMessageKey(message),
        content = message.content;
      const execution = await this.client.getExecution(message.sourceIds[0]!, {
        signal: lease.abort.signal,
      });
      this.check(lease);
      if (
        execution.id !== message.sourceIds[0] ||
        execution.sessionId !== scope.sessionId ||
        execution.originStoreId !== scope.storeId ||
        execution.runId !== message.runId
      )
        throw new ClientError('model_usage_identity_mismatch');
      if (
        execution.kind !== 'model' ||
        execution.status !== 'succeeded' ||
        object(execution.result)?.content !== content
      )
        return page;
      const estimate = await this.client.getContextEstimate(
        scope.sessionId,
        { storeId: scope.storeId, executionId: execution.id },
        { signal: lease.abort.signal },
      );
      this.check(lease);
      const view = await this.client.getView(scope.sessionId, { signal: lease.abort.signal });
      await this.client.verifyConnection({ signal: lease.abort.signal });
      this.check(lease);
      const current = this.messages().get(message.id);
      if (!current || modelUsageMessageKey(current) !== key || current.content !== content)
        throw new ClientError('native_selection_changed');
      if (
        view.storeId !== scope.storeId ||
        view.session.id !== scope.sessionId ||
        view.session.workspaceId !== scope.workspaceId ||
        view.session.deletedAt !== null ||
        estimate.storeId !== scope.storeId ||
        estimate.sessionId !== scope.sessionId ||
        estimate.runId !== execution.runId ||
        estimate.modelInputExecutionId !== execution.id ||
        estimate.contextSelectionId !== view.session.contextSelectionId
      )
        throw new ClientError('context_selection_changed');
      if (
        !Number.isSafeInteger(estimate.totalInputTokens) ||
        estimate.totalInputTokens < 0 ||
        !estimate.modelId ||
        (estimate.contextWindowTokens !== undefined &&
          (!Number.isSafeInteger(estimate.contextWindowTokens) ||
            estimate.contextWindowTokens <= 0))
      )
        throw new ClientError('context_estimate_unavailable');
      page.context = {
        modelId: estimate.modelId,
        contextSelectionId: estimate.contextSelectionId,
        totalInputTokens: estimate.totalInputTokens,
        ...(estimate.contextWindowTokens === undefined
          ? {}
          : { contextWindowTokens: estimate.contextWindowTokens }),
      };
      return page;
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
          !execution.originStoreId ||
          execution.sessionId !== origin.sessionId ||
          execution.runId !== origin.runId ||
          (message.originMessage && execution.originStoreId !== message.originMessage.storeId)
        )
          throw new ClientError('model_usage_identity_mismatch');
        if (execution.originStoreId !== scope.storeId && !message.originMessage) {
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
    if (
      input.executionIds !== undefined &&
      (!Array.isArray(input.executionIds) ||
        input.executionIds.length < 1 ||
        input.executionIds.length > 32 ||
        input.messageIds.length !== 0 ||
        new Set(input.executionIds).size !== input.executionIds.length)
    )
      throw new ClientError('invalid_native_request');
    const commandIds =
      input.executionIds?.map((id) => `native-execution:${id}`) ?? input.messageIds;
    if (
      input.commandOffsets !== undefined &&
      (!input.commandOffsets ||
        typeof input.commandOffsets !== 'object' ||
        Array.isArray(input.commandOffsets) ||
        Object.entries(input.commandOffsets).some(
          ([id, offset]) =>
            !commandIds.includes(id) ||
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            offset > 524288,
        ))
    )
      throw new ClientError('invalid_native_request');
    const lease = this.open(input),
      { scope } = lease;
    const labelBudget = new NativeMcpToolLabelBudget(lease.abort.signal);
    try {
      await this.client.verifyConnection({ signal: lease.abort.signal });
      this.check(lease);
      const entries: NativeToolMessagePage['entries'] = [];
      const labels = new Map<string, Promise<string | undefined>>();
      const receiptRuns = new Map<string, Run | undefined>();
      const labelFor = (execution: Execution) => {
        const key = JSON.stringify([
          execution.originStoreId,
          execution.sessionId,
          execution.runId,
          execution.definitionId,
          execution.definitionVersion,
        ]);
        if (!labels.has(key))
          labels.set(
            key,
            nativeMcpToolLabel(
              this.client,
              execution,
              scope.storeId,
              scope.sessionId,
              labelBudget,
            ).catch(() => {
              this.check(lease);
              return undefined;
            }),
          );
        return labels.get(key)!;
      };
      let shellOutputBytes = 0;
      for (const id of input.executionIds ?? []) {
        const observed = this.liveExecutions().find((execution) => execution.id === id);
        if (
          observed?.kind !== 'tool' ||
          observed.originStoreId !== scope.storeId ||
          observed.sessionId !== scope.sessionId ||
          !observed.runId
        )
          throw new ClientError('tool_message_unavailable');
        if (
          !/^mcp\.([A-Za-z0-9_-]{1,128})\.[a-f0-9]{32}$/.test(observed.definitionId) &&
          (observed.definitionVersion !== '1' ||
            !['shell.execute', 'shell.launch', 'shell.read', 'shell.wait', 'shell.stop'].includes(
              observed.definitionId,
            ))
        )
          continue;
        const execution = await this.client.getExecution(id, { signal: lease.abort.signal });
        this.check(lease);
        const current = this.liveExecutions().find((item) => item.id === id);
        if (
          !current ||
          [
            'id',
            'kind',
            'originStoreId',
            'sessionId',
            'runId',
            'definitionId',
            'definitionVersion',
            'toolCallId',
          ].some(
            (key) =>
              execution[key as keyof Execution] !== observed[key as keyof Execution] ||
              current[key as keyof Execution] !== observed[key as keyof Execution],
          )
        )
          throw new ClientError('tool_message_identity_mismatch');
        const fact = nativeLiveShellInputFact(
          execution,
          input.commandOffsets?.[`native-execution:${id}`] ?? 0,
        );
        if (fact) entries.push(fact);
        else if (execution.toolCallId) {
          const label = await labelFor(execution);
          this.check(lease);
          entries.push({
            messageId: `native-execution:${execution.id}`,
            executionId: execution.id,
            definitionId: execution.definitionId,
            definitionVersion: execution.definitionVersion,
            status: execution.status,
            resultRevision: execution.resultRevision,
            ...(label ? { label } : {}),
            inputSource: {
              storeId: scope.storeId,
              sessionId: scope.sessionId,
              runId: execution.runId!,
              toolCallId: execution.toolCallId,
            },
          });
        }
      }
      for (const id of input.messageIds) {
        const message = this.messages().get(id);
        if (!message || message.sessionId !== scope.sessionId)
          throw new ClientError('tool_message_unavailable');
        if (!nativeToolMessageEligible(message)) continue;
        const execution = await this.client.getExecution(message.sourceIds[0]!, {
          signal: lease.abort.signal,
        });
        this.check(lease);
        let receiptRun: Run | undefined;
        const worktreeIssue =
          execution.definitionId === 'git.worktree' &&
          execution.definitionVersion === '1' &&
          ['failed', 'outcome_unknown'].includes(execution.status);
        const creatingFile = nativeFileCreationCandidate(execution);
        const legacyShellOutput = nativeLegacyShellOutput(execution);
        const taskReceipt =
          execution.definitionVersion === '1' &&
          ((execution.definitionId === 'task.events' &&
            ['succeeded', 'failed'].includes(execution.status)) ||
            (execution.definitionId === 'task.message' && execution.status === 'succeeded'));
        const optionalReceipt =
          taskReceipt || worktreeIssue || creatingFile || nativeWebFetchBatchCandidate(execution);
        if (
          execution.runId &&
          (legacyShellOutput ||
            optionalReceipt ||
            (execution.status === 'succeeded' &&
              execution.definitionId === 'files.read' &&
              ['4', '5'].includes(execution.definitionVersion) &&
              object(object(execution.result)?.details)?.exists === false))
        ) {
          receiptRun = receiptRuns.get(execution.runId);
          if (!receiptRuns.has(execution.runId) || (!receiptRun && !optionalReceipt)) {
            try {
              receiptRun = await this.client.getRun(execution.runId, {
                signal: lease.abort.signal,
              });
              this.check(lease);
            } catch (cause) {
              this.check(lease);
              // Optional receipt classification cannot withdraw the original Tool result.
              if (!optionalReceipt && !legacyShellOutput) throw cause;
            }
            receiptRuns.set(execution.runId, receiptRun);
          }
        }
        const fact = nativeToolMessageFact({
          execution,
          ...(receiptRun ? { run: receiptRun } : {}),
          message,
          messages: this.messages().values(),
          sessionId: scope.sessionId,
          commandOffset: input.commandOffsets?.[id] ?? 0,
        });
        if (fact) {
          if (
            fact.shellJobExecutionId &&
            !message.originMessage &&
            !(input.commandOffsets?.[id] ?? 0)
          ) {
            // Arm the exact verified launch before the Job GET: a completion can
            // arrive after the Store snapshot but before its response is delivered.
            const finishWatch = this.watchShellJob(scope, fact.shellJobExecutionId);
            try {
              const job = await this.client.getExecution(fact.shellJobExecutionId, {
                signal: lease.abort.signal,
              });
              this.check(lease);
              const identity = {
                ...execution,
                executionId: execution.id,
                jobExecutionId: fact.shellJobExecutionId,
              };
              fact.shellJobSettlement = nativeShellJobSettlement(job, identity);
              if (!nativeShellJobMatches(job, identity)) finishWatch?.('mismatch');
              else if (['succeeded', 'failed', 'cancelled'].includes(job.status))
                finishWatch?.('terminal');
            } catch {
              // The verified launch remains readable when its optional Job result is unavailable.
            }
            this.check(lease);
          }
          if (fact.shellDisplay?.output !== undefined) {
            const bytes = Buffer.byteLength(JSON.stringify(fact.shellDisplay.output));
            shellOutputBytes += bytes;
            if (input.messageIds.length > 1 && shellOutputBytes > nativeShellOutputPageBytes)
              throw new ClientError('tool_message_page_too_large');
          }
          const label = await labelFor(execution);
          this.check(lease);
          entries.push(label ? { ...fact, label } : fact);
        }
      }
      await this.client.verifyConnection({ signal: lease.abort.signal });
      this.check(lease);
      const page: NativeToolMessagePage = {
        kind: 'toolMessages.page',
        readId: input.readId,
        scope: { ...scope },
        entries,
      };
      // Only the newly added command transport gets this stricter budget. Existing
      // ask/image metadata retains the IPC response limit it already had.
      if (
        Buffer.byteLength(JSON.stringify(entries.map((entry) => entry.shellInput?.command))) >
        nativeToolMessagePageBytes
      )
        throw new ClientError('tool_message_page_too_large');
      return page;
    } finally {
      labelBudget.close();
      this.close(input.readId);
    }
  }
  close(readId: string) {
    this.reads.get(readId)?.abort.abort();
    this.reads.delete(readId);
  }
  release() {
    this.shellJobs = undefined;
    for (const readId of this.reads.keys()) this.close(readId);
  }
}
