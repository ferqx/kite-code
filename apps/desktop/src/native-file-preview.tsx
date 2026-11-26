import type { OutputFileTarget } from '@kite-ai/client';
import type { OutputFileSummary } from '@kite-ai/ui/desktop';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { filePreviewFormat } from './file-preview-format';
import type { NativeBridge } from './native-bridge';
import {
  type FilePreviewState,
  filePreviewFailure,
  NativeFilePreviewStatus,
} from './native-file-preview-status';
import { NativeImageZoom } from './native-image-zoom';
import { createOfficePreviewFrame } from './native-office-frame';
import { NativeOfficeToolbar, NativePreviewToolbar } from './native-office-toolbar';
import { presentNativePreview } from './native-preview-presentation';
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
  const [fileRead, setFileRead] = useState<{ file: OutputFileSummary; retry: number }>();
  const file = fileRead?.file;
  const [status, setStatus] = useState<FilePreviewState>('loading');
  const [issue, setIssue] = useState('');
  const [retry, setRetry] = useState(0);

  const [interaction, setInteraction] = useState<OfficePreviewInteraction>();
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [presentation, setPresentation] = useState(false);
  const onRequestEdit = useRef(props.onRequestEdit);
  onRequestEdit.current = props.onRequestEdit;
  const isPdf = !!file && (file.mediaType === 'application/pdf' || /\.pdf$/i.test(file.name));
  const isPpt = !!file && /\.pptx$/i.test(file.name);
  const isOffice = isPdf || (!!file && /\.(pptx|docx|xlsx)$/i.test(file.name));
  const selectionReady = status === 'ready' && !interaction?.requestOpen;
  // Only this attempt’s verified output can become a whole-file draft.
  const failedOfficeFile =
    isOffice &&
    fileRead?.retry === retry &&
    typeof status === 'object' &&
    !status.sourceUnavailable &&
    !interaction?.requestOpen
      ? file
      : undefined;
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
        if (cancelled) return;
        if (result && 'kind' in result && result.kind === 'outputs.info' && 'file' in result)
          setFileRead({ file: result.file, retry });
        else setStatus({ message: '无法读取文件信息', retry: true });
      })
      .catch(() => {
        if (!cancelled) setStatus({ message: '无法读取文件信息', retry: true });
      });
    return () => {
      cancelled = true;
    };
  }, [props.bridge, props.generation, retry]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The immutable keyed target owns the isolated preview lifetime.
  useLayoutEffect(() => {
    const bridge = props.bridge;
    if (!bridge || !fileRead || fileRead.retry !== retry) return;
    const { file } = fileRead;
    let cancelled = false;
    setStatus('loading');
    setIssue('');
    setInteraction(undefined);
    setPresentation(false);
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
    let ready = false;
    let previewUnavailable = false;
    const unavailable = (reason?: 'access' | 'interrupted') => {
      if (cancelled) return;
      previewUnavailable = true;
      ready = false;
      setStatus(
        reason === 'access'
          ? { message: '文件或访问权限已变化，请关闭后重新打开', sourceUnavailable: true }
          : { message: '预览已中断', retry: true },
      );
    };
    const frame = createOfficePreviewFrame(
      viewport.current!,
      bridge,
      props.generation,
      previewId,
      file.name,
      unavailable,
    );
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
    const presentation = presentNativePreview(
      viewport.current!,
      bridge,
      props.generation,
      previewId,
      (message) => {
        if (message) setIssue('');
        setStatus(message ? { message } : 'ready');
      },
      unavailable,
    );
    void bridge
      .request({
        method: 'outputs.preview.open',
        generation: props.generation,
        previewId,
        target: props.target,
        bounds: bounds(),
      })
      .then(async (result) => {
        if (cancelled || previewUnavailable) return;
        const prepared = !!result && 'kind' in result && result.kind === 'outputs.preview';
        if (prepared && result.status === 'frame') await frame.load(result.url);
        if (cancelled || previewUnavailable) return;
        ready = prepared && (result.status === 'ready' || result.status === 'frame');
        setStatus(ready ? 'ready' : filePreviewFailure());
        if (ready) presentation.ready();
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
      .catch((error) => {
        if (!cancelled && !previewUnavailable) setStatus(filePreviewFailure(error));
      });
    const timer = setInterval(() => void read(), 200);
    return () => {
      cancelled = true;
      frame.dispose();
      clearInterval(timer);
      presentation.dispose();
      if (preview.current === previewId) preview.current = undefined;
      void bridge
        .request({ method: 'outputs.preview.close', generation: props.generation, previewId })
        .catch(() => {});
    };
  }, [props.bridge, props.generation, fileRead, retry]);

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
      if (alive.current && preview.current === id)
        setIssue(
          interaction?.requestOpen
            ? '请先发送或关闭当前修改输入，再调整预览。'
            : '预览操作未完成，请重试。',
        );
    }
  }
  return (
    <section className="native-file-preview" aria-label={file ? `预览 ${file.name}` : '文件预览'}>
      {isOffice && file ? (
        <NativeOfficeToolbar
          name={file.name}
          source={`来源：Run ${file.ownerRunId}`}
          powerpoint={isPpt}
          excel={
            /\.xlsx$/i.test(file.name)
              ? {
                  selection: interaction?.selection ?? null,
                  view: interaction?.excelSelection,
                  onLocate: (selectionSerial) =>
                    void control({ kind: 'locate-selection', selectionSerial }),
                }
              : undefined
          }
          ready={selectionReady}
          zoom={zoom}
          presentation={presentation}
          onZoom={(value) => void control({ kind: 'zoom', value })}
          onPresentation={() => void control({ kind: 'presentation', value: !presentation })}
          onSave={() => props.onSave(file)}
        />
      ) : file ? (
        <NativePreviewToolbar
          name={file.name}
          reading={
            filePreviewFormat(file.name, file.mediaType) === 'image' ? (
              <NativeImageZoom
                bridge={props.bridge}
                generation={props.generation}
                previewId={status === 'ready' ? preview.current : undefined}
                onIssue={setIssue}
              />
            ) : undefined
          }
          editLabel="继续修改"
          onEdit={() => props.onEdit(file)}
          onSave={() => props.onSave(file)}
        />
      ) : null}
      {status === 'ready' && issue && (
        <div className="native-office-status" role="status">
          {issue}
        </div>
      )}
      <div ref={viewport} className="native-file-preview-viewport native-file-preview-output">
        <NativeFilePreviewStatus
          state={status}
          onEditWholeFile={failedOfficeFile ? () => props.onEdit(failedOfficeFile) : undefined}
          onRetry={() => {
            setStatus('loading');
            setRetry((value) => value + 1);
          }}
        />
      </div>
    </section>
  );
}
