import type { ModelRuntimeConfig } from './config';
import { createChatModel, type SupportedChatModel } from './factory';
import {
  computeModelInvocationPrivateDigest,
  type ModelInvocationGateway,
  type ModelInvocationPersistence,
  type ModelInvocationStateView,
  normalizedModelResponseToAIMessage,
} from './invocation-gateway';
import { type BaseMessage, humanMessage, systemMessage } from './messages';
import { compileModelSurface } from './surface-compiler';

export type ShellApprovalGrant = 'approve_once' | 'same_command' | 'full_access';

export interface ToolApprovalPayload {
  risk:
    | 'read'
    | 'plan'
    | 'write_file'
    | 'execute_code'
    | 'destructive'
    | 'network'
    | 'vcs_mutation'
    | 'mcp'
    | 'unknown';
  expectedEffects: readonly string[];
  grantOptions: readonly ShellApprovalGrant[];
  recommendedGrant: ShellApprovalGrant;
  summary: string;
  reason: string;
}

export interface PendingToolRequestView {
  id?: string;
  name: string;
  args: unknown;
}

type ReviewGateway = Pick<ModelInvocationGateway, 'invoke'>;

interface ReviewStateView extends ModelInvocationStateView {
  readonly context: { readonly activeCheckpoint?: { readonly sourceDigest: string } };
}

export interface AutoReviewSuggestion {
  approved: boolean;
  requiresUserApproval?: true;
  grant: ShellApprovalGrant;
  reason: string;
  riskAssessment?: 'low' | 'medium' | 'high' | 'critical';
}

export interface AutoReviewResult {
  ok: boolean;
  modelInvocationId?: string;
  suggestion?: AutoReviewSuggestion;
  reason?: string;
  failureType?: 'technical' | 'invalid_response';
}

export interface ReviewContext {
  userTask?: string;
  planSummary?: string;
  recentRejections?: readonly { toolName: string; reason: string; timestamp: number }[];
  isSubAgent?: boolean;
  subAgentRole?: string;
  workspaceRoot?: string;
  doomLoopInfo?: { fingerprint: string; count: number };
}

export function resolveAutoReviewConfig(config: ModelRuntimeConfig): ModelRuntimeConfig {
  const review = config.autoReview;
  return {
    ...config,
    providerName: review?.provider ?? config.providerName,
    modelName: review?.model ?? config.modelName,
  };
}

export function createAutoReviewModel(config: ModelRuntimeConfig): SupportedChatModel {
  return createChatModel(resolveAutoReviewConfig(config));
}

export async function reviewToolApproval(input: {
  config?: ModelRuntimeConfig;
  model?: SupportedChatModel;
  gateway?: ReviewGateway;
  persistence?: ModelInvocationPersistence<ReviewStateView>;
  payload: ToolApprovalPayload;
  request: PendingToolRequestView;
  context?: ReviewContext;
  timeoutMs?: number;
  parentReservationId?: string;
  parentInvocationId?: string;
}): Promise<AutoReviewResult> {
  const baseTimeout = input.timeoutMs ?? 15_000;
  const effectiveTimeout = riskAdjustedTimeout(input.payload.risk, baseTimeout);
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(new Error('auto review timed out')),
    effectiveTimeout,
  );
  let modelInvocationId: string | undefined;
  try {
    const messages = buildReviewPrompt(input.payload, input.request, input.context);
    if (!input.config || !input.model || !input.gateway || !input.persistence) {
      throw new Error('ModelInvocationGateway execution context is unavailable.');
    }
    const compiled = compileModelSurface({
      purpose: 'auto_review',
      config: input.config,
      model: input.model,
      tools: {},
      messages,
      maxOutputTokens: 1_000,
      transport: 'generate',
    });
    const state = input.persistence.getState();
    const pending = await input.gateway.invoke({
      model: input.model,
      compiled,
      persistence: input.persistence,
      provenance: {
        parentInvocationId: input.parentInvocationId ?? null,
        parentToolCallId: input.request.id,
        contextCheckpointId: state.context.activeCheckpoint?.sourceDigest ?? null,
        promptContractVersion: 'auto-review-v1',
        projectionEnvironmentDigest: computeModelInvocationPrivateDigest(
          'kite.model-projection-environment.v1',
          { reviewContext: input.context ?? null },
        ),
        capabilityBindingDigest: computeModelInvocationPrivateDigest(
          'kite.model-capability-bindings.v1',
          [],
        ),
      },
      resourceKind: 'verification',
      ...(input.parentReservationId ? { parentReservationId: input.parentReservationId } : {}),
      signal: controller.signal,
    });
    modelInvocationId = pending.invocationId;
    const result = normalizedModelResponseToAIMessage(await pending.commit());
    const reviewResult = parseAutoReviewSuggestion(
      modelResponseText(result.content),
      input.payload.grantOptions,
    );

    // Belt-and-suspenders: destructive commands are never auto-approved
    if (
      reviewResult.ok &&
      reviewResult.suggestion?.approved &&
      input.payload.risk === 'destructive'
    ) {
      return {
        ok: true,
        modelInvocationId,
        suggestion: {
          approved: false,
          grant: 'approve_once',
          reason: 'Destructive commands cannot be auto-approved by policy.',
          riskAssessment: 'critical',
        },
      };
    }

    return { ...reviewResult, modelInvocationId };
  } catch (error) {
    return {
      ok: false,
      ...(modelInvocationId ? { modelInvocationId } : {}),
      reason: error instanceof Error ? error.message : String(error),
      failureType: 'technical',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function modelResponseText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part && typeof part === 'object' && 'text' in part
        ? String((part as { text: unknown }).text)
        : '',
    )
    .join('');
}

const REVIEWER_SYSTEM_PROMPT = [
  'You are a security reviewer for a coding agent execution gateway.',
  'Your job is to decide whether a tool call may run, must be rejected, or needs user approval.',
  '',
  'SAFETY RULES (ordered by priority):',
  '1. DESTRUCTIVE commands are ALWAYS denied:',
  '   - sudo, chmod -R, chown -R, dd, mkfs, shutdown/reboot, diskpart',
  '   - curl | bash, eval on downloaded content',
  '   - Deleting the workspace root, /etc, /bin, /boot, /lib, /sys, /proc, /dev, C:\\Windows',
  '   - force push to main, production deploys, IAM/permission grants',
  '',
  '2. FILE DELETION (rm -rf / del /s) is ACCEPTABLE when:',
  '   - The target is a build cache, temp directory, or dependency folder (node_modules, .next, dist, /tmp, /var/tmp)',
  '   - The target is a non-critical path outside workspace and system directories',
  '   - The action aligns with the user task or approved plan',
  '   ONLY deny rm/del when it targets the workspace root or critical system paths (listed in rule 1).',
  '',
  '3. NETWORK commands require explicit justification:',
  '   - curl, wget — must fetch from trusted domains only',
  '   - Data exfiltration to untrusted destinations is denied',
  '',
  '4. FILE WRITES within the workspace are ACCEPTABLE when:',
  '   - The file path is inside the workspace directory (see workspaceRoot)',
  '   - The content aligns with the approved plan or user task',
  '',
  '5. SHELL commands are ACCEPTABLE when:',
  '   - They are read-only inspection (ls, cat, grep, git status, git diff)',
  '   - They run project-defined tests/builds (bun test, npm run build)',
  '   - They install dependencies from configured package managers',
  '',
  '6. MCP tools are ACCEPTABLE when the server is configured by the user.',
  '',
  'CONTEXT RULES:',
  '- If an approved plan exists, actions aligning with the plan are expected.',
  '- If the user task describes a specific goal, actions serving that goal are expected.',
  '- If this same tool was recently rejected, do NOT approve unless the args have changed meaningfully.',
  '- If doom-loop is detected (same call repeated), ALWAYS deny.',
  '',
  'DECISION RULES:',
  '- Use "approve" when the call is safe, scoped, and aligned with the user task.',
  '- Use "reject" when the call is clearly unsafe, unrelated, deceptive, or violates a hard safety rule.',
  '- Use "ask_user" when safety depends on user intent or authorization that the available context cannot establish.',
  '',
  'OUTPUT FORMAT: Return ONLY a JSON object:',
  '{',
  '  "decision": "approve" | "reject" | "ask_user",',
  '  "grant": "approve_once" | "same_command" | "full_access",',
  '  "reason": "brief explanation (max 200 chars)",',
  '  "riskAssessment": "low" | "medium" | "high" | "critical"',
  '}',
  '',
  'Default to "approve_once" unless the action is a repeatable build/test command.',
  'Prefer allowing file cleanup operations (rm, del) on non-critical paths.',
].join('\n');

function buildReviewPrompt(
  payload: ToolApprovalPayload,
  request: PendingToolRequestView,
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

  return [systemMessage(REVIEWER_SYSTEM_PROMPT), humanMessage(JSON.stringify(reviewData, null, 2))];
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
  grantOptions: readonly ShellApprovalGrant[],
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

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: 'auto review returned a non-object response',
      failureType: 'invalid_response',
    };
  }
  const obj = parsed as Record<string, unknown>;
  const allowedKeys = new Set(['decision', 'approved', 'grant', 'reason', 'riskAssessment']);
  if (Object.keys(obj).some((key) => !allowedKeys.has(key))) {
    return {
      ok: false,
      reason: 'auto review returned unknown fields',
      failureType: 'invalid_response',
    };
  }
  if (
    (obj.decision !== undefined &&
      obj.decision !== 'approve' &&
      obj.decision !== 'reject' &&
      obj.decision !== 'ask_user') ||
    (obj.approved !== undefined && typeof obj.approved !== 'boolean')
  ) {
    return {
      ok: false,
      reason: 'auto review returned an unsupported decision',
      failureType: 'invalid_response',
    };
  }
  const decision =
    obj.decision === 'approve' || obj.decision === 'reject' || obj.decision === 'ask_user'
      ? obj.decision
      : typeof obj.approved === 'boolean'
        ? obj.approved
          ? 'approve'
          : 'ask_user'
        : null;
  if (decision === null) {
    return {
      ok: false,
      reason: 'auto review returned an unsupported decision',
      failureType: 'invalid_response',
    };
  }
  if (typeof obj.approved === 'boolean' && obj.approved !== (decision === 'approve')) {
    return {
      ok: false,
      reason: 'auto review returned contradictory decision fields',
      failureType: 'invalid_response',
    };
  }
  const approved = decision === 'approve';
  const grant = typeof obj.grant === 'string' ? obj.grant : 'approve_once';
  const reason = typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : '';
  if (
    obj.riskAssessment !== undefined &&
    (typeof obj.riskAssessment !== 'string' ||
      !['low', 'medium', 'high', 'critical'].includes(obj.riskAssessment))
  ) {
    return {
      ok: false,
      reason: 'auto review returned an invalid risk assessment',
      failureType: 'invalid_response',
    };
  }
  const riskAssessment = obj.riskAssessment as AutoReviewSuggestion['riskAssessment'];

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
      ...(decision === 'ask_user' ? { requiresUserApproval: true as const } : {}),
      grant,
      reason:
        reason ||
        (approved
          ? 'auto review approved'
          : decision === 'ask_user'
            ? 'auto review requested user approval'
            : 'auto review rejected'),
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
