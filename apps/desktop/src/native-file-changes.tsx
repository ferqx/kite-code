import type { Message } from '@kite-ai/client';
import {
  Button,
  type Message as DesktopMessage,
  FileChanges,
  FileDiff,
  ScrollArea,
  Spinner,
  useConversationReadActive,
} from '@kite-ai/ui/desktop';
import { useEffect, useState } from 'react';
import type {
  DesktopEditor,
  NativeFileChange,
  NativeFileChangeDetail,
} from './file-changes-bridge';
import type { NativeBridge, NativeSelection } from './native-bridge';
import type { NativeDisplayCache } from './native-display-cache';
import { useNativeFileTargets } from './native-file-targets';
import { nativeReadDeadline } from './native-read-deadline';

function ChangeDetail({
  bridge,
  generation,
  entry,
  editor,
  view = 'diff',
  disclosure,
  child = false,
  openFile,
  fileOpenBlocked,
}: {
  bridge: NativeBridge;
  generation: number;
  entry: NativeFileChange;
  editor: DesktopEditor;
  view?: 'diff' | 'snapshot';
  disclosure?: {
    open: boolean;
    readAvailable?: boolean;
    key: string;
    cache: NativeDisplayCache<NativeFileChangeDetail>;
  };
  child?: boolean;
  openFile?: (path: string) => void;
  fileOpenBlocked?: boolean;
}) {
  const conversationReadActive = useConversationReadActive();
  const readActive =
    !disclosure ||
    (disclosure.open && conversationReadActive && disclosure.readAvailable !== false);
  const diffCache = disclosure?.cache;
  const inlineEdit = !!disclosure && (entry.operation === 'edit' || entry.operation === 'write');
  const cacheKey = disclosure?.key ?? '';
  const [body, setBody] = useState<NativeFileChangeDetail | undefined>(() =>
    entry.preview === 'available' ? diffCache?.get(cacheKey) : undefined,
  );
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [opening, setOpening] = useState(false);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (!readActive || entry.preview === 'unavailable') return;
    const cached = diffCache?.get(cacheKey);
    if (cached?.changeId === entry.changeId) {
      setBody(cached);
      return;
    }
    const readId = `${revision}-${crypto.randomUUID()}`;
    let active = true;
    const close = () => {
      if (!active) return;
      active = false;
      void bridge
        .request(
          child
            ? { method: 'background.child.file.close', surface: 'environment', generation, readId }
            : { method: 'fileChanges.close', generation, readId },
        )
        .catch(() => {});
    };
    setError('');
    if (!diffCache) setBody(undefined);
    const request = bridge.request(
      child
        ? {
            method: 'background.child.file',
            surface: 'environment',
            generation,
            changeId: entry.changeId,
            readId,
            offset,
            view,
          }
        : {
            method: 'fileChanges.detail',
            generation,
            changeId: entry.changeId,
            readId,
            offset,
            view,
          },
    );
    void (diffCache ? nativeReadDeadline(request) : request)
      .then((value) => {
        if (!active) return;
        if (
          !value ||
          !('changeId' in value) ||
          !('kind' in value) ||
          value.kind !== 'fileChanges.detail' ||
          value.changeId !== entry.changeId
        )
          throw Error('file_change_identity_mismatch');
        if (value.text !== undefined) diffCache?.set(cacheKey, value);
        setBody(value);
      })
      .catch(() => {
        if (active) setError('文件操作的原记录目前不可读，请重新读取。');
      })
      .finally(close);
    return close;
  }, [
    bridge,
    generation,
    entry.changeId,
    entry.preview,
    revision,
    offset,
    view,
    readActive,
    diffCache,
    cacheKey,
    child,
  ]);
  async function open() {
    setOpening(true);
    setError('');
    try {
      await bridge.request({
        method: 'fileChanges.open',
        generation,
        changeId: entry.changeId,
        editor,
      });
    } catch (cause) {
      setError(
        (cause as { code?: string }).code === 'file_editor_open_failed' ||
          (cause as Error).message === 'file_editor_open_failed'
          ? '无法打开文件，请确认所选编辑器已安装。'
          : '无法打开文件，请确认文件仍在当前项目中并重新读取记录。',
      );
    } finally {
      setOpening(false);
    }
  }
  const message: DesktopMessage = {
    id: entry.messageId,
    role: 'tool',
    text: '',
    settled: true,
    ...(body?.text !== undefined
      ? { toolResult: { ok: true, stdout: body.text, status: 'success' } as const }
      : {}),
  };
  const displayError = disclosure && body?.text !== undefined ? '' : error;
  if (inlineEdit && body?.text === undefined) {
    return (
      <div className="file-diff" data-inline="true">
        <div className="file-diff-toolbar">
          {entry.path && openFile ? (
            <Button
              className="file-diff-path file-link"
              title={entry.path}
              readOnly={fileOpenBlocked}
              onClick={() => openFile(entry.path!)}
            >
              {entry.path.split(/[/\\]/).at(-1) || entry.path}
            </Button>
          ) : (
            <span className="file-diff-path" title={entry.path}>
              {entry.path?.split(/[/\\]/).at(-1) || entry.path || '本次操作'}
            </span>
          )}
        </div>
        {displayError && (
          <p className="file-diff-notice" role="alert">
            {displayError}
          </p>
        )}
        {displayError && entry.preview === 'available' && (
          <Button
            onClick={() => {
              diffCache?.delete(cacheKey);
              setRevision((value) => value + 1);
            }}
          >
            重新读取历史内容
          </Button>
        )}
        {!displayError && (entry.preview === 'unavailable' || body) && (
          <p className="file-diff-notice">历史记录未保存可读差异，不会从当前文件内容重建。</p>
        )}
      </div>
    );
  }
  if (disclosure && entry.preview === 'available' && !body && !displayError) return null;
  return (
    <>
      {!inlineEdit && entry.path && entry.openable && (
        <Button
          className="file-link"
          disabled={opening}
          readOnly={fileOpenBlocked}
          onClick={() => void open()}
        >
          打开当前文件：{entry.path}
        </Button>
      )}
      {displayError && <p role="alert">{displayError}</p>}
      {displayError && entry.preview === 'available' && (
        <Button
          onClick={() => {
            diffCache?.delete(cacheKey);
            setRevision((value) => value + 1);
          }}
        >
          重新读取历史内容
        </Button>
      )}
      {body?.unavailableReason === 'snapshot_too_large' ? (
        <p role="status">
          本次历史全文超过 1 MiB，未加载。可阅读有界差异；编辑器打开的是当前文件，不是本次历史版本。
        </p>
      ) : entry.preview === 'unavailable' || (body && body.text === undefined) ? (
        <p>历史记录未保存可读差异，不会从当前文件内容重建。</p>
      ) : body?.text !== undefined ? (
        <>
          {body.truncated && (
            <p role="status">差异预览已截断或省略部分内容；编辑器打开文件的当前内容。</p>
          )}
          {body.snapshot ? (
            <>
              <p>本次交付的历史版本；后续编辑不会改变此内容。</p>
              <ScrollArea
                className="tool-snapshot-scroll"
                fade="y"
                viewportClassName="tool-detail-viewport"
                viewportProps={{ role: 'region', 'aria-label': '交付文件历史内容', tabIndex: 0 }}
              >
                <pre
                  className="tool-file-snapshot"
                  style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                >
                  {body.text}
                </pre>
              </ScrollArea>
              {offset > 0 && <Button onClick={() => setOffset(0)}>回到开头</Button>}
              {body.nextOffset != null && (
                <Button onClick={() => setOffset(body.nextOffset!)}>读取下一段</Button>
              )}
            </>
          ) : (
            <FileDiff
              message={message}
              path={entry.path}
              scope="operation"
              inline={inlineEdit}
              openFile={openFile}
              fileOpenBlocked={fileOpenBlocked}
            />
          )}
        </>
      ) : !disclosure && !displayError ? (
        <Spinner size={16} aria-label={view === 'diff' ? '正在读取本次差异' : '正在读取历史版本'} />
      ) : null}
    </>
  );
}

/** A delivery is readable from its own message, including when the current file is gone. */
export function NativeOutputFile(props: {
  bridge: NativeBridge;
  generation: number;
  entry: NativeFileChange;
  editor: DesktopEditor;
  child?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>查看本次交付的文件</summary>
      {open && <ChangeDetail {...props} view="snapshot" />}
    </details>
  );
}

/** Mounted only by the confirmed tool's expanded disclosure. */
export function NativeOperationDiff({
  scope,
  receipt,
  open,
  readAvailable,
  cache,
  ...props
}: {
  scope?: string;
  receipt?: Message;
  bridge: NativeBridge;
  generation: number;
  entry: NativeFileChange;
  editor: DesktopEditor;
  open: boolean;
  readAvailable?: boolean;
  cache: NativeDisplayCache<NativeFileChangeDetail>;
  child?: boolean;
  openFile?: (path: string) => void;
  fileOpenBlocked?: boolean;
}) {
  // The receipt owns display; changeId is a current observation used only for requests.
  const key = JSON.stringify(
    receipt && scope !== undefined
      ? [
          scope,
          receipt.id,
          receipt.sessionId,
          receipt.seq,
          receipt.runId,
          receipt.originMessage,
          receipt.sourceIds,
          receipt.toolCallId,
          receipt.status,
          receipt.contentFormat,
          receipt.deferredText?.sha256,
          receipt.content,
          props.entry.path,
          props.entry.operation,
          props.entry.preview,
        ]
      : [props.generation, props.entry.changeId],
  );
  return (
    <ChangeDetail
      key={key}
      {...props}
      view="diff"
      disclosure={{ open, readAvailable, cache, key }}
    />
  );
}

/** Original FileChanges presentation; metadata scans and expanded bodies own only GETs. */
export function NativeFileChanges({
  bridge,
  generation,
  selection,
  historyEpoch,
  messages,
  historyComplete,
  editor,
}: {
  bridge: NativeBridge;
  generation: number;
  selection: NativeSelection;
  historyEpoch: number;
  messages: readonly Message[];
  historyComplete: boolean;
  editor: DesktopEditor;
}) {
  const targets = useNativeFileTargets({ bridge, generation, selection, historyEpoch, messages });
  const entries = targets.entries;
  return (
    <>
      {targets.error && <p role="alert">{targets.error}</p>}
      {targets.error && <Button onClick={() => targets.retry()}>重新读取文件操作</Button>}
      <FileChanges
        loading={targets.loading || !historyComplete}
        messages={entries.map((entry) => ({
          id: entry.messageId,
          role: 'tool',
          text: '',
          settled: true,
          changedFile: entry.path,
          changeConfirmed: true,
        }))}
        renderDetail={(message) => {
          const entry = entries.find((entry) => entry.messageId === message.id)!;
          return (
            <ChangeDetail
              key={entry.changeId}
              bridge={bridge}
              generation={generation}
              entry={entry}
              editor={editor}
            />
          );
        }}
      />
    </>
  );
}
