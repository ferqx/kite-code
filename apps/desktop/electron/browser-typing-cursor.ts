/** Fixed isolated-world read. Only viewport coordinates leave the page, never field contents. */
export function readBrowserTypingCursor() {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  if (
    !(element instanceof HTMLElement) ||
    !element.matches('input,textarea,[contenteditable]') ||
    (element instanceof HTMLInputElement &&
      !['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(element.type)) ||
    (element instanceof HTMLInputElement && (element.disabled || element.readOnly)) ||
    (element instanceof HTMLTextAreaElement && (element.disabled || element.readOnly)) ||
    (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
      !element.isContentEditable)
  )
    return null;
  const rect = element.getBoundingClientRect();
  const left = Math.max(0, rect.left),
    top = Math.max(0, rect.top),
    right = Math.min(innerWidth, rect.right),
    bottom = Math.min(innerHeight, rect.bottom);
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top)
    return null;
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

export const browserTypingCursorScript = `(${readBrowserTypingCursor.toString()})()`;
