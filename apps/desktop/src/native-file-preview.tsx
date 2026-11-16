import type { OutputFileTarget } from '@kite-ai/client';
import { Button, type OutputFileSummary } from '@kite-ai/ui/desktop';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { NativeBridge } from './native-bridge';
import {
  type FilePreviewState,
  filePreviewFailure,
  NativeFilePreviewStatus,
} from './native-file-preview-status';
import { NativeExcelReadonlyBar, NativeOfficeToolbar } from './native-office-toolbar';
import { presentNativePreview } from './native-preview-presentation';
import { readNativeSkillCatalogue } from './native-skills';
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
    skillId?: string,
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
  const [fileRead, setFileRead] = useState<{ file: OutputFileSummary; retry: number }>();
  const file = fileRead?.file;
  const [status, setStatus] = useState<FilePreviewState>('loading');
  const [issue, setIssue] = useState('');
  const [retry, setRetry] = useState(0);

  const [interaction, setInteraction] = useState<OfficePreviewInteraction>();
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [presentation, setPresentation] = useState(false);
  const [skills, setSkills] = useState<{ id: string; name: string }[]>([]);
  const [skillId, setSkillId] = useState('');
  const selectedSkill = useRef('');
  const onRequestEdit = useRef(props.onRequestEdit);
  onRequestEdit.current = props.onRequestEdit;
  const isPdf = !!file && (file.mediaType === 'application/pdf' || /\.pdf$/i.test(file.name));
  const isPpt = !!file && /\.pptx$/i.test(file.name);
  const isOffice = isPdf || (!!file && /\.(pptx|docx|xlsx)$/i.test(file.name));
  useEffect(() => {
    const bridge = props.bridge;
    if (!isOffice || !bridge) return;
    const abort = new AbortController();
    void readNativeSkillCatalogue({
      bridge,
      scope: { generation: props.generation, storeId: props.target.storeId },
      signal: abort.signal,
      isCurrent: () => !abort.signal.aborted,
    })
      .then((catalogue) => {
        if (abort.signal.aborted) return;
        const options = catalogue.entries.flatMap(({ id, name, state }) =>
          state === 'available' && name && id.length <= 128 ? [{ id, name }] : [],
        );
        const counts = new Map<string, number>();
        for (const { name } of options) counts.set(name, (counts.get(name) ?? 0) + 1);
        setSkills(
          options.map(({ id, name }) => ({
            id,
            name: counts.get(name)! > 1 ? `${name} (${id})` : name,
          })),
        );
      })
      .catch(() => {
        if (!abort.signal.aborted) setSkills([]);
      });
    return () => abort.abort();
  }, [isOffice, props.bridge, props.generation, props.target.storeId]);
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
    let reading = false;
    let requestSkill: string | undefined;
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
          if (result.interaction.requestOpen) requestSkill ??= selectedSkill.current;
          else requestSkill = undefined;
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
            const skill = requestSkill || undefined;
            void (async () => {
              let outcome: OfficeRequestOutcome;
              try {
                outcome = onRequestEdit.current
                  ? await onRequestEdit.current(file, request.context, request.prompt, skill)
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
      (message) => setStatus(message ? { message } : 'ready'),
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
        if (cancelled) return;
        ready =
          !!result &&
          'kind' in result &&
          result.kind === 'outputs.preview' &&
          result.status === 'ready';
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
        if (!cancelled) setStatus(filePreviewFailure(error));
      });
    const timer = setInterval(() => void read(), 200);
    return () => {
      cancelled = true;
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
      if (id && status === 'ready') {
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
          ready={status === 'ready' && !interaction?.requestOpen}
          zoom={zoom}
          presentation={presentation}
          onZoom={(value) => void control({ kind: 'zoom', value })}
          onPresentation={() => void control({ kind: 'presentation', value: !presentation })}
          onEdit={() => void requestEdit()}
          onSave={() => props.onSave(file)}
          skill={
            skills.length
              ? {
                  id: skillId,
                  options: skills,
                  select: (id) => {
                    selectedSkill.current = id;
                    setSkillId(id);
                  },
                }
              : undefined
          }
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
      {isPpt && interaction?.notes?.trim() && status === 'ready' && (
        <details className="native-office-notes" key={interaction.currentSlide}>
          <summary>演讲者备注</summary>
          <p>{interaction.notes}</p>
        </details>
      )}
      {file && /\.xlsx$/i.test(file.name) && (
        <NativeExcelReadonlyBar
          selection={interaction?.selection ?? null}
          view={interaction?.excelSelection}
          ready={status === 'ready' && !interaction?.requestOpen}
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
      <div ref={viewport} style={{ flex: 1, minHeight: 80, overflow: 'auto' }}>
        <NativeFilePreviewStatus
          state={status}
          onRetry={() => {
            setStatus('loading');
            setRetry((value) => value + 1);
          }}
        />
      </div>
    </section>
  );
}
function contextFor(interaction: OfficePreviewInteraction): OfficeEditContext {
  return {
    sourceHash: interaction.sourceHash,
    ...(interaction.selection ? { selection: interaction.selection } : {}),
  };
}
