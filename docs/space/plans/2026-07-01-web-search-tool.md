# Web Fetch 工具方案

状态：draft
创建：2026-07-01
优先级：P0
依赖：无
替代：无

## 目标

为 Kite Code 新增 `web_fetch` 工具，让 Agent 能够抓取公开网页并用 `@mozilla/readability` 提取高质量正文（Markdown）。填补 [B28](../../space/backlog/2026-06-08-product-experience-gaps.md#b28--web-search-工具) 缺口的第一阶段——正文获取能力。

`web_search`（搜索发现 URL）作为第二阶段独立方案，在 `web_fetch` 稳定后实施。

### 两阶段策略

```
Phase 1（本方案）: web_fetch
  URL 来源：用户输入、模型已知站点、对话上下文中的链接
  ↓
  fetch → SSRF 检查 → readability 提取 → turndown → Markdown
  ↓
  模型获得高质量正文，可以直接阅读文档/Issue/API 参考

Phase 2（后续方案）: web_search + web_fetch 联用
  模型自动发现 URL → web_search(query)
  ↓
  搜索结果 URL 列表 → web_fetch(url) × N
  ↓
  模型获得搜索 + 阅读的完整能力
```

### MVP 范围

- `web_fetch` 接受一个 URL，返回 readability 提取后的 Markdown 正文
- 强制 SSRF 防护（每次 fetch 前 + redirect 后双重检查）
- 默认 10s 超时，正文截断 8000 字符，拒绝 >5MB 响应
- 默认需审批（`risk: 'network'`），隐私扫描 URL 中的敏感信息
- 不支持 `file://`、`ftp://`、内网 IP、localhost

---

## 方案设计

### 目录结构

```
src/core/web/
├── types.ts          # WebFetchInput / WebFetchResult
├── extractor.ts      # fetch → SSRF → readability → turndown 管道
└── ssrf.ts           # URL 安全检查（协议、主机黑名单、redirect 跟踪）
```

Phase 1 没有 Provider 抽象，`mock.ts` 不需要——测试直接 mock `fetchAndExtract` 即可。`provider.ts`、`service.ts`、`privacy.ts`、`url-utils.ts`、搜索引擎 adapter 是 Phase 2 才需要的。

### 类型定义

`src/core/web/types.ts`：

```ts
export interface WebFetchInput {
  url: string;                       // 目标 URL（仅限 http/https）
  max_chars?: number;                // 正文截断长度，默认 8000，最大 16000
}

export interface WebFetchResult {
  ok: boolean;
  url: string;
  /** 最终 URL（经过重定向后） */
  final_url?: string;
  /** readability 提取的页面标题 */
  title?: string;
  /** readability + turndown 提取的 Markdown 正文 */
  content?: string;
  /** 响应 Content-Type */
  content_type?: string;
  /** 正文是否被截断 */
  truncated: boolean;
  /** 错误信息（ok=false 时） */
  error?: string;
}
```

### 核心提取管道

`src/core/web/extractor.ts` — 完整实现：

```ts
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { checkUrl } from './ssrf';

export interface ExtractOptions {
  signal?: AbortSignal;
  timeoutMs?: number;      // default 10000
  maxChars?: number;       // default 8000
  maxRedirects?: number;   // default 3
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
});

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
  // ── 1. SSRF 检查（初始 URL） ──
  const initialCheck = checkUrl(url);
  if (!initialCheck.allowed) {
    return { ok: false, url, truncated: false, error: initialCheck.reason };
  }

  // ── 2. 抓取 HTML ──
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Fetch timeout')),
    options?.timeoutMs ?? 10000,
  );
  if (options?.signal) {
    options.signal.addEventListener('abort', () => controller.abort());
  }

  let html: string | undefined;
  let finalUrl = url;
  let contentType = '';

  try {
    // 手动处理 redirect 以检查每次跳转目标
    let currentUrl = url;
    let redirects = 0;
    const maxRedirects = options?.maxRedirects ?? 3;

    while (redirects <= maxRedirects) {
      const resp = await fetch(currentUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'KiteCode/1.0 WebFetchBot',
          'Accept': 'text/html, application/xhtml+xml',
        },
        redirect: 'manual',  // 手动跟踪 redirect
      });

      // 处理 redirect（3xx 状态码 + Location header）
      const location = resp.headers.get('location');
      if (location && resp.status >= 300 && resp.status < 400) {
        const redirectUrl = new URL(location, currentUrl).href;
        const redirectCheck = checkUrl(redirectUrl);
        if (!redirectCheck.allowed) {
          return { ok: false, url, truncated: false, error: `Redirect blocked: ${redirectCheck.reason}` };
        }
        currentUrl = redirectUrl;
        redirects++;
        continue;
      }

      if (!resp.ok) {
        return { ok: false, url, truncated: false, error: `HTTP ${resp.status}` };
      }

      // 非 redirect 响应也要更新 URL（服务器可能内部重写）
      finalUrl = resp.url;
      contentType = resp.headers.get('content-type') ?? '';

      // 只接受 text/html
      if (!contentType.includes('text/html')) {
        return { ok: false, url, finalUrl, contentType, truncated: false, error: `Not HTML: ${contentType}` };
      }

      // 拒绝超大响应（>5MB header 声明）
      const contentLength = resp.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > 5_000_000) {
        return { ok: false, url, finalUrl, contentType, truncated: false, error: `Response too large: ${contentLength} bytes` };
      }

      html = await resp.text();
      // 拒绝实际内容超大的响应（body 可能无 Content-Length header）
      if (html.length > 5_000_000) {
        return { ok: false, url, finalUrl, contentType, truncated: false, error: `Response body too large: ${html.length} bytes` };
      }
      break;
    }

    if (redirects > maxRedirects || html === undefined) {
      return { ok: false, url, truncated: false, error: `Too many redirects (>${maxRedirects})` };
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, url, truncated: false, error: 'Fetch cancelled or timed out.' };
    }
    return { ok: false, url, truncated: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }

  // ── 3. readability 提取正文 ──
  let title: string | undefined;
  let content: string;

  try {
    const dom = new JSDOM(html, { url: finalUrl });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article?.content) {
      return { ok: false, url, finalUrl, contentType, truncated: false, error: 'Readability could not extract content from this page.' };
    }

    // article.title 是 Readability 提取的文章标题（自动去除站点名后缀），优于 raw <title>
    title = article.title || dom.window.document.title || undefined;

    // ── 4. HTML → Markdown ──
    content = turndown.turndown(article.content);
  } catch (err) {
    return { ok: false, url, finalUrl, title, contentType, truncated: false, error: err instanceof Error ? err.message : String(err) };
  }

  // ── 5. 截断 ──
  const maxChars = options?.maxChars ?? 8000;
  let truncated = false;
  if (content.length > maxChars) {
    content = content.slice(0, maxChars) + '\n\n... (content truncated)';
    truncated = true;
  }

  return { ok: true, url, finalUrl, title, content, contentType, truncated };
}
```

### SSRF 防护

`src/core/web/ssrf.ts`：

```ts
const BLOCKED_HOSTS = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]',
  '169.254.169.254',  // cloud metadata
  'metadata.google.internal',  // GCP metadata
]);
const BLOCKED_PROTOCOLS = new Set(['file:', 'ftp:', 'gopher:', 'data:', 'javascript:']);
// 内网 IPv4 前缀
const PRIVATE_IPV4_PREFIXES = ['10.', '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.', '192.168.'];

export interface SsrfDecision {
  allowed: boolean;
  reason?: string;
}

export function checkUrl(rawUrl: string): SsrfDecision {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: `Invalid URL: ${rawUrl.slice(0, 100)}` };
  }

  // 协议检查
  if (BLOCKED_PROTOCOLS.has(parsed.protocol)) {
    return { allowed: false, reason: `Blocked protocol: ${parsed.protocol}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: `Only http/https allowed` };
  }

  // 主机检查
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(hostname)) {
    return { allowed: false, reason: `Blocked host: ${hostname}` };
  }

  // 内网 IP 前缀检查
  if (PRIVATE_IPV4_PREFIXES.some((prefix) => hostname.startsWith(prefix))) {
    return { allowed: false, reason: `Private network address blocked: ${hostname}` };
  }

  // @todo Phase 2: 完整 CIDR 子网匹配覆盖 IPv6 私有段 fc00::/7 (ULA) 和 fe80::/10 (Link-Local)

  return { allowed: true };
}
```

---

## Harness 接入

### 1. `src/core/tools/tool-contracts.ts`

新增 `WEB_FETCH_CONTRACT`：

```ts
export const WEB_FETCH_CONTRACT: ToolContract = {
  name: 'web_fetch',
  sections: {
    whenToUse:
      'Fetch and extract the main content from a public web page. ' +
      'Use this to read documentation, API references, GitHub issues, blog posts, ' +
      'or any public URL that the user mentions or that appears in context. ' +
      'The tool returns clean Markdown extracted by the same algorithm that powers Firefox Reader Mode. ' +
      'Do NOT use this for URLs you are uncertain about — always verify the URL exists first. ' +
      'For searching the web to discover URLs, wait for the web_search tool.',
    commonMistakes:
      'Fetching URLs without verifying they exist or are relevant. ' +
      'Fetching internal/localhost URLs — these are blocked by SSRF protection. ' +
      'Fetching very large pages without adjusting max_chars. ' +
      'Expecting to fetch authenticated pages or pages behind paywalls — this tool only accesses public content.',
    outputFormat:
      'JSON: ok (boolean), url (requested URL), final_url (after redirects), ' +
      'title (extracted page title), content (Markdown), content_type (MIME type), truncated (boolean). ' +
      'On error: ok: false with error field explaining why.',
    failureHandling:
      'If HTTP error (4xx/5xx): the page may not exist or may be inaccessible — try a different URL. ' +
      'If content not extractable: readability may fail on non-article pages (e.g., interactive SPAs, login pages). ' +
      'If timeout: the page is too slow — try a different source or reduce max_chars. ' +
      'If blocked by SSRF: the URL is internal/private — do not attempt to access it.',
  },
  description: '',
};
WEB_FETCH_CONTRACT.description = buildDescription(WEB_FETCH_CONTRACT.sections);
```

同步更新：
- `KNOWN_TOOL_NAMES`（`:354`）追加 `'web_fetch'`
- `TOOL_CONTRACTS` Map（`:372`）追加 `['web_fetch', WEB_FETCH_CONTRACT]`

### 2. `src/core/tools/definitions.ts`

```ts
// CreateAgentToolsInput 无需新增字段 — web_fetch 无外部依赖，始终可用

// builtinTools 新增
const webFetchTool = tool(
  async ({ url, max_chars }) => {
    const result = await fetchAndExtract(url, {
      signal: input.signal,
      maxChars: max_chars,
    });
    // stdout 格式化为人类可读文本（TUI summary 取前 200 字符，模型看到全文）
    const stdout = result.ok
      ? [`Fetched: ${result.title ?? result.finalUrl ?? url}`,
         result.content_type ? `Type: ${result.content_type}` : '',
         result.truncated ? '(content truncated)' : '',
         '',
         result.content ?? '',
        ].filter(Boolean).join('\n')
      : `Failed to fetch ${url}: ${result.error ?? 'unknown error'}`;
    // 模型通过 JSON.stringify 看到 stdout；TUI 通过 graph.ts summary 取 slice(0,200)
    return JSON.stringify({ ...result, stdout });
  },
  {
    name: 'web_fetch',
    description: WEB_FETCH_CONTRACT.description,
    schema: z.object({
      url: z.string().min(1).describe('Public http/https URL to fetch'),
      max_chars: z.number().int().min(1000).max(16000).optional()
        .describe('Max characters of extracted content (default 8000)'),
    }),
  },
);
```

### 3. `src/core/harness/tool-requests.ts`

`PendingToolRequest` 新增成员：

```ts
| {
    id?: string;
    name: 'web_fetch';
    args: { url: string; max_chars?: number };
    reason: string;
    protectedCommand: string;
  }
```

`toolRequestFromCall()` 新增解析分支。

### 4. `src/core/harness/tool-policy.ts`

`evaluateToolPolicy()` 中新增 `web_fetch` 分支：

```ts
if (request.name === 'web_fetch') {
  const rawUrl = (request.args.url ?? '').trim();

  // URL 隐私扫描：拒绝包含凭证的 URL
  // Privacy scan: reject URLs that embed credentials
  let urlObj: URL | null = null;
  try { urlObj = new URL(rawUrl); } catch { /* invalid */ }
  if (!urlObj) {
    return deny({
      risk: 'network',
      reason: 'Invalid URL format.',
      userVisibleSummary: 'Blocked a web fetch with an invalid URL.',
      expectedEffects: ['No request will be sent'],
    });
  }
  // 拒绝 https://user:pass@host
  if (urlObj.username || urlObj.password) {
    return deny({
      risk: 'network',
      reason: 'URL must not contain embedded credentials (userinfo).',
      userVisibleSummary: 'Blocked a web fetch to a URL with embedded credentials.',
      expectedEffects: ['No request will be sent'],
    });
  }
  // 拒绝 query string 中包含疑似 token/key 的长值
  if (/[?&](?:token|key|secret|password|auth|api_key)=[^&]{20,}/i.test(rawUrl)) {
    return deny({
      risk: 'network',
      reason: 'URL query parameters appear to contain credentials.',
      userVisibleSummary: 'Blocked a web fetch to a URL containing credentials in query.',
      expectedEffects: ['No request will be sent'],
    });
  }

  return requireApproval({
    risk: 'network',
    reason: 'Fetching external web content requires user approval.',
    userVisibleSummary: `Fetch: ${rawUrl.slice(0, 60)}`,
    expectedEffects: ['Fetches a public web page', 'Extracts and returns clean Markdown content'],
  });
}
```

**注意**：`web_fetch` 默认**需要审批**，与 `web_search` 不同。原因是：
- 模型可能尝试 fetch 任意 URL，包括用户暂未确认要访问的页面
- URL 中可能暴露用户意图（如内部 Jira ticket）
- 一次 fetch 消耗 ~1-2 秒网络时间，需要用户确认这是有意行为

`web_search`（Phase 2）则可设为默认不审批——搜索查询的敏感度低于直接访问 URL。

### 5. `src/core/harness/tool-runner.ts`

`runApprovedTool()` 新增 `web_fetch` 执行分支（在 shell_execute 分支前插入）：

```ts
if (request.name === 'web_fetch') {
  try {
    const result = await fetchAndExtract(request.args.url ?? '', {
      signal,
      maxChars: request.args.max_chars,
    });
    const stdout = result.ok
      ? [`Fetched: ${result.title ?? result.finalUrl ?? request.args.url}`,
         result.content_type ? `Type: ${result.content_type}` : '',
         result.truncated ? '(content truncated)' : '',
         '',
         result.content ?? '',
        ].filter(Boolean).join('\n')
      : `Failed to fetch ${request.args.url}: ${result.error ?? 'unknown error'}`;

    return withFailureGuidance(request, {
      ok: result.ok,
      command: `web_fetch ${request.args.url ?? ''}`,
      exitCode: result.ok ? 0 : -1,
      stdout: truncateToolOutput(stdout, 8000),
      stderr: result.error ?? '',
    });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    return withFailureGuidance(request, {
      ok: false,
      command: `web_fetch ${request.args.url ?? ''}`,
      exitCode: isAbort ? 130 : -1,
      stdout: '',
      stderr: isAbort
        ? 'Web fetch cancelled by user.'
        : error instanceof Error ? error.message : String(error),
    });
  }
}
```

`toolUsageGuidance()` 新增 case：

```ts
case 'web_fetch':
  return 'Use web_fetch with a complete http/https URL. Verify the URL is public and accessible before calling. If fetch fails with HTTP error, the page may not exist or may be behind authentication. If readability fails, the page may not be a text article — try a different source.';
```

### 6. `src/core/harness/routes.ts` — 无需修改

### 7. `src/core/harness/graph.ts` — 无需修改

### 8. `src/app/tui/components/render-utils.ts`

```ts
// ACTION_NAMES
web_fetch: 'Web Fetch',

// getToolPreview
case 'web_fetch': {
  const u = typeof args.url === 'string' ? args.url : '';
  if (!u) return undefined;
  try { return new URL(u).hostname; } catch { return u.slice(0, 40); }
}

// getToolDetail
case 'web_fetch': {
  const u = typeof args.url === 'string' ? args.url.slice(0, 80) : '';
  return u ? `Fetch: ${u}` : 'Web fetch';
}
```

---

## npm 依赖

```
npm install jsdom @mozilla/readability turndown
```

| 包 | 用途 |
|---|---|
| `jsdom` | Readability 需要 DOM 环境 |
| `@mozilla/readability` | Firefox 阅读模式正文提取 |
| `turndown` | HTML → Markdown |

三个包都是纯 JS/TS，支持 Bun 运行时。无需 `normalize-url`（Phase 1 不涉及搜索去重）。

---

## 上下文压缩交互

| 检查点 | 结论 |
|--------|------|
| `FOLDABLE_TOOLS` | `web_fetch` 不在集合中，结果不被折叠，全文保留 |
| `EXPLORATION_TOOLS` | `web_fetch` 不在集合中，不会被合并到 `tool_summary` |
| Token 预算 | 单次 fetch 返回 ~2-8K tokens，在 128K context 中占比 2-6% |

---

## 测试清单

| 测试文件 | 覆盖范围 |
|---------|---------|
| `tests/web-fetch.test.ts`（新建） | extractor 管道（正常 HTML、空页面、非 HTML 响应）、SSRF 拦截（内网 IP、file://、redirect 到内网）、超时、超大响应 |
| `tests/tool-policy.test.ts`（追加） | web_fetch 需审批、URL 含密钥被拒绝 |
| `tests/tools.test.ts`（追加） | schema 校验、参数边界 |
| `tests/tool-definitions.test.ts` | 自动覆盖（TOOL_CONTRACTS 遍历） |

---

## 实施顺序

```
Phase 1：依赖 + 工具函数（无行为变更）
  1. npm install jsdom @mozilla/readability turndown
  2. 创建 src/core/web/types.ts
  3. 创建 src/core/web/ssrf.ts
  4. 创建 src/core/web/extractor.ts

Phase 2：Harness 接入
  5. 新增 WEB_FETCH_CONTRACT → tool-contracts.ts
     - 同步更新 KNOWN_TOOL_NAMES + TOOL_CONTRACTS Map
  6. 注册 web_fetch 工具 → definitions.ts
     - 无需新增 CreateAgentToolsInput 字段（web_fetch 无外部依赖）
     - tool 闭包捕获 input.signal
  7. 新增 PendingToolRequest 成员 → tool-requests.ts
  8. 新增 policy 分支 → tool-policy.ts
     - requireApproval + risk: 'network' + 内联 URL 隐私检查
  9. 新增执行分支 → tool-runner.ts
      - 调用 fetchAndExtract() + AbortError try-catch + stdout 格式化 + toolUsageGuidance case

Phase 3：TUI
  10. render-utils.ts — ACTION_NAMES + getToolPreview + getToolDetail 新增 web_fetch

Phase 4：测试
  11. 编写 tests/web-fetch.test.ts（extractor + SSRF + 边界）
  12. 编写 tests/tool-policy.test.ts 追加
  13. 编写 tests/tools.test.ts 追加

Phase 5：集成验证
  14. bun run typecheck（零错误）
  15. bun test（全绿）
  16. 真实模型手动验证 web_fetch 工具调用链路
```

---

## 与 web_search 的衔接

`web_fetch` 的产出构成 `web_search` Phase 2 的基础：

| 组件 | web_fetch (Phase 1) | web_search (Phase 2) |
|------|---------------------|----------------------|
| `extractor.ts` | ✅ 实现 | 直接复用 |
| `ssrf.ts` | ✅ 实现 | 直接复用 |
| `types.ts` | 定义 `WebFetchInput/Result` | 新增 `WebSearchInput/Response` |
| Provider 抽象 | 不需要 | 新增 `provider.ts` + `service.ts` |
| 搜索 adapter | 不需要 | 新增 `providers/searxng.ts` + `providers/ddg-lite.ts` |
| URL 规范化去重 | 不需要 | 新增 `url-utils.ts` + `normalize-url` |
| 隐私扫描 | URL 级简单扫描 | 新增 `privacy.ts`（查询文本扫描） |
| 缓存 | 不需要 | 新增内存缓存 + LRU |

## 明确不做（Phase 1）

- `web_search` 工具（Phase 2 独立方案）
- 搜索引擎 Provider 抽象
- 搜索结果去重/缓存/规范化
- 完整查询隐私扫描（Phase 1 只做 URL 级简单扫描）
- 任意文件类型支持（仅 HTML → Markdown）
- 图片/视频/PDF 内容提取

## 相关规则

- `execution/active/tool-description-contracts.md`
- `execution/active/tool-gated-autonomy.md`
- `execution/active/layer-boundary-enforcement.md`
- `execution/active/project-conventions.md`
