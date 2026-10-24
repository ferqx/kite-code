import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { join } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';
import { desktopMarkdownDecoderAlias } from './markdown-worker-resolution';

export async function startDesktopRenderer(root: string) {
  const cspNonce = randomUUID().replaceAll('-', '');
  const http = createHttpServer();
  let server: ViteDevServer | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await server?.close();
      } finally {
        if (http.listening)
          await new Promise<void>((resolve, reject) => {
            http.close((error) => (error ? reject(error) : resolve()));
            http.closeAllConnections();
          });
      }
    })());
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => {
        http.off('error', reject);
        resolve();
      });
    });
    const address = http.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1')
      throw Error('development_renderer_unavailable');
    // Middleware mode leaves signals and process exit to the owning development host.
    server = await createServer({
      root: join(root, 'apps/desktop'),
      configFile: false,
      envFile: false,
      mode: 'development',
      define: { __KITE_DESKTOP_TEST_DIAGNOSTICS__: 'false' },
      plugins: [react(), tailwindcss()],
      resolve: { alias: [desktopMarkdownDecoderAlias()] },
      clearScreen: false,
      logLevel: 'warn',
      html: { cspNonce },
      cacheDir: join(root, 'apps/desktop/node_modules/.vite-desktop-dev'),
      server: {
        middlewareMode: true,
        hmr: { server: http, clientPort: address.port },
        host: '127.0.0.1',
        port: address.port,
        strictPort: false,
        fs: {
          allow: [join(root, 'apps/desktop'), join(root, 'packages'), join(root, 'node_modules')],
          deny: [
            '.env',
            '.env.*',
            '*.{crt,pem}',
            ...['.git', '.kite-code', '.cache', '.aws', '.codex', '.agents'].flatMap((name) => [
              `${root.replaceAll('\\', '/')}/${name}`,
              `${root.replaceAll('\\', '/')}/${name}/**`,
            ]),
          ],
        },
      },
    });
    http.on('request', server.middlewares);
    return {
      server,
      close,
      configuration: { rendererUrl: `http://127.0.0.1:${address.port}/`, cspNonce },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
