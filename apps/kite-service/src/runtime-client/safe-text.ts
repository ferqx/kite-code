const MAX_CLIENT_TEXT_CODE_POINTS = 65_536;
const SECRET_PATTERNS = [
  /\b(?:authorization|api[_ -]?key|token|secret|password)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/giu,
  /\bsk-[A-Za-z0-9_-]{16,}\b/gu,
];

/** Shared App-owned text boundary for live Client events and durable history. */
export function projectRuntimeClientText(
  value: string,
  maximum = MAX_CLIENT_TEXT_CODE_POINTS,
): string {
  let text = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (
      codePoint <= 0x08 ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      continue;
    }
    text += character;
  }
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]');
  if (text.length <= maximum) return text;
  let end = Math.max(0, maximum - 1);
  // Protocol/Zod bounds use JavaScript string length. Avoid splitting a UTF-16
  // surrogate pair while keeping the ellipsis inside the same exact bound.
  const trailing = text.charCodeAt(end - 1);
  if (trailing >= 0xd800 && trailing <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** Approval commands must remain recognizable; only control characters and length are bounded. */
export function projectRuntimeClientCommand(value: string, maximum = 16_384): string {
  let text = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (
      codePoint <= 0x08 ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      continue;
    }
    text += character;
  }
  if (text.length <= maximum) return text;
  let end = Math.max(0, maximum - 1);
  const trailing = text.charCodeAt(end - 1);
  if (trailing >= 0xd800 && trailing <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}
