import {
  Button,
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
function useNativeSearchReading(reader?: NativeSearchReader, retry = 0) {
  const active = useConversationReadActive(),
    current = useRef(reader);
  current.current = reader;
  const scope = reader?.scope,
    executionId = reader?.executionId,
    live = reader?.live;
  const [saved, setSaved] = useState<{ scope: string; data: WebSearchDisplay }>();
  const [state, setState] = useState<{
    scope: string;
    retry: number;
    phase: 'available' | 'absent' | 'unavailable';
  }>();
  useEffect(() => {
    if (!active || !scope || !executionId) return;
    let done = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      delay = 1000;
    const report = (phase: 'available' | 'absent' | 'unavailable') =>
      setState((prev) =>
        prev?.scope === scope && prev.retry === retry && prev.phase === phase
          ? prev
          : { scope, retry, phase },
      );
    const read = async () => {
      if (done || current.current?.scope !== scope) return;
      const again = live;
      try {
        const data = await current.current.read();
        if (done || current.current?.scope !== scope) return;
        if (data && data.executionId === executionId) {
          report('available');
          setSaved((old) =>
            old?.scope === scope && old.data.revision >= data.revision ? old : { scope, data },
          );
          // One model execution may contain several native search calls; stop polling when the owning execution settles, not at the first result.
        } else {
          report('absent');
        }
        delay = 1250;
      } catch {
        if (done || current.current?.scope !== scope) return;
        report('unavailable');
        delay = Math.min(8000, delay * 2);
      }
      if (!done && again) timer = setTimeout(() => void read(), delay);
    };
    void read();
    return () => {
      done = true;
      clearTimeout(timer);
    };
  }, [scope, executionId, live, active, retry]);
  const evidence =
    saved && saved.scope === scope && saved.data.executionId === executionId
      ? !live && saved.data.status === 'running'
        ? { ...saved.data, status: 'unknown' as const }
        : saved.data
      : undefined;
  return {
    evidence,
    phase: state?.scope === scope && state?.retry === retry ? state?.phase : 'loading',
  };
}
export function useNativeSearchEvidence(reader?: NativeSearchReader) {
  return useNativeSearchReading(reader).evidence;
}
/** Only mounted when the original, verified tool's own disclosure and its parent are open. */
export function NativeWebSearchToolDetails({
  reader,
  unsupported,
}: {
  reader?: NativeSearchReader;
  unsupported?: boolean;
}) {
  const [retry, setRetry] = useState(0),
    { evidence, phase } = useNativeSearchReading(reader, retry);
  if (evidence?.route === 'provider') return <WebSearchSources evidence={evidence} toolReceipt />;
  if (unsupported) return <small>此连接不支持查看搜索来源。</small>;
  if (reader && phase === 'unavailable')
    return (
      <div>
        <small>暂时无法读取搜索来源。</small>{' '}
        <Button variant="ghost" onClick={() => setRetry((v) => v + 1)}>
          重新读取来源
        </Button>
      </div>
    );
  if (reader && !reader.live && (phase === 'absent' || evidence))
    return <small>此执行未记录可展示的来源。</small>;
  return reader && phase === 'loading' ? (
    <small role="status" aria-busy="true">
      正在读取来源…
    </small>
  ) : null;
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
