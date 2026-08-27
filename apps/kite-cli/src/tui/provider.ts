import type { RuntimeClientInteraction, ShellApprovalGrant } from '@kite-ai/runtime-contract';
import type { TuiSubmittedInteractionAction as SessionUserAction } from '../adapters/tui/session-adapter';

export type TuiAction =
  | { type: 'approve'; interactionId: string; generation: number; grant: ShellApprovalGrant }
  | { type: 'reject'; interactionId: string; generation: number }
  | {
      type: 'input';
      interactionId?: string;
      text: string;
      optionId?: string;
      answers?: Record<string, string>;
    }
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
/** Client-safe interaction payload; Service-owned approval/input details never cross this type. */
export type TuiInterruptPayload = RuntimeClientInteraction;

type PendingResolve = (action: SessionUserAction) => void;
type ActionSink = (action: SessionUserAction) => void | Promise<void>;

export class TuiUserInputProvider {
  private pendingResolve: PendingResolve | null = null;
  private pendingInterrupt: TuiInterruptPayload | null = null;
  private actionSink: ActionSink | null = null;
  private readonly submittedActionKeys = new Set<string>();
  private readonly submittingActionKeys = new Set<string>();

  /** 获取当前待处理的中断负载 / Get current pending interrupt payload */
  getPendingInterrupt(): TuiInterruptPayload | null {
    return this.pendingInterrupt;
  }

  setActionSink(sink: ActionSink | null): () => void {
    this.actionSink = sink;
    return () => {
      // An older React effect cleanup must not clear a newer Runtime owner.
      if (this.actionSink === sink) this.actionSink = null;
    };
  }

  /** Submit and wait until the Runtime has accepted the interaction command. */
  async submitActionAsync(action: TuiAction): Promise<boolean> {
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
      return false;
    }

    const normalized = pending
      ? this.normalizeAction(action, pending)
      : this.normalizeExactAction(action);
    if (!normalized) return false;
    const key =
      normalized.type === 'approve' || normalized.type === 'reject'
        ? `${normalized.interactionId}:${normalized.generation}`
        : normalized.interactionId;
    if (this.submittedActionKeys.has(key) || this.submittingActionKeys.has(key)) return false;
    const resolve = this.pendingResolve;
    const sink = this.actionSink;
    if (!resolve && !sink) return false;
    this.submittingActionKeys.add(key);
    try {
      await sink?.(normalized);
    } finally {
      this.submittingActionKeys.delete(key);
    }
    this.submittedActionKeys.add(key);
    if (this.submittedActionKeys.size > 4096) {
      const oldest = this.submittedActionKeys.values().next().value;
      if (oldest) this.submittedActionKeys.delete(oldest);
    }
    if (this.pendingResolve === resolve) {
      this.pendingResolve = null;
      this.pendingInterrupt = null;
    }
    resolve?.(normalized);
    return true;
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
    pending: TuiInterruptPayload,
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
          ...(action.optionId ? { optionId: action.optionId } : {}),
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
          ...(action.optionId ? { optionId: action.optionId } : {}),
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
