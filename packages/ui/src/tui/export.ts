/** Presentation-only snapshot: no filesystem paths, executable authority or network reader. */
export interface TuiLoadedTextExport {
  readonly storeId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly messages: readonly {
    id: string;
    seq: string;
    role: 'user' | 'assistant';
    content: string;
    reasoning?: string;
    previewOnly?: boolean;
    complete: boolean;
  }[];
}
export interface TuiExportPort {
  write(snapshot: TuiLoadedTextExport, signal: AbortSignal): Promise<{ path: string }>;
}
/** Serialize only already loaded text. Unknown/unread body is never promoted to full content. */
export function serializeLoadedText(snapshot: TuiLoadedTextExport): string {
  const blocks = snapshot.messages.flatMap((message) => {
    const parts: string[] = [];
    if (message.content)
      parts.push(message.role === 'user' ? `**You:** ${message.content}` : message.content);
    if (message.reasoning) parts.push(`> ${message.reasoning.replaceAll('\n', '\n> ')}`);
    if (message.previewOnly)
      parts.push(`> Loaded preview only; complete recorded body not loaded (${message.id}).`);
    else if (!message.complete)
      parts.push(`> Loaded incomplete prefix (${message.id}); later output is not included.`);
    return parts;
  });
  return `# Kite Code Session Export\n\n---\n\n${blocks.join('\n\n')}\n`;
}
