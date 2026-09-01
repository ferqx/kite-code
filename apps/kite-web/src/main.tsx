import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { KiteRoutes } from '@/routing';
import '@/styles/globals.css';
import { createWebRestTransport } from '@/transport/client';

const root = document.getElementById('root');
if (!root) throw new Error('Kite Web root is missing.');
const transport = createWebRestTransport();

window.addEventListener('pagehide', (event) => {
  if (!event.persisted) void transport.disconnect();
});

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <KiteRoutes transport={transport} />
    </BrowserRouter>
  </StrictMode>,
);
