const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** UTF-8 output section for Shell receipts, model feedback and historical display. */
export function shellOutputPreview(
  details: Record<string, unknown>,
  executionId: string,
  requestedTokens: unknown,
  modelTokenLimit?: number,
) {
  const lines: string[] = [];
  const gaps: string[] = [];
  for (const stream of ['stdout', 'stderr']) {
    const content = details[stream];
    if (typeof content === 'string' && content.length) lines.push(`${stream}:\n${content}`);
  }
  if (details.output !== undefined) {
    const output = object(details.output);
    if (!Array.isArray(output?.items)) return;
    for (const raw of output.items) {
      const item = object(raw);
      if (
        !item ||
        item.executionId !== executionId ||
        typeof item.content !== 'string' ||
        (item.stream !== 'stdout' && item.stream !== 'stderr')
      )
        return;
      if (item.content.length) lines.push(`${item.stream}:\n${item.content}`);
      if (item.droppedBytes === null) {
        gaps.push(`Output gap in ${item.stream} (byte count unavailable for this page).`);
      } else if (item.droppedBytes && item.droppedBytes !== '0') {
        gaps.push(`Output bytes unavailable: ${item.droppedBytes} (${item.stream}).`);
      } else continue;
      lines.push(gaps.at(-1)!);
    }
  }
  const limit = Math.min(
    typeof requestedTokens === 'number' &&
      Number.isSafeInteger(requestedTokens) &&
      requestedTokens > 0
      ? requestedTokens
      : 10_000,
    modelTokenLimit ?? Number.POSITIVE_INFINITY,
  );
  return limitShellOutput(lines.join('\n'), limit, gaps);
}

/** Reuse the saved output section as-is unless the receiving model has less room. */
export function limitShellOutput(text: string, tokens: number, gaps: readonly string[] = []) {
  // Reserve room for an omission marker and keep both cuts on UTF-8 boundaries.
  const budget = tokens * 4;
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= budget) return { text, limited: false };
  const marker = (count: number) => `[Model output preview omitted ${count} retained bytes.]`;
  const markerLength = marker(bytes.length).length;
  if (budget < markerLength) return { text: budget >= 3 ? '…' : '', limited: true };
  const retainedGaps: string[] = [];
  let remaining = budget - markerLength;
  for (const gap of new Set(gaps)) {
    if (gap.length + 1 > remaining) break;
    retainedGaps.push(gap);
    remaining -= gap.length + 1;
  }
  const excerptBudget = Math.max(0, remaining - 2);
  let start = Math.ceil(excerptBudget / 2);
  let end = bytes.length - Math.floor(excerptBudget / 2);
  while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start--;
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end++;
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const preview = [
    decoder.decode(bytes.subarray(0, start)),
    marker(end - start),
    decoder.decode(bytes.subarray(end)),
  ]
    .filter(Boolean)
    .join('\n');
  return {
    text: [preview, ...retainedGaps.filter((gap) => !preview.includes(gap))].join('\n'),
    limited: true,
  };
}
