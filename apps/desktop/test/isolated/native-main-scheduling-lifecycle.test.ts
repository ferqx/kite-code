import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentClient } from '@kite-ai/client';
import type { DevelopmentServiceReload } from '../../electron/development';
import type { ScheduledTaskClock, ScheduledTaskRunner } from '../../electron/scheduled-task-runner';
import { createScheduledTaskData } from '../../electron/scheduled-tasks';
import type { NativeCreation } from '../../src/native-bridge';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Barrier = 'launch' | 'profile' | 'creation';
type Service = {
  id: number;
  client: AgentClient;
  closed: boolean;
  bootstrap: { storeId: string };
  exited: Promise<number>;
  close(): Promise<void>;
};

/** Run the original Main module with finite host ports, not a copied lifecycle implementation.
 * SQLite scheduling and ScheduledTaskRunner are real. Electron, paired process admission and
 * the renderer are controlled ports; this does not establish Electron or OS cleanup qualification.
 */
async function mainFixture(barrier: Barrier) {
  const root = mkdtempSync(join(tmpdir(), 'kite-main-scheduling-'));
  const mainPath = fileURLToPath(new URL('../../electron/main.ts', import.meta.url));
  const runnerPath = fileURLToPath(
    new URL('../../electron/scheduled-task-runner.ts', import.meta.url),
  );
  const key = `__kiteMainLifecycle_${crypto.randomUUID().replaceAll('-', '')}`;
  const entered = deferred(),
    release = deferred(),
    registered = deferred(),
    exited = deferred<number>();
  const services: Service[] = [],
    runners: ScheduledTaskRunner[] = [];
  const posts: { service: number; kind: 'create' | 'start'; afterClose: boolean }[] = [];
  const resources: { service: number; closed: boolean; close(): void }[] = [];
  const trace: string[] = [],
    errors: unknown[] = [];
  const clocks = new Map<
    AgentClient,
    { clock: ScheduledTaskClock; timers: Map<unknown, () => void> }
  >();
  let open!: () => Promise<unknown>, reload!: (request: DevelopmentServiceReload) => Promise<void>;
  let profileCalls = 0;
  const connected = deferred<Socket>();
  const sockets = new Set<Socket>();
  const control = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', (error) => errors.push(error));
    socket.resume();
    connected.resolve(socket);
  });
  await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve));
  const address = control.address();
  if (!address || typeof address === 'string') throw Error('fixture_control_unavailable');
  const app = Object.assign(new EventEmitter(), {
    setName: () => {},
    getAppPath: () => root,
    getVersion: () => 'fixture',
    setAboutPanelOptions: () => {},
    whenReady: async () => {},
    exit(code: number) {
      app.emit('will-quit');
      exited.resolve(code);
    },
  });
  class BrowserWindow extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: 'http://127.0.0.1:43219/' },
      isDestroyed: () => false,
      send: () => {},
      setWindowOpenHandler: () => {},
      setIgnoreMenuShortcuts: () => {},
      session: {
        setPermissionRequestHandler: () => {},
        setPermissionCheckHandler: () => {},
        webRequest: { onHeadersReceived: () => {} },
      },
    });
    isDestroyed() {
      return false;
    }
    show() {}
    hide() {}
    focus() {}
    removeMenu() {}
    setMenu() {}
    setMenuBarVisibility() {}
    setBackgroundColor() {}
    setTitleBarOverlay() {}
    async loadURL() {}
  }
  const fixture = {
    errors,
    electron: {
      app,
      BrowserWindow,
      clipboard: { writeText: () => {} },
      dialog: { showErrorBox: (...args: unknown[]) => errors.push(args) },
      ipcMain: {},
      Menu: { buildFromTemplate: () => ({}) },
      nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }),
    },
    selectProfile: () => ({ profilePath: join(root, 'profile') }),
    parseNativeAssets: (value: unknown) => value,
    verifyNativeAsset: () => {},
    unused: () => {
      throw Error('unexpected_fixture_port');
    },
    canonicalProtectedPath: (path: string) => path,
    registerNativeIpc: (options: { caller: typeof open }) => {
      open = options.caller;
      registered.resolve();
    },
    register: () => {},
    parseDesktopDevelopment: (value: unknown) => value,
    desktopContentSecurityPolicy: () => "default-src 'none'",
    serveDevelopmentReload: (options: { reload: typeof reload }) => {
      reload = options.reload;
      return () => {};
    },
    async acquireDesktopProfileAccess() {
      if (++profileCalls === 1 && barrier === 'profile') {
        entered.resolve();
        await release.promise;
      }
      return {
        close() {
          trace.push('profile:close');
        },
      };
    },
    async launchPairedService() {
      const id = services.length + 1;
      const service: Service = {
        id,
        closed: false,
        bootstrap: { storeId: 'store' },
        exited: Promise.resolve(0),
        client: {
          serverInfo: { storeId: 'store' },
          async createSession(input: NativeCreation['input']) {
            posts.push({ service: id, kind: 'create', afterClose: service.closed });
            if (id === 1 && barrier === 'creation') {
              entered.resolve();
              await release.promise;
            }
            return { id: input.sessionId, workspaceId: input.workspaceId, parentSessionId: null };
          },
          async startRun() {
            posts.push({ service: id, kind: 'start', afterClose: service.closed });
            throw Error('fixture_start_not_admitted');
          },
          async getCommand() {
            throw Error('fixture_original_not_found');
          },
        } as unknown as AgentClient,
        async close() {
          service.closed = true;
          trace.push(`${id}:service:close`);
        },
      };
      services.push(service);
      if (id === 1 && barrier === 'launch') {
        entered.resolve();
        await release.promise;
      }
      return service;
    },
    openPrivateData() {
      const service = services.at(-1)!;
      const db = new Database(':memory:');
      db.exec('PRAGMA user_version=9');
      const data = createScheduledTaskData(() => db as unknown as DatabaseSync);
      const at = Date.UTC(2026, 9, 15, 9);
      data.saveScheduledTask(
        {
          id: 'scheduled',
          name: 'Main lifecycle',
          prompt: 'Finite scheduling fixture',
          storeId: 'store',
          workspaceId: 'workspace',
          modelId: 'fixed',
          enabled: true,
          schedule: { frequency: 'daily', time: '09:00', timeZone: 'UTC' },
        },
        at - 60000,
      );
      const creations = new Map<string, NativeCreation>();
      const resource = {
        service: service.id,
        closed: false,
        close() {
          if (resource.closed) return;
          resource.closed = true;
          trace.push(`${service.id}:database:close`);
          db.close();
        },
      };
      resources.push(resource);
      const timers = new Map<unknown, () => void>();
      const clock: ScheduledTaskClock = {
        now: () => at,
        setTimeout(callback) {
          const handle = {};
          timers.set(handle, callback);
          return handle;
        },
        clearTimeout(handle) {
          timers.delete(handle);
        },
      };
      clocks.set(service.client, { clock, timers });
      return {
        ...data,
        close: resource.close,
        begin(input: NativeCreation['input']) {
          const old = creations.get(input.commandId);
          if (old) return { created: false, value: old };
          const value: NativeCreation = { input: structuredClone(input), phase: 'pending' };
          creations.set(input.commandId, value);
          return { created: true, value };
        },
        finish(id: string, phase: NativeCreation['phase']) {
          const value = creations.get(id)!;
          value.phase = phase;
          trace.push(`${service.id}:creation:${phase}`);
          return value;
        },
      };
    },
    clockFor: (client: AgentClient) => clocks.get(client)!.clock,
    registerRunner: (runner: ScheduledTaskRunner) => runners.push(runner),
    NativeCaller: class {
      private readonly client: AgentClient;
      constructor(client: AgentClient) {
        this.client = client;
      }
      setScheduledTasks() {}
      detach() {}
      async close() {
        trace.push(`${services.find((s) => s.client === this.client)!.id}:caller:close`);
      }
    },
  };
  const global = globalThis as unknown as Record<string, unknown>;
  global[key] = fixture;
  const prefix = `const f = globalThis[${JSON.stringify(key)}];\n`;
  const exports = (names: string[], source = 'f') =>
    prefix + names.map((name) => `export const ${name} = ${source}.${name};`).join('\n');
  const mocks: Record<string, string> = {
    electron: exports(
      ['app', 'BrowserWindow', 'clipboard', 'dialog', 'ipcMain', 'Menu', 'nativeTheme'],
      'f.electron',
    ),
    '@kite-ai/agent/profile': exports(['selectProfile']),
    '@kite-ai/service/paired':
      exports(['launchPairedService']) +
      '\nexport class PairedServiceError extends Error {}\nexport const formatServiceStartupReport = () => null;',
    './native-assets':
      exports(['parseNativeAssets', 'verifyNativeAsset']) +
      '\nexport const resolveNativeCandidate = f.unused;',
    './development': exports([
      'parseDesktopDevelopment',
      'desktopContentSecurityPolicy',
      'serveDevelopmentReload',
    ]),
    './native-caller': exports(['NativeCaller']),
    './private-data': exports(['openPrivateData']),
    './profile-access': exports(['acquireDesktopProfileAccess']),
    './protected-path': exports(['canonicalProtectedPath']),
    './native-ipc':
      exports(['registerNativeIpc']) +
      '\nexport const registerNativeStartupIpc = f.register, registerNativeThemeIpc = f.register, registerNativeWindowIpc = f.register;',
    './native-window-menu':
      prefix +
      'export const nativeWindowMenuShortcut = f.register, nativeWindowMenuTemplate = f.register, registerNativeWindowMenuIpc = f.register;',
    './artifact-access': `${prefix}export const acquireNodeArtifactAccess = f.unused;`,
    './node-process': `${prefix}export const spawnNodePairedChild = f.unused;`,
    './sqlite-engine': `${prefix}export const assertNativeSqliteEngine = f.unused;`,
    './windows-native-candidate':
      prefix +
      'export const acquireWindowsNativeCandidate = f.unused, parseWindowsNativeHandoff = f.unused, retainWindowsNativePairedArtifact = f.unused;',
    './scheduled-task-runner':
      prefix +
      `import { ScheduledTaskRunner as Runner } from ${JSON.stringify(runnerPath)};
      export class ScheduledTaskRunner extends Runner {
        constructor(client, data) { super(client, data, { clock: f.clockFor(client) }); f.registerRunner(this); }
        async stop() { try { await super.stop(); } catch (error) { f.errors.push(String(error)); throw error; } }
      }`,
  };
  try {
    const result = await Bun.build({
      entrypoints: [mainPath],
      target: 'bun',
      format: 'esm',
      outdir: root,
      define: {
        __KITE_DESKTOP_NATIVE_ASSETS__: JSON.stringify({
          kind: 'development',
          serviceEntrypoint: join(root, 'service.js'),
          serviceSha256: 'a'.repeat(64),
          bunExecutable: process.execPath,
          bunSha256: 'b'.repeat(64),
          buildId: 'fixture',
          apiMajor: 1,
          requiredCapabilities: [],
        }),
        __KITE_DESKTOP_PROFILE_ACCESS__: JSON.stringify({
          relativePath: 'profile-access.js',
          sha256: 'c'.repeat(64),
        }),
        __KITE_DESKTOP_WINDOWS_ACCESS__: 'null',
        __KITE_DESKTOP_DEVELOPMENT__: JSON.stringify({
          rendererUrl: 'http://127.0.0.1:43219/',
          cspNonce: 'd'.repeat(32),
          control: { port: address.port, token: 'e'.repeat(64) },
        }),
      },
      plugins: [
        {
          name: 'finite-native-main-host',
          setup(build) {
            build.onResolve({ filter: /.*/ }, (args) => {
              if (resolve(args.importer) === mainPath && Object.hasOwn(mocks, args.path))
                return { path: args.path, namespace: 'native-main-fixture' };
              return undefined;
            });
            build.onLoad({ filter: /.*/, namespace: 'native-main-fixture' }, (args) => ({
              contents: mocks[args.path]!,
              loader: 'js',
            }));
          },
        },
      ],
    });
    if (!result.success) throw new AggregateError(result.logs, 'main_fixture_build_failed');
    await import(pathToFileURL(result.outputs[0]!.path).href);
    await registered.promise;
    await connected.promise;
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => control.close(() => resolve()));
    delete global[key];
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    open,
    reload,
    entered: entered.promise,
    release: () => release.resolve(),
    services,
    runners,
    posts,
    resources,
    clocks,
    trace,
    errors,
    async close() {
      release.resolve();
      const parent = await connected.promise;
      parent.end();
      const code = await exited.promise;
      // Also drain a leaked runner on a red assertion so the fixture owns its cleanup.
      for (const runner of runners) await runner.stop();
      for (const resource of resources) resource.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => control.close(() => resolve()));
      delete global[key];
      rmSync(root, { recursive: true, force: true });
      expect({ code, errors, trace }).toEqual({ code: 0, errors: [], trace });
    },
  };
}

const replacement = { id: 'a'.repeat(32), sha256: 'b'.repeat(64) };

for (const barrier of ['launch', 'profile'] as const) {
  test(`Main reload fences an opening caller held at ${barrier} before creating its scheduler`, async () => {
    const f = await mainFixture(barrier);
    try {
      const opening = f.open().then(
        () => null,
        (error: unknown) => error,
      );
      await f.entered;
      const reload = f.reload(replacement);
      f.release();
      expect(await opening).toMatchObject({ message: 'native_draining' });
      await reload;
      expect(f.services).toHaveLength(2);
      expect(f.services[0]!.closed).toBe(true);
      expect(f.runners).toHaveLength(1);
      expect(f.resources.map((resource) => resource.service)).toEqual([2]);
      expect(f.posts.filter((post) => post.service === 1)).toEqual([]);
      await f.runners[0]!.tick();
      expect(f.posts.some((post) => post.service === 2 && post.kind === 'start')).toBe(true);
      expect(f.posts.some((post) => post.afterClose)).toBe(false);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  }, 15000);
}

test('Main reload drains the original scheduler creation before closing its database and Service', async () => {
  const f = await mainFixture('creation');
  try {
    await f.open();
    await f.entered;
    const original = f.runners[0]!;
    let reloaded = false;
    const reload = f.reload(replacement).then(() => {
      reloaded = true;
    });
    await Promise.resolve();
    expect(reloaded).toBe(false);
    expect(f.services[0]!.closed).toBe(false);
    expect(f.resources[0]!.closed).toBe(false);
    f.release();
    await reload;
    await f.runners[1]!.tick();
    expect(f.posts.filter((post) => post.service === 1).map((post) => post.kind)).toEqual([
      'create',
    ]);
    expect(f.resources[0]!.closed).toBe(true);
    expect(f.services[0]!.closed).toBe(true);
    expect(f.trace.indexOf('1:creation:created')).toBeLessThan(f.trace.indexOf('1:database:close'));
    expect(f.trace.indexOf('1:database:close')).toBeLessThan(f.trace.indexOf('1:service:close'));
    expect(f.clocks.get(f.services[0]!.client)!.timers.size).toBe(0);
    const before = f.posts.length;
    await original.tick();
    expect(f.posts).toHaveLength(before);
    expect(f.posts.some((post) => post.afterClose)).toBe(false);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
}, 15000);
