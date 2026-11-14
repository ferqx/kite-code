import type { SessionFileTarget } from '@kite-ai/ui/desktop';
import { useLayoutEffect, useRef, useState } from 'react';
import { filePreviewFormat } from './file-preview-format';
import type { NativeBridge } from './native-bridge';
import { observeNativeContent } from './native-content-observer';
import { NativeOfficeToolbar } from './native-office-toolbar';

type Target = Extract<SessionFileTarget, { kind: 'local-preview' }>;
/** Local references are scoped read-only handles, never delivery records or output files. */
export function NativeLocalFilePreview({
  bridge,
  generation,
  target,
}: {
  bridge?: NativeBridge;
  generation: number;
  target: Target;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const preview = useRef<string | undefined>(undefined);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const paged = ['office', 'pdf'].includes(filePreviewFormat(target.name, target.mediaType));
  const [status, setStatus] = useState('正在读取文件…');
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly reopens the same scoped read handle.
  useLayoutEffect(() => {
    if (!bridge || !viewport.current) return;
    let cancelled = false;
    let lastBounds = '';
    let revoked = false;
    let checking = false;
    const previewId = crypto.randomUUID();
    preview.current = previewId;
    const bounds = () => {
      const rect = viewport.current!.getBoundingClientRect();
      return {
        x: Math.max(0, rect.x),
        y: Math.max(0, rect.y),
        width: Math.max(0, rect.width),
        height: Math.max(0, rect.height),
      };
    };
    const sync = (force = false) => {
      if (cancelled || revoked) return;
      const next = bounds();
      const key = JSON.stringify(next);
      if (!force && lastBounds === key) return;
      lastBounds = key;
      void bridge
        .request({ method: 'outputs.preview.bounds', generation, previewId, bounds: next })
        .catch(() => {});
    };
    setStatus('正在读取文件…');
    void bridge
      .request({
        method: 'localPreview.open',
        generation,
        handleId: target.handleId,
        previewId,
        bounds: bounds(),
      })
      .then((result) => {
        if (cancelled || revoked) return;
        if (
          result &&
          'kind' in result &&
          result.kind === 'outputs.preview' &&
          result.status === 'ready'
        ) {
          setStatus('');
          sync(true);
        } else setStatus('文件暂时无法预览');
      })
      .catch((error: unknown) => {
        if (cancelled || revoked) return;
        const code =
          error && typeof error === 'object' && 'code' in error
            ? error.code
            : error instanceof Error
              ? error.message
              : undefined;
        setStatus(
          code === 'preview_format_unavailable'
            ? '二进制文件无法打开'
            : code === 'preview_text_budget'
              ? '文本过大，无法预览'
              : code === 'preview_text_encoding_unavailable'
                ? '暂不支持此文本编码'
                : typeof code === 'string' && code.startsWith('local_preview_')
                  ? '文件或访问权限已变化，请关闭后重新打开'
                  : '文件读取或预览失败，请重试',
        );
      });
    const unobserve = observeNativeContent(
      viewport.current,
      () => sync(),
      () => sync(),
      true,
    );
    const timer = setInterval(() => {
      if (cancelled || revoked || checking) return;
      checking = true;
      void bridge
        .request({ method: 'localPreview.check', generation, handleId: target.handleId })
        .catch(() => {
          if (cancelled || revoked) return;
          revoked = true;
          setStatus('文件或访问权限已变化，请关闭后重新打开');
          void bridge
            .request({ method: 'outputs.preview.close', generation, previewId })
            .catch(() => {});
        })
        .finally(() => {
          checking = false;
        });
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (preview.current === previewId) preview.current = undefined;
      unobserve();
      // Switching tabs unmounts this view but must not revoke the tab's read-only handle.
      void bridge
        .request({ method: 'outputs.preview.close', generation, previewId })
        .catch(() => {});
    };
  }, [bridge, generation, target.handleId, retry]);
  return (
    <section
      className="native-file-preview"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
      aria-label={`预览 ${target.name}`}
    >
      {paged && (
        <NativeOfficeToolbar
          name={target.name}
          source="本地文件，只读预览"
          powerpoint={false}
          ready={!status}
          zoom={zoom}
          presentation={false}
          onPresentation={() => {}}
          onZoom={(value) => {
            const id = preview.current;
            if (!id || !bridge) return;
            void bridge
              .request({
                method: 'outputs.preview.control',
                generation,
                previewId: id,
                control: { kind: 'zoom', value },
              })
              .then(() => {
                if (preview.current === id) setZoom(value);
              })
              .catch(() => {
                if (preview.current === id) setStatus('预览缩放失败，请重试');
              });
          }}
        />
      )}
      {status && (
        <div role="status">
          {status}
          {status.includes('失败') && (
            <button type="button" onClick={() => setRetry((value) => value + 1)}>
              重试
            </button>
          )}
        </div>
      )}
      <div
        ref={viewport}
        className="native-file-preview-viewport"
        style={{ flex: 1, minHeight: 0 }}
      />
    </section>
  );
}
