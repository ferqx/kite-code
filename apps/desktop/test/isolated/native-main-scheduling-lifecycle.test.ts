import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentClient } from '@kite-ai/client';
import type { DevelopmentServiceReload } from '../../electron/development';
import type { ScheduledTaskClock, ScheduledTaskRunner } from '../../electron/scheduled-task-runner';
import { createScheduledTaskData } from '../../electron/scheduled-tasks';
import type { NativeCreation } from '../../src/native-bridge';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type Barrier = 'launch' | 'profile' | 'creation' | 'none';
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
async function mainFixture(barrier: Barrier, holdServiceClose = false, holdMenu = false) {
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
  const lifecyclePhases: string[] = [],
    exitCodes: number[] = [];
  const menuEntered = deferred(),
    menuResult = deferred<{ response: number; checkboxChecked: boolean }>();
  const trace: string[] = [],
    errors: unknown[] = [];
  const clocks = new Map<
    AgentClient,
    { clock: ScheduledTaskClock; timers: Map<unknown, () => void> }
  >();
  let open!: () => Promise<unknown>, reload!: (request: DevelopmentServiceReload) => Promise<void>;
  let profileCalls = 0;
  const connected = deferred<Socket>(),
    mainConnection = deferred<Socket>(),
    serviceClosing = deferred(),
    releaseServiceClose = deferred();
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
    quit() {
      let prevented = false;
      app.emit('before-quit', {
        preventDefault() {
          prevented = true;
        },
      });
      if (!prevented) app.exit(0);
    },
    exit(code: number) {
      exitCodes.push(code);
      app.emit('will-quit');
      exited.resolve(code);
    },
  });
  class BrowserWindow extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: 'http://127.0.0.1:43219/' },
      isDestroyed: () => false,
      send: (_channel: string, event: { kind: string; phase: string }) => {
        if (event.kind === 'lifecycle') lifecyclePhases.push(event.phase);
      },
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
    observeConnection: (connection: Socket) => mainConnection.resolve(connection),
    electron: {
      app,
      BrowserWindow,
      clipboard: { writeText: () => {} },
      dialog: {
        showErrorBox: (...args: unknown[]) => errors.push(args),
        showMessageBox: async () => {
          if (!holdMenu) throw Error('unexpected_fixture_dialog');
          menuEntered.resolve();
          return menuResult.promise;
        },
      },
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
          trace.push(`${id}:service:closing`);
          serviceClosing.resolve();
          if (holdServiceClose) await releaseServiceClose.promise;
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
      hasActiveWork() {
        return holdMenu;
      }
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
    './native-browser': `${prefix}export const registerNativeBrowserIpc = () => f.register;`,
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
            build.onLoad({ filter: /main\.ts$/ }, (args) => {
              if (resolve(args.path) !== mainPath) return undefined;
              const source = readFileSync(mainPath, 'utf8');
              const boundary = '  const stop = serveDevelopmentReload({';
              if (!source.includes(boundary)) throw Error('fixture_parent_observation_missing');
              return {
                contents: source.replace(
                  boundary,
                  `  globalThis[${JSON.stringify(key)}].observeConnection(parent);\n${boundary}`,
                ),
                loader: 'ts',
                resolveDir: dirname(mainPath),
              };
            });
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
    lifecyclePhases,
    exitCodes,
    quit: () => app.quit(),
    menuEntered: menuEntered.promise,
    retainService: () => menuResult.resolve({ response: 0, checkboxChecked: false }),
    rejectMenu: () => menuResult.reject(Error('fixture_cancelled_dialog')),
    connection: await mainConnection.promise,
    parent: await connected.promise,
    serviceClosing: serviceClosing.promise,
    releaseServiceClose: () => releaseServiceClose.resolve(),
    exited: exited.promise,
    async close(expectedExit = 0) {
      release.resolve();
      releaseServiceClose.resolve();
      const parent = await connected.promise;
      parent.end();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const code = await Promise.race([
        exited.promise,
        new Promise<number>((resolve) => {
          timeout = setTimeout(() => {
            // Red-path fixture cleanup cannot be counted as production settlement.
            app.exit(expectedExit);
            resolve(expectedExit);
          }, 100);
        }),
      ]).finally(() => clearTimeout(timeout));
      // Also drain a leaked runner on a red assertion so the fixture owns its cleanup.
      for (const runner of runners) await runner.stop();
      for (const resource of resources) resource.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => control.close(() => resolve()));
      delete global[key];
      rmSync(root, { recursive: true, force: true });
      expect({ code, errors, trace }).toEqual({ code: expectedExit, errors: [], trace });
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

for (const reason of ['end', 'error', 'close', 'SIGINT', 'SIGTERM'] as const) {
  test(`Main ${reason} waits for one original Service close before process exit`, async () => {
    const f = await mainFixture('none', true);
    const exitCode = reason === 'error' ? 1 : 0;
    try {
      await f.open();
      if (reason === 'end') f.parent.end();
      else if (reason === 'error') f.connection.destroy(Error('fixture_control_reset'));
      else if (reason === 'close') f.connection.emit('close', false);
      else process.emit(reason);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const first = await Promise.race([
        f.serviceClosing.then(() => 'closing'),
        f.exited.then(() => 'exited'),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), 1000);
        }),
      ]).finally(() => clearTimeout(timer));
      expect(first).toBe('closing');
      expect(f.services[0]!.closed).toBe(false);
      expect(f.trace.filter((item) => item === '1:service:closing')).toHaveLength(1);
      // A second signal and a late stream close share the exact original drain.
      process.emit('SIGINT');
      f.connection.destroy();
      await Promise.resolve();
      expect(f.trace.filter((item) => item === '1:service:closing')).toHaveLength(1);
      f.releaseServiceClose();
      expect(await f.exited).toBe(exitCode);
      expect(f.services[0]!.closed).toBe(true);
      expect(f.resources.every((resource) => resource.closed)).toBe(true);
      expect(f.posts.some((post) => post.afterClose)).toBe(false);
    } finally {
      await f.close(exitCode);
    }
  }, 15000);
}

for (const reason of ['SIGINT', 'end'] as const) {
  for (const answer of ['retain', 'reject'] as const) {
    test(`Main ${reason} drain cannot be revoked by a late menu ${answer}`, async () => {
      const f = await mainFixture('none', true, true);
      try {
        await f.open();
        await f.runners[0]!.tick();
        const posts = f.posts.length;
        f.quit();
        await f.menuEntered;
        if (reason === 'end') f.parent.end();
        else process.emit('SIGINT');
        await f.serviceClosing;
        if (answer === 'retain') f.retainService();
        else f.rejectMenu();
        // Flush the actual menu continuation and its catch while Service close stays held.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(f.lifecyclePhases).not.toContain('active');
        await expect(f.open()).rejects.toThrow('native_draining');
        expect(f.posts).toHaveLength(posts);
        expect(f.exitCodes).toEqual([]);
        expect(f.trace.filter((item) => item === '1:service:closing')).toHaveLength(1);
        expect(f.errors).toEqual([]);
        f.releaseServiceClose();
        expect(await f.exited).toBe(0);
        expect(f.exitCodes).toEqual([0]);
        expect(f.clocks.get(f.services[0]!.client)!.timers.size).toBe(0);
        expect(f.posts.some((post) => post.afterClose)).toBe(false);
      } finally {
        await f.close();
      }
    }, 15000);
  }
}

test('Main still permits an ordinary menu cancellation to retain the original Service', async () => {
  const f = await mainFixture('none', false, true);
  try {
    const caller = await f.open();
    await f.runners[0]!.tick();
    f.quit();
    await f.menuEntered;
    f.retainService();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(f.lifecyclePhases).toEqual(['quitting', 'active']);
    expect(await f.open()).toBe(caller);
    expect(f.services[0]!.closed).toBe(false);
    expect(f.exitCodes).toEqual([]);
    expect(f.trace).not.toContain('1:service:closing');
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
}, 15000);
