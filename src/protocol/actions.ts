import type {
  AgentPlan,
  AuthorizationMode,
  InteractionMode,
  ShellGrantUsed,
  ToolApprovalPayload,
  UserInputPayload,
} from './events';

export type UserAction =
  | { type: 'approve'; grant: ShellGrantUsed }
  | { type: 'reject' }
  | { type: 'input'; text: string; answers?: Record<string, string> }
  | { type: 'cancel' }
  | { type: 'switch_auth'; mode: AuthorizationMode }
  // ── Plan Mode v2: unified plan_review_decision ──
  | {
      type: 'plan_review_decision';
      interactionId: string;
      planId: string;
      version: number;
      structuralDigest: string;
      decision:
        | { kind: 'approve'; nextMode: InteractionMode; clearPlanningContext: boolean }
        | { kind: 'revise'; feedback: string }
        | { kind: 'cancel'; reason?: string };
    }
  // ── Deprecated: replaced by plan_review_decision, kept for transition ──
  | { type: 'approve_plan' }
  | { type: 'approve_plan_auto' }
  | { type: 'approve_plan_manual' }
  | { type: 'supplement_plan'; feedback: string }
  | { type: 'reject_plan' };

export type InterruptPayload =
  | { kind: 'approval'; approval: ToolApprovalPayload }
  | { kind: 'input'; question: UserInputPayload }
  | { kind: 'plan_review'; plan: AgentPlan };
