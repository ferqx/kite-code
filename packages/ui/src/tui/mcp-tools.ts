import type {
  McpToolMetadata,
  McpToolsEntry,
  McpToolsPage,
  McpToolsSnapshot,
  McpToolsSnapshots,
} from '@kite-ai/client';

export interface TuiMcpToolsState {
  screen: 'snapshots' | 'tools' | 'descriptor';
  phase: 'reading' | 'ready' | 'failed';
  snapshots?: McpToolsSnapshots;
  snapshot?: McpToolsSnapshot;
  page?: McpToolsPage;
  pageStarts?: readonly number[];
  entry?: McpToolsEntry;
  metadata?: McpToolMetadata;
  error?: string;
}

/** Original metadata provenance is independent of the current live catalogue. */
export function sameMcpToolsOrigin(snapshot: McpToolsSnapshot, page: McpToolsPage): boolean {
  return Object.entries(snapshot.origin).every(
    ([key, value]) => page.binding[key as keyof typeof snapshot.origin] === value,
  );
}

/** Fixed-width text rows retain every character, including long schema lines and Unicode tails. */
export function mcpTextRows(text: string, width = 64): number[] {
  const starts = [0];
  let column = 0;
  for (let offset = 0; offset < text.length; ) {
    const point = text.codePointAt(offset)!;
    offset += point > 0xffff ? 2 : 1;
    // Conservatively reserve two terminal cells for every non-ASCII point.
    // This keeps CJK/emoji rows inside the viewport without dropping their bytes.
    const cells = point < 128 ? 1 : 2;
    if (point !== 10 && column + cells > width) {
      starts.push(offset - (point > 0xffff ? 2 : 1));
      column = 0;
    }
    column += cells;
    if (point === 10 || column >= width) {
      if (offset < text.length) starts.push(offset);
      column = 0;
    }
  }
  return starts;
}

export function mcpTextWindow(text: string, starts: readonly number[], offset: number, rows = 10) {
  return starts
    .slice(offset, offset + rows)
    .map((start, index) =>
      text.slice(start, starts[offset + index + 1] ?? text.length).replace(/\n$/, ''),
    );
}
