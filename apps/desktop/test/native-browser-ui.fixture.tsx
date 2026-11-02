import { SessionPage } from '@kite-ai/ui/desktop';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeBrowserPane } from '../src/native-browser-pane';
import {
  closeNativeBrowserTab,
  nativeBrowserDisplayHint,
  restoreNativeBrowserDraft,
} from '../src/native-browser-session';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

let mountedReaders = 0;
let closedReaders = 0;
function Changes() {
  useEffect(() => {
    mountedReaders++;
    return () => {
      closedReaders++;
    };
  }, []);
  return <section aria-label="变更内容">暂无文件变更</section>;
}
declare global {
  interface Window {
    browserTabsFixture: {
      setScope(scope: string): void;
      draft(): string;
      readers(): { mounted: number; closed: number };
    };
  }
}
function Fixture() {
  const [scope, setScope] = useState('session-a');
  // This isolated UI has no Core Caller. Each displayed Session owns a distinct
  // Root-local manual inventory; changing selection only withdraws its display.
  const draft = scope === 'session-a' ? 'a'.repeat(32) : 'b'.repeat(32);
  window.browserTabsFixture = {
    setScope,
    draft: () => draft,
    readers: () => ({ mounted: mountedReaders, closed: closedReaders }),
  };
  return (
    <SessionPage
      workspaces={[]}
      selected={scope}
      readingKey={scope}
      sessionLabel="会话标题"
      messages={[]}
      loading={false}
      connected
      connectionLabel=""
      actions={{}}
      renderBrowser={(props) => (
        <NativeBrowserPane
          {...props}
          draft={draft}
          initialHint={nativeBrowserDisplayHint(props.id, undefined, draft)}
        />
      )}
      closeBrowser={(id) => closeNativeBrowserTab(id, draft)}
      restoreBrowser={() => restoreNativeBrowserDraft(draft)}
      browserRestoreKey={draft}
      fileChangesContent={<Changes />}
    />
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
