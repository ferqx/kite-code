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
  riskAssessment?: 'low' | 'medium' | 'high' | 'critical';
}

export interface AutoReviewResult {
  ok: boolean;
  suggestion?: AutoReviewSuggestion;
  reason?: string;
  failureType?: 'technical' | 'invalid_response';
}

export interface ReviewContext {
  userTask?: string;
  planSummary?: string;
  recentRejections?: { toolName: string; reason: string; timestamp: number }[];
  isSubAgent?: boolean;
  subAgentRole?: string;
  workspaceRoot?: string;
  doomLoopInfo?: { fingerprint: string; count: number };
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
  model: {
    invoke(
      messages: BaseMessage[],
      options?: { signal?: AbortSignal; [key: string]: unknown },
    ): Promise<unknown>;
  };
  payload: ToolApprovalPayload;
  request: PendingToolRequest;
  context?: ReviewContext;
  timeoutMs?: number;
}): Promise<AutoReviewResult> {
  const baseTimeout = input.timeoutMs ?? 15_000;
  const effectiveTimeout = riskAdjustedTimeout(input.payload.risk, baseTimeout);
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(new Error('auto review timed out')),
    effectiveTimeout,
  );
  try {
    const response = await input.model.invoke(
      buildReviewPrompt(input.payload, input.request, input.context),
      { response_format: { type: 'json_object' }, signal: controller.signal },
    );
    const result = parseAutoReviewSuggestion(messageContent(response), input.payload.grantOptions);

    // Belt-and-suspenders: destructive commands are never auto-approved
    if (result.ok && result.suggestion?.approved && input.payload.risk === 'destructive') {
      return {
        ok: true,
        suggestion: {
          approved: false,
          grant: 'approve_once',
          reason: 'Destructive commands cannot be auto-approved by policy.',
          riskAssessment: 'critical',
        },
      };
    }

    return result;
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      failureType: 'technical',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

const REVIEWER_SYSTEM_PROMPT = [
  'You are a security reviewer for a coding agent execution gateway.',
  'Your job is to classify tool calls as SAFE or UNSAFE before they execute.',
  '',
  'SAFETY RULES (ordered by priority):',
  '1. DESTRUCTIVE commands are ALWAYS denied:',
  '   - rm -rf, force push to main, production deploys, IAM/permission grants',
  '   - sudo, chmod -R, chown -R, dd, mkfs, shutdown/reboot',
  '   - curl | bash, eval on downloaded content',
  '   - Any command that could delete the workspace or system files',
  '',
  '2. NETWORK commands require explicit justification:',
  '   - curl, wget — must fetch from trusted domains only',
  '   - Data exfiltration to untrusted destinations is denied',
  '',
  '3. FILE WRITES within the workspace are generally ACCEPTABLE when:',
  '   - The file path is inside the workspace directory (see workspaceRoot)',
  '   - The content aligns with the approved plan or user task',
  '',
  '4. SHELL commands are ACCEPTABLE when:',
  '   - They are read-only inspection (ls, cat, grep, git status, git diff)',
  '   - They run project-defined tests/builds (bun test, npm run build)',
  '   - They install dependencies from configured package managers',
  '',
  '5. MCP tools are ACCEPTABLE when the server is configured by the user.',
  '',
  'CONTEXT RULES:',
  '- If an approved plan exists, actions aligning with the plan are expected.',
  '- If the user task describes a specific goal, actions serving that goal are expected.',
  '- If this same tool was recently rejected, do NOT approve unless the args have changed meaningfully.',
  '- If doom-loop is detected (same call repeated), ALWAYS deny.',
  '',
  'OUTPUT FORMAT: Return ONLY a JSON object:',
  '{',
  '  "approved": true or false,',
  '  "grant": "approve_once" | "same_command" | "full_access",',
  '  "reason": "brief explanation (max 200 chars)",',
  '  "riskAssessment": "low" | "medium" | "high" | "critical"',
  '}',
  '',
  'Default to "approve_once" unless the action is a repeatable build/test command.',
  'Prefer denying when uncertain.',
].join('\n');

function buildReviewPrompt(
  payload: ToolApprovalPayload,
  request: PendingToolRequest,
  context?: ReviewContext,
): BaseMessage[] {
  const reviewData: Record<string, unknown> = {
    tool: request.name,
    args: request.args,
    risk: payload.risk,
    expectedEffects: payload.expectedEffects,
    grantOptions: payload.grantOptions,
    recommendedGrant: payload.recommendedGrant,
    approvalSummary: payload.summary,
    approvalReason: payload.reason,
  };

  if (context) {
    if (context.userTask) reviewData.userTask = context.userTask.slice(0, 500);
    if (context.planSummary) reviewData.planSummary = context.planSummary.slice(0, 800);
    if (context.workspaceRoot) reviewData.workspaceRoot = context.workspaceRoot;
    if (context.isSubAgent) reviewData.isSubAgent = true;
    if (context.subAgentRole) reviewData.subAgentRole = context.subAgentRole;
    if (context.doomLoopInfo) {
      reviewData.doomLoopDetected = true;
      reviewData.doomLoopCount = context.doomLoopInfo.count;
    }
    if (context.recentRejections?.length) {
      reviewData.recentRejections = context.recentRejections.slice(-5).map((r) => ({
        toolName: r.toolName,
        reason: r.reason,
      }));
    }
  }

  return [
    new SystemMessage(REVIEWER_SYSTEM_PROMPT),
    new HumanMessage(JSON.stringify(reviewData, null, 2)),
  ];
}

function riskAdjustedTimeout(risk: string, defaultTimeout: number): number {
  switch (risk) {
    case 'destructive':
      return Math.min(defaultTimeout * 2, 30_000);
    case 'network':
    case 'vcs_mutation':
      return Math.min(defaultTimeout * 1.5, 22_500);
    default:
      return defaultTimeout;
  }
}

function parseAutoReviewSuggestion(
  content: string,
  grantOptions: ShellApprovalGrant[],
): AutoReviewResult {
  const json = extractJsonObject(content);
  if (!json) {
    return {
      ok: false,
      reason: 'auto review did not return JSON',
      failureType: 'invalid_response',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {
      ok: false,
      reason: 'auto review returned invalid JSON',
      failureType: 'invalid_response',
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      reason: 'auto review returned a non-object response',
      failureType: 'invalid_response',
    };
  }
  const obj = parsed as Record<string, unknown>;
  const approved = obj.approved === true;
  const grant = typeof obj.grant === 'string' ? obj.grant : 'approve_once';
  const reason = typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : '';
  const riskAssessment =
    typeof obj.riskAssessment === 'string' &&
    ['low', 'medium', 'high', 'critical'].includes(obj.riskAssessment)
      ? (obj.riskAssessment as AutoReviewSuggestion['riskAssessment'])
      : undefined;

  if (!isShellApprovalGrant(grant) || !grantOptions.includes(grant)) {
    return {
      ok: false,
      reason: `auto review suggested unsupported grant: ${grant}`,
      failureType: 'invalid_response',
    };
  }

  return {
    ok: true,
    suggestion: {
      approved,
      grant,
      reason: reason || (approved ? 'auto review approved' : 'auto review rejected'),
      riskAssessment,
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
