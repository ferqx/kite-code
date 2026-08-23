export class SessionRegistry<Runtime> {
  readonly runtimes = new Map<string, Runtime>();
  activeId = '';
  private counter = 0;

  nextSessionId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${this.counter++}`;
  }

  nextRecoverySessionId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-recovery-${this.counter++}`;
  }
}
