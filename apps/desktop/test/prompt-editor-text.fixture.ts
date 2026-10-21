import type { Locator } from 'playwright';

/** Read actual PromptEditor paragraph/BR text, preserving spaces and real line breaks.
 * CSS paragraph spacing and an empty editor's placeholder BR are not draft bytes.
 */
export const promptText = (input: Locator): Promise<string> =>
  input.evaluate((element) => {
    const text = (node: Node): string =>
      node.nodeName === 'BR'
        ? '\n'
        : node.nodeType === 3
          ? (node.textContent ?? '')
          : [...node.childNodes].map(text).join('');
    return [...element.children]
      .map((child) => (child.textContent ? text(child) : ''))
      .join('\n')
      .replace(/\r\n?/g, '\n');
  });
