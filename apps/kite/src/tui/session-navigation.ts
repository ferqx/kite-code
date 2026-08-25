/**
 * Single authority for foreground Session navigation ordering.
 *
 * An async historical load captures a token. Every later navigation invalidates
 * that token before changing the active Runtime/TUI projection, so a delayed
 * success or failure can no longer commit or roll back over the newer choice.
 */
export class SessionNavigationAuthority {
  #generation = 0;

  beginLoad(): number {
    this.#generation += 1;
    return this.#generation;
  }

  invalidatePendingLoad(): void {
    this.#generation += 1;
  }

  isCurrent(token: number): boolean {
    return token === this.#generation;
  }

  commit(token: number, effect: () => void): boolean {
    if (!this.isCurrent(token)) return false;
    effect();
    return true;
  }
}
