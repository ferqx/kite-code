import type { Message } from '@kite-ai/kite-client-ui';
import type { RuntimeClientEvent, RuntimeSessionProjection } from '@kite-ai/runtime-contract';

export function isActiveRun(session?: RuntimeSessionProjection) {
  return ['queued', 'running', 'waiting'].includes(session?.currentRun?.status ?? '');
}

/** A lost Run owner cannot keep an unsealed tool visibly executing. This is display-only. */
export function showRunRecovery(
  messages: readonly Message[],
  session?: RuntimeSessionProjection,
): readonly Message[] {
  const run = session?.currentRun;
  if (run?.status !== 'recovery_required') return messages;
  const turnId = run.activeTurnId ?? run.initialTurnId;
  return messages.map((message) =>
    message.role === 'tool' &&
    message.turnId === turnId &&
    !message.settled &&
    (message.status === 'running' || message.status === 'queued')
      ? { ...message, status: 'recovery_required' as const }
      : message,
  );
}

export type { Message } from '@kite-ai/kite-client-ui';

/** Mutable only while replaying one unpublished historical transcript. */
export class HistoryMessageBuilder {
  readonly messages: Message[] = [];
  readonly #byId = new Map<string, number>();
  readonly #byTurn = new Map<string, Set<number>>();
  readonly #unscopedThinking = new Set<number>();
  readonly #approvalInteractions = new Map<string, number>();

  index(id: string): number {
    return this.#byId.get(id) ?? -1;
  }

  find(id: string): Message | undefined {
    const index = this.index(id);
    return index < 0 ? undefined : this.messages[index];
  }

  append(message: Message): void {
    const index = this.messages.length;
    this.messages.push(message);
    this.#index(index, message);
  }

  replace(index: number, message: Message): void {
    this.#unindex(index, this.messages[index]!);
    this.messages[index] = message;
    this.#index(index, message);
  }

  remove(id: string): void {
    const index = this.index(id);
    if (index < 0) return;
    this.messages.splice(index, 1);
    this.#byId.clear();
    this.#byTurn.clear();
    this.#unscopedThinking.clear();
    this.#approvalInteractions.clear();
    this.messages.forEach((message, position) => {
      this.#index(position, message);
    });
  }

  hasApprovalInteraction(id: string): boolean {
    return this.#approvalInteractions.has(id);
  }

  terminalIndices(turnId: string): number[] {
    return [...(this.#byTurn.get(turnId) ?? []), ...this.#unscopedThinking].sort((a, b) => a - b);
  }

  #index(index: number, message: Message): void {
    this.#byId.set(message.id, index);
    if (message.turnId) {
      let indices = this.#byTurn.get(message.turnId);
      if (!indices) {
        indices = new Set();
        this.#byTurn.set(message.turnId, indices);
      }
      indices.add(index);
    } else if (message.role === 'thinking') this.#unscopedThinking.add(index);
    if (message.approval?.interactionId) {
      const id = message.approval.interactionId;
      this.#approvalInteractions.set(id, (this.#approvalInteractions.get(id) ?? 0) + 1);
    }
  }

  #unindex(index: number, message: Message): void {
    this.#byId.delete(message.id);
    if (message.turnId) {
      const indices = this.#byTurn.get(message.turnId);
      indices?.delete(index);
      if (indices?.size === 0) this.#byTurn.delete(message.turnId);
    } else if (message.role === 'thinking') this.#unscopedThinking.delete(index);
    if (message.approval?.interactionId) {
      const id = message.approval.interactionId;
      const remaining = (this.#approvalInteractions.get(id) ?? 1) - 1;
      if (remaining) this.#approvalInteractions.set(id, remaining);
      else this.#approvalInteractions.delete(id);
    }
  }
}

/** Service text deltas are cumulative; durable model output wins over late deltas. */
export function projectEvent(
  messages: readonly Message[],
  event: RuntimeClientEvent,
): readonly Message[] {
  return projectEventWithIdentity(messages, event);
}

export function projectEventWithIdentity(
  messages: readonly Message[],
  event: RuntimeClientEvent,
  identity: Readonly<{ turnId?: string; observedAt?: number }> = {},
): readonly Message[] {
  return projectEventCore(messages, event, identity);
}

export function projectHistoricalEvent(
  builder: HistoryMessageBuilder,
  event: RuntimeClientEvent,
  identity: Readonly<{ turnId?: string; observedAt?: number }> = {},
): void {
  projectEventCore(builder.messages, event, identity, builder);
}

function projectEventCore(
  messages: readonly Message[],
  event: RuntimeClientEvent,
  identity: Readonly<{ turnId?: string; observedAt?: number }>,
  builder?: HistoryMessageBuilder,
): readonly Message[] {
  const find = (id: string) =>
    builder ? builder.find(id) : messages.find((message) => message.id === id);
  const replaceExact = (id: string, message: Message): readonly Message[] => {
    const index = builder?.index(id) ?? messages.findIndex((item) => item.id === id);
    if (builder) {
      if (index < 0) builder.append(message);
      else builder.replace(index, message);
      return messages;
    }
    return index < 0
      ? [...messages, message]
      : messages.map((item) => (item.id === id ? message : item));
  };
  if (event.type === 'agent.mail_status') {
    const entries =
      event.status === 'result_settled'
        ? [{ id: `agent-followup:${event.submissionId}`, label: 'Agent 续轮' }]
        : (event.messageIds ?? []).map((messageId) => ({
            id: `agent-mail:${messageId}`,
            label: 'Agent 消息',
          }));
    let next = messages;
    for (const entry of entries) {
      const previous = builder
        ? builder.find(entry.id)
        : next.find((message) => message.id === entry.id);
      if (previous?.status === 'running' && event.status === 'accepted') continue;
      const phase =
        event.status === 'accepted'
          ? '已受理，等待目标读取'
          : event.status === 'input_prepared'
            ? '已准备进入目标模型输入'
            : `结果已结算（${event.resultStatus}）`;
      const message: Message = {
        id: entry.id,
        role: 'system',
        title: entry.label,
        text: phase,
        status:
          event.status === 'accepted'
            ? 'queued'
            : event.status === 'input_prepared'
              ? 'running'
              : event.resultStatus === 'completed'
                ? 'completed'
                : 'failed',
        settled: event.status === 'result_settled',
      };
      next = builder
        ? replaceExact(entry.id, message)
        : previous
          ? next.map((item) => (item.id === entry.id ? message : item))
          : [...next, message];
    }
    return next;
  }
  if (event.type === 'model.response_superseded') {
    if (builder) {
      builder.remove(`model:${event.requestId}`);
      return messages;
    }
    return messages.filter((message) => message.id !== `model:${event.requestId}`);
  }
  if (event.type === 'turn.terminal' || event.type === 'run.terminal') {
    const turnId = event.type === 'turn.terminal' ? event.turnId : (identity.turnId ?? event.runId);
    const indices = builder
      ? builder.terminalIndices(turnId)
      : Array.from({ length: messages.length }, (_, index) => index);
    let finalReplyIndex = -1;
    if (event.type === 'turn.terminal' && event.status === 'completed') {
      for (const index of indices) {
        const message = messages[index]!;
        if (message.role === 'assistant' && message.turnId === event.turnId && message.text)
          finalReplyIndex = index;
      }
      if (
        finalReplyIndex >= 0 &&
        indices.some((index) => {
          const message = messages[index]!;
          return (
            index > finalReplyIndex && message.role === 'tool' && message.turnId === event.turnId
          );
        })
      )
        finalReplyIndex = -1;
    }
    const settle = (message: Message, index: number): Message => {
      if (
        message.role === 'thinking' &&
        !message.settled &&
        (!message.turnId || message.turnId === turnId)
      )
        return {
          ...message,
          settled: true,
          ...(message.thinkingStartedAt !== undefined && identity.observedAt !== undefined
            ? { thinkingEndedAt: identity.observedAt }
            : {}),
        };
      if (
        event.type === 'turn.terminal' &&
        message.role === 'assistant' &&
        message.turnId === event.turnId
      )
        return {
          ...message,
          ...(event.status === 'completed' ? { settled: true } : {}),
          finalReply: event.status === 'completed' && index === finalReplyIndex,
        };
      return message;
    };
    const settledMessages = builder ? messages : messages.map(settle);
    if (builder) {
      for (const index of indices) {
        const message = messages[index]!;
        const settled = settle(message, index);
        if (settled !== message) builder.replace(index, settled);
      }
    }
    if (event.status !== 'failed') return settledMessages;
    const id = `failure:${turnId}`;
    const previous = builder
      ? builder.find(id)
      : settledMessages.find((message) => message.id === id);
    const reason = event.type === 'run.terminal' ? event.outcome?.reasonCode : undefined;
    const reasonText: Partial<Record<string, string>> = {
      provider_auth_required: '模型服务认证失败。请检查当前提供商的凭据和账号权限后再发送。',
      model_retry_exhausted: '模型请求重试次数已用尽。请检查模型服务状态后重试。',
      provider_unavailable: '模型服务暂不可用。请检查连接和提供商状态后重试。',
      persistence_unavailable: '会话存储不可用。请检查服务状态后重试。',
      loop_exhausted: '本轮工具纠错次数已用尽。请检查失败的工具调用后继续。',
    };
    const specificReason = reason ? reasonText[reason] : undefined;
    const notice: Message = {
      id,
      turnId,
      role: 'system',
      title: '本轮回复失败',
      text: specificReason ?? '本轮回复未完成。请检查会话中的失败详情和任务状态后再决定是否继续。',
      status: 'failed',
      settled: true,
    };
    if (previous && (!specificReason || previous.text === notice.text)) return settledMessages;
    return builder
      ? replaceExact(id, notice)
      : previous
        ? settledMessages.map((message) => (message.id === id ? notice : message))
        : [...settledMessages, notice];
  }
  if (event.type === 'tool.file_changed') {
    const id = `tool:${event.toolId}`;
    const previous = find(id);
    const change: Message = {
      ...(previous ?? { id, role: 'tool', text: event.summary ?? '文件已变更', settled: false }),
      ...(identity.turnId ? { turnId: identity.turnId } : {}),
      changeConfirmed: true,
      ...(event.path ? { changedFile: event.path } : {}),
    };
    return replaceExact(id, change);
  }
  if (
    event.type === 'interaction.settled' &&
    (builder
      ? builder.hasApprovalInteraction(event.interactionId)
      : messages.some((message) => message.approval?.interactionId === event.interactionId))
  )
    return messages;
  // Authorization is attached to its exact tool owner and survives execution terminal events.
  const approvalInteraction =
    (event.type === 'approval.queued' || event.type === 'interaction.available') &&
    event.interaction.kind === 'approval'
      ? event.interaction
      : undefined;
  if (
    event.type === 'tool.review' ||
    approvalInteraction ||
    event.type === 'approval.granted' ||
    event.type === 'approval.rejected'
  ) {
    const owner =
      approvalInteraction?.owner ??
      (event.type === 'approval.granted' || event.type === 'approval.rejected'
        ? event.owner
        : undefined);
    const toolId = event.type === 'tool.review' ? event.toolId : owner?.toolCallId;
    if (toolId && (!owner || owner.kind === 'root_tool')) {
      const id = `tool:${toolId}`;
      const previous = find(id);
      if (
        previous?.settled &&
        (approvalInteraction || (event.type === 'tool.review' && event.status === 'reviewing'))
      )
        return messages;
      if (approvalInteraction && ['approved', 'rejected'].includes(previous?.approval?.state ?? ''))
        return messages;
      if (
        event.type === 'tool.review' &&
        previous?.approval?.source === 'user' &&
        previous.approval.state === 'approved'
      )
        return messages;
      const approval: NonNullable<Message['approval']> =
        event.type === 'tool.review'
          ? { source: 'auto', state: event.status, reason: event.summary }
          : event.type === 'approval.granted'
            ? {
                source: 'user',
                state: 'approved',
                grant: event.grant,
                interactionId: event.interactionId,
              }
            : event.type === 'approval.rejected'
              ? {
                  source: 'user',
                  state: 'rejected',
                  reason: event.summary,
                  interactionId: event.interactionId,
                }
              : {
                  interactionId: approvalInteraction?.interactionId,
                  source: previous?.approval?.source ?? 'user',
                  state: 'awaiting_user',
                  reason: previous?.approval?.reason ?? approvalInteraction?.summary,
                };
      const message: Message = {
        ...(previous ?? { id, role: 'tool', text: '', settled: false }),
        ...(identity.turnId ? { turnId: identity.turnId } : {}),
        approval,
        ...(!previous?.settled
          ? {
              status:
                approval.state === 'approved'
                  ? ('queued' as const)
                  : approval.state === 'rejected'
                    ? ('rejected' as const)
                    : ('waiting' as const),
              settled: approval.state === 'rejected',
            }
          : {}),
      };
      return replaceExact(id, message);
    }
  }
  let next: Message;
  switch (event.type) {
    case 'context.compaction': {
      const previous = [...messages]
        .reverse()
        .find((message) => message.systemKind === 'compaction');
      if (event.status === 'reset') return messages;
      next = {
        id:
          event.status !== 'requested' && previous && !previous.settled
            ? previous.id
            : `compaction:${messages.length}`,
        role: 'system',
        systemKind: 'compaction',
        title:
          event.status === 'requested'
            ? '正在自动压缩上下文'
            : event.status === 'failed'
              ? '上下文自动压缩失败'
              : '上下文已自动压缩',
        text: event.status === 'failed' ? (event.summary ?? '') : '',
        status:
          event.status === 'requested'
            ? 'running'
            : event.status === 'failed'
              ? 'failed'
              : 'completed',
        settled: event.status !== 'requested',
      };
      break;
    }
    case 'reasoning.activity': {
      const previous = find(`thinking:${event.requestId}:${event.segmentId}`);
      const startedAt =
        previous?.thinkingStartedAt ??
        (event.state === 'streaming' ? identity.observedAt : undefined);
      next = {
        id: `thinking:${event.requestId}:${event.segmentId}`,
        role: 'thinking',
        text: event.text,
        settled: event.state === 'completed',
        ...(startedAt !== undefined ? { thinkingStartedAt: startedAt } : {}),
        ...(event.state === 'completed' &&
        startedAt !== undefined &&
        identity.observedAt !== undefined
          ? { thinkingEndedAt: previous?.thinkingEndedAt ?? identity.observedAt }
          : {}),
      };
      break;
    }
    case 'subagent.started':
      next = {
        id: `subagent:${event.subagentId}`,
        role: 'subagent',
        title: event.name,
        text: '',
        ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        settled: false,
        status: event.status ?? 'running',
      };
      break;
    case 'subagent.phase':
      next = {
        id: `subagent:${event.subagentId}`,
        role: 'subagent',
        text: '',
        parentToolCallId: event.parentToolCallId,
        settled: false,
        status:
          event.approvalState === 'auto_reviewing'
            ? 'auto_reviewing'
            : event.status === 'suspended'
              ? 'waiting'
              : 'running',
      };
      break;
    case 'subagent.review':
      if (event.status === 'rejected' || event.status === 'failed') return messages;
      next = {
        id: `subagent:${event.subagentId}`,
        role: 'subagent',
        text: '',
        parentToolCallId: event.parentToolCallId,
        settled: false,
        status: event.status === 'reviewing' ? 'auto_reviewing' : 'waiting',
      };
      break;
    case 'subagent.step': {
      const id = `subagent:${event.subagentId}`;
      const previous = find(id);
      if (previous?.settled) return messages;
      const steps = previous?.steps ?? [];
      const existing = steps.find((item) => item.id === event.stepId);
      const step = {
        id: event.stepId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        text: event.displayLabel || event.toolName,
        ...((event.arguments ?? existing?.arguments)
          ? { arguments: event.arguments ?? existing?.arguments }
          : {}),
        ...(event.summary ? { summary: event.summary } : {}),
        status: event.status,
      };
      if (existing && existing.status !== 'started' && step.status === 'started') return messages;
      next = {
        id,
        role: 'subagent',
        text: previous?.text ?? '',
        settled: false,
        ...(event.status === 'started' ? { status: 'running' as const } : {}),
        steps: existing
          ? steps.map((item) => (item.id === step.id ? step : item))
          : [...steps, step],
      };
      break;
    }
    case 'subagent.completed':
    case 'subagent.failed': {
      const previous = find(`subagent:${event.subagentId}`);
      next = {
        id: `subagent:${event.subagentId}`,
        role: 'subagent',
        ...(previous?.parentToolCallId ? { parentToolCallId: previous.parentToolCallId } : {}),
        ...(previous?.title ? { title: previous.title } : {}),
        ...(previous?.steps ? { steps: previous.steps } : {}),
        text: event.summary,
        settled: true,
        status: event.type === 'subagent.completed' ? 'completed' : (event.status ?? 'failed'),
      };
      break;
    }
    case 'interaction.available':
    case 'approval.queued':
    case 'input.requested':
    case 'plan.review_requested':
      next = {
        id: `interaction:${event.interaction.interactionId}`,
        role: 'system',
        systemKind:
          event.interaction.kind === 'input'
            ? 'ask'
            : event.interaction.kind === 'approval'
              ? 'approval'
              : undefined,
        ...(event.interaction.kind === 'input'
          ? {
              ask: {
                toolCallId: event.interaction.toolCallId,
                questions: event.interaction.questions ?? [
                  {
                    id: 'question',
                    question: event.interaction.question,
                    options: event.interaction.options,
                  },
                ],
              },
            }
          : {}),
        title: event.interaction.title,
        text:
          event.interaction.kind === 'approval'
            ? (event.interaction.command ?? event.interaction.summary ?? '')
            : event.interaction.kind === 'input'
              ? (event.interaction.questions?.map((question) => question.question).join('\n') ??
                event.interaction.question)
              : (event.interaction.summary ?? ''),
        settled: false,
      };
      break;
    case 'approval.granted':
    case 'approval.rejected':
    case 'input.answered':
    case 'input.cancelled':
    case 'plan.approved':
    case 'interaction.settled': {
      const id = `interaction:${event.interactionId}`;
      const previous = find(id);
      if (
        event.type === 'interaction.settled' &&
        event.outcome === 'completed' &&
        previous?.settled
      )
        return messages;
      const title =
        event.type === 'approval.granted'
          ? '已批准本次命令，执行结果以工具记录为准'
          : event.type === 'approval.rejected'
            ? '已拒绝本次命令'
            : event.type === 'input.answered'
              ? '回答已提交'
              : event.type === 'input.cancelled'
                ? '已取消回答'
                : event.type === 'plan.approved'
                  ? `计划已批准 · ${event.mode === 'auto' ? 'Auto' : 'Accept Edits'}`
                  : event.outcome === 'cancelled'
                    ? '交互已取消'
                    : event.outcome === 'rejected'
                      ? '交互已拒绝'
                      : event.outcome === 'expired'
                        ? '交互已过期'
                        : '本次确认已提交';
      next = {
        id,
        role: 'system',
        systemKind:
          event.type === 'input.answered' || event.type === 'input.cancelled'
            ? 'ask'
            : previous?.systemKind,
        title,
        ...(previous?.ask
          ? {
              ask: {
                ...previous.ask,
                ...(event.type === 'input.answered'
                  ? {
                      summary: event.summary,
                      answers: event.answers
                        ? Object.fromEntries(
                            Object.entries(event.answers).map(([id, answer]) => [
                              id,
                              previous.ask?.questions
                                .find((question) => question.id === id)
                                ?.options?.find((option) => option.id === answer)?.label ?? answer,
                            ]),
                          )
                        : undefined,
                    }
                  : {}),
              },
            }
          : {}),
        status:
          event.type === 'input.cancelled'
            ? 'cancelled'
            : event.type === 'input.answered'
              ? 'completed'
              : previous?.status,
        text:
          event.type === 'input.answered' && event.summary !== undefined
            ? [previous?.text, event.summary].filter(Boolean).join('\n\n')
            : (previous?.text ?? ''),
        settled: true,
      };
      break;
    }
    case 'user.message':
      next = { id: `user:${event.messageId}`, role: 'user', text: event.text, settled: true };
      break;
    case 'plan.progress':
      next = {
        id: `plan:${event.planId}`,
        role: 'system',
        title: '计划进度',
        text: event.summary ?? '',
        settled: event.status === 'completed' || event.status === 'skipped',
        status:
          event.status === 'completed'
            ? 'completed'
            : event.status === 'skipped'
              ? 'cancelled'
              : event.status === 'pending'
                ? 'queued'
                : 'running',
      };
      break;
    case 'plan.completed':
      next = {
        id: `plan:${event.planId}`,
        role: 'system',
        title: '计划已完成',
        text: event.summary ?? '',
        settled: true,
        status: 'completed',
      };
      break;
    case 'model.text_delta':
      next = {
        id: `model:${event.requestId}`,
        role: 'assistant',
        text: event.text,
        settled: false,
      };
      break;
    case 'model.responded':
      next = {
        id: `model:${event.requestId}`,
        role: 'assistant',
        text: event.summary ?? '',
        settled: true,
        finalReply: false,
      };
      break;
    case 'tool.queued':
      next = {
        id: `tool:${event.toolId}`,
        role: 'tool',
        text: event.summary,
        settled: false,
        title: event.displayLabel || event.toolName || '工具执行',
        toolName: event.toolName,
        presentation: event.presentation,
        presentationOwner: event.presentationOwner,
        presentationGroupId: event.presentationGroupId,
        arguments: event.arguments,
        status: 'queued',
      };
      break;
    case 'tool.started':
      next = {
        id: `tool:${event.toolId}`,
        role: 'tool',
        text: event.summary ?? '正在执行工具',
        settled: false,
        status: 'running',
      };
      break;
    case 'tool.progress': {
      const existing = find(`tool:${event.toolId}`);
      const toolProgress = {
        stdout: event.stream === 'stdout' ? event.summary : existing?.toolProgress?.stdout,
        stderr: event.stream === 'stderr' ? event.summary : existing?.toolProgress?.stderr,
        stdoutLines:
          event.stream === 'stdout' ? event.lineCount : existing?.toolProgress?.stdoutLines,
        stderrLines:
          event.stream === 'stderr' ? event.lineCount : existing?.toolProgress?.stderrLines,
      };
      next = {
        id: `tool:${event.toolId}`,
        role: 'tool',
        text: event.summary,
        settled: false,
        status: 'running',
        toolProgress,
      };
      break;
    }
    case 'tool.finished':
      next = {
        id: `tool:${event.toolId}`,
        role: 'tool',
        text: [event.summary, event.result.stdout, event.result.stderr].filter(Boolean).join('\n'),
        settled: true,
        toolResult: event.result,
        ...(event.toolName ? { toolName: event.toolName } : {}),
        ...(event.displayLabel || event.toolName
          ? { title: event.displayLabel || event.toolName }
          : {}),
        presentation: event.presentation,
        ...(event.presentationOwner ? { presentationOwner: event.presentationOwner } : {}),
        status: event.result.ok ? 'completed' : 'failed',
      };
      break;
    case 'tool.failed':
    case 'tool.rejected':
      next = {
        id: `tool:${event.toolId}`,
        role: 'tool',
        text: event.summary,
        settled: true,
        presentation: event.presentation,
        ...(event.presentationOwner ? { presentationOwner: event.presentationOwner } : {}),
        status: event.type === 'tool.failed' ? 'failed' : 'rejected',
      };
      break;
    case 'tool.cancelled':
      next = {
        id: `tool:${event.toolId}`,
        role: 'tool',
        text: event.summary ?? '工具已取消',
        settled: true,
        presentation: event.presentation,
        ...(event.presentationOwner ? { presentationOwner: event.presentationOwner } : {}),
        status: 'cancelled',
      };
      break;
    default:
      return messages;
  }
  if (identity.turnId) next = { ...next, turnId: identity.turnId };
  const index = builder?.index(next.id) ?? messages.findIndex((message) => message.id === next.id);
  if (index < 0) {
    if (builder) {
      builder.append(next);
      return messages;
    }
    return [...messages, next];
  }
  const previous = messages[index]!;
  if (previous.settled && !next.settled) return messages;
  if (next.role === 'assistant' && !next.settled && !next.text.startsWith(previous.text))
    return messages;
  if (!next.text) next = { ...next, text: previous.text };
  next = { ...previous, ...next };
  if (builder) {
    builder.replace(index, next);
    return messages;
  }
  return messages.map((message, position) => (position === index ? next : message));
}
