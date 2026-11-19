import { useContext } from 'react';
import { useConversationReadActive } from '../conversation-activity';
import { WebLinkContext } from './MessageContent';
import {
  type WebSearchDisplay,
  type WebSearchSource,
  webSearchLabel,
  webSearchLinks,
} from './web-search-citations';

const statusText = {
  running: '正在搜索',
  completed: '搜索完成',
  failed: '搜索失败',
  incomplete: '搜索未完成',
  cancelled: '搜索已取消',
  unknown: '搜索结果未知',
};
function SourceList({ sources, label }: { sources: readonly WebSearchSource[]; label: string }) {
  const open = useContext(WebLinkContext),
    active = useConversationReadActive(),
    links = webSearchLinks(sources);
  if (!links.length) return null;
  return (
    <details>
      <summary>
        {label}（{links.length}）
      </summary>
      <ul>
        {links.map(({ url, title }) => (
          <li key={url}>
            <a
              href={url}
              rel="noopener noreferrer"
              target="_blank"
              onClick={(e) => {
                if (open || !active) e.preventDefault();
                if (active) open?.(url);
              }}
            >
              {title}
            </a>{' '}
            <small>{new URL(url).hostname}</small>
          </li>
        ))}
      </ul>
    </details>
  );
}
export function WebSearchSources({ evidence }: { evidence: WebSearchDisplay }) {
  const query = webSearchLabel(evidence.query);
  return (
    <section className="web-search-sources" aria-label="网页搜索">
      <small role="status">
        {statusText[evidence.status]}
        {evidence.provider
          ? ` · ${evidence.route === 'native' ? '原生搜索' : '搜索服务'}：${webSearchLabel(evidence.provider)}`
          : ''}
        {query ? `：${query}` : ''}
      </small>
      <SourceList
        sources={evidence.citations}
        label={evidence.route === 'provider' ? '搜索服务引用' : '正文引用'}
      />
      <SourceList sources={evidence.sources} label="检索来源" />
      {evidence.truncated && <small>仅显示部分搜索材料。</small>}
    </section>
  );
}
