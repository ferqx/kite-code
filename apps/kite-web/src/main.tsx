import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app/app';
import '@/styles/globals.css';

const root = document.getElementById('root');
if (!root) throw new Error('Kite Web root is missing.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
