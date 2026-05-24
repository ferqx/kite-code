import type { AgentEvent } from "@/protocol/events";
import type { InterruptPayload, UserAction } from "@/protocol/actions";
import type { UserInputProvider } from "@/protocol/provider";

export class TuiUserInputProvider implements UserInputProvider {
  private dispatch: (event: AgentEvent) => void;
  private pendingResolve: ((action: UserAction) => void) | null = null;
  private pendingInterrupt: InterruptPayload | null = null;
  /** 手动压缩上下文请求标志 / Flag set when user requests manual compaction */
  compactRequested = false;

  constructor(dispatch: (event: AgentEvent) => void) {
    this.dispatch = dispatch;
  }

  onEvent(event: AgentEvent): void {
    this.dispatch(event);
  }

  /** 获取当前待处理的中断负载 / Get current pending interrupt payload */
  getPendingInterrupt(): InterruptPayload | null {
    return this.pendingInterrupt;
  }

  /** 由 UI 调用，提交用户操作 / Called by UI to submit user action */
  submitAction(action: UserAction): void {
    this.pendingInterrupt = null;
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(action);
    }
  }

  async requestAction(payload: InterruptPayload): Promise<UserAction> {
    this.pendingInterrupt = payload;
    // 中断永久等待用户处理
    return new Promise<UserAction>((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  async teardown(): Promise<void> {
    if (this.pendingResolve) {
      this.pendingResolve({ type: "cancel" });
      this.pendingResolve = null;
      this.pendingInterrupt = null;
    }
  }

  reset(): void {
    if (this.pendingResolve) {
      this.pendingResolve({ type: "cancel" });
    }
    this.pendingResolve = null;
    this.pendingInterrupt = null;
  }
}
