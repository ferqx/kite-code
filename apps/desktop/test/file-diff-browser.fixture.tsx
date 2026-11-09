// Isolated synthetic bridge only; never imported by ordinary Native entrypoints.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionPage } from '../../../packages/ui/src/desktop/SessionPage';
import { ToolActivity } from '../../../packages/ui/src/desktop/ToolActivity';
import type { NativeBridge, NativeResult, NativeSelection } from '../src/native-bridge';
import { NativeOperationDiff, NativeOutputFile } from '../src/native-file-changes';
import { NativeWorkspaceChanges } from '../src/native-workspace-changes';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

const events: string[] = [];
const pending: { method: string; release: (fail?: boolean) => void }[] = [];
const patch = [
  '@@ -1 +1,1002 @@',
  '-old operation',
  '+new operation',
  `+${'x'.repeat(10000)}`,
  ...Array.from({ length: 1000 }, (_, i) => `+synthetic line ${i}`),
].join('\n');
const workspacePatch = [
  '@@ -1,31 +1,31 @@',
  ...Array.from({ length: 15 }, (_, i) => ` const retained${i} = ${i};`),
  '-const value = "before";',
  '+const value = "CURRENT WORKSPACE ONLY";',
  ...Array.from({ length: 15 }, (_, i) => ` const tail${i} = ${i};`),
].join('\n');
const bridge: NativeBridge = {
  watch: () => () => {},
  async request(request): Promise<NativeResult> {
    events.push(request.method + ('view' in request ? `:${request.view}` : ''));
    if (
      request.method === 'fileChanges.detail' ||
      request.method === 'workspaceChanges.list' ||
      request.method === 'workspaceChanges.detail'
    ) {
      await new Promise<void>((resolve, reject) =>
        pending.push({
          method: request.method,
          release: (fail) => (fail ? reject(Error('synthetic failure')) : resolve()),
        }),
      );
      if (request.method === 'fileChanges.detail')
        return {
          kind: 'fileChanges.detail',
          changeId: request.changeId,
          text: request.view === 'snapshot' ? 'ORIGINAL HISTORICAL SNAPSHOT' : patch,
          snapshot: request.view === 'snapshot',
        };
      if (request.method === 'workspaceChanges.detail')
        return {
          kind: 'workspaceChanges.detail',
          changeId: request.changeId,
          readId: request.readId,
          text: request.changeId.startsWith('new-')
            ? '@@ -0,0 +1 @@\n+NEW FILE CONTENT'
            : workspacePatch,
          truncated: false,
        };
      return {
        kind: 'workspaceChanges.page',
        readId: request.readId,
        scope: {
          generation: 1,
          viewSelection: request.viewSelection,
          storeId: 'store',
          sessionId: `s${request.viewSelection}`,
          workspaceId: 'workspace',
        },
        repository: true,
        truncated: false,
        entries: [
          {
            changeId: `git-${request.viewSelection}-${request.readId}`,
            path: 'src/example.ts',
            indexStatus: 'M',
            worktreeStatus: 'M',
            untracked: false,
          },
          {
            changeId: `new-${request.viewSelection}-${request.readId}`,
            path: 'new.txt',
            indexStatus: '?',
            worktreeStatus: '?',
            untracked: true,
          },
        ],
      };
    }
    return null;
  },
};
const entry = {
  changeId: 'operation',
  messageId: 'message',
  path: 'src/example.ts',
  preview: 'available' as const,
  openable: false,
  operation: 'write' as const,
  snapshot: true,
  diff: true,
};
function App() {
  const [expanded, setExpanded] = useState(false),
    [selection, setSelection] = useState(1),
    [draft, setDraft] = useState('Unsent original draft');
  Object.assign(window, {
    fileDiffFixture: {
      release(method: string, fail = false) {
        const index = pending.findIndex((item) => item.method === method);
        if (index < 0) throw Error(`No pending ${method}`);
        pending.splice(index, 1)[0]!.release(fail);
      },
      switchSession() {
        setSelection((v) => v + 1);
        setExpanded(false);
      },
      snapshot() {
        return { events: [...events], pending: pending.map((item) => item.method), selection };
      },
    },
  });
  return (
    <div className="kite-client dark" data-theme="dark" style={{ height: '100vh' }}>
      <SessionPage
        workspaces={[]}
        readingKey={`fixture-${selection}`}
        tabsScopeKey={`fixture-${selection}`}
        sessionLabel="Native file diff · isolated components"
        loading={false}
        connected
        connectionLabel=""
        actions={{}}
        messages={[
          {
            id: 'operation-fixture',
            role: 'assistant',
            text: 'Original conversation',
            settled: true,
          },
        ]}
        renderMessage={() => (
          <div data-operation-fixture>
            <ToolActivity
              messages={[
                {
                  id: 'message',
                  role: 'tool',
                  toolName: 'write_file',
                  text: '',
                  changedFile: 'src/example.ts',
                  changeConfirmed: true,
                  status: 'completed',
                  settled: true,
                },
              ]}
              expanded={expanded}
              onToggle={setExpanded}
              renderChildren={() => null}
              renderFileChange={() => (
                <NativeOperationDiff
                  key={selection}
                  bridge={bridge}
                  generation={1}
                  entry={entry}
                  editor="vscode"
                />
              )}
            />
            <NativeOutputFile
              key={selection}
              bridge={bridge}
              generation={1}
              entry={entry}
              editor="vscode"
            />
          </div>
        )}
        composer={{ draft, onChange: setDraft, active: false, stopping: false, disabled: false }}
        renderBrowser={({ tools }) => <>{tools}</>}
        fileChangesContent={
          <NativeWorkspaceChanges
            bridge={bridge}
            generation={1}
            selection={
              {
                viewSelection: selection,
                viewGeneration: selection,
                storeId: 'store',
                session: { id: `s${selection}`, workspaceId: 'workspace' },
              } as NativeSelection
            }
          />
        }
      />
    </div>
  );
}
declare global {
  interface Window {
    fileDiffFixture: {
      release(method: string, fail?: boolean): void;
      switchSession(): void;
      snapshot(): { events: string[]; pending: string[]; selection: number };
    };
  }
}
createRoot(document.getElementById('root')!).render(<App />);
