import type { SessionFileTarget } from '@kite-ai/ui/desktop';
import { useLayoutEffect, useRef, useState } from 'react';
import { filePreviewFormat } from './file-preview-format';
import type { NativeBridge } from './native-bridge';
import {
  type FilePreviewState,
  filePreviewFailure,
  NativeFilePreviewStatus,
} from './native-file-preview-status';
import { createOfficePreviewFrame } from './native-office-frame';
import { NativeOfficeToolbar } from './native-office-toolbar';
import { presentNativePreview } from './native-preview-presentation';
import type { LocalOfficeRequest, OfficeRequestOutcome } from './output-files-bridge';

type Target = Extract<SessionFileTarget, { kind: 'local-preview' }>;
/** Local references are scoped read-only handles, never delivery records or output files. */
export function NativeLocalFilePreview({
  bridge,
  generation,
  target,
  onRequestEdit,
}: {
  bridge?: NativeBridge;
  generation: number;
  target: Target;
  onRequestEdit?: (request: LocalOfficeRequest) => Promise<OfficeRequestOutcome>;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const preview = useRef<string | undefined>(undefined);
  const requestEdit = useRef(onRequestEdit);
  requestEdit.current = onRequestEdit;
  const pdf = filePreviewFormat(target.name, target.mediaType) === 'pdf';
  const [issue, setIssue] = useState('');
  const [requestOpen, setRequestOpen] = useState(false);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const paged = ['office', 'pdf'].includes(filePreviewFormat(target.name, target.mediaType));
  const [status, setStatus] = useState<FilePreviewState>('loading');
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly reopens the same scoped read handle.
  useLayoutEffect(() => {
    if (!bridge || !viewport.current) return;
    let cancelled = false;
    let revoked = false;
    let checking = false;
    let ready = false;
    let reading = false;
    const submitted = new Set<string>();
    const outcomes = new Map<
      string,
      { outcome: OfficeRequestOutcome; attempts: number; settled: boolean; settling: boolean }
    >();
    const previewId = crypto.randomUUID();
    preview.current = previewId;
    const unavailable = (reason?: 'access' | 'interrupted') => {
      if (cancelled) return;
      revoked = true;
      ready = false;
      setStatus(
        reason === 'access'
          ? { message: '文件或访问权限已变化，请关闭后重新打开' }
          : { message: '预览已中断', retry: true },
      );
    };
    const frame = createOfficePreviewFrame(
      viewport.current,
      bridge,
      generation,
      previewId,
      target.name,
      unavailable,
    );
    const bounds = () => {
      const rect = viewport.current!.getBoundingClientRect();
      return {
        x: Math.max(0, rect.x),
        y: Math.max(0, rect.y),
        width: Math.max(0, rect.width),
        height: Math.max(0, rect.height),
      };
    };
    const presentation = presentNativePreview(
      viewport.current!,
      bridge,
      generation,
      previewId,
      setIssue,
      unavailable,
    );
    setStatus('loading');
    setRequestOpen(false);
    setZoom('fit');
    setIssue('');
    void bridge
      .request({
        method: 'localPreview.open',
        generation,
        handleId: target.handleId,
        previewId,
        bounds: bounds(),
      })
      .then(async (result) => {
        if (cancelled || revoked) return;
        if (
          result &&
          'kind' in result &&
          result.kind === 'outputs.preview' &&
          result.status === 'frame'
        )
          await frame.load(result.url);
        if (cancelled || revoked) return;
        if (
          result &&
          'kind' in result &&
          result.kind === 'outputs.preview' &&
          (result.status === 'ready' || result.status === 'frame')
        ) {
          setStatus('ready');
          ready = true;
          presentation.ready();
        } else setStatus(filePreviewFailure());
      })
      .catch((error: unknown) => {
        if (cancelled || revoked) return;
        setStatus(filePreviewFailure(error));
      });
    const settle = async (requestId: string) => {
      const value = outcomes.get(requestId);
      if (!value || value.settled || value.settling || value.attempts >= 3 || cancelled || revoked)
        return;
      value.settling = true;
      value.attempts++;
      try {
        await bridge.request({
          method: 'localPreview.request.result',
          generation,
          handleId: target.handleId,
          previewId,
          requestId,
          outcome: value.outcome,
        });
        value.settled = true;
      } catch {
        if (!cancelled) setIssue('预览回执暂时不可用，请在会话中核对原请求。不会重复发送。');
      } finally {
        value.settling = false;
      }
    };
    const readInteraction = async () => {
      if (!paged || !ready || reading || cancelled || revoked) return;
      reading = true;
      try {
        const result = await bridge.request({
          method: 'localPreview.interaction',
          generation,
          handleId: target.handleId,
          previewId,
          consumeRequest: pdf && !!requestEdit.current,
        });
        if (
          cancelled ||
          revoked ||
          !result ||
          !('kind' in result) ||
          result.kind !== 'localPreview.interaction' ||
          !('interaction' in result)
        )
          return;
        const value = result.interaction;
        if (
          value.previewId !== previewId ||
          value.generation !== generation ||
          value.handleId !== target.handleId
        )
          return;
        if (value.zoom !== undefined) setZoom(value.zoom);
        const edit = requestEdit.current;
        if (!pdf || !edit) return;
        setRequestOpen(!!value.requestOpen);
        const request = value.inlineRequest;
        if (!request || request.context.sourceHash !== value.sourceHash) return;
        if (submitted.has(request.requestId)) {
          void settle(request.requestId);
          return;
        }
        submitted.add(request.requestId);
        void (async () => {
          let outcome: OfficeRequestOutcome;
          try {
            outcome = await edit({
              handleId: target.handleId,
              previewId,
              requestId: request.requestId,
            });
          } catch {
            outcome = { status: 'unknown', message: '发送结果待核实，请检查会话，勿重复发送。' };
          }
          outcomes.set(request.requestId, {
            outcome,
            attempts: 0,
            settled: false,
            settling: false,
          });
          await settle(request.requestId);
        })();
      } catch {
        /* Revoked/closed previews cannot produce current requests. */
      } finally {
        reading = false;
      }
    };
    const requestTimer = setInterval(() => {
      void readInteraction();
    }, 250);
    const timer = setInterval(() => {
      if (cancelled || revoked || checking) return;
      checking = true;
      void bridge
        .request({ method: 'localPreview.check', generation, handleId: target.handleId })
        .catch(() => {
          if (cancelled || revoked) return;
          revoked = true;
          frame.dispose();
          setStatus({ message: '文件或访问权限已变化，请关闭后重新打开' });
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
      frame.dispose();
      clearInterval(timer);
      clearInterval(requestTimer);
      if (preview.current === previewId) preview.current = undefined;
      presentation.dispose();
      // Switching tabs unmounts this view but must not revoke the tab's read-only handle.
      void bridge
        .request({ method: 'outputs.preview.close', generation, previewId })
        .catch(() => {});
    };
  }, [bridge, generation, target.handleId, retry, pdf, paged]);
  return (
    <section className="native-file-preview" aria-label={`预览 ${target.name}`}>
      {paged && (
        <NativeOfficeToolbar
          name={target.name}
          source={pdf && onRequestEdit ? '本地文件，原路径引用' : '本地文件，只读预览'}
          powerpoint={false}
          ready={status === 'ready' && !requestOpen}
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
                if (preview.current === id) {
                  setZoom(value);
                  setIssue('');
                }
              })
              .catch(() => {
                if (preview.current === id) setIssue('预览缩放失败，请重试');
              });
          }}
        />
      )}
      {status === 'ready' && issue && (
        <div className="native-office-status" role="status">
          {issue}
        </div>
      )}
      <div ref={viewport} className="native-file-preview-viewport">
        <NativeFilePreviewStatus state={status} onRetry={() => setRetry((value) => value + 1)} />
      </div>
    </section>
  );
}
