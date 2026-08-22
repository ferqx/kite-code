export function normalizeCompactionSummary(summary: string): string {
  return summary.replace(/\r\n?/g, '\n').trim();
}

/** Canonical low-permission history frame serializer used by projection and replay. */
export function serializeCompactionSummary(summary: string): string {
  const escaped = normalizeCompactionSummary(summary)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return `<compacted_history>\n${escaped}\n</compacted_history>`;
}
