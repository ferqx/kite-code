import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiDocs } from '@/api-docs/api-docs';
import { isApiDocsPath } from '@/api-docs/routing';
import { App } from '@/app/app';
import '@/styles/globals.css';

const root = document.getElementById('root');
if (!root) throw new Error('Kite Web root is missing.');

createRoot(root).render(
  <StrictMode>{isApiDocsPath(window.location.pathname) ? <ApiDocs /> : <App />}</StrictMode>,
);
