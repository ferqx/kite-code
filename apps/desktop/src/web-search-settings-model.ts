/** Renderer facts contain account identities, never vault references, secrets or provider-supplied diagnostics. */
export type SearchAdapter = 'deepseek-search' | 'perplexity-search' | 'openai-search';
export type SearchMode = 'auto' | 'provider' | 'disabled';
export type SearchService = {
  id: string;
  name: string;
  adapter: SearchAdapter;
  account: { kind: 'provider'; alias: string } | { kind: 'dedicated'; hasCredential: boolean };
  maxResults?: number;
  modelId?: string;
};
export type SearchDraft = { mode: SearchMode; providerId?: string; providers: SearchService[] };
export type SearchView = {
  revision: string;
  canWrite: boolean;
  draft: SearchDraft;
  accounts: readonly { alias: string; name: string; adapter: SearchAdapter }[];
  route: { available: boolean; label: string };
};
export type SearchProbe = {
  route: string;
  observed: boolean;
  sources: readonly { url: string; title?: string }[];
  errorCode?: string;
};
export type WebSearchSettingsPort = {
  read(): Promise<SearchView>;
  save(
    revision: string,
    draft: SearchDraft,
    credentials: readonly { providerId: string; secret: string }[],
  ): Promise<SearchView>;
  test(revision: string): Promise<SearchProbe>;
};
export const searchAdapterNames: Record<SearchAdapter, string> = {
  'deepseek-search': 'DeepSeek Search',
  'perplexity-search': 'Perplexity Search',
  'openai-search': 'OpenAI 搜索模型',
};
export function searchDraftIssue(
  draft: SearchDraft,
  hasSecret: (id: string) => boolean,
): string | undefined {
  if (draft.mode === 'provider' && !draft.providerId) return '请选择搜索服务。';
  if (draft.providerId && !draft.providers.some((p) => p.id === draft.providerId))
    return '所选搜索服务不存在。';
  if (
    draft.providers.length > 16 ||
    new Set(draft.providers.map((p) => p.id)).size !== draft.providers.length
  )
    return '搜索服务列表无效。';
  for (const p of draft.providers) {
    if (!p.name.trim()) return '请填写搜索服务名称。';
    if (p.account.kind === 'provider' && !p.account.alias) return '请选择匹配的账户。';
    if (p.account.kind === 'dedicated' && !p.account.hasCredential && !hasSecret(p.id))
      return '请为专用账户输入 API Key。';
    if (
      p.adapter === 'openai-search'
        ? !p.modelId?.trim()
        : !Number.isInteger(p.maxResults) || p.maxResults! < 1 || p.maxResults! > 10
    )
      return p.adapter === 'openai-search' ? '请填写搜索模型。' : '结果数量必须是 1 至 10 的整数。';
  }
  return undefined;
}
const errors: Record<string, string> = {
  search_auth_failed: '凭据无效，请检查所选账户。',
  search_payment_required: '提供商余额或配额不足。',
  search_forbidden: '提供商拒绝了搜索。',
  search_rate_limited: '提供商限流，请稍后再试。',
  search_not_performed: '提供商没有执行搜索。',
  search_timeout: '搜索超时，结果未知，未自动重试。',
  search_cancelled: '搜索已取消。',
  search_network_error: '网络响应中断，搜索结果未知，未自动重试。',
  search_credential_unavailable: '所选账户没有可用的搜索凭据。',
  search_incomplete: '提供商未完成搜索。',
  web_search_unauthorized: '凭据无效，请检查所选账户。',
  authentication_failed: '凭据无效，请检查所选账户。',
  web_search_payment_required: '提供商余额或配额不足。',
  web_search_quota_exceeded: '提供商余额或配额不足。',
  web_search_rate_limited: '提供商限流，请稍后再试。',
  rate_limited: '提供商限流，请稍后再试。',
  web_search_not_performed: '提供商没有执行搜索。',
  web_search_timeout: '搜索超时，结果未知，未自动重试。',
  web_search_unavailable: '当前路线不可用。',
  configuration_changed: '配置已变化，请重新读取。',
  web_search_forbidden: '当前权限不允许搜索。',
  web_search_cancelled: '搜索已取消。',
};
export function webSearchProblem(error: unknown, fallback: string): string {
  const code =
    typeof error === 'string'
      ? error
      : ((error as { code?: string })?.code ?? (error as Error)?.message);
  return errors[code] ?? fallback;
}
