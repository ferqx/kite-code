import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import TurndownService from 'turndown';

declare const self: {
  onmessage: ((event: MessageEvent<{ html: string; url: string }>) => void) | null;
  postMessage(value: { title?: string; content?: string; error?: string }): void;
};
self.onmessage = ({ data }) => {
  let dom: JSDOM | undefined;
  try {
    // Passive parsing: no runScripts/resources options and no subresource loader.
    dom = new JSDOM(data.html, { url: data.url, virtualConsole: new VirtualConsole() });
    const article = new Readability(dom.window.document).parse();
    if (!article?.content) {
      self.postMessage({ error: 'web_content_unavailable' });
      return;
    }
    self.postMessage({
      title: article.title ?? '',
      content: new TurndownService().turndown(article.content),
    });
  } catch {
    self.postMessage({ error: 'web_content_unavailable' });
  } finally {
    dom?.window.close();
  }
};
