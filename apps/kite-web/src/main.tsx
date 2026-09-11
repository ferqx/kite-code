import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { KiteRoutes } from '@/routing';
import '@/styles/globals.css';
import '@kite-ai/kite-client-ui/style.css';
import { createWebRestTransport } from '@/transport/client';
import { createPageBoundFetch } from '@/transport/page-identity';

const root = document.getElementById('root');
if (!root) throw new Error('Kite Web root is missing.');
const identity = document.querySelector<HTMLMetaElement>('meta[name="kite-web-identity"]')?.content;

function KiteWebRoot() {
  const [changed, setChanged] = useState(false);
  const transport = useMemo(
    () => createWebRestTransport({ fetch: createPageBoundFetch(identity, () => setChanged(true)) }),
    [],
  );
  useEffect(() => {
    const pagehide = (event: PageTransitionEvent) => {
      if (!event.persisted) void transport.disconnect();
    };
    window.addEventListener('pagehide', pagehide);
    return () => window.removeEventListener('pagehide', pagehide);
  }, [transport]);
  return (
    <>
      {changed && (
        <div
          role="alert"
          className="border-b border-amber-500 bg-amber-50 p-3 text-sm text-amber-950"
        >
          服务已更换或页面版本不匹配，当前内容可能已过期。请重新加载页面；地址无法访问时，运行 kite
          web 获取新地址。
          <button type="button" className="ml-3 underline" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      )}
      <BrowserRouter>
        <KiteRoutes transport={transport} />
      </BrowserRouter>
    </>
  );
}

createRoot(root).render(
  <StrictMode>
    <KiteWebRoot />
  </StrictMode>,
);
