import { assertCurrentRuntimeEvent } from './codec';
import type { KernelEvent } from './events';

export type AgentMailAcceptedEvent = Extract<KernelEvent, { type: 'agent.mail_accepted' }>;
export type AgentMailInputPreparedEvent = Extract<
  KernelEvent,
  { type: 'agent.mail_input_prepared' }
>;

/**
 * Check one Host-selected mailbox batch against the exact frozen model
 * admission and exclusive prepared watermark. Store owns the mailbox rows;
 * Kernel receives only their immutable metadata for this admission check.
 */
export function validateAgentMailInputPreparation(input: {
  prepared: AgentMailInputPreparedEvent;
  accepted: readonly AgentMailAcceptedEvent[];
  targetAgentId: string;
  invocationId: string;
  modelAdmissionId: string;
  previousThroughSequence: number;
  existingPrepared?: AgentMailInputPreparedEvent;
}): 'admitted' | 'replay' {
  const { prepared } = input;
  assertCurrentRuntimeEvent(prepared);
  if (
    prepared.targetAgentId !== input.targetAgentId ||
    prepared.invocationId !== input.invocationId ||
    prepared.modelAdmissionId !== input.modelAdmissionId
  )
    throw new Error('Agent mail input model admission identity mismatch.');
  if (input.existingPrepared) {
    const existing = input.existingPrepared;
    assertCurrentRuntimeEvent(existing);
    if (
      existing.targetAgentId === prepared.targetAgentId &&
      existing.invocationId === prepared.invocationId &&
      existing.modelAdmissionId === prepared.modelAdmissionId &&
      existing.fromSequence === prepared.fromSequence &&
      existing.throughSequence === prepared.throughSequence &&
      existing.messageIds.length === prepared.messageIds.length &&
      existing.messageIds.every((id, index) => id === prepared.messageIds[index])
    )
      return 'replay';
    throw new Error('Agent mail input invocation replay conflicts with admitted facts.');
  }
  if (
    prepared.fromSequence !== input.previousThroughSequence ||
    input.accepted.length !== prepared.messageIds.length
  )
    throw new Error('Agent mail input identity or prepared watermark mismatch.');
  let sequence = prepared.fromSequence;
  for (const [index, message] of input.accepted.entries()) {
    assertCurrentRuntimeEvent(message);
    if (
      message.targetAgentId !== prepared.targetAgentId ||
      message.messageId !== prepared.messageIds[index] ||
      message.sequence <= sequence ||
      message.sequence > prepared.throughSequence
    )
      throw new Error('Agent mail input batch is not the exact ordered accepted sequence.');
    sequence = message.sequence;
  }
  if (sequence !== prepared.throughSequence)
    throw new Error('Agent mail input watermark does not end at the admitted message.');
  return 'admitted';
}

export interface AgentMessageContextFrame {
  readonly kind: 'agent_message';
  readonly trust: 'untrusted_agent';
  readonly modelRole: 'user';
  readonly messageId: string;
  readonly senderAgentId: string;
  readonly sourceTaskId?: string;
  readonly content: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

/** The private body is used transiently and never returned to Kernel State. */
export function createAgentMessageContextFrame(input: {
  messageId: string;
  senderAgentId: string;
  sourceTaskId?: string;
  body: string;
}): AgentMessageContextFrame {
  if (
    !input.messageId.trim() ||
    !input.senderAgentId.trim() ||
    (input.sourceTaskId !== undefined && !input.sourceTaskId.trim()) ||
    new TextEncoder().encode(input.body).byteLength > 4_096
  )
    throw new Error('Agent message frame identity or body bound is invalid.');
  const attributes = [
    `message_id="${escapeXml(input.messageId)}"`,
    `sender_agent_id="${escapeXml(input.senderAgentId)}"`,
    ...(input.sourceTaskId ? [`source_task_id="${escapeXml(input.sourceTaskId)}"`] : []),
  ];
  return Object.freeze({
    kind: 'agent_message',
    trust: 'untrusted_agent',
    modelRole: 'user',
    messageId: input.messageId,
    senderAgentId: input.senderAgentId,
    ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}),
    content: `<agent_message ${attributes.join(' ')}>\n${escapeXml(input.body)}\n</agent_message>`,
  });
}
