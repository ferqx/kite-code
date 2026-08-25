import type { AgentPlan, InteractionMode, PlanArtifactRef } from '@kite/runtime-contract';
import type { RuntimePresentationEvent } from '#app/tui/runtime-presentation';

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
  readonly runtimeEvents: readonly RuntimePresentationEvent[];
  readonly interrupt: ReplayInterrupt | null;
  readonly modelProvider: string;
  readonly modelName: string;
  readonly thinkingLevel: string | null;
  readonly plan: AgentPlan | null;
  readonly interactionMode: InteractionMode;
}
