import { Database } from 'bun:sqlite';
import { expect, spyOn, test } from 'bun:test';
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
import type { WindowsProfilePermissionIssue } from '../../electron/windows-access';
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
async function mainFixture(
  barrier: Barrier,
  holdServiceClose = false,
  holdMenu = false,
  rejectServiceClose = false,
  holdRendererLoad = false,
  barrierService = 1,
  holdAppReady = false,
  permissionIssue?: WindowsProfilePermissionIssue,
) {
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
  const rendererEntered = deferred(),
    rendererLoad = deferred();
  const appReady = deferred();
  const permissionEntered = deferred();
  const permissionResult = deferred<{ response: number; checkboxChecked: boolean }>();
  let pendingPermission = permissionIssue;
  const trace: string[] = [],
    errors: unknown[] = [];
  const dialogs: unknown[][] = [];
  let windowDestroyed = false;
  let windowVisible = false;
  let windowMinimized = false;
  const windows: BrowserWindow[] = [];
  const trays: FixtureTray[] = [];
  const appUserModelIds: string[] = [];
  let dockHides = 0;
  let appHides = 0;
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
    setAppUserModelId: (id: string) => appUserModelIds.push(id),
    getAppPath: () => root,
    getVersion: () => 'fixture',
    setAboutPanelOptions: () => {},
    hide: () => {
      appHides += 1;
    },
    dock: {
      hide: () => {
        dockHides += 1;
      },
    },
    whenReady: async () => {
      if (holdAppReady) await appReady.promise;
    },
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
    static getAllWindows() {
      return windows.filter((window) => !window.isDestroyed());
    }
    constructor(..._args: unknown[]) {
      super();
      windows.push(this);
    }
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: 'http://127.0.0.1:43219/' },
      isDestroyed: () => windowDestroyed,
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
      return windowDestroyed;
    }
    show() {
      if (this.isDestroyed()) throw Error('fixture_show_destroyed_window');
      windowVisible = true;
      trace.push('window:show');
    }
    hide() {
      windowVisible = false;
    }
    isMinimized() {
      return windowMinimized;
    }
    restore() {
      windowMinimized = false;
      trace.push('window:restore');
    }
    focus() {
      if (this.isDestroyed()) throw Error('fixture_focus_destroyed_window');
      trace.push('window:focus');
    }
    destroy() {
      if (windowDestroyed) return;
      windowDestroyed = true;
      trace.push('window:destroy');
      this.emit('closed');
      app.emit('window-all-closed');
    }
    removeMenu() {}
    setMenu() {}
    setMenuBarVisibility() {}
    setBackgroundColor() {}
    setTitleBarOverlay() {}
    async loadURL() {
      rendererEntered.resolve();
      if (holdRendererLoad) await rendererLoad.promise;
    }
  }
  class FixtureTray extends EventEmitter {
    readonly icon: string;
    destroyed = false;
    tooltip = '';
    menu: { label?: string; click?: () => void }[] = [];
    constructor(icon: string) {
      super();
      this.icon = icon;
      trays.push(this);
    }
    setToolTip(value: string) {
      this.tooltip = value;
    }
    setContextMenu(menu: typeof this.menu) {
      this.menu = menu;
    }
    destroy() {
      this.destroyed = true;
      trace.push('tray:destroy');
    }
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
        showMessageBox: async (...args: unknown[]) => {
          dialogs.push(args);
          if ((args[0] as { title?: string }).title === 'Kite 数据权限异常') {
            trace.push('permissions:dialog');
            permissionEntered.resolve();
            return permissionResult.promise;
          }
          if (!holdMenu) throw Error('unexpected_fixture_dialog');
          menuEntered.resolve();
          return menuResult.promise;
        },
      },
      ipcMain: {},
      Menu: { buildFromTemplate: (template: unknown) => template },
      nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }),
      Tray: FixtureTray,
    },
    selectProfile: () => ({
      dataRoot: root,
      profile: 'profile',
      profilePath: join(root, 'profile'),
    }),
    loadWindowsAccess: () => ({
      profilePermissions() {
        trace.push('permissions:inspect');
        return (
          pendingPermission && {
            ...pendingPermission,
            repair() {
              trace.push('permissions:repair');
              pendingPermission!.repair();
              pendingPermission = undefined;
            },
          }
        );
      },
    }),
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
      if (++profileCalls === barrierService && barrier === 'profile') {
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
          if (rejectServiceClose) throw Error('fixture_service_close_failed');
          service.closed = true;
          trace.push(`${id}:service:close`);
        },
      };
      services.push(service);
      if (id === barrierService && barrier === 'launch') {
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
      ['app', 'BrowserWindow', 'clipboard', 'dialog', 'ipcMain', 'Menu', 'nativeTheme', 'Tray'],
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
    './windows-access': exports(['loadWindowsAccess']),
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
        __KITE_DESKTOP_WINDOWS_ACCESS__: permissionIssue
          ? JSON.stringify({ relativePath: 'windows-access.node', sha256: 'f'.repeat(64) })
          : 'null',
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
    if (!holdAppReady && !permissionIssue) await registered.promise;
    await connected.promise;
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => control.close(() => resolve()));
    delete global[key];
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    get open() {
      return open;
    },
    registered: registered.promise,
    permissionEntered: permissionEntered.promise,
    answerPermission: (response: number) =>
      permissionResult.resolve({ response, checkboxChecked: false }),
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
    dialogs,
    destroyWindow: () => {
      windows.at(-1)?.destroy();
    },
    windowCount: () => BrowserWindow.getAllWindows().length,
    windowVisible: () => windowVisible,
    windowMinimized: () => windowMinimized,
    closeWindow: () => windows.at(-1)!.emit('close', { preventDefault() {} }),
    minimizeWindow: () => {
      windowMinimized = true;
    },
    trays,
    appUserModelIds,
    trayQuit: () => trays.at(-1)!.menu.find((item) => item.label === '退出')!.click!(),
    dockHides: () => dockHides,
    appHides: () => appHides,
    activate: () => app.emit('activate'),
    readyToShow: () => windows.at(-1)?.emit('ready-to-show'),
    lifecyclePhases,
    exitCodes,
    quit: () => app.quit(),
    menuEntered: menuEntered.promise,
    retainService: () => menuResult.resolve({ response: 0, checkboxChecked: false }),
    confirmQuit: () => menuResult.resolve({ response: 1, checkboxChecked: false }),
    rejectMenu: () => menuResult.reject(Error('fixture_cancelled_dialog')),
    rendererEntered: rendererEntered.promise,
    releaseAppReady: () => appReady.resolve(),
    rejectRendererLoad: () => rendererLoad.reject(Error('fixture_renderer_load_failed')),
    connection: await mainConnection.promise,
    parent: await connected.promise,
    serviceClosing: serviceClosing.promise,
    releaseServiceClose: () => releaseServiceClose.resolve(),
    exited: exited.promise,
    async close(expectedExit = 0) {
      appReady.resolve();
      rendererLoad.resolve();
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

for (const response of [0, 1]) {
  test.skipIf(process.platform !== 'win32')(
    `Main permission response ${response} gates renderer, Service and database before first launch`,
    async () => {
      let repairs = 0;
      const f = await mainFixture('none', false, false, false, false, 1, false, {
        path: 'C:\\owned\\data',
        backupPath: 'C:\\owned\\data\\permissions-backup.txt',
        repairable: true,
        repair() {
          repairs++;
        },
      });
      try {
        await f.permissionEntered;
        expect(f.windowCount()).toBe(0);
        expect(f.services).toHaveLength(0);
        expect(f.resources).toHaveLength(0);
        expect(repairs).toBe(0);
        f.answerPermission(response);
        if (response === 0) {
          expect(await f.exited).toBe(1);
          expect(f.services).toHaveLength(0);
          expect(f.resources).toHaveLength(0);
          expect(repairs).toBe(0);
        } else {
          await f.registered;
          await f.open();
          expect(f.trace.slice(0, 4)).toEqual([
            'permissions:inspect',
            'permissions:dialog',
            'permissions:repair',
            'permissions:inspect',
          ]);
          expect(repairs).toBe(1);
          expect(f.services).toHaveLength(1);
          expect(f.resources).toHaveLength(1);
        }
      } finally {
        await f.close(response === 0 ? 1 : 0);
      }
    },
    15000,
  );
}

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

for (const rejectServiceClose of [false, true]) {
  test(`Main confirmed quit ${rejectServiceClose ? 'forces exit on rejected cleanup' : 'exits after clean cleanup'} with one prompt`, async () => {
    const f = await mainFixture('none', true, true, rejectServiceClose);
    const exitCode = rejectServiceClose ? 1 : 0;
    try {
      await f.open();
      await f.runners[0]!.tick();
      f.quit();
      await f.menuEntered;
      f.quit();
      expect(f.dialogs).toHaveLength(1);
      expect(f.trace).not.toContain('1:service:closing');
      f.confirmQuit();
      await f.serviceClosing;
      expect(f.windowCount()).toBe(0);
      expect(f.trace.indexOf('window:destroy')).toBeLessThan(f.trace.indexOf('1:service:closing'));
      f.quit();
      expect(f.dialogs).toHaveLength(1);
      expect(f.exitCodes).toEqual([]);
      expect(f.trace.filter((item) => item === '1:service:closing')).toHaveLength(1);
      f.releaseServiceClose();
      expect(await f.exited).toBe(exitCode);
      expect(f.exitCodes).toEqual([exitCode]);
      expect(f.dialogs).toHaveLength(1);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close(exitCode);
    }
  }, 15000);
}

test.skipIf(process.platform !== 'win32')(
  'Windows tray restores the original window and idle exit drains its Service',
  async () => {
    const f = await mainFixture('none', true);
    try {
      await f.open();
      expect(f.appUserModelIds).toEqual(['dev.kite-code.native']);
      expect(f.trays).toHaveLength(1);
      const tray = f.trays[0]!;
      expect(tray.icon.endsWith('app-icon.ico')).toBe(true);
      expect(tray.tooltip).toBe('Kite');
      f.readyToShow();
      f.closeWindow();
      expect(f.windowVisible()).toBe(false);
      expect(tray.destroyed).toBe(false);
      tray.emit('double-click');
      expect(f.windowVisible()).toBe(true);
      expect(f.trace.at(-1)).toBe('window:focus');
      f.minimizeWindow();
      tray.emit('double-click');
      expect(f.windowMinimized()).toBe(false);
      expect(f.windowCount()).toBe(1);
      f.trayQuit();
      await f.serviceClosing;
      expect(f.dialogs).toEqual([]);
      expect(tray.destroyed).toBe(true);
      expect(f.windowCount()).toBe(0);
      const presentation = [...f.trace];
      tray.emit('double-click');
      expect(f.trace).toEqual(presentation);
      f.releaseServiceClose();
      expect(await f.exited).toBe(0);
      expect(f.services[0]!.closed).toBe(true);
    } finally {
      await f.close();
    }
  },
  15000,
);

for (const retain of [true, false]) {
  test.skipIf(process.platform !== 'win32')(
    `Windows tray active-work exit ${retain ? 'keeps the tray on cancellation' : 'confirms before removing the tray'}`,
    async () => {
      const f = await mainFixture('none', false, true);
      try {
        await f.open();
        const tray = f.trays[0]!;
        f.trayQuit();
        await f.menuEntered;
        f.trayQuit();
        expect(f.dialogs).toHaveLength(1);
        expect(tray.destroyed).toBe(false);
        expect(f.services[0]!.closed).toBe(false);
        if (retain) {
          f.retainService();
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          expect(tray.destroyed).toBe(false);
          f.closeWindow();
          tray.emit('double-click');
          expect(f.windowVisible()).toBe(true);
          expect(f.services[0]!.closed).toBe(false);
          expect(f.exitCodes).toEqual([]);
        } else {
          f.confirmQuit();
          expect(await f.exited).toBe(0);
          expect(tray.destroyed).toBe(true);
          expect(f.services[0]!.closed).toBe(true);
        }
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
    15000,
  );
}

test('Main idle quit needs no confirmation', async () => {
  const f = await mainFixture('none');
  try {
    await f.open();
    await f.runners[0]!.tick();
    f.quit();
    expect(await f.exited).toBe(0);
    expect(f.dialogs).toEqual([]);
    expect(f.trace.filter((item) => item === '1:service:closing')).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
}, 15000);

for (const rejectConfirmation of [false, true]) {
  test(`Main destroyed window uses one windowless confirmation and ${rejectConfirmation ? 'exits when confirmation throws' : 'honors confirmation'}`, async () => {
    const f = await mainFixture('none', false, true);
    const exitCode = rejectConfirmation ? 1 : 0;
    try {
      await f.open();
      await f.runners[0]!.tick();
      f.destroyWindow();
      f.quit();
      await f.menuEntered;
      expect(f.dialogs).toHaveLength(1);
      expect(f.dialogs[0]).toHaveLength(1);
      expect(f.dialogs[0]![0]).toMatchObject({ buttons: ['保留服务', '退出'] });
      if (rejectConfirmation) f.rejectMenu();
      else f.confirmQuit();
      expect(await f.exited).toBe(exitCode);
      expect(f.dialogs).toHaveLength(1);
      expect(f.trace.filter((item) => item === '1:service:closing')).toHaveLength(1);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close(exitCode);
    }
  }, 15000);
}

for (const blocked of ['opening', 'reload'] as const) {
  test(`Main confirmed quit closes the window while held ${blocked} cleans up in background`, async () => {
    const f = await mainFixture(
      blocked === 'opening' ? 'launch' : 'none',
      blocked === 'reload',
      true,
    );
    let pending: Promise<unknown> | undefined;
    const timers = spyOn(globalThis, 'setTimeout');
    try {
      if (blocked === 'opening') {
        pending = f.open().catch((error: unknown) => error);
        await f.entered;
      } else {
        await f.open();
        await f.runners[0]!.tick();
        pending = f.reload(replacement).catch((error: unknown) => error);
        await f.serviceClosing;
      }
      f.quit();
      await f.menuEntered;
      expect(f.windowCount()).toBe(1);
      f.confirmQuit();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(f.windowCount()).toBe(0);
      expect(f.trace.filter((item) => item === 'window:destroy')).toHaveLength(1);
      if (process.platform === 'darwin') {
        expect(f.appHides()).toBe(1);
        expect(f.dockHides()).toBe(1);
      }
      expect(f.exitCodes).toEqual([]);
      expect(timers.mock.calls.filter((call) => call[1] === 20000)).toEqual([]);
      const presentation = f.trace.filter((item) => item.startsWith('window:'));
      f.quit();
      f.activate();
      f.readyToShow();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(f.trace.filter((item) => item.startsWith('window:'))).toEqual(presentation);
      expect(f.windowCount()).toBe(0);
      expect(f.exitCodes).toEqual([]);
      expect(f.dialogs).toHaveLength(1);
      expect(f.errors).toEqual([]);
      if (blocked === 'reload')
        expect(f.trace.filter((item) => item === '1:service:closing')).toHaveLength(1);
      else expect(f.trace).not.toContain('1:service:closing');
      f.release();
      f.releaseServiceClose();
      await pending;
      expect(await f.exited).toBe(0);
      expect(f.exitCodes).toEqual([0]);
      expect(f.services[0]!.closed).toBe(true);
      expect(f.windowCount()).toBe(0);
      expect(f.dialogs).toHaveLength(1);
    } finally {
      timers.mockRestore();
      f.release();
      f.releaseServiceClose();
      await pending;
      await f.close();
    }
  }, 15000);
}

test('Main late renderer startup rejection cannot add a dialog or duplicate background cleanup', async () => {
  const f = await mainFixture('none', true, true, false, true);
  const timers = spyOn(globalThis, 'setTimeout');
  try {
    await f.rendererEntered;
    await f.open();
    await f.runners[0]!.tick();
    f.quit();
    await f.menuEntered;
    f.confirmQuit();
    await f.serviceClosing;
    const drainDeadlines = () => timers.mock.calls.filter((call) => call[1] === 20000);
    expect(drainDeadlines()).toHaveLength(0);
    f.rejectRendererLoad();
    // Flush the original app.whenReady/loadURL rejection and its catch while
    // the already-authorized Service drain remains pending.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    f.quit();
    expect(f.dialogs).toHaveLength(1);
    expect(f.errors).toEqual([]);
    expect(f.exitCodes).toEqual([]);
    expect(drainDeadlines()).toHaveLength(0);
    expect(f.trace.filter((item) => item === '1:service:closing')).toHaveLength(1);
    f.releaseServiceClose();
    expect(await f.exited).toBe(0);
    expect(f.exitCodes).toEqual([0]);
    expect(f.dialogs).toHaveLength(1);
    expect(f.errors).toEqual([]);
    expect(drainDeadlines()).toHaveLength(0);
    expect(f.trace.filter((item) => item === '1:service:closing')).toHaveLength(1);
  } finally {
    timers.mockRestore();
    await f.close();
  }
}, 15000);

test('Main reload resumes after retained quit when original close finishes during confirmation', async () => {
  const f = await mainFixture('none', true, true);
  let reloading: Promise<unknown> | undefined;
  try {
    await f.open();
    await f.runners[0]!.tick();
    let reloadSettled = false;
    reloading = f.reload(replacement).then(
      () => {
        reloadSettled = true;
        return null;
      },
      (error: unknown) => {
        reloadSettled = true;
        return error;
      },
    );
    await f.serviceClosing;
    f.quit();
    await f.menuEntered;
    f.releaseServiceClose();
    // Complete the original drain while the user still owns the unanswered
    // confirmation. The replacement must wait for that decision, not fail.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(reloadSettled).toBe(false);
    expect(f.services).toHaveLength(1);
    expect(f.exitCodes).toEqual([]);
    expect(f.dialogs).toHaveLength(1);
    f.retainService();
    expect(await reloading).toBeNull();
    const caller = await f.open();
    expect(caller).toBeDefined();
    expect(await f.open()).toBe(caller);
    expect(f.services).toHaveLength(2);
    expect(f.services[0]!.closed).toBe(true);
    expect(f.services[1]!.closed).toBe(false);
    await f.runners[1]!.tick();
    expect(f.posts.some((post) => post.service === 2 && post.kind === 'start')).toBe(true);
    expect(f.posts.some((post) => post.afterClose)).toBe(false);
    expect(f.exitCodes).toEqual([]);
    expect(f.dialogs).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally {
    f.retainService();
    f.releaseServiceClose();
    await reloading;
    await f.close();
  }
}, 15000);

for (const openingKind of ['initial', 'replacement'] as const) {
  for (const barrier of ['launch', 'profile'] as const) {
    test(`Main retained quit resumes ${openingKind} caller held at ${barrier}`, async () => {
      const serviceId = openingKind === 'initial' ? 1 : 2;
      const f = await mainFixture(barrier, false, true, false, false, serviceId);
      let pending: Promise<unknown> | undefined;
      try {
        if (openingKind === 'replacement') {
          await f.open();
          await f.runners[0]!.tick();
        }
        let settled = false;
        const operation = openingKind === 'initial' ? f.open() : f.reload(replacement);
        pending = operation.then(
          (value) => {
            settled = true;
            return { value };
          },
          (error: unknown) => {
            settled = true;
            return { error };
          },
        );
        await f.entered;
        f.quit();
        await f.menuEntered;
        f.release();
        // The actual openCaller continuation reaches its quit-decision fence
        // after the host launch/profile port returns, before closing the Service.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(settled).toBe(false);
        expect(f.trace).not.toContain(`${serviceId}:service:closing`);
        expect(f.services[serviceId - 1]!.closed).toBe(false);
        expect(f.runners).toHaveLength(serviceId - 1);
        expect(f.exitCodes).toEqual([]);
        expect(f.dialogs).toHaveLength(1);
        f.retainService();
        expect(await pending).not.toHaveProperty('error');
        const caller = await f.open();
        expect(caller).toBeDefined();
        expect(await f.open()).toBe(caller);
        expect(f.services).toHaveLength(serviceId);
        expect(f.services[serviceId - 1]!.closed).toBe(false);
        expect(f.runners).toHaveLength(serviceId);
        await f.runners[serviceId - 1]!.tick();
        expect(f.posts.some((post) => post.service === serviceId && post.kind === 'start')).toBe(
          true,
        );
        expect(f.posts.some((post) => post.afterClose)).toBe(false);
        expect(f.exitCodes).toEqual([]);
        expect(f.dialogs).toHaveLength(1);
        expect(f.errors).toEqual([]);
      } finally {
        f.retainService();
        f.release();
        await pending;
        await f.close();
      }
    }, 15000);
  }
}

test('Main late app readiness cannot create a client window after committed quit', async () => {
  const f = await mainFixture('none', false, false, false, false, 1, true);
  try {
    expect(f.windowCount()).toBe(0);
    f.quit();
    expect(await f.exited).toBe(0);
    f.releaseAppReady();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    f.activate();
    f.readyToShow();
    expect(f.windowCount()).toBe(0);
    expect(f.trace.filter((item) => item.startsWith('window:'))).toEqual([]);
    expect(f.services).toEqual([]);
    expect(f.dialogs).toEqual([]);
    expect(f.exitCodes).toEqual([0]);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
}, 15000);
