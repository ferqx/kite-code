import {
  useConversationReadActive,
  verifyWebSearchAnchors,
  type WebSearchAnchor,
  type WebSearchDisplay,
  WebSearchSources,
} from '@kite-ai/ui/desktop';
import { useEffect, useRef, useState } from 'react';
export type NativeSearchReader = {
  scope: string;
  executionId: string;
  live: boolean;
  read(): Promise<WebSearchDisplay | undefined>;
};
/** Observation only: reads at most one request at a time, never a probe, and drops out-of-scope completions. */
function useNativeSearchReading(reader?: NativeSearchReader) {
  const active = useConversationReadActive(),
    current = useRef(reader);
  current.current = reader;
  const scope = reader?.scope,
    executionId = reader?.executionId,
    live = reader?.live;
  const [saved, setSaved] = useState<{ scope: string; data: WebSearchDisplay }>();
  const [failedScope, setFailedScope] = useState<string>();
  useEffect(() => {
    if (!active || !scope || !executionId) return;
    let done = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      delay = 1000;
    const read = async () => {
      if (done || current.current?.scope !== scope) return;
      const again = live;
      try {
        const data = await current.current.read();
        if (done || current.current?.scope !== scope) return;
        setFailedScope(undefined);
        if (data && data.executionId === executionId) {
          setSaved((old) =>
            old?.scope === scope && old.data.revision >= data.revision ? old : { scope, data },
          );
          // One model execution may contain several native search calls; stop polling when the owning execution settles, not at the first result.
        }
        delay = 1250;
      } catch {
        if (done || current.current?.scope !== scope) return;
        setFailedScope(scope);
        delay = Math.min(8000, delay * 2);
      }
      if (!done && again) timer = setTimeout(() => void read(), delay);
    };
    void read();
    return () => {
      done = true;
      clearTimeout(timer);
    };
  }, [scope, executionId, live, active]);
  // Ordinary search has its own tool status. Only model search needs a fallback here.
  const evidence =
    saved && saved.scope === scope && saved.data.executionId === executionId
      ? !live && saved.data.route !== 'provider' && saved.data.status === 'running'
        ? { ...saved.data, status: 'unknown' as const }
        : saved.data
      : undefined;
  return {
    evidence,
    unavailable: failedScope !== undefined && failedScope === scope,
  };
}
export function useNativeSearchEvidence(reader?: NativeSearchReader) {
  return useNativeSearchReading(reader).evidence;
}
/** Only mounted when the original, verified tool's own disclosure and its parent are open. */
export function NativeWebSearchToolDetails({
  reader,
  unsupported,
  headingQuery,
}: {
  reader?: NativeSearchReader;
  unsupported?: boolean;
  headingQuery?: string;
}) {
  const { evidence, unavailable } = useNativeSearchReading(reader);
  if (evidence?.route === 'provider')
    return <WebSearchSources evidence={evidence} toolReceipt headingQuery={headingQuery} />;
  if (unsupported) return <small>此连接不支持查看搜索来源。</small>;
  if (unavailable) return <small>暂时无法读取搜索来源。</small>;
  return null;
}
export function NativeWebSearchActivity({ reader }: { reader: NativeSearchReader }) {
  const evidence = useNativeSearchEvidence(reader);
  return evidence ? <WebSearchSources evidence={evidence} /> : null;
}
export function useNativeSearchAnchors(
  text: string,
  executionId: string | undefined,
  evidence: WebSearchDisplay | undefined,
) {
  const [accepted, setAccepted] = useState<{
    text: string;
    data: WebSearchDisplay;
    anchors: WebSearchAnchor[];
  }>();
  useEffect(() => {
    if (!executionId || !evidence?.citations.length) return;
    let active = true;
    void verifyWebSearchAnchors(text, executionId, evidence)
      .then((anchors) => {
        if (active && anchors.length) setAccepted({ text, data: evidence, anchors });
      })
      .catch(() => {
        /* Unavailable verification falls back to ordinary source links. */
      });
    return () => {
      active = false;
    };
  }, [text, executionId, evidence]);
  return executionId &&
    executionId === evidence?.executionId &&
    accepted?.text === text &&
    accepted.data === evidence
    ? accepted.anchors
    : undefined;
}
