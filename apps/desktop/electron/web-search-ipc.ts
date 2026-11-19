import type { NativeSearchRequest } from '../src/native-web-search-bridge';

const fail = (): never => {
  throw Error('invalid_native_request');
};
const row = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
const exact = (r: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(r).some((k) => !keys.includes(k))) fail();
};
const ident = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(v);
const label = (v: unknown, n: number) =>
  typeof v === 'string' && !!v.trim() && v.length <= n && !/[\p{Cc}\p{Cf}]/u.test(v);
export function validateSearchOperation(
  method: NativeSearchRequest['method'],
  input: Record<string, unknown>,
) {
  if (
    (method === 'webSearch.settings.save' || method === 'webSearch.settings.test') &&
    !ident(input.revision)
  )
    fail();
  if (
    method === 'webSearch.evidence' &&
    (!Number.isSafeInteger(input.viewSelection) || Number(input.viewSelection) < 1)
  )
    fail();
  if (method !== 'webSearch.settings.save') return;
  const draft = row(input.draft);
  exact(draft, ['mode', 'providerId', 'providers']);
  if (
    !['auto', 'disabled', 'provider'].includes(String(draft.mode)) ||
    !Array.isArray(draft.providers) ||
    draft.providers.length > 16
  )
    return fail();
  const ids = new Set<string>(),
    dedicated = new Set<string>();
  for (const item of draft.providers) {
    const p = row(item);
    exact(p, ['id', 'name', 'adapter', 'account', 'modelId', 'maxResults']);
    if (!ident(p.id) || ids.has(String(p.id)) || !label(p.name, 120)) fail();
    ids.add(String(p.id));
    if (!['openai-search', 'deepseek-search', 'perplexity-search'].includes(String(p.adapter)))
      fail();
    if (
      p.adapter === 'openai-search'
        ? !label(p.modelId, 128) || p.maxResults !== undefined
        : p.modelId !== undefined ||
          !Number.isInteger(p.maxResults) ||
          Number(p.maxResults) < 1 ||
          Number(p.maxResults) > 10
    )
      fail();
    const account = row(p.account);
    if (account.kind === 'dedicated') {
      exact(account, ['kind', 'hasCredential']);
      if (typeof account.hasCredential !== 'boolean') fail();
      dedicated.add(String(p.id));
    } else if (account.kind === 'provider') {
      exact(account, ['kind', 'alias']);
      if (!ident(account.alias)) fail();
    } else fail();
  }
  if (
    (draft.mode === 'provider' && !draft.providerId) ||
    (draft.mode === 'disabled' && draft.providerId !== undefined) ||
    (draft.providerId !== undefined && !ids.has(String(draft.providerId)))
  )
    fail();
  if (input.credential !== undefined) {
    const c = row(input.credential);
    exact(c, ['providerId', 'secret']);
    if (!dedicated.has(String(c.providerId)) || !label(c.secret, 4096)) fail();
  }
}
