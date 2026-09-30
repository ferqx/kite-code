import { checkUrl } from './ssrf';
import type { WebFetchResult } from './types';

// ── robots.txt 缓存：按域名缓存 Disallow 规则，含并发去重 ──
const robotsCache = new Map<string, { disallowed: Set<string>; fetchedAt: number }>();
const robotsPending = new Map<string, Promise<void>>(); // 防止并发重复请求
const ROBOTS_CACHE_TTL_MS = 300_000; // 5 分钟
const MAX_ROBOTS_CACHE_SIZE = 200; // LRU 上限
const MAX_WEB_RESPONSE_BYTES = 5_000_000;

/** Enforce the parser's memory boundary before accumulating an untrusted body. */
async function readBoundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new Error(`Response body exceeds the ${maximumBytes} byte parsing safety limit.`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let observedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      observedBytes += value.byteLength;
      if (observedBytes > maximumBytes) {
        await reader.cancel();
        throw new Error(`Response body exceeds the ${maximumBytes} byte parsing safety limit.`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}

/** 检查目标路径是否被 robots.txt 禁止（基础规则解析）。
 *  不可达或超时时默许放行，不做阻断。
 *
 *  Check if target path is disallowed by robots.txt (basic rule parsing).
 *  Gracefully allows on unreachable/timeout — never blocks requests. */
async function checkRobotsTxt(
  parsed: URL,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ allowed: boolean }> {
  signal?.throwIfAborted();
  const domain = parsed.hostname;
  const cached = robotsCache.get(domain);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_CACHE_TTL_MS) {
    return { allowed: ![...cached.disallowed].some((p) => parsed.pathname.startsWith(p)) };
  }

  // 并发去重：同一域名的并发请求复用同一个 fetch
  const pending = robotsPending.get(domain);
  if (pending) {
    try {
      await waitForAbortable(pending, signal);
    } catch {
      /* fall through to cached check */
    }
    const cachedAfter = robotsCache.get(domain);
    if (cachedAfter) {
      return { allowed: ![...cachedAfter.disallowed].some((p) => parsed.pathname.startsWith(p)) };
    }
  }

  let resolvePending: () => void;
  robotsPending.set(
    domain,
    new Promise<void>((r) => {
      resolvePending = r;
    }),
  );

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbort: (() => void) | undefined;
  try {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    removeAbort = () => signal?.removeEventListener('abort', abort);
    if (signal?.aborted) abort();
    timeout = setTimeout(() => controller.abort(new Error('Robots timeout')), 3000);
    // robots.txt fetch 用 manual redirect + SSRF 检查
    let robotsUrl = `https://${domain}/robots.txt`;
    let httpFallback = false;
    let robotsRedirects = 0;
    let resp: Response | undefined;
    while (robotsRedirects <= 2) {
      const r = await waitForAbortable(
        fetchImpl(robotsUrl, {
          signal: controller.signal,
          headers: { 'User-Agent': 'KiteCode/1.0 WebFetchBot', Accept: 'text/plain' },
          redirect: 'manual',
        }),
        signal,
      );
      const location = r.headers.get('location');
      if (location && r.status >= 300 && r.status < 400) {
        const target = new URL(location, robotsUrl).href;
        const targetCheck = checkUrl(target);
        if (!targetCheck.allowed) break;
        robotsUrl = target;
        robotsRedirects++;
        continue;
      }
      // HTTPS 失败 → 尝试 HTTP fallback（仅一次）
      if (
        !httpFallback &&
        robotsUrl.startsWith('https://') &&
        (r.status === 0 || r.status >= 400)
      ) {
        robotsUrl = robotsUrl.replace('https://', 'http://');
        httpFallback = true;
        continue;
      }
      resp = r;
      break;
    }

    if (!resp?.ok) {
      robotsCache.set(domain, { disallowed: new Set(), fetchedAt: Date.now() });
      evictRobotsCache();
      return { allowed: true };
    }

    const text = await waitForAbortable(readBoundedResponseText(resp, 500_000), signal);

    const disallowed = new Set<string>();
    let currentAgent = '*';
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (/^User-agent:\s*(.+)/i.test(trimmed)) {
        currentAgent = RegExp.$1.trim().toLowerCase();
        continue;
      }
      if (
        (currentAgent === '*' || currentAgent === 'kitecode') &&
        /^Disallow:\s*(.+)/i.test(trimmed)
      ) {
        const rule = RegExp.$1!.trim();
        if (rule) disallowed.add(rule);
      }
    }

    robotsCache.set(domain, { disallowed, fetchedAt: Date.now() });
    evictRobotsCache();

    return { allowed: ![...disallowed].some((p) => parsed.pathname.startsWith(p)) };
  } catch {
    signal?.throwIfAborted();
    return { allowed: true };
  } finally {
    clearTimeout(timeout);
    removeAbort?.();
    robotsPending.delete(domain);
    resolvePending!();
  }
}

/** robotsCache LRU 淘汰 / Evict oldest entries when cache exceeds max size */
function evictRobotsCache() {
  if (robotsCache.size <= MAX_ROBOTS_CACHE_SIZE) return;
  const sorted = [...robotsCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
  for (const [key] of sorted.slice(0, sorted.length - MAX_ROBOTS_CACHE_SIZE)) {
    robotsCache.delete(key);
  }
}

// ── per-domain 请求节流：同域名串行化 + 至少间隔 500ms ──
const domainThrottle = new Map<string, Promise<void>>();
const DOMAIN_THROTTLE_MS = 500;

async function throttleDomain(hostname: string, signal?: AbortSignal): Promise<void> {
  const previous = domainThrottle.get(hostname);
  let resolve: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  domainThrottle.set(hostname, promise);
  try {
    if (previous) await waitForAbortable(previous, signal);
    signal?.throwIfAborted();
    await waitForAbortable(new Promise((r) => setTimeout(r, DOMAIN_THROTTLE_MS)), signal);
  } finally {
    resolve!();
    if (domainThrottle.get(hostname) === promise) domainThrottle.delete(hostname);
  }
}

function waitForAbortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export interface ExtractOptions {
  /** 外部中止信号 / External abort signal */
  signal?: AbortSignal;
  /** 超时时间（毫秒），默认 15000 / Timeout in ms, default 15000 */
  timeoutMs?: number;
  /** Caller-selected content limit; omitted returns the complete extracted text. */
  maxChars?: number;
  /** Caller-selected redirect count; otherwise governed by timeout and cycle detection. */
  maxRedirects?: number;
  /** Governed fetch implementation. Production boundaries must provide one. */
  fetch?: typeof fetch;
}

interface WorkerResult {
  ok: boolean;
  title?: string;
  content?: string;
  truncated: boolean;
  error?: string;
}

/**
 * 在 Worker 线程中执行 JSDOM + readability + turndown，避免阻塞主线程 TUI。
 * 若 Worker 不可用（测试环境等），fallback 到内联解析。
 *
 * Run JSDOM + readability + turndown in a Worker thread to avoid
 * blocking the main-thread TUI. Falls back to inline if Worker unavailable.
 */
async function parseInWorker(
  html: string,
  url: string,
  maxChars: number | undefined,
  signal?: AbortSignal,
): Promise<WorkerResult> {
  try {
    const worker = new Worker(new URL('./extractor-worker.ts', import.meta.url));

    const result = await new Promise<WorkerResult>((resolve, reject) => {
      // 信号在 Worker 创建前已被 abort（fetch 完成后超时）→ 直接跳过
      if (signal?.aborted) {
        worker.terminate();
        const reason = signal.reason;
        const msg =
          reason instanceof Error
            ? reason.message
            : typeof reason === 'string'
              ? reason
              : 'Aborted';
        reject(new DOMException(msg, 'AbortError'));
        return;
      }

      const onAbort = () => {
        worker.terminate();
        const reason = signal?.reason;
        const msg =
          reason instanceof Error
            ? reason.message
            : typeof reason === 'string'
              ? reason
              : 'Aborted';
        reject(new DOMException(msg, 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      worker.onmessage = (event: MessageEvent<WorkerResult>) => {
        signal?.removeEventListener('abort', onAbort);
        worker.terminate();
        resolve(event.data);
      };
      worker.onerror = (err) => {
        signal?.removeEventListener('abort', onAbort);
        worker.terminate();
        reject(new Error(`Worker error: ${err.message ?? String(err)}`));
      };

      worker.postMessage({ html, url, maxChars });
    });

    return result;
  } catch (err) {
    // Worker 不可用时 fallback（文件缺失 / 不支持 / 初始化失败）
    if (err instanceof Error) {
      const msg = err.message;
      if (msg.includes('Worker') || msg.includes('module') || msg.includes('Cannot find')) {
        return parseInline(html, url, maxChars);
      }
    }
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err), truncated: false };
  }
}

/**
 * 内联解析（Worker 不可用时的 fallback）。
 * 直接在当前线程执行 JSDOM + readability + turndown。
 */
async function parseInline(
  html: string,
  url: string,
  maxChars: number | undefined,
): Promise<WorkerResult> {
  const { JSDOM } = await import('jsdom');
  const { Readability } = await import('@mozilla/readability');
  const TurndownService = (await import('turndown')).default;

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });

  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article?.content) {
    dom.window.close();
    return {
      ok: false,
      error: 'Readability could not extract content from this page.',
      truncated: false,
    };
  }

  const title = article.title || dom.window.document.title || undefined;
  let content = turndown.turndown(article.content);
  let truncated = false;

  if (maxChars !== undefined && content.length > maxChars) {
    content = `${content.slice(0, maxChars)}\n\n... (content truncated)`;
    truncated = true;
  }

  dom.window.close();
  return { ok: true, title, content, truncated };
}

/** 抓取网页并用 readability + turndown 提取 Markdown 正文
 *  Fetch a web page and extract Markdown content via readability + turndown. */
export async function fetchAndExtract(
  url: string,
  options?: ExtractOptions,
): Promise<WebFetchResult> {
  // ── 1. SSRF 检查 ──
  if (options?.signal?.aborted) {
    return { ok: false, url, truncated: false, error: 'Cancelled.' };
  }
  const initialCheck = checkUrl(url);
  if (!initialCheck.allowed) {
    return { ok: false, url, truncated: false, error: initialCheck.reason };
  }

  // One deadline covers robots, domain queue, fetch, and extraction.
  const controller = new AbortController();
  const timeoutAt = Date.now() + (options?.timeoutMs ?? 15000);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const armTimeout = () => {
    const remaining = timeoutAt - Date.now();
    if (remaining <= 0) {
      controller.abort(new Error('Fetch timeout'));
      return;
    }
    // Long caller timeouts must not overflow the host timer into a 1ms timeout.
    timeout = setTimeout(armTimeout, Math.min(remaining, 2_147_483_647));
  };
  armTimeout();
  const onExternalAbort = () => controller.abort();
  if (options?.signal) {
    options.signal.addEventListener('abort', onExternalAbort);
    if (options.signal.aborted) onExternalAbort();
  }

  const parsedUrl = new URL(url);
  const fetchImpl = options?.fetch ?? fetch;
  let readyForFetch = false;
  try {
    const robotsCheck = await checkRobotsTxt(parsedUrl, fetchImpl, controller.signal);
    controller.signal.throwIfAborted();
    if (!robotsCheck.allowed) {
      return {
        ok: false,
        url,
        truncated: false,
        error: `Blocked by robots.txt: ${parsedUrl.hostname} disallows crawling ${parsedUrl.pathname}`,
      };
    }
    await throttleDomain(parsedUrl.hostname, controller.signal);
    readyForFetch = true;
  } catch (error) {
    return {
      ok: false,
      url,
      truncated: false,
      error: controller.signal.aborted ? 'Fetch cancelled or timed out.' : String(error),
    };
  } finally {
    if (!readyForFetch) {
      clearTimeout(timeout);
      options?.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  // ── 3. 抓取 HTML ──

  let html: string | undefined;
  let finalUrl = url;
  let contentType = '';
  let isHtml = false;
  let readyToParse = false;

  try {
    // 手动处理 redirect 以检查每次跳转目标 / Manual redirect handling for per-hop SSRF check
    let currentUrl = url;
    let redirects = 0;
    const maxRedirects = options?.maxRedirects ?? Number.POSITIVE_INFINITY;
    const seenRequests = new Set<string>();

    while (redirects <= maxRedirects) {
      if (Date.now() >= timeoutAt) controller.abort(new Error('Fetch timeout'));
      controller.signal.throwIfAborted();
      const requestUrl = new URL(currentUrl);
      requestUrl.hash = '';
      if (seenRequests.has(requestUrl.href)) {
        return { ok: false, url, truncated: false, error: 'Redirect loop detected.' };
      }
      seenRequests.add(requestUrl.href);
      const resp = await waitForAbortable(
        fetchImpl(currentUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'KiteCode/1.0 WebFetchBot',
            Accept: 'text/html, application/xhtml+xml',
          },
          redirect: 'manual',
        }),
        controller.signal,
      );

      // 处理 redirect（3xx + Location header）/ Handle redirects
      const location = resp.headers.get('location');
      if (location && resp.status >= 300 && resp.status < 400) {
        const redirectUrl = new URL(location, currentUrl).href;
        // SSRF + 凭证检查（policy 层只检查了初始 URL）
        const redirectCheck = checkUrl(redirectUrl);
        if (!redirectCheck.allowed) {
          return {
            ok: false,
            url,
            truncated: false,
            error: `Redirect blocked: ${redirectCheck.reason}`,
          };
        }
        // 拒绝包含内嵌凭证的重定向目标 / Reject redirects with embedded credentials
        const redirectParsed = new URL(redirectUrl);
        if (redirectParsed.username || redirectParsed.password) {
          return {
            ok: false,
            url,
            truncated: false,
            error: 'Redirect target contains embedded credentials.',
          };
        }
        currentUrl = redirectUrl;
        redirects++;
        continue;
      }

      if (!resp.ok) {
        if (resp.status === 403) {
          return {
            ok: false,
            url,
            truncated: false,
            error: `HTTP 403 (likely anti-bot protection) — try a different source for the same content`,
          };
        }
        if (resp.status === 429) {
          const retryAfter = resp.headers.get('retry-after');
          return {
            ok: false,
            url,
            truncated: false,
            error: `HTTP 429 rate limited${retryAfter ? `, retry after ${retryAfter}s` : ''} — slow down or try a different source`,
          };
        }
        return { ok: false, url, truncated: false, error: `HTTP ${resp.status}` };
      }

      finalUrl = currentUrl;
      contentType = resp.headers.get('content-type') ?? '';

      // 分类 Content-Type / Classify content type
      const hasContentType = contentType.length > 0;
      isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
      const isPlainText =
        !isHtml &&
        (contentType.includes('text/plain') ||
          contentType.includes('text/markdown') ||
          contentType.includes('text/csv') ||
          contentType.includes('text/xml') ||
          contentType.includes('application/json') ||
          contentType.includes('application/xml') ||
          contentType.includes('application/rss') ||
          contentType.includes('application/atom'));
      // 缺失 Content-Type 时默认按纯文本处理 / Missing Content-Type defaults to plain text
      if (!isHtml && !isPlainText && hasContentType) {
        return {
          ok: false,
          url,
          finalUrl,
          contentType,
          truncated: false,
          error: `Unsupported content type: ${contentType}`,
        };
      }

      html = await waitForAbortable(
        readBoundedResponseText(resp, MAX_WEB_RESPONSE_BYTES),
        controller.signal,
      );
      break;
    }

    if (redirects > maxRedirects || html === undefined) {
      return {
        ok: false,
        url,
        truncated: false,
        error: `Too many redirects (>${maxRedirects})`,
      };
    }
    readyToParse = true;
  } catch (err) {
    if (err instanceof Error && err.name === 'NetworkBoundaryError') throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        ok: false,
        url,
        truncated: false,
        error: 'Fetch cancelled or timed out.',
      };
    }
    return {
      ok: false,
      url,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (!readyToParse) {
      clearTimeout(timeout);
      options?.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  // ── 3. 解析（HTML → readability，纯文本 → 直接返回）──
  const maxChars = options?.maxChars;

  try {
    if (!isHtml) {
      controller.signal.throwIfAborted();
      // 纯文本 / JSON / XML / CSV — 返回原始内容，不做提取
      let content = html;
      let truncated = false;
      if (maxChars !== undefined && content.length > maxChars) {
        content = `${content.slice(0, maxChars)}\n\n... (content truncated)`;
        truncated = true;
      }
      return {
        ok: true,
        url,
        finalUrl,
        content,
        contentType,
        truncated,
      };
    }

    // HTML — Worker 线程 readability + turndown
    const parsed = await parseInWorker(html, finalUrl, maxChars, controller.signal);

    if (!parsed.ok) {
      return {
        ok: false,
        url,
        finalUrl,
        contentType,
        truncated: false,
        error: parsed.error ?? 'Readability could not extract content from this page.',
      };
    }

    return {
      ok: true,
      url,
      finalUrl,
      title: parsed.title,
      content: parsed.content,
      contentType,
      truncated: parsed.truncated,
    };
  } catch (err) {
    // parseInWorker 抛出的 AbortError — 传递原始消息以便上层区分超时 vs 取消
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    return {
      ok: false,
      url,
      finalUrl,
      contentType,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
    if (options?.signal) {
      options.signal.removeEventListener('abort', onExternalAbort);
    }
  }
}
