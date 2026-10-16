import { parseDesktopMarkdown } from '@kite-ai/ui/desktop/markdown';

// Fixed pure syntax computation only. Rendering and URL/HTML/image policy stay in MessageContent.
self.onmessage = (event: MessageEvent<{ id: number; text: string }>) => {
  const { id, text } = event.data;
  try {
    self.postMessage({ id, text, tree: parseDesktopMarkdown(text) });
  } catch {
    self.postMessage({ id, error: 'native_markdown_parse_failed' });
  }
};
