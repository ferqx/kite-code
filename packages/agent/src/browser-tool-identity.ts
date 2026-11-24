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
