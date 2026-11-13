import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import TurndownService from 'turndown';
import { workerEndpoint } from '../../platform/process/worker-endpoint';

const endpoint = workerEndpoint<
  { html: string; url: string },
  { title?: string; content?: string; error?: string }
>();
endpoint.onmessage = ({ data }) => {
  let dom: JSDOM | undefined;
  try {
    // Passive parsing: no runScripts/resources options and no subresource loader.
    dom = new JSDOM(data.html, { url: data.url, virtualConsole: new VirtualConsole() });
    const article = new Readability(dom.window.document).parse();
    if (!article?.content) {
      endpoint.postMessage({ error: 'web_content_unavailable' });
      return;
    }
    endpoint.postMessage({
      title: article.title ?? '',
      content: new TurndownService().turndown(article.content),
    });
  } catch {
    endpoint.postMessage({ error: 'web_content_unavailable' });
  } finally {
    dom?.window.close();
  }
};
