import type { Message } from '@kite-ai/client';
import { Button, type Message as DesktopMessage, FileChanges, FileDiff } from '@kite-ai/ui/desktop';
import { useEffect, useState } from 'react';
import type {
  DesktopEditor,
  NativeFileChange,
  NativeFileChangeDetail,
} from './file-changes-bridge';
import type { NativeBridge, NativeSelection } from './native-bridge';
import { useNativeFileTargets } from './native-file-targets';

function ChangeDetail({
  bridge,
  generation,
  entry,
  editor,
}: {
  bridge: NativeBridge;
  generation: number;
  entry: NativeFileChange;
  editor: DesktopEditor;
}) {
  const [body, setBody] = useState<NativeFileChangeDetail>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    if (entry.preview === 'unavailable') return;
    const readId = `${revision}-${crypto.randomUUID()}`;
    let active = true;
    setError('');
    setBody(undefined);
    void bridge
      .request({ method: 'fileChanges.detail', generation, changeId: entry.changeId, readId })
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
        setBody(value);
      })
      .catch(() => {
        if (active) setError('文件操作的原记录目前不可读，请重新读取。');
      });
    return () => {
      active = false;
      void bridge.request({ method: 'fileChanges.close', generation, readId }).catch(() => {});
    };
  }, [bridge, generation, entry.changeId, entry.preview, revision]);
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
  return (
    <>
      {entry.path && entry.openable && (
        <Button className="file-link" disabled={opening} onClick={() => void open()}>
          {entry.path}
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
      {error && entry.preview === 'available' && (
        <Button onClick={() => setRevision((value) => value + 1)}>重新读取差异</Button>
      )}
      {entry.preview === 'unavailable' || (body && body.text === undefined) ? (
        <p>历史记录未保存可读差异，不会从当前文件内容重建。</p>
      ) : body?.text !== undefined ? (
        <>
          {body.truncated && <p role="status">差异预览已截断；编辑器打开文件的当前内容。</p>}
          <FileDiff message={message} />
        </>
      ) : (
        !error && <p role="status">正在读取原文件差异。</p>
      )}
    </>
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
