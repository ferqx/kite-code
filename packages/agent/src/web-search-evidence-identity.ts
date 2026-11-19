import { createHash } from 'node:crypto';

export const webSearchMediaType = 'application/vnd.kite.web-search+json';
export const webSearchBlockBytes = 64 * 1024;
export const webSearchRequestBytes = 1024 * 1024;

export function webSearchRefPrefix(sessionId: string, executionId: string) {
  const hash = createHash('sha256')
    .update(JSON.stringify([sessionId, executionId]))
    .digest('hex');
  return `web-search-${hash}-`;
}
export function webSearchRefId(sessionId: string, executionId: string, revision: number) {
  return webSearchRefPrefix(sessionId, executionId) + String(revision).padStart(8, '0');
}

export function webSearchDisplayUrl(raw: string) {
  if (
    typeof raw !== 'string' ||
    raw.length > 4096 ||
    !/^https?:\/\/[^/?#@\s]+(?:[/?#]|$)/i.test(raw) ||
    /[\s\\]/u.test(raw) ||
    [...raw].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    return false;
  const url = URL.parse(raw);
  return !!(url?.hostname && !url.username && !url.password);
}
