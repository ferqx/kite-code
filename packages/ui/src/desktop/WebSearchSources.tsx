import { ArrowDown01Icon, Globe02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useContext, useId, useLayoutEffect, useRef, useState } from 'react';
import { useConversationReadActive } from '../conversation-activity';
import { WebLinkContext } from './MessageContent';
import {
  isSearchSiteIcon,
  type WebSearchDisplay,
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
function useSourceClick() {
  const open = useContext(WebLinkContext),
    active = useConversationReadActive();
  return (event: React.MouseEvent<HTMLAnchorElement>, url: string) => {
    if (open || !active) event.preventDefault();
    if (active) open?.(url);
  };
}
/** Secondary sources in model output stay separate from the ordinary tool receipt. */
function SourceList({ links, label }: { links: ReturnType<typeof webSearchLinks>; label: string }) {
  const visit = useSourceClick();
  if (!links.length) return null;
  return (
    <details>
      <summary>
        {label}（{links.length}）
      </summary>
      <ul aria-label={label}>
        {links.map(({ url, title }) => (
          <li key={url}>
            <a href={url} rel="noopener noreferrer" target="_blank" onClick={(e) => visit(e, url)}>
              {title}
            </a>{' '}
            <small>{new URL(url).hostname}</small>
          </li>
        ))}
      </ul>
    </details>
  );
}
function SiteMark({ pixels }: { pixels?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    if (!isSearchSiteIcon(pixels) || !canvas.current) return;
    const ctx = canvas.current.getContext('2d');
    if (!ctx) return;
    const data = ctx.createImageData(16, 16);
    data.data.set(Uint8Array.from(atob(pixels), (c) => c.charCodeAt(0)));
    ctx.putImageData(data, 0, 0);
  }, [pixels]);
  return isSearchSiteIcon(pixels) ? (
    <span className="search-source-mark" aria-hidden="true">
      <canvas ref={canvas} width={16} height={16} />
    </span>
  ) : (
    <HugeiconsIcon icon={Globe02Icon} aria-hidden="true" className="search-source-mark" />
  );
}
const initialCount = 8;
function SearchReceipt({
  evidence,
  headingQuery,
}: {
  evidence: WebSearchDisplay;
  headingQuery?: string;
}) {
  const [details, setDetails] = useState(false),
    [all, setAll] = useState(false),
    listId = useId(),
    visit = useSourceClick();
  const links = webSearchLinks(evidence.sources),
    citations = webSearchLinks(evidence.citations),
    query = webSearchLabel(evidence.query),
    provider = webSearchLabel(evidence.provider),
    visible = all ? links : links.slice(0, initialCount);
  const state =
    evidence.status === 'running' || evidence.status === 'completed'
      ? undefined
      : statusText[evidence.status];
  if (!state && !links.length && !citations.length) return null;
  return (
    <section className="web-search-sources web-search-receipt" aria-label="网页搜索来源">
      {query && query !== webSearchLabel(headingQuery) && (
        <p className="search-receipt-query">{query}</p>
      )}
      {state && (
        <span role="status" className="search-receipt-status">
          {state}
        </span>
      )}
      {links.length > 0 && (
        <>
          <ul
            className="search-receipt-list"
            data-details={details || undefined}
            id={listId}
            aria-label={`检索来源（${links.length} 个来源）`}
          >
            {visible.map(({ url, title, snippet, siteIconPixels }) => {
              const domain = new URL(url).hostname;
              return (
                <li key={url}>
                  <a
                    className="search-source-link"
                    href={url}
                    rel="noopener noreferrer"
                    target="_blank"
                    onClick={(e) => visit(e, url)}
                    title={`${title} · ${domain}`}
                    aria-label={title === domain ? title : `${title}，${domain}`}
                  >
                    <SiteMark pixels={siteIconPixels} />
                    <span className="search-source-title">{title}</span>
                    {details && title !== domain && (
                      <small className="search-source-domain">{domain}</small>
                    )}
                  </a>
                  {details && snippet && <p className="web-search-snippet">{snippet}</p>}
                </li>
              );
            })}
          </ul>
          <div className="search-receipt-options">
            {links.length > initialCount && (
              <button
                type="button"
                className="search-receipt-control"
                aria-controls={listId}
                aria-expanded={all}
                onClick={() => setAll(!all)}
              >
                {all ? '收起更多来源' : `显示其余 ${links.length - initialCount} 个来源`}
              </button>
            )}
            <button
              type="button"
              className="search-receipt-control"
              aria-expanded={details}
              aria-controls={listId}
              onClick={() => setDetails(!details)}
            >
              {details ? '收起详情' : '来源详情'}
              <HugeiconsIcon icon={ArrowDown01Icon} aria-hidden="true" />
            </button>
            {details && provider && <small>搜索服务：{provider}</small>}
          </div>
        </>
      )}
      <SourceList links={citations} label="搜索服务引用" />
    </section>
  );
}
export function WebSearchSources({
  evidence,
  toolReceipt = false,
  headingQuery,
}: {
  evidence: WebSearchDisplay;
  toolReceipt?: boolean;
  headingQuery?: string;
}) {
  if (toolReceipt) return <SearchReceipt evidence={evidence} headingQuery={headingQuery} />;
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
        links={webSearchLinks(evidence.citations)}
        label={evidence.route === 'provider' ? '搜索服务引用' : '正文引用'}
      />
      <SourceList links={webSearchLinks(evidence.sources)} label="检索来源" />
    </section>
  );
}
