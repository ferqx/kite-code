import type {
  AgentPlan,
  AuthorizationMode,
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
      interactionId?: string;
      planId?: string;
      version?: number;
      structuralDigest?: string;
      decision:
        | {
            kind: 'approve';
            nextMode: 'accept_edits' | 'auto';
            clearPlanningContext: boolean;
          }
        | { kind: 'revise'; feedback: string }
        | { kind: 'cancel'; reason?: string };
    };

export type InterruptPayload =
  | { kind: 'approval'; approval: ToolApprovalPayload }
  | { kind: 'input'; question: UserInputPayload }
  | { kind: 'plan_review'; plan: AgentPlan };
