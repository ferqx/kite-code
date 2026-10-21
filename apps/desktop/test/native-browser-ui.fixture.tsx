import { SessionPage } from '@kite-ai/ui/desktop';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { closeNativeBrowserTab, renderNativeBrowser } from '../src/native-browser-pane';
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
      readers(): { mounted: number; closed: number };
    };
  }
}
function Fixture() {
  const [scope, setScope] = useState('session-a');
  window.browserTabsFixture = {
    setScope,
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
      renderBrowser={renderNativeBrowser}
      closeBrowser={closeNativeBrowserTab}
      fileChangesContent={<Changes />}
    />
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
