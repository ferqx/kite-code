import type {
  AcceptedPresentationEnvelope,
  AgentPlan,
  InteractionMode,
  PlanArtifactRef,
} from '@kite-ai/runtime-contract';

export interface SessionInfo {
  readonly threadId: string;
  readonly name: string;
  readonly updatedAt: string;
  readonly needsSmartName: boolean;
}

export interface ReplayInterrupt {
  readonly kind: 'approval' | 'input' | 'plan_review';
  readonly callId?: string;
  readonly plan?: AgentPlan;
  readonly artifact?: PlanArtifactRef;
}

export interface SessionData {
  readonly threadId: string;
  readonly messages: readonly unknown[];
  /** Current-format history events are already accepted presentation envelopes. */
  readonly runtimeEvents: readonly AcceptedPresentationEnvelope[];
  readonly interrupt: ReplayInterrupt | null;
  readonly modelProvider: string;
  readonly modelName: string;
  readonly thinkingLevel: string | null;
  readonly plan: AgentPlan | null;
  readonly interactionMode: InteractionMode;
  readonly recovery: 'normal' | 'pending_interaction' | 'restart_required';
}
