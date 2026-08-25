import type { ShellApprovalGrant } from '@kite-ai/runtime-contract';
import type { SessionInterruptPayload, SessionUserAction } from '#app/runtime/session/contracts';

export type TuiAction =
  | { type: 'approve'; interactionId: string; generation: number; grant: ShellApprovalGrant }
  | { type: 'reject'; interactionId: string; generation: number }
  | { type: 'input'; interactionId?: string; text: string; answers?: Record<string, string> }
  | { type: 'cancel'; interactionId?: string }
  | {
      type: 'plan_review_decision';
      interactionId?: string;
      decision:
        | {
            kind: 'approve';
            nextMode: 'accept_edits' | 'auto';
          }
        | { kind: 'revise'; feedback: string }
        | { kind: 'cancel'; reason?: string };
    };
export type TuiInterruptPayload = SessionInterruptPayload;

type PendingResolve = (action: SessionUserAction) => void;

export class TuiUserInputProvider {
  private pendingResolve: PendingResolve | null = null;
  private pendingInterrupt: TuiInterruptPayload | null = null;
  private actionSink: ((action: SessionUserAction) => void) | null = null;
  private readonly submittedActionKeys = new Set<string>();

  /** 获取当前待处理的中断负载 / Get current pending interrupt payload */
  getPendingInterrupt(): SessionInterruptPayload | null {
    return this.pendingInterrupt;
  }

  setActionSink(sink: ((action: SessionUserAction) => void) | null): void {
    this.actionSink = sink;
  }

  /** 由 UI 调用，提交用户操作 / Called by UI to submit user action */
  submitAction(action: TuiAction): void {
    const pending = this.pendingInterrupt;

    const approvalAction = action.type === 'approve' || action.type === 'reject';
    // Approvals are generation-scoped. A late click from a previous replay
    // generation is a no-op even when it happens to reuse the same id.
    if (
      approvalAction &&
      pending &&
      (action.interactionId !== pending.interactionId ||
        action.generation !== (pending.kind === 'approval' ? pending.generation : undefined))
    ) {
      return;
    }

    const normalized = pending
      ? this.normalizeAction(action, pending)
      : this.normalizeExactAction(action);
    if (!normalized) return;
    const key =
      normalized.type === 'approve' || normalized.type === 'reject'
        ? `${normalized.interactionId}:${normalized.generation}`
        : normalized.interactionId;
    if (this.submittedActionKeys.has(key)) return;
    this.submittedActionKeys.add(key);
    if (this.submittedActionKeys.size > 4096) {
      const oldest = this.submittedActionKeys.values().next().value;
      if (oldest) this.submittedActionKeys.delete(oldest);
    }
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    this.pendingInterrupt = null;
    resolve?.(normalized);
    this.actionSink?.(normalized);
  }

  async requestAction(payload: TuiInterruptPayload): Promise<SessionUserAction> {
    this.pendingInterrupt = payload;
    // 中断永久等待用户处理
    return new Promise<SessionUserAction>((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  async teardown(): Promise<void> {
    if (this.pendingResolve) {
      const interactionId = this.pendingInterrupt?.interactionId;
      this.pendingResolve({
        type: 'cancel',
        interactionId: interactionId!,
      });
      this.pendingResolve = null;
      this.pendingInterrupt = null;
    }
  }

  reset(): void {
    if (this.pendingResolve) {
      const interactionId = this.pendingInterrupt?.interactionId;
      this.pendingResolve({
        type: 'cancel',
        interactionId: interactionId!,
      });
    }
    this.pendingResolve = null;
    this.pendingInterrupt = null;
  }

  private normalizeAction(
    action: TuiAction,
    pending: SessionInterruptPayload,
  ): SessionUserAction | null {
    const id = action.interactionId ?? pending.interactionId;
    switch (action.type) {
      case 'approve':
        if (pending.kind !== 'approval') return null;
        return {
          type: 'approve',
          interactionId: id,
          generation: action.generation,
          grant: action.grant,
        };
      case 'reject':
        if (pending.kind !== 'approval') return null;
        return { type: 'reject', interactionId: id, generation: action.generation };
      case 'input':
        return {
          type: 'input',
          interactionId: id,
          text: action.text,
          ...(action.answers ? { answers: action.answers } : {}),
        };
      case 'cancel':
        return { type: 'cancel', interactionId: id };
      case 'plan_review_decision':
        return {
          type: 'plan_review_decision',
          interactionId: id,
          decision: action.decision,
        };
    }
  }

  private normalizeExactAction(action: TuiAction): SessionUserAction | null {
    if (!action.interactionId) return null;
    switch (action.type) {
      case 'approve':
        return {
          type: 'approve',
          interactionId: action.interactionId,
          generation: action.generation,
          grant: action.grant,
        };
      case 'reject':
        return {
          type: 'reject',
          interactionId: action.interactionId,
          generation: action.generation,
        };
      case 'input':
        return {
          type: 'input',
          interactionId: action.interactionId,
          text: action.text,
          ...(action.answers ? { answers: action.answers } : {}),
        };
      case 'cancel':
        return { type: 'cancel', interactionId: action.interactionId };
      case 'plan_review_decision':
        return {
          type: 'plan_review_decision',
          interactionId: action.interactionId,
          decision: action.decision,
        };
    }
  }
}
