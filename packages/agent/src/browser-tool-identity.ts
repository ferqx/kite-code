export const browserStructuredToolIds = [
  'browser.structured.navigate',
  'browser.structured.snapshot',
  'browser.structured.click',
  'browser.structured.type',
  'browser.structured.fill_form',
  'browser.structured.tabs',
  'browser.structured.screenshot',
  'browser.structured.press',
  'browser.structured.wait',
  'browser.structured.dialog',
  'browser.structured.history',
  'browser.structured.pointer',
] as const;

export type BrowserStructuredToolId = (typeof browserStructuredToolIds)[number];

export function isBrowserOrchestrator(id: string | undefined, version: string | undefined) {
  return (
    version === '1' &&
    (id === 'browser.execute' || browserStructuredToolIds.some((tool) => id === tool))
  );
}

/** Existing-page operations that can proceed while an approved plan recovers progress. */
export function isBrowserObservationOrReleaseTool(
  id: string | undefined,
  version: string | undefined,
  input: unknown,
): boolean {
  if (version !== '1') return false;
  switch (id) {
    case 'browser.snapshot':
    case 'browser.image':
    case 'browser.close':
    case 'browser.request_human':
    case 'browser.structured.snapshot':
    case 'browser.structured.screenshot':
    case 'browser.structured.wait':
      return true;
    case 'browser.structured.tabs':
    case 'browser.structured.dialog': {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
      const { action } = input as { action?: unknown };
      return (
        action === 'list' ||
        (id === 'browser.structured.tabs' && (action === 'select' || action === 'close'))
      );
    }
    default:
      return false;
  }
}
