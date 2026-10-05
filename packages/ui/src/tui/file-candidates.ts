export type TuiFileScope = Readonly<{ storeId: string; sessionId: string; workspaceId: string }>;
export type TuiFilePage = Readonly<{
  scope: TuiFileScope;
  query: string;
  snapshotId: string;
  paths: readonly string[];
  nextCursor: string | null;
  unavailable: readonly { path: string; reason: string }[];
}>;
/** Names only. No path supplied by the renderer becomes filesystem authority. */
export interface TuiFileCandidatesPort {
  read(
    scope: TuiFileScope,
    input: { query: string; cursor?: string },
    signal: AbortSignal,
  ): Promise<TuiFilePage>;
}
export type FileToken = { start: number; end: number; query: string; key: string };
export function fileToken(text: string, cursor: number): FileToken | undefined {
  let start = -1,
    quoted = false,
    escaped = false;
  for (let i = 0; i < cursor; i++) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && start >= 0) {
      escaped = true;
      continue;
    }
    if (ch === '"' && start >= 0) {
      quoted = !quoted;
      continue;
    }
    if (/\s/u.test(ch) && !quoted) start = -1;
    else if (ch === '@' && start < 0) start = i;
  }
  if (start < 0) return;
  let end = cursor,
    quote = quoted,
    tailEscaped = escaped;
  for (; end < text.length; end++) {
    const ch = text[end]!;
    if (tailEscaped) {
      tailEscaped = false;
      continue;
    }
    if (ch === '\\') {
      tailEscaped = true;
      continue;
    }
    if (ch === '"') {
      quote = !quote;
      continue;
    }
    if (/\s/u.test(ch) && !quote) break;
  }
  const raw = text.slice(start + 1, cursor);
  let query = raw;
  if (raw.startsWith('"')) {
    try {
      query = JSON.parse(raw.endsWith('"') && !escaped ? raw : `${raw}"`);
    } catch {
      return;
    }
  }
  return { start, end, query, key: JSON.stringify([start, end, cursor, text.slice(start, end)]) };
}
export function fileReference(path: string): string {
  return `@${/[\s"\\\p{Cc}]/u.test(path) ? JSON.stringify(path) : path}`;
}
