import type { OutputFileTarget } from '@kite-ai/client';
import { Button, type OutputFileSummary } from '@kite-ai/ui/desktop';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { NativeBridge } from './native-bridge';
import { NativeExcelReadonlyBar, NativeOfficeToolbar } from './native-office-toolbar';
import type {
  OfficeEditContext,
  OfficePreviewControl,
  OfficePreviewInteraction,
  OfficeRequestOutcome,
} from './output-files-bridge';

type Props = {
  bridge?: NativeBridge;
  generation: number;
  target: OutputFileTarget;
  onSave: (file: OutputFileSummary) => void;
  onEdit: (file: OutputFileSummary, context?: OfficeEditContext) => void;
  onRequestEdit?: (
    file: OutputFileSummary,
    context: OfficeEditContext,
    prompt: string,
  ) => Promise<OfficeRequestOutcome>;
};
export function NativeFilePreview(props: Props) {
  // Exact target changes retire every in-flight read, form and preview together.
  return <FilePreview key={`${props.generation}:${JSON.stringify(props.target)}`} {...props} />;
}
function FilePreview(props: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const preview = useRef<string | undefined>(undefined);
  const editPending = useRef(false);
  const [file, setFile] = useState<OutputFileSummary>();
  const [status, setStatus] = useState('正在准备预览…');
  const [issue, setIssue] = useState('');
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState(1);
  const [pdf, setPdf] = useState<{ data: string; totalPages: number }>();
  const [interaction, setInteraction] = useState<OfficePreviewInteraction>();
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [presentation, setPresentation] = useState(false);
  const onRequestEdit = useRef(props.onRequestEdit);
  onRequestEdit.current = props.onRequestEdit;
  const isPpt = !!file && /\.pptx$/i.test(file.name);
  const isOffice = !!file && /\.(pptx|docx|xlsx)$/i.test(file.name);
  const slide = interaction?.currentSlide ?? 1;
  const slideCount = interaction?.slideCount ?? 1;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry rereads exact metadata; target is keyed by the owner.
  useEffect(() => {
    let cancelled = false;
    void props.bridge
      ?.request({ method: 'outputs.info', generation: props.generation, target: props.target })
      .then((result) => {
        if (
          !cancelled &&
          result &&
          'kind' in result &&
          result.kind === 'outputs.info' &&
          'file' in result
        )
          setFile(result.file);
      })
      .catch(() => {
        if (!cancelled) setStatus('文件信息暂时不可用，请重试');
      });
    return () => {
      cancelled = true;
    };
  }, [props.bridge, props.generation, retry]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The immutable keyed target owns the isolated preview lifetime.
  useLayoutEffect(() => {
    const bridge = props.bridge;
    if (!bridge || !file) return;
    let cancelled = false;
    setStatus('正在准备预览…');
    setInteraction(undefined);
    setPresentation(false);
    if (file.mediaType === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      void bridge
        .request({
          method: 'outputs.pdf.page',
          generation: props.generation,
          target: props.target,
          page,
        })
        .then((result) => {
          if (
            !cancelled &&
            result &&
            'kind' in result &&
            result.kind === 'outputs.pdf.page' &&
            'pdf' in result
          ) {
            setPdf({ data: result.pdf.data, totalPages: result.pdf.totalPages });
            setStatus('');
          }
        })
        .catch(() => {
          if (!cancelled) setStatus('文件已保存，暂时无法预览');
        });
      return () => {
        cancelled = true;
      };
    }
    const previewId = crypto.randomUUID();
    preview.current = previewId;
    const bounds = () => {
      const rect = viewport.current!.getBoundingClientRect();
      return {
        x: Math.max(0, Math.round(rect.x)),
        y: Math.max(0, Math.round(rect.y)),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      };
    };
    let ready = false;
    let reading = false;
    const submitted = new Set<string>();
    const outcomes = new Map<
      string,
      { outcome: OfficeRequestOutcome; attempts: number; settling: boolean; settled: boolean }
    >();
    const settle = async (requestId: string) => {
      const result = outcomes.get(requestId);
      if (
        !result ||
        result.settling ||
        result.settled ||
        result.attempts >= 3 ||
        cancelled ||
        preview.current !== previewId
      )
        return;
      result.settling = true;
      result.attempts++;
      try {
        await bridge.request({
          method: 'outputs.preview.request.result',
          generation: props.generation,
          previewId,
          requestId,
          outcome: result.outcome,
        });
        result.settled = true;
        if (!cancelled) setIssue((previous) => (previous.startsWith('预览回执') ? '' : previous));
      } catch {
        if (!cancelled)
          setIssue('预览回执暂时不可用，请在会话中核对原请求。可关闭输入，不会重复发送。');
      } finally {
        result.settling = false;
      }
    };
    const read = async () => {
      if (!ready || reading || cancelled || !isOffice) return;
      reading = true;
      try {
        const result = await bridge.request({
          method: 'outputs.preview.interaction',
          generation: props.generation,
          previewId,
        });
        if (
          !cancelled &&
          result &&
          'kind' in result &&
          result.kind === 'outputs.preview.interaction' &&
          'interaction' in result
        ) {
          setInteraction(result.interaction);
          if (result.interaction.presentation !== undefined)
            setPresentation(result.interaction.presentation);
          if (result.interaction.zoom !== undefined) setZoom(result.interaction.zoom);
          const request = result.interaction.inlineRequest;
          if (request && !submitted.has(request.requestId)) {
            submitted.add(request.requestId);
            if (
              result.interaction.previewId !== previewId ||
              result.interaction.generation !== props.generation ||
              result.interaction.target.storeId !== props.target.storeId ||
              result.interaction.target.sessionId !== props.target.sessionId ||
              result.interaction.target.fileId !== props.target.fileId ||
              JSON.stringify(result.interaction.target.locator) !==
                JSON.stringify(props.target.locator) ||
              request.context.sourceHash !== result.interaction.sourceHash
            )
              return;
            // Sending can outlive the local form. Keep polling so Escape closes it promptly.
            void (async () => {
              let outcome: OfficeRequestOutcome;
              try {
                outcome = onRequestEdit.current
                  ? await onRequestEdit.current(file, request.context, request.prompt)
                  : { status: 'failed', message: '当前会话尚未就绪，请稍后重试。' };
              } catch {
                outcome = {
                  status: 'unknown',
                  message: '发送结果待核实，请在会话中查看原请求。不会重复发送。',
                };
              }
              outcomes.set(request.requestId, {
                outcome,
                attempts: 0,
                settling: false,
                settled: false,
              });
              await settle(request.requestId);
            })();
          } else if (request) {
            // Only retry the idempotent local UI receipt, never the Agent request.
            void settle(request.requestId);
          }
        }
      } catch {
        /* A closed native preview cannot supply current selection. */
      } finally {
        reading = false;
      }
    };
    void bridge
      .request({
        method: 'outputs.preview.open',
        generation: props.generation,
        previewId,
        target: props.target,
        bounds: bounds(),
      })
      .then(async (result) => {
        if (cancelled) return;
        ready =
          !!result &&
          'kind' in result &&
          result.kind === 'outputs.preview' &&
          result.status === 'ready';
        if (ready) syncBounds(true);
        setStatus(ready ? '' : '文件已保存，暂时无法预览');
        if (ready && isOffice) {
          await bridge
            .request({
              method: 'outputs.preview.control',
              generation: props.generation,
              previewId,
              control: { kind: 'zoom', value: zoom },
            })
            .catch(() => {});
          await read();
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('文件已保存，暂时无法预览');
      });
    let lastBounds = '';
    const syncBounds = (force = false) => {
      if (cancelled) return;
      const next = bounds();
      const key = JSON.stringify(next);
      if (!force && key === lastBounds) return;
      lastBounds = key;
      void bridge
        .request({
          method: 'outputs.preview.bounds',
          generation: props.generation,
          previewId,
          bounds: next,
        })
        .catch(() => {
          // A pending/replaced host may reject; the ready handoff resends once.
          // Do not turn a rejected geometry into a per-frame retry loop.
        });
    };
    const resize = new ResizeObserver(() => syncBounds());
    resize.observe(viewport.current!);
    // ResizeObserver only tracks size. Pane transitions can move a same-sized viewport.
    // Track this single active rect without React renders or unchanged IPC messages.
    let frame = 0;
    const trackPosition = () => {
      if (cancelled) return;
      syncBounds();
      frame = window.requestAnimationFrame(trackPosition);
    };
    frame = window.requestAnimationFrame(trackPosition);
    const timer = setInterval(() => void read(), 200);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.cancelAnimationFrame(frame);
      resize.disconnect();
      if (preview.current === previewId) preview.current = undefined;
      void bridge
        .request({ method: 'outputs.preview.close', generation: props.generation, previewId })
        .catch(() => {});
    };
  }, [props.bridge, props.generation, file, retry, page]);

  async function control(command: OfficePreviewControl) {
    const id = preview.current;
    if (!id || !props.bridge) return;
    try {
      await props.bridge.request({
        method: 'outputs.preview.control',
        generation: props.generation,
        previewId: id,
        control: command,
      });
      if (!alive.current || preview.current !== id) return;
      if (command.kind === 'zoom') setZoom(command.value);
      if (command.kind === 'presentation') setPresentation(command.value);
      if (command.kind === 'slide')
        setInteraction((old) => (old ? { ...old, currentSlide: command.value } : old));
      setIssue('');
    } catch {
      if (alive.current)
        setIssue(
          interaction?.requestOpen
            ? '请先发送或关闭当前修改输入，再调整预览。'
            : '预览操作未完成，请重试。',
        );
    }
  }
  async function requestEdit() {
    if (!file || editPending.current) return;
    editPending.current = true;
    try {
      let current: OfficePreviewInteraction | undefined;
      const id = preview.current;
      if (id && !status) {
        try {
          const result = await props.bridge?.request({
            method: 'outputs.preview.interaction',
            consumeRequest: false,
            generation: props.generation,
            previewId: id,
          });
          if (!alive.current || preview.current !== id) return;
          if (
            result &&
            'kind' in result &&
            result.kind === 'outputs.preview.interaction' &&
            'interaction' in result
          )
            current = result.interaction;
          else throw Error('selection_unavailable');
        } catch {
          if (alive.current) setIssue('无法读取当前选区，请重试；尚未发送修改请求。');
          return;
        }
      }
      if (!alive.current) return;
      if (isOffice) {
        if (!id || !current || (!current.selection && !isPpt)) {
          setIssue('请先选择需要修改的文字或单元格。');
          return;
        }
        await control({ kind: 'request-edit' });
      } else props.onEdit(file, current ? contextFor(current) : undefined);
    } finally {
      editPending.current = false;
    }
  }
  return (
    <section
      className="native-file-preview"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      {isOffice && file ? (
        <NativeOfficeToolbar
          name={file.name}
          source={`来源：Run ${file.ownerRunId}`}
          powerpoint={isPpt}
          ready={!status && !interaction?.requestOpen}
          zoom={zoom}
          presentation={presentation}
          onZoom={(value) => void control({ kind: 'zoom', value })}
          onPresentation={() => void control({ kind: 'presentation', value: !presentation })}
          onEdit={() => void requestEdit()}
          onSave={() => props.onSave(file)}
        />
      ) : (
        <header>
          {file?.name ?? '已保存的文件'}
          {file && (
            <>
              <Button onClick={() => props.onSave(file)}>另存为</Button>
              <Button onClick={() => props.onEdit(file)}>继续修改</Button>
            </>
          )}
        </header>
      )}
      {file && /\.xlsx$/i.test(file.name) && (
        <NativeExcelReadonlyBar
          selection={interaction?.selection ?? null}
          view={interaction?.excelSelection}
          ready={!status && !interaction?.requestOpen}
          onLocate={(selectionSerial) =>
            void control({ kind: 'locate-selection', selectionSerial })
          }
        />
      )}
      {issue && (
        <div className="native-office-status" role="status">
          {issue}
        </div>
      )}
      {pdf && (
        <nav aria-label="PDF页码">
          <Button disabled={page <= 1} onClick={() => setPage(page - 1)}>
            上一页
          </Button>
          <span>
            {page} / {pdf.totalPages}
          </span>
          <Button disabled={page >= pdf.totalPages} onClick={() => setPage(page + 1)}>
            下一页
          </Button>
        </nav>
      )}
      <div ref={viewport} style={{ flex: 1, minHeight: 80, overflow: 'auto' }}>
        {status && <p role="status">{status}</p>}
        {status.includes('暂时') && <Button onClick={() => setRetry(retry + 1)}>重试预览</Button>}
        {pdf && !status && (
          <img
            style={{ maxWidth: '100%' }}
            src={`data:image/png;base64,${pdf.data}`}
            alt={`第 ${page} 页`}
          />
        )}
      </div>
      {isPpt && (
        <footer className="native-office-footer">
          <div>
            <button
              type="button"
              disabled={!!status || !!interaction?.requestOpen || slide <= 1}
              onClick={() => void control({ kind: 'slide', value: slide - 1 })}
            >
              上一页
            </button>
            <span>
              {slide} / {slideCount}
            </span>
            <button
              type="button"
              disabled={!!status || !!interaction?.requestOpen || slide >= slideCount}
              onClick={() => void control({ kind: 'slide', value: slide + 1 })}
            >
              下一页
            </button>
          </div>
          <details className="native-office-notes">
            <summary>演讲者备注</summary>
            <p>{interaction?.notes || '此页暂无备注。'}</p>
          </details>
        </footer>
      )}
    </section>
  );
}
function contextFor(interaction: OfficePreviewInteraction): OfficeEditContext {
  return {
    sourceHash: interaction.sourceHash,
    ...(interaction.selection ? { selection: interaction.selection } : {}),
  };
}
