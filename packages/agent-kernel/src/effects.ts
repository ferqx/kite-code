import type { CompletionGuardBlocked } from './completion';

export type McpProviderRecoveryAction = 'login' | 'approve' | 'retry';
export type McpProviderDirectoryStatus =
  | 'pending_approval'
  | 'rejected'
  | 'disabled'
  | 'login_required'
  | 'connecting'
  | 'ready'
  | 'degraded'
  | 'failed'
  | 'quarantined';

/** Complete State effect vocabulary. Controllers interpret these facts; Kernel never executes them. */
export type RuntimeEffect =
  | {
      readonly type: 'call_model';
      readonly resourceEstimate?: {
        readonly inputTokens: number;
        readonly maxOutputTokens: number;
      };
    }
  | { readonly type: 'compact_context'; readonly compactionId: string }
  | { readonly type: 'run_tools'; readonly toolCallIds: readonly string[] }
  | {
      readonly type: 'request_user_input';
      readonly interactionId: string;
      readonly toolCallId: string;
    }
  | {
      readonly type: 'request_plan_review';
      readonly interactionId: string;
      readonly toolCallId: string;
    }
  | {
      readonly type: 'request_tool_approval';
      readonly interactionId: string;
      readonly toolCallId: string;
    }
  | {
      readonly type: 'request_verification_decision';
      readonly interactionId: string;
      readonly verificationId: string;
    }
  | {
      readonly type: 'request_provider_action';
      readonly interactionId: string;
      readonly providerId: string;
      readonly action: McpProviderRecoveryAction;
      readonly originatingToolCallId: string;
    }
  | {
      readonly type: 'request_provider_admission';
      readonly interactionId: string;
      readonly providerId: string;
      readonly providerStatus: McpProviderDirectoryStatus;
      readonly retryable: boolean;
    }
  | { readonly type: 'run_auto_review'; readonly reviewId: string; readonly toolCallId: string }
  | { readonly type: 'run_verification'; readonly verificationId: string }
  | { readonly type: 'repair_verification'; readonly verificationId: string }
  | { readonly type: 'run_verification_compensation'; readonly verificationId: string }
  | { readonly type: 'emit_final' }
  | { readonly type: 'completion_blocked'; readonly decision: CompletionGuardBlocked }
  | { readonly type: 'stop' }
  | { readonly type: 'busy'; readonly reason: string }
  | {
      readonly type: 'recovery_blocked';
      readonly reason: string;
      readonly failureKind:
        | 'persistence_unavailable'
        | 'loop_exhausted'
        | 'compaction_failed'
        | 'unknown';
      readonly recoveryCause?: 'journal_invalid' | 'no_progress';
    };

export type PendingEffect = RuntimeEffect;

export function isTerminalEffect(effect: RuntimeEffect): boolean {
  return (
    effect.type === 'emit_final' ||
    effect.type === 'stop' ||
    effect.type === 'busy' ||
    effect.type === 'recovery_blocked'
  );
}

export function isInterruptEffect(effect: RuntimeEffect): boolean {
  return (
    effect.type === 'request_user_input' ||
    effect.type === 'request_plan_review' ||
    effect.type === 'request_tool_approval' ||
    effect.type === 'request_verification_decision' ||
    effect.type === 'request_provider_action' ||
    effect.type === 'request_provider_admission'
  );
}
