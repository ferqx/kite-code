import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';

export async function startDesktopRenderer(root: string) {
  const cspNonce = randomUUID().replaceAll('-', '');
  const server = await createServer({
    root: join(root, 'apps/desktop'),
    configFile: false,
    envFile: false,
    mode: 'development',
    define: { __KITE_DESKTOP_TEST_DIAGNOSTICS__: 'false' },
    plugins: [react(), tailwindcss()],
    clearScreen: false,
    logLevel: 'warn',
    html: { cspNonce },
    cacheDir: join(root, 'apps/desktop/node_modules/.vite-desktop-dev'),
    server: {
      host: '127.0.0.1',
      port: 0,
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
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1')
      throw Error('development_renderer_unavailable');
    return {
      server,
      configuration: { rendererUrl: `http://127.0.0.1:${address.port}/`, cspNonce },
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}
