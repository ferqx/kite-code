import { type BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { AgentConfig } from '@/core/config/index';
import { createChatModel, type SupportedChatModel } from '@/core/model/factory';
import type { ShellApprovalGrant } from '@/protocol/events';
import type { ToolApprovalPayload } from '../harness/tool-policy';
import type { PendingToolRequest } from '../harness/tool-requests';

export interface AutoReviewSuggestion {
  approved: boolean;
  grant: ShellApprovalGrant;
  reason: string;
}

export interface AutoReviewResult {
  ok: boolean;
  suggestion?: AutoReviewSuggestion;
  reason?: string;
}

export function resolveAutoReviewConfig(config: AgentConfig): AgentConfig {
  const review = config.autoReview;
  return {
    ...config,
    providerName: review?.provider ?? config.providerName,
    modelName: review?.model ?? config.modelName,
  };
}

export function createAutoReviewModel(config: AgentConfig): SupportedChatModel {
  return createChatModel(resolveAutoReviewConfig(config));
}

export async function reviewToolApproval(input: {
  model: { invoke(messages: BaseMessage[], options?: unknown): Promise<unknown> };
  payload: ToolApprovalPayload;
  request: PendingToolRequest;
  timeoutMs?: number;
}): Promise<AutoReviewResult> {
  const timeoutMs = input.timeoutMs ?? 15_000;
  try {
    const response = await withTimeout(
      input.model.invoke(reviewMessages(input.payload, input.request)),
      timeoutMs,
    );
    return parseAutoReviewSuggestion(messageContent(response), input.payload.grantOptions);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function reviewMessages(payload: ToolApprovalPayload, request: PendingToolRequest): BaseMessage[] {
  return [
    new SystemMessage(
      [
        'You are an approval reviewer for a coding agent execution gateway.',
        'Return only compact JSON with keys: approved, grant, reason.',
        'approved must be true only when the requested action is justified by the current tool request and expected effects.',
        'grant must be one of the provided grantOptions. Prefer approve_once unless a broader grant is explicitly justified.',
      ].join(' '),
    ),
    new HumanMessage(
      JSON.stringify({
        tool: request.name,
        args: request.args,
        approval: payload,
      }),
    ),
  ];
}

function parseAutoReviewSuggestion(
  content: string,
  grantOptions: ShellApprovalGrant[],
): AutoReviewResult {
  const json = extractJsonObject(content);
  if (!json) {
    return { ok: false, reason: 'auto review did not return JSON' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'auto review returned invalid JSON' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'auto review returned a non-object response' };
  }
  const obj = parsed as Record<string, unknown>;
  const approved = obj.approved === true;
  const grant = typeof obj.grant === 'string' ? obj.grant : 'approve_once';
  const reason = typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : '';

  if (!isShellApprovalGrant(grant) || !grantOptions.includes(grant)) {
    return { ok: false, reason: `auto review suggested unsupported grant: ${grant}` };
  }

  return {
    ok: true,
    suggestion: {
      approved,
      grant,
      reason: reason || (approved ? 'auto review approved' : 'auto review rejected'),
    },
  };
}

function extractJsonObject(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return extractJsonObject(fenced[1]);
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return null;
}

function isShellApprovalGrant(value: string): value is ShellApprovalGrant {
  return value === 'approve_once' || value === 'same_command' || value === 'full_access';
}

function messageContent(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('auto review timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
