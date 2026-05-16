const PLACEHOLDER: Record<string, string> = {
  timer: "<TIMER>",
  timestamp: "<TIMESTAMP>",
  cacheHitRate: "<CACHE_HIT_RATE>",
  cacheTokenCount: "<CACHE_TOKEN_COUNT>",
  toolElapsed: "<TOOL_ELAPSED>",
};

export function freezeAnsi(ansi: string, freezeKeys: string[]): string {
  let result = ansi;
  // 跨平台：屏蔽 Header 中的工作目录路径 / Cross-platform: mask workspace path in Header
  result = result.replace(/(▘▘ ▝▝ {4}).+/g, "$1<CWD>");
  for (const key of freezeKeys) {
    const p = PLACEHOLDER[key];
    if (!p) continue;
    if (key === "timer") {
      result = result.replace(/\b\d{2}:\d{2}\b/g, p);
      // Freeze elapsed time in exit summary line (── 22s ──, ── 1m 30s ──)
      result = result.replace(/── \d{1,3}s ──/g, `── ${p} ──`);
      result = result.replace(/── \d+m \d{1,2}s ──/g, `── ${p} ──`);
    }
    if (key === "cacheHitRate") {
      result = result.replace(/\b\d{1,3}%/g, p);
    }
    if (key === "cacheTokenCount") {
      result = result.replace(/(?<!\d)(\d{1,3}(?:,\d{3})+|\d{4,})(?![\d,])/g, p);
    }
    if (key === "timestamp") {
      result = result.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g, p);
    }
    if (key === "toolElapsed") {
      result = result.replace(/\(\d+(?:\.\d+)?(?:ms|s)\)/g, p);
    }
  }
  return result;
}

export function freezeState(
  state: Record<string, unknown>,
  freezeKeys: string[]
): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  const status = out.status as Record<string, unknown> | undefined;
  if (!status) return out;
  for (const key of freezeKeys) {
    if (key === "cacheHitRate") status.cacheHitRate = "<CACHE_HIT_RATE>";
    if (key === "cacheTokenCount") status.totalTokens = "<CACHE_TOKEN_COUNT>";
  }
  return out;
}
