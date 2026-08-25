/**
 * Single authority for foreground Session navigation ordering.
 *
 * An async historical load captures a token. Every later navigation invalidates
 * that token before changing the active Runtime/TUI projection, so a delayed
 * success or failure can no longer commit or roll back over the newer choice.
 */
export class SessionNavigationAuthority {
  #generation = 0;
  #loadingTarget: string | null = null;

  beginLoad(target?: string): number {
    this.#generation += 1;
    this.#loadingTarget = target ?? null;
    return this.#generation;
  }

  invalidatePendingLoad(): void {
    this.#generation += 1;
    this.#loadingTarget = null;
  }

  isCurrent(token: number): boolean {
    return token === this.#generation;
  }

  isLoadingTarget(threadId: string): boolean {
    return this.#loadingTarget === threadId;
  }

  commit(token: number, effect: () => void): boolean {
    if (!this.isCurrent(token)) return false;
    effect();
    this.#loadingTarget = null;
    return true;
  }
}
