/** 稳定序列化（key 排序）确保相同结构对象生成一致字符串 / Stable stringify for consistent hashing */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 提取 next 中不在 previous 中的新项目 / Extract new items in next that are not in previous */
export function newItems(previous: string[], next: string[]): string[] {
  const previousSet = new Set(previous);
  return next.filter((item) => item && !previousSet.has(item));
}

/** 去重并截取末尾最多 max 个元素 / Deduplicate and keep at most last `max` elements */
export function uniqueTail(values: string[], max: number): string[] {
  return [...new Set(values.filter(Boolean))].slice(-max);
}
