import { checkUrl } from './ssrf';

// ── robots.txt 缓存：按域名缓存 Disallow 规则，含并发去重 ──
const robotsCache = new Map<string, { disallowed: Set<string>; fetchedAt: number }>();
const robotsPending = new Map<string, Promise<void>>(); // 防止并发重复请求
const ROBOTS_CACHE_TTL_MS = 300_000; // 5 分钟
const MAX_ROBOTS_CACHE_SIZE = 200; // LRU 上限
const MAX_ROBOTS_RULES = 100; // 单域名 Disallow 规则上限

/** 检查目标路径是否被 robots.txt 禁止（基础规则解析）。
 *  不可达或超时时默许放行，不做阻断。
 *
 *  Check if target path is disallowed by robots.txt (basic rule parsing).
 *  Gracefully allows on unreachable/timeout — never blocks requests. */
async function checkRobotsTxt(parsed: URL): Promise<{ allowed: boolean }> {
  const domain = parsed.hostname;
  const cached = robotsCache.get(domain);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_CACHE_TTL_MS) {
    return { allowed: ![...cached.disallowed].some((p) => parsed.pathname.startsWith(p)) };
  }

  // 并发去重：同一域名的并发请求复用同一个 fetch
  const pending = robotsPending.get(domain);
  if (pending) {
    try {
      await pending;
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

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    // robots.txt fetch 用 manual redirect + SSRF 检查
    let robotsUrl = `https://${domain}/robots.txt`;
    let httpFallback = false;
    let robotsRedirects = 0;
    let resp: Response | undefined;
    while (robotsRedirects <= 2) {
      const r = await fetch(robotsUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'KiteCode/1.0 WebFetchBot', Accept: 'text/plain' },
        redirect: 'manual',
      });
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
    clearTimeout(timeout);

    if (!resp?.ok) {
      robotsCache.set(domain, { disallowed: new Set(), fetchedAt: Date.now() });
      evictRobotsCache();
      return { allowed: true };
    }

    // 限制大小
    const cl = resp.headers.get('content-length');
    if (cl && parseInt(cl, 10) > 500_000) {
      robotsCache.set(domain, { disallowed: new Set(), fetchedAt: Date.now() });
      evictRobotsCache();
      return { allowed: true };
    }
    const text = await resp.text();
    if (text.length > 500_000) {
      robotsCache.set(domain, { disallowed: new Set(), fetchedAt: Date.now() });
      evictRobotsCache();
      return { allowed: true };
    }

    const disallowed = new Set<string>();
    let currentAgent = '*';
    for (const line of text.split('\n')) {
      if (disallowed.size >= MAX_ROBOTS_RULES) break; // 规则数上限
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
    return { allowed: true };
  } finally {
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
const MAX_THROTTLE_SIZE = 500; // 长 session 内存上限

async function throttleDomain(hostname: string): Promise<void> {
  const prev = domainThrottle.get(hostname);
  if (prev) await prev;
  let resolve: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  domainThrottle.set(hostname, promise);
  // 内存上限：淘汰最老的非活跃条目
  if (domainThrottle.size > MAX_THROTTLE_SIZE) {
    const toDelete = [...domainThrottle.keys()].slice(0, domainThrottle.size - MAX_THROTTLE_SIZE);
    for (const k of toDelete) domainThrottle.delete(k);
  }
  await new Promise((r) => setTimeout(r, DOMAIN_THROTTLE_MS));
  resolve!();
}

export interface ExtractOptions {
  /** 外部中止信号 / External abort signal */
  signal?: AbortSignal;
  /** 超时时间（毫秒），默认 15000 / Timeout in ms, default 15000 */
  timeoutMs?: number;
  /** 正文截断长度，默认 8000 / Max extracted content length */
  maxChars?: number;
  /** 最大重定向次数，默认 3 / Max redirect count */
  maxRedirects?: number;
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
  maxChars: number,
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
async function parseInline(html: string, url: string, maxChars: number): Promise<WorkerResult> {
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

  if (content.length > maxChars) {
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
): Promise<{
  ok: boolean;
  url: string;
  finalUrl?: string;
  title?: string;
  content?: string;
  contentType?: string;
  truncated: boolean;
  error?: string;
}> {
  // ── 1. SSRF 检查（初始 URL）──
  const initialCheck = checkUrl(url);
  if (!initialCheck.allowed) {
    return { ok: false, url, truncated: false, error: initialCheck.reason };
  }

  // ── 2. robots.txt 检查 + domain 节流 ──
  const parsedUrl = new URL(url);
  const robotsCheck = await checkRobotsTxt(parsedUrl);
  if (!robotsCheck.allowed) {
    return {
      ok: false,
      url,
      truncated: false,
      error: `Blocked by robots.txt: ${parsedUrl.hostname} disallows crawling ${parsedUrl.pathname}`,
    };
  }
  await throttleDomain(parsedUrl.hostname);

  // ── 3. 抓取 HTML ──
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Fetch timeout')),
    options?.timeoutMs ?? 15000,
  );
  const onExternalAbort = () => controller.abort();
  if (options?.signal) {
    options.signal.addEventListener('abort', onExternalAbort);
  }

  let html: string | undefined;
  let finalUrl = url;
  let contentType = '';
  let isHtml = false;

  try {
    // 手动处理 redirect 以检查每次跳转目标 / Manual redirect handling for per-hop SSRF check
    let currentUrl = url;
    let redirects = 0;
    const maxRedirects = options?.maxRedirects ?? 3;

    while (redirects <= maxRedirects) {
      const resp = await fetch(currentUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'KiteCode/1.0 WebFetchBot',
          Accept: 'text/html, application/xhtml+xml',
        },
        redirect: 'manual',
      });

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

      finalUrl = resp.url;
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

      // 拒绝超大响应（>5MB header 声明 + body 实际大小）
      const contentLength = resp.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > 5_000_000) {
        return {
          ok: false,
          url,
          finalUrl,
          contentType,
          truncated: false,
          error: `Response too large: ${contentLength} bytes`,
        };
      }

      html = await resp.text();
      if (html.length > 5_000_000) {
        return {
          ok: false,
          url,
          finalUrl,
          contentType,
          truncated: false,
          error: `Response body too large: ${html.length} bytes`,
        };
      }
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
  } catch (err) {
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
    clearTimeout(timeout);
    if (options?.signal) {
      options.signal.removeEventListener('abort', onExternalAbort);
    }
  }

  // ── 3. 解析（HTML → readability，纯文本 → 直接返回）──
  const maxChars = options?.maxChars ?? 8000;

  if (!isHtml) {
    // 纯文本 / JSON / XML / CSV — 返回原始内容，不做提取
    let content = html;
    let truncated = false;
    if (content.length > maxChars) {
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
}
