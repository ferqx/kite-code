import { useCallback, useEffect, useRef, useState } from 'react';
import { useConversationActivity } from '../conversation-activity';
import { CodeBlockContent } from './components/ui/code-block';
import { type DiagramColors, diagramRestriction, renderMarkdownDiagram } from './markdown-diagram';

export function MarkdownDiagram({
  code,
  complete,
  sourceVisible,
}: {
  code: string;
  complete: boolean;
  sourceVisible: boolean;
}) {
  const { readActive, retention } = useConversationActivity();
  const host = useRef<HTMLDivElement>(null);
  const [colors, setColors] = useState<DiagramColors>();
  const [visible, setVisible] = useState(true);
  const [result, setResult] = useState<{ code: string; image?: string; error?: string }>();
  const resource = useRef<{ image: string; unregister: () => void } | undefined>(undefined);
  const clear = useCallback(() => {
    resource.current?.unregister();
    resource.current = undefined;
    setResult(undefined);
  }, []);
  const restriction = diagramRestriction(code);
  useEffect(() => {
    const update = () => {
      setVisible(!document.hidden);
      if (document.hidden) clear();
    };
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, [clear]);
  useEffect(() => {
    if (!readActive || !host.current) return;
    const update = () => {
      const style = getComputedStyle(host.current!);
      const next = {
        foreground: style.color,
        accent: style.getPropertyValue('--diagram-accent').trim() || style.color,
        secondary: style.getPropertyValue('--diagram-secondary').trim() || style.color,
      };
      setColors((current) =>
        current?.foreground === next.foreground &&
        current.accent === next.accent &&
        current.secondary === next.secondary
          ? current
          : next,
      );
    };
    update();
    const observer = new MutationObserver(update);
    for (let parent: HTMLElement | null = host.current; parent; parent = parent.parentElement)
      observer.observe(parent, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme'],
      });
    return () => observer.disconnect();
  }, [readActive]);
  useEffect(() => {
    if (!readActive || !visible || !complete || restriction || !colors) return;
    const controller = new AbortController();
    void renderMarkdownDiagram(code, colors, controller.signal).then(
      (image) => {
        if (!controller.signal.aborted) setResult({ code, image });
      },
      () => {
        if (!controller.signal.aborted) setResult({ code, error: '图表暂时无法解析，请查看源码' });
      },
    );
    return () => controller.abort();
  }, [code, complete, restriction, colors, readActive, visible]);
  useEffect(() => {
    if (!result?.image || !retention) return;
    if (resource.current?.image !== result.image) {
      resource.current?.unregister();
      resource.current = {
        image: result.image,
        unregister: retention.retain({
          bytes: result.image.length * 2,
          release: clear,
          releaseOnWindowHide: true,
        }),
      };
    }
    return () => {
      if (!retention.isPaused()) {
        resource.current?.unregister();
        resource.current = undefined;
      }
    };
  }, [result, retention, clear]);
  const current = result?.code === code ? result : undefined;
  const error = complete ? (restriction ?? current?.error) : undefined;
  const showImage = complete && !error && current?.image && !sourceVisible;
  return (
    <div ref={host} className="markdown-diagram">
      {showImage ? (
        <section
          className="markdown-diagram-scroll"
          aria-label="Mermaid 图表"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Oversized diagrams need a keyboard-scrollable reading region.
          tabIndex={0}
        >
          <img
            src={current.image}
            alt="Mermaid 图表；可切换源码查看图表描述"
            onError={() => setResult({ code, error: '图表暂时无法显示，请查看源码' })}
          />
        </section>
      ) : (
        <>
          {!sourceVisible && (
            <p className="markdown-diagram-status">
              {!complete ? '图表生成中，当前显示源码' : (error ?? '正在绘制图表…')}
            </p>
          )}
          <CodeBlockContent codeClassName="language-mermaid" aria-label="mermaid 代码">
            {code}
          </CodeBlockContent>
        </>
      )}
    </div>
  );
}
