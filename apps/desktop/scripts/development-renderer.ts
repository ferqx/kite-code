import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createServer, type FSWatcher, type ViteDevServer } from 'vite';
import { desktopMarkdownDecoderAlias } from './markdown-worker-resolution';

/** Own a fresh instance of Vite's public FSWatcher class, including its first scan. */
export async function startDevelopmentServiceWatcher(input: {
  template: FSWatcher;
  roots: readonly string[];
  changed: (event: string, file: string) => void;
  failed: (error: Error) => void;
  signal?: AbortSignal;
}) {
  const within = (parent: string, child: string) => {
    const path = relative(parent, child);
    return (
      !isAbsolute(path) &&
      path !== '..' &&
      !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    );
  };
  const directories: string[] = [];
  for (const source of input.roots) {
    let path = resolve(source);
    while (!existsSync(path)) {
      const parent = dirname(path);
      if (parent === path) throw Error('development_service_watch_root_unavailable');
      path = parent;
    }
    if (!lstatSync(path).isDirectory()) throw Error('development_service_watch_root_unavailable');
    directories.push(realpathSync(path));
  }
  const roots = [...new Set(directories)]
    .sort((a, b) => a.length - b.length)
    .filter(
      (directory, index, all) => !all.slice(0, index).some((parent) => within(parent, directory)),
    );
  const Constructor = input.template.constructor;
  if (
    typeof Constructor !== 'function' ||
    !['add', 'close', 'getWatched', 'on', 'once'].every(
      (name) => typeof Reflect.get(Constructor.prototype ?? {}, name) === 'function',
    )
  )
    throw Error('development_service_watcher_unavailable');
  const ignored = input.template.options.ignored;
  const watcher = new (Constructor as new (options: FSWatcher['options']) => FSWatcher)({
    ...input.template.options,
    followSymlinks: false,
    ignoreInitial: true,
    ignored: [
      ...(ignored === undefined ? [] : Array.isArray(ignored) ? ignored : [ignored]),
      (file: string) =>
        roots.some(
          (root) =>
            within(root, file) &&
            relative(root, file)
              .split(/[\\/]/)
              .some((part) => part === '.cache' || part === 'node_modules'),
        ),
    ],
  });
  if (
    watcher === input.template ||
    !['add', 'close', 'getWatched', 'on', 'once'].every(
      (name) => typeof Reflect.get(watcher, name) === 'function',
    )
  ) {
    if (watcher !== input.template && typeof watcher.close === 'function') await watcher.close();
    throw Error('development_service_watcher_unavailable');
  }
  let closed = false;
  let closing: Promise<void> | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // add() can throw before the first await; closing must still reject admission
  // without leaving that startup promise unobserved.
  void ready.catch(() => {});
  const close = () => {
    if (closing) return closing;
    closed = true;
    input.signal?.removeEventListener('abort', abort);
    rejectReady(Error('development_service_watcher_closed'));
    closing = Promise.resolve().then(() => watcher.close());
    return closing;
  };
  const abort = () => {
    void close().catch(input.failed);
  };
  watcher.once('ready', resolveReady);
  watcher.on('all', (event, file) => {
    if (!closed) input.changed(event, file);
  });
  watcher.on('error', (error) => {
    if (closed) return;
    rejectReady(error);
    try {
      input.failed(error);
    } finally {
      void close().catch(input.failed);
    }
  });
  watcher.once('close', () => {
    if (!closed) {
      const error = Error('development_service_watcher_closed');
      rejectReady(error);
      try {
        input.failed(error);
      } finally {
        void close().catch(input.failed);
      }
    }
  });
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (input.signal?.aborted) abort();
    else watcher.add(roots);
    await ready;
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}

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
