/**
 * Worker 线程 — 执行 JSDOM + readability + turndown 的同步阻塞解析，
 * 避免主线程（TUI）卡顿。
 *
 * Worker thread — runs the synchronous JSDOM + readability + turndown
 * pipeline off the main thread so the TUI stays responsive.
 */

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';

interface WorkerInput {
  html: string;
  url: string;
  maxChars: number;
}

interface WorkerOutput {
  ok: boolean;
  title?: string;
  content?: string;
  truncated: boolean;
  error?: string;
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
});

// Bun Worker 使用 self.onmessage / Bun 的 Worker 环境不使用 globalThis.onmessage
self.onmessage = (event: MessageEvent<WorkerInput>) => {
  const { html, url, maxChars } = event.data;

  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article?.content) {
      const output: WorkerOutput = {
        ok: false,
        error: 'Readability could not extract content from this page.',
        truncated: false,
      };
      self.postMessage(output);
      return;
    }

    const title = article.title || dom.window.document.title || undefined;
    let content = turndown.turndown(article.content);
    let truncated = false;

    if (content.length > maxChars) {
      content = `${content.slice(0, maxChars)}\n\n... (content truncated)`;
      truncated = true;
    }

    // 清理 DOM，释放内存 / Clean up DOM to free memory
    dom.window.close();

    const output: WorkerOutput = { ok: true, title, content, truncated };
    self.postMessage(output);
  } catch (err) {
    const output: WorkerOutput = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      truncated: false,
    };
    self.postMessage(output);
  }
};
