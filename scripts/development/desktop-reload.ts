import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import type { DevelopmentServiceReload } from '../../apps/desktop/electron/development';

export {
  startDesktopRenderer,
  startDevelopmentServiceWatcher,
} from '../../apps/desktop/scripts/development-renderer';

/** Private, per-launch parent control. Windows Electron GUI stdin is not a reliable pipe. */
export async function startDesktopControl() {
  const token = randomBytes(32).toString('hex');
  let socket: Socket | undefined;
  let stopping = false;
  let channel: ReturnType<typeof createDesktopReloadChannel> | undefined;
  let accept: ((peer: Socket) => void) | undefined;
  let rejectStartup: ((error: Error) => void) | undefined;
  const ready = new Promise<Socket>((resolve, reject) => {
    accept = resolve;
    rejectStartup = reject;
  });
  void ready.catch(() => {});
  const candidates = new Set<Socket>();
  const server = createServer((peer) => {
    candidates.add(peer);
    let buffer = '';
    const timeout = setTimeout(() => peer.destroy(), 45000);
    const receive = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > 512) {
        peer.destroy();
        return;
      }
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      let value: unknown;
      try {
        value = JSON.parse(buffer.slice(0, end));
      } catch {
        peer.destroy();
        return;
      }
      if (
        socket ||
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !('kind' in value) ||
        !['desktop.ready', 'desktop.failed'].includes(String(value.kind)) ||
        Object.keys(value).length !== (value.kind === 'desktop.ready' ? 2 : 3) ||
        (value.kind === 'desktop.failed' &&
          (!('code' in value) ||
            typeof value.code !== 'string' ||
            !/^[a-z][a-z0-9_]{0,80}$/.test(value.code))) ||
        !('token' in value) ||
        typeof value.token !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.token) ||
        !timingSafeEqual(Buffer.from(value.token), Buffer.from(token)) ||
        buffer.slice(end + 1)
      ) {
        peer.destroy();
        return;
      }
      clearTimeout(timeout);
      peer.off('data', receive);
      peer.pause();
      socket = peer;
      if (stopping) peer.end();
      if (value.kind === 'desktop.failed')
        rejectStartup!(Error(String(Reflect.get(value, 'code'))));
      else accept!(peer);
    };
    peer.on('data', receive);
    peer.on('error', () => {});
    peer.once('close', () => {
      clearTimeout(timeout);
      candidates.delete(peer);
    });
  });
  server.maxConnections = 4;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('development_control_unavailable');
  return {
    configuration: { port: address.port, token },
    async attach(exited: Promise<number>) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const peer = await Promise.race([
          ready,
          exited.then(() => {
            throw Error('development_desktop_exited');
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error('development_control_unavailable')), 45000);
          }),
        ]);
        let writing = Promise.resolve();
        channel = createDesktopReloadChannel({
          stdin: {
            write(value) {
              writing = new Promise<void>((resolve, reject) =>
                peer.write(value, (error) => (error ? reject(error) : resolve())),
              );
            },
            flush: () => writing,
          },
          stdout: Readable.toWeb(peer),
          exited,
        });
        if (stopping) channel.stop();
        return channel;
      } finally {
        clearTimeout(timer);
      }
    },
    stop() {
      if (stopping) return;
      stopping = true;
      channel?.stop();
      socket?.end();
    },
    async close() {
      rejectStartup!(Error('development_desktop_stopping'));
      for (const peer of candidates) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const serviceWorkspaces = ['apps/service', 'packages/agent', 'packages/ai', 'packages/client'];
export function developmentServiceSourceRoots(root: string): string[] {
  return serviceWorkspaces.map((workspace) => join(root, workspace, 'src'));
}
const sourceFile = /\.(?:[cm]?[jt]sx?|json)$/;

/** External workspace imports do not change the generated entry bytes. */
function developmentSourceSha256(root: string): string {
  const hash = createHash('sha256');
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && sourceFile.test(entry.name)) {
        const bytes = readFileSync(path);
        hash
          .update(relative(root, path).replaceAll('\\', '/'))
          .update('\0')
          .update(String(bytes.byteLength))
          .update('\0')
          .update(bytes);
      }
    }
  }
  for (const directory of developmentServiceSourceRoots(root))
    if (existsSync(directory)) visit(directory);
  return hash.digest('hex');
}

/** Load the actual external dependency graph in a fresh process, without executing import.meta.main. */
async function verifyDevelopmentService(entrypoint: string, root: string): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-install',
      '--eval',
      `await import(${JSON.stringify(pathToFileURL(entrypoint).href)})`,
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: homedir(),
        LANG: 'C.UTF-8',
        ...(process.platform === 'win32' ? { USERPROFILE: homedir() } : {}),
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    },
  );
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 10000);
  let diagnostic = '';
  const read = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      if (diagnostic.length < 16384)
        diagnostic += decoder.decode(chunk, { stream: true }).slice(0, 16384 - diagnostic.length);
    }
  })();
  try {
    const [code] = await Promise.all([child.exited, read]);
    if (code !== 0 || timedOut) {
      const failure = timedOut
        ? 'development_service_load_timeout'
        : 'development_service_load_failed';
      throw Object.assign(Error(diagnostic.trim() || failure), { code: failure });
    }
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.allSettled([child.exited, read]);
  }
}

export async function buildDevelopmentService(
  root: string,
  outdir: string,
): Promise<DevelopmentServiceReload & { readonly sourceSha256: string }> {
  const sourceSha256 = developmentSourceSha256(root);
  const id = randomUUID().replaceAll('-', ''),
    services = join(outdir, 'services'),
    directory = join(services, id);
  privateDirectory(outdir);
  privateDirectory(services);
  privateDirectory(directory);
  const browserConfiguration = join(root, 'apps/service/src/browser-configuration.ts');
  if (existsSync(browserConfiguration)) {
    // The locator is compiled into this exact Service entry. Its sibling guardian
    // must be built from the same current sources, including after a source reload.
    try {
      const assets = await Bun.build({
        entrypoints: [
          join(root, 'packages/agent/src/mcp/stdio-guardian.ts'),
          join(root, 'packages/agent/src/mcp/windows-stdio-guardian.ts'),
        ],
        target: 'bun',
        outdir: directory,
        naming: '[name].js',
      });
      if (!assets.success) throw new AggregateError(assets.logs);
    } catch (error) {
      throw new AggregateError([error], 'development_browser_assets_build_failed');
    }
  }
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [join(root, 'apps/service/src/main.ts')],
      target: 'bun',
      packages: 'bundle',
      external: ['@kite-ai/*'],
      plugins: [
        {
          name: 'development-process-assets',
          setup(build) {
            build.onResolve({ filter: /^@kite-ai\/agent\/mcp$/ }, (args) => {
              if (args.importer !== browserConfiguration) return;
              // Only Browser's locator is bundled. Other MCP users retain source
              // imports; no source locator is permitted to impersonate a JS asset.
              return { path: join(root, 'packages/agent/src/mcp/stdio-port.ts'), external: false };
            });
            // The packaged locator must keep its original module URL next to built assets.
            // Other workspace imports continue using current sources during development.
            build.onResolve({ filter: /^@kite-ai\/agent\/jobs\/shell$/ }, () => ({
              path: pathToFileURL(join(root, 'packages/agent/dist/jobs/shell.js')).href,
              external: true,
            }));
          },
        },
      ],
      outdir: directory,
      naming: 'main.js',
    });
  } catch (error) {
    throw new AggregateError([error], 'development_service_build_failed');
  }
  if (!result.success) throw new AggregateError(result.logs, 'development_service_build_failed');
  await verifyDevelopmentService(join(directory, 'main.js'), root);
  if (developmentSourceSha256(root) !== sourceSha256)
    throw Error('development_service_source_changed');
  return {
    id,
    sourceSha256,
    sha256: createHash('sha256')
      .update(readFileSync(join(directory, 'main.js')))
      .digest('hex'),
  };
}

export function isDevelopmentServiceSource(root: string, file: string): boolean {
  const path = relative(root, file).replaceAll('\\', '/');
  return (
    serviceWorkspaces.some((workspace) => path.startsWith(`${workspace}/src/`)) &&
    sourceFile.test(path)
  );
}

export function isDevelopmentServiceSourceEvent(
  root: string,
  event: string,
  file: string,
): boolean {
  if (isDevelopmentServiceSource(root, file)) return true;
  if (event !== 'addDir' && event !== 'unlinkDir') return false;
  const path = relative(root, file).replaceAll('\\', '/');
  return serviceWorkspaces.some((workspace) => {
    const source = `${workspace}/src`;
    return path === source || path.startsWith(`${source}/`) || source.startsWith(`${path}/`);
  });
}

/** Coalesce saves and serialize builds/reloads; a failed build can be retried by the next save. */
export function createDesktopReloadQueue(input: {
  reload: () => Promise<void>;
  failed: (error: unknown) => void;
  debounceMs?: number;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined,
    running: Promise<void> | undefined,
    pending = false,
    closed = false;
  const drain = () => {
    if (running || closed) return;
    running = (async () => {
      while (pending && !closed) {
        pending = false;
        try {
          await input.reload();
        } catch (error) {
          input.failed(error);
        }
      }
    })().finally(() => {
      running = undefined;
      if (pending && !closed) drain();
    });
  };
  return {
    changed() {
      if (closed) return;
      pending = true;
      clearTimeout(timer);
      timer = setTimeout(drain, input.debounceMs ?? 150);
    },
    async close() {
      closed = true;
      pending = false;
      clearTimeout(timer);
      await running;
    },
  };
}

/** A missing acknowledgement is unknown; do not issue another reload against that Main. */
export function createDesktopReloadChannel(
  child: {
    stdin: { write(value: string): unknown; flush(): unknown };
    stdout: {
      getReader(): { read(): Promise<{ done?: boolean; value?: Uint8Array }>; releaseLock(): void };
    };
    exited: Promise<number>;
  },
  timeoutMs = 45000,
) {
  let pending: { id: string; resolve: () => void; reject: (error: Error) => void } | undefined,
    failure: Error | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    pending?.reject(failure);
    pending = undefined;
  };
  const read = (async () => {
    const reader = child.stdout.getReader(),
      decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!chunk.value) throw Error('development_service_reload_unconfirmed');
        buffer += decoder.decode(chunk.value, { stream: true });
        if (Buffer.byteLength(buffer) > 16384)
          throw Error('development_service_reload_unconfirmed');
        for (;;) {
          const index = buffer.indexOf('\n');
          if (index === -1) break;
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            continue;
          }
          if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            !('kind' in value) ||
            value.kind !== 'service.reloaded' ||
            !('id' in value) ||
            value.id !== pending?.id ||
            !('ok' in value) ||
            typeof value.ok !== 'boolean' ||
            Object.keys(value).length !== 3
          )
            continue;
          if (!value.ok) fail(Error('development_service_reload_failed'));
          else {
            pending?.resolve();
            pending = undefined;
          }
        }
      }
    } catch {
      fail(Error('development_service_reload_unconfirmed'));
    } finally {
      reader.releaseLock();
    }
  })();
  void child.exited.then(() => fail(Error('development_desktop_exited')));
  return {
    read,
    stop: () => fail(Error('development_desktop_stopping')),
    async reload(request: DevelopmentServiceReload) {
      if (failure) throw failure;
      if (pending) throw Error('development_service_reload_busy');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const acknowledged = new Promise<void>((resolve, reject) => {
        pending = { id: request.id, resolve, reject };
        timer = setTimeout(() => fail(Error('development_service_reload_unconfirmed')), timeoutMs);
      });
      void acknowledged.catch(() => {});
      try {
        child.stdin.write(`${JSON.stringify({ kind: 'service.reload', ...request })}\n`);
        await child.stdin.flush();
        await acknowledged;
      } catch (error) {
        if (pending) fail(Error('development_service_reload_unconfirmed'));
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
