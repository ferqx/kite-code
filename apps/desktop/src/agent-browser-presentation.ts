import type { NativeSelection } from './native-bridge';

/** Existing verified View facts may present a browser; a webpage or foreign/background job may not. */
export function agentBrowserPresentationKeys(
  selection: NativeSelection | undefined,
  selectedSessionId: string | undefined,
): string[] {
  if (
    !selection?.canReadExtensions ||
    selection.viewLoading ||
    selection.session.parentSessionId ||
    selection.session.id !== selectedSessionId
  )
    return [];
  return selection.executions
    .filter(
      (execution) =>
        execution.originStoreId === selection.storeId &&
        execution.sessionId === selection.session.id &&
        execution.kind === 'job' &&
        execution.definitionId === 'browser.session' &&
        execution.definitionVersion === '1' &&
        ['dispatching', 'running'].includes(execution.status) &&
        execution.cancelRequestedAt === null,
    )
    .map((execution) => JSON.stringify([selection.storeId, selection.session.id, execution.id]));
}

/** Remember presentation, not browser lifecycle. Dismissing an observation does not reopen it. */
export class AgentBrowserPresentation {
  private readonly seen = new Set<string>();
  observe(keys: readonly string[]): boolean {
    const fresh = keys.some((key) => !this.seen.has(key));
    for (const key of keys) this.seen.add(key);
    return fresh;
  }
}
