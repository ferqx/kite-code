// Test-only synthetic Native bridge, never imported by a production entrypoint.
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionPage } from '../../../packages/ui/src/desktop/SessionPage';
import { ToolActivity } from '../../../packages/ui/src/desktop/ToolActivity';
import type { NativeFileChangeDetail } from '../src/file-changes-bridge';
import type { NativeBridge, NativeResult } from '../src/native-bridge';
import { NativeDisplayCache } from '../src/native-display-cache';
import { NativeOperationDiff } from '../src/native-file-changes';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

const patch = [
  'Line diff (bounded alignment; unchanged gaps omitted)',
  '137   };',
  '138 -const renderWait = (message: Message, open: boolean) =>',
  "138 +const renderWait = (message: Message, open: boolean, status: 'running' | 'completed' = 'completed') =>",
  '139   new JSDOM(',
  '... unchanged lines omitted ...',
  '151   }}',
  "152 -  turnActivity={{ turnId: 'run', status: 'running' }}",
  "152 +  turnActivity={{ turnId: 'run', status }}",
  '153   saveReading={() => {}}',
  '... unchanged lines omitted ...',
  '157',
  '158 +for (const [status, label] of [',
  "159 +  ['running', '等待 Agent 事件'],",
  `160 +${'longContent'.repeat(200)}`,
  ...Array.from({ length: 100 }, (_, i) => `${161 + i} +synthetic line ${i}`),
].join('\n');
const events: string[] = [];
const pending: { release: (fail?: boolean) => void }[] = [];
const bridge: NativeBridge = {
  watch: () => () => {},
  async request(request): Promise<NativeResult> {
    events.push(request.method + ('view' in request ? `:${request.view}` : ''));
    if (request.method === 'fileChanges.detail') {
      await new Promise<void>((resolve, reject) =>
        pending.push({
          release: (fail) => (fail ? reject(Error('synthetic failure')) : resolve()),
        }),
      );
      return {
        kind: 'fileChanges.detail',
        changeId: request.changeId,
        text: request.changeId.startsWith('short-edit')
          ? patch.split('\n').slice(0, 14).join('\n')
          : patch,
        snapshot: false,
      };
    }
    return null;
  },
};
type Case =
  | 'running-edit'
  | 'running-write'
  | 'completed-edit'
  | 'completed-write'
  | 'failed-edit'
  | 'failed-write'
  | 'short-edit'
  | 'unavailable-edit';
function App() {
  const cache = useRef(new NativeDisplayCache<NativeFileChangeDetail>());
  const copied = useRef('');
  const [current, setCurrent] = useState<Case>('running-edit');
  const [expanded, setExpanded] = useState(false);
  const [revision, setRevision] = useState(0);
  const status = current.startsWith('running')
    ? 'running'
    : current.startsWith('failed')
      ? 'failed'
      : 'completed';
  const tool = current.endsWith('write') ? 'write_file' : 'edit_file';
  Object.assign(window, {
    fileUiFixture: {
      select(next: Case) {
        setCurrent(next);
        setExpanded(false);
        setRevision((v) => v + 1);
      },
      release(fail = false) {
        const p = pending.shift();
        if (!p) throw Error('no pending request');
        p.release(fail);
      },
      snapshot() {
        return { current, events: [...events], pending: pending.length, copied: copied.current };
      },
    },
  });
  const entry = {
    changeId: `${current}-${revision}`,
    messageId: 'message',
    path: 'src/desktop-reasoning-turns.test.tsx',
    preview: current === 'unavailable-edit' ? ('unavailable' as const) : ('available' as const),
    openable: false,
    operation: tool === 'write_file' ? ('write' as const) : ('edit' as const),
    snapshot: true,
    diff: true,
    diffCounts: { added: 103, removed: 2 },
  };
  return (
    <div className="kite-client dark" data-theme="dark" style={{ height: '100vh' }}>
      <SessionPage
        workspaces={[]}
        readingKey="fixture"
        tabsScopeKey="fixture"
        sessionLabel="Isolated Electron · synthetic bridge"
        loading={false}
        connected
        connectionLabel=""
        actions={{}}
        writeClipboardText={async (text) => {
          copied.current = text;
        }}
        messages={[{ id: 'fixture', role: 'assistant', text: '', settled: true }]}
        renderMessage={() => (
          <div data-file-ui-fixture>
            <ToolActivity
              messages={[
                {
                  id: 'message',
                  role: 'tool',
                  toolName: tool,
                  text: status === 'failed' ? 'synthetic operation failed' : '',
                  changedFile: entry.path,
                  changeConfirmed: status === 'completed',
                  fileDiffCounts: entry.diffCounts,
                  status,
                  settled: status !== 'running',
                },
              ]}
              expanded={expanded}
              onToggle={setExpanded}
              openFile={(path) => events.push(`editor:${path}`)}
              renderChildren={() => null}
              renderFileChange={(_message, open, openFile) => (
                <NativeOperationDiff
                  key={entry.changeId}
                  bridge={bridge}
                  generation={1}
                  entry={entry}
                  editor="vscode"
                  open={open}
                  cache={cache.current}
                  openFile={openFile}
                />
              )}
            />
          </div>
        )}
        composer={{
          draft: '',
          onChange: () => {},
          active: false,
          stopping: false,
          disabled: false,
        }}
        renderBrowser={({ tools }) => <>{tools}</>}
      />
    </div>
  );
}
declare global {
  interface Window {
    fileUiFixture: {
      select(next: Case): void;
      release(fail?: boolean): void;
      snapshot(): { current: Case; events: string[]; pending: number; copied: string };
    };
  }
}
createRoot(document.getElementById('root')!).render(<App />);
