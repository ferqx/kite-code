/**
 * Shared metadata sanitization for model-visible capability output.
 *
 * All Provider names, Tool names, and other user-supplied strings that
 * appear in tool results MUST pass through safeCapabilityMetadata before
 * reaching the model. This prevents control characters, ANSI escapes,
 * excessive whitespace, and unbounded length from leaking into tool
 * messages, JSON serialization, or TUI rendering.
 */

/**
 * Code point ranges that MUST be removed from model-visible output:
 *  - C0 controls + DEL (0–31, 127)
 *  - Unpaired surrogates (U+D800–U+DFFF, 55296–57343): these are not valid
 *    Unicode scalars and produce replacement characters in JSON or TUI
 */
function isUnsafeCodePoint(codePoint: number): boolean {
  return codePoint < 32 || codePoint === 127 || (codePoint >= 0xd800 && codePoint <= 0xdfff);
}

export function safeCapabilityMetadata(value: string, maximum = 96): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return isUnsafeCodePoint(codePoint) ? ' ' : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}
