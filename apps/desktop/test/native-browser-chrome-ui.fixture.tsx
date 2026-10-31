import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  SessionPage,
} from '@kite-ai/ui/desktop';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { NativeBrowserRestoreScope } from '../src/native-browser-bridge';
import type { NativeBrowserChromeRootBridge } from '../src/native-browser-chrome-bridge';
import { NativeBrowserChromeRenderer } from '../src/native-browser-chrome-renderer';
import { useNativeBrowserChromeRoot } from '../src/native-browser-chrome-root';
import { NativeBrowserPane } from '../src/native-browser-pane';
import { closeNativeBrowserTab } from '../src/native-browser-session';
import { installNativeInputModality } from '../src/native-input-modality';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

const scope: NativeBrowserRestoreScope = {
  storeId: 'chrome-fixture-store',
  sessionId: 'chrome-fixture-session',
  generation: 1,
  viewSelection: 1,
};
declare global {
  interface Window {
    browserChromeFixture?: {
      setCovered(value: boolean): void;
      read(): {
        scope: NativeBrowserRestoreScope;
        timeOrigin: number;
        width: number;
        height: number;
        devicePixelRatio: number;
        visualViewport: {
          width: number;
          height: number;
          scale: number;
          offsetLeft: number;
          offsetTop: number;
        } | null;
        hosted: boolean;
        bridge: { publish: boolean; state: boolean; action: boolean };
        tabs: string[];
      };
    };
  }
}
function Fixture() {
  const [covered, setCovered] = useState(false);
  const chrome = useNativeBrowserChromeRoot(scope, { interactive: true, covered });
  const bridge = window.kiteNative as typeof window.kiteNative &
    Partial<NativeBrowserChromeRootBridge>;
  window.browserChromeFixture = {
    setCovered,
    read: () => ({
      scope,
      timeOrigin: performance.timeOrigin,
      width: innerWidth,
      height: innerHeight,
      devicePixelRatio,
      visualViewport: window.visualViewport
        ? {
            width: window.visualViewport.width,
            height: window.visualViewport.height,
            scale: window.visualViewport.scale,
            offsetLeft: window.visualViewport.offsetLeft,
            offsetTop: window.visualViewport.offsetTop,
          }
        : null,
      hosted: chrome.tabsHosted,
      bridge: {
        publish: typeof bridge?.publishBrowserChrome === 'function',
        state: typeof bridge?.watchBrowserChromeState === 'function',
        action: typeof bridge?.watchBrowserChromeAction === 'function',
      },
      tabs: [...document.querySelectorAll('#session-tabs [role="tab"]')].map(
        (node) => node.textContent ?? '',
      ),
    }),
  };
  return (
    <>
      <SessionPage
        workspaces={[]}
        selected={scope.sessionId}
        readingKey={JSON.stringify(scope)}
        tabsScopeKey={JSON.stringify([scope.storeId, scope.sessionId])}
        sessionLabel="原生浏览器布局隔离验收"
        messages={[
          {
            id: 'fixture-user',
            role: 'user',
            text: '保留右侧网页、表单与阅读位置。',
            settled: true,
          },
          {
            id: 'fixture-assistant',
            role: 'assistant',
            text: '这是隔离布局夹具。窗口变化期间，这段正文应保持在聊天区域内。\n\n表单、页面身份与滚动位置由独立观测记录；真实画面需另行录制全过程。',
            settled: true,
            finalReply: true,
          },
        ]}
        loading={false}
        connected
        connectionLabel=""
        actions={{}}
        covered={covered}
        onTabsChromePresentation={chrome.tabs}
        tabsChromeHosted={chrome.tabsHosted}
        renderBrowser={(props) => (
          <NativeBrowserPane
            {...props}
            scope={scope}
            chromeHosted={chrome.hosted(props.id)}
            onChromePresentation={chrome.toolbar(props.id)}
          />
        )}
        closeBrowser={closeNativeBrowserTab}
        fileChangesContent={<section aria-label="变更内容">隔离的非浏览器标签内容</section>}
      />
      <Dialog open={covered} onOpenChange={setCovered}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>隔离覆盖检查</DialogTitle>
            <DialogDescription>此覆盖应恢复完整 Root，关闭后保留原网页。</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
}
document.documentElement.dataset.nativeWindow = 'true';
document.documentElement.dataset.platform = /Macintosh|Mac OS X/i.test(navigator.userAgent)
  ? 'macos'
  : 'windows';
document.documentElement.dataset.theme = 'dark';
document.documentElement.dataset.windowMaterial = 'none';
installNativeInputModality(document);
if (window.kiteBrowserChrome) document.documentElement.dataset.browserChrome = 'true';
createRoot(document.getElementById('root')!).render(
  window.kiteBrowserChrome ? <NativeBrowserChromeRenderer /> : <Fixture />,
);
