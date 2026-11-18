/** Conservative retained-payload estimate, not a JavaScript heap measurement. */
export function estimateSnapshotBytes(value: unknown, limit: number): number {
  if (typeof value === 'string') return 16 + value.length * 2;
  if (value === null || typeof value !== 'object') return 8;
  let bytes = 32;
  if (Array.isArray(value)) {
    for (const child of value) {
      bytes += 16 + estimateSnapshotBytes(child, limit - bytes - 16);
      if (bytes > limit) break;
    }
  } else {
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const overhead = 16 + key.length * 2;
      bytes +=
        overhead +
        estimateSnapshotBytes((value as Record<string, unknown>)[key], limit - bytes - overhead);
      if (bytes > limit) break;
    }
  }
  return bytes;
}
