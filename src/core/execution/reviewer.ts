import type { AgentConfig } from '@/core/config/index';
import {
  ProviderDataAdmissionError,
  type ProviderDataAdmissionGateV1,
} from '@/core/config/provider-data-admission';
import { type BaseMessage, humanMessage, systemMessage } from '@/core/messages';
import { createChatModel, type SupportedChatModel } from '@/core/model/factory';
import {
  computeModelInvocationPrivateDigestV1,
  type ModelInvocationGatewayV1,
  type ModelInvocationPersistenceV1,
  normalizedModelResponseToAIMessageV1,
} from '@/core/model/invocation-gateway';
import { compileModelSurfaceV1 } from '@/core/model/surface-compiler';
import type { ShellApprovalGrant, ToolApprovalPayload } from '@/protocol/events';
import type {
  VerificationReviewerInput,
  VerificationReviewerResult,
} from '@/protocol/verification';
import type { PendingToolRequest } from '../harness/tool-requests';

export interface AutoReviewSuggestion {
  approved: boolean;
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
  config?: AgentConfig;
  model: SupportedChatModel;
  gateway?: ModelInvocationGatewayV1;
  persistence?: ModelInvocationPersistenceV1;
  payload: ToolApprovalPayload;
  request: PendingToolRequest;
  context?: ReviewContext;
  timeoutMs?: number;
  providerDataAdmission?: ProviderDataAdmissionGateV1;
  providerDataPolicyRequired?: boolean;
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
    if (!input.config || !input.gateway || !input.persistence) {
      throw new Error('ModelInvocationGateway execution context is unavailable.');
    }
    const compiled = compileModelSurfaceV1({
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
        projectionEnvironmentDigest: computeModelInvocationPrivateDigestV1(
          'kite.model-projection-environment.v1',
          { reviewContext: input.context ?? null },
        ),
        capabilityBindingDigest: computeModelInvocationPrivateDigestV1(
          'kite.model-capability-bindings.v1',
          [],
        ),
      },
      providerDataAdmission: input.providerDataAdmission,
      providerDataPolicyRequired: input.providerDataPolicyRequired ?? false,
      resourceKind: 'verification',
      ...(input.parentReservationId ? { parentReservationId: input.parentReservationId } : {}),
      signal: controller.signal,
    });
    modelInvocationId = pending.invocationId;
    const result = normalizedModelResponseToAIMessageV1(await pending.commit());
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
    if (error instanceof ProviderDataAdmissionError) throw error;
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

/** Review post-execution evidence in an isolated prompt with no main-model conclusion. */
export async function reviewVerificationEvidence(input: {
  config?: AgentConfig;
  model: SupportedChatModel;
  gateway?: ModelInvocationGatewayV1;
  persistence?: ModelInvocationPersistenceV1;
  evidence: VerificationReviewerInput;
  timeoutMs?: number;
  providerDataAdmission?: ProviderDataAdmissionGateV1;
  providerDataPolicyRequired?: boolean;
  parentReservationId?: string;
}): Promise<VerificationReviewerResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(new Error('verification review timed out')),
    input.timeoutMs ?? 30_000,
  );
  let modelInvocationId: string | undefined;
  try {
    if (!input.config || !input.gateway || !input.persistence) {
      throw new Error('ModelInvocationGateway execution context is unavailable.');
    }
    const messages = [
      systemMessage(
        [
          'You are an independent post-execution verifier.',
          'Use only the supplied original receipts, artifacts, and structured workflow outputs.',
          'Do not trust or infer any main-model claim.',
          'Return only JSON: {"outcome":"passed|failed|inconclusive","summary":"..."}.',
        ].join('\n'),
      ),
      humanMessage(JSON.stringify(input.evidence)),
    ];
    const compiled = compileModelSurfaceV1({
      purpose: 'verification_review',
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
        contextCheckpointId: state.context.activeCheckpoint?.sourceDigest ?? null,
        promptContractVersion: 'verification-review-v1',
        projectionEnvironmentDigest: computeModelInvocationPrivateDigestV1(
          'kite.model-projection-environment.v1',
          { verificationEvidence: input.evidence },
        ),
        capabilityBindingDigest: computeModelInvocationPrivateDigestV1(
          'kite.model-capability-bindings.v1',
          [],
        ),
      },
      providerDataAdmission: input.providerDataAdmission,
      providerDataPolicyRequired: input.providerDataPolicyRequired ?? false,
      resourceKind: 'verification',
      ...(input.parentReservationId ? { parentReservationId: input.parentReservationId } : {}),
      signal: controller.signal,
    });
    modelInvocationId = pending.invocationId;
    const result = normalizedModelResponseToAIMessageV1(await pending.commit());
    const parsed = JSON.parse(modelResponseText(result.content)) as Record<string, unknown>;
    if (
      !['passed', 'failed', 'inconclusive'].includes(String(parsed.outcome)) ||
      typeof parsed.summary !== 'string'
    ) {
      return {
        outcome: 'inconclusive',
        summary: 'Reviewer returned an invalid response.',
        modelInvocationId,
      };
    }
    return {
      outcome: parsed.outcome as VerificationReviewerResult['outcome'],
      summary: parsed.summary,
      modelInvocationId,
    };
  } catch (error) {
    if (error instanceof ProviderDataAdmissionError) throw error;
    return {
      outcome: 'inconclusive',
      summary: error instanceof Error ? error.message : String(error),
      ...(modelInvocationId ? { modelInvocationId } : {}),
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
  'Your job is to classify tool calls as SAFE or UNSAFE before they execute.',
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
  'OUTPUT FORMAT: Return ONLY a JSON object:',
  '{',
  '  "approved": true or false,',
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
