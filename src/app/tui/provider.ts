import type {
  AgentPlan,
  PlanArtifactRef,
  ShellGrantUsed,
  ToolApprovalPayload,
  UserInputPayload,
} from '@/protocol/events';

export type TuiAction =
  | { type: 'approve'; grant: ShellGrantUsed }
  | { type: 'reject' }
  | { type: 'input'; text: string; answers?: Record<string, string> }
  | { type: 'cancel' }
  | {
      type: 'plan_review_decision';
      decision:
        | {
            kind: 'approve';
            nextMode: 'accept_edits' | 'auto';
          }
        | { kind: 'revise'; feedback: string }
        | { kind: 'cancel'; reason?: string };
    };

export type TuiInterruptPayload =
  | { kind: 'approval'; approval: ToolApprovalPayload }
  | { kind: 'input'; question: UserInputPayload }
  | { kind: 'plan_review'; plan: AgentPlan; artifact?: PlanArtifactRef };

export class TuiUserInputProvider {
  private pendingResolve: ((action: TuiAction) => void) | null = null;
  private pendingInterrupt: TuiInterruptPayload | null = null;

  /** 获取当前待处理的中断负载 / Get current pending interrupt payload */
  getPendingInterrupt(): TuiInterruptPayload | null {
    return this.pendingInterrupt;
  }

  /** 由 UI 调用，提交用户操作 / Called by UI to submit user action */
  submitAction(action: TuiAction): void {
    this.pendingInterrupt = null;
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(action);
    }
  }

  async requestAction(payload: TuiInterruptPayload): Promise<TuiAction> {
    this.pendingInterrupt = payload;
    // 中断永久等待用户处理
    return new Promise<TuiAction>((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  async teardown(): Promise<void> {
    if (this.pendingResolve) {
      this.pendingResolve({ type: 'cancel' });
      this.pendingResolve = null;
      this.pendingInterrupt = null;
    }
  }

  reset(): void {
    if (this.pendingResolve) {
      this.pendingResolve({ type: 'cancel' });
    }
    this.pendingResolve = null;
    this.pendingInterrupt = null;
  }
}
