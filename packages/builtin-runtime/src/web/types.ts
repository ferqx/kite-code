/** web_fetch 工具输入 / Input for the web_fetch tool */
export interface WebFetchInput {
  /** 目标 URL（仅限 http/https）/ Target URL (http/https only) */
  url: string;
  /** 正文截断长度，默认 8000，最大 16000 / Max extracted content length */
  max_chars?: number;
}

/** web_fetch 工具返回 / Result from the web_fetch tool */
export interface WebFetchResult {
  ok: boolean;
  /** 请求的原始 URL / Original requested URL */
  url: string;
  /** 最终 URL（经过重定向后）/ Final URL after redirects */
  finalUrl?: string;
  /** readability 提取的页面标题 / Page title extracted by readability */
  title?: string;
  /** readability + turndown 提取的 Markdown 正文 / Extracted Markdown content */
  content?: string;
  /** 响应 Content-Type / Response content type */
  contentType?: string;
  /** 正文是否被截断 / Whether extracted content was truncated */
  truncated: boolean;
  /** 错误信息（ok=false 时）/ Error message when ok=false */
  error?: string;
}
