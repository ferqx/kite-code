import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir, release } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import {
  formatServiceStartupReport,
  launchPairedService,
  PairedServiceError,
  type ServiceStartupDiagnostic,
} from '@kite-ai/service/paired';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, Tray } from 'electron';
import { type NativeWindowAppearance, nativeEventChannel } from '../src/native-bridge';
import { nativeWindowMenuActionChannel } from '../src/native-menu-bridge';
import { acquireNodeArtifactAccess } from './artifact-access';
import {
  type DevelopmentServiceReload,
  desktopContentSecurityPolicy,
  parseDesktopDevelopment,
  serveDevelopmentReload,
} from './development';
import { parseNativeAssets, resolveNativeCandidate, verifyNativeAsset } from './native-assets';
import { registerNativeBrowserIpc } from './native-browser';
import { NativeCaller } from './native-caller';
import {
  registerNativeIpc,
  registerNativeStartupIpc,
  registerNativeThemeIpc,
  registerNativeWindowIpc,
} from './native-ipc';
import {
  nativeWindowMenuShortcut,
  nativeWindowMenuTemplate,
  registerNativeWindowMenuIpc,
} from './native-window-menu';
import { spawnNodePairedChild } from './node-process';
import { openPrivateData, type PrivateData } from './private-data';
import { acquireDesktopProfileAccess, type DesktopProfileAccess } from './profile-access';
import { canonicalProtectedPath } from './protected-path';
import { inspectNativeQuitWork, settleDesktopQuit } from './quit-settlement';
import { ScheduledTaskRunner } from './scheduled-task-runner';
import { assertNativeSqliteEngine } from './sqlite-engine';
import {
  acquireWindowsNativeCandidate,
  parseWindowsNativeHandoff,
  retainWindowsNativePairedArtifact,
  type WindowsNativeCandidateAccess,
} from './windows-native-candidate';

declare const __KITE_DESKTOP_NATIVE_ASSETS__: unknown;
declare const __KITE_DESKTOP_PROFILE_ACCESS__: {
  relativePath: 'profile-access.js';
  sha256: string;
};
declare const __KITE_DESKTOP_WINDOWS_ACCESS__: {
  relativePath: 'windows-access.node';
  sha256: string;
} | null;
const inputAssets = __KITE_DESKTOP_NATIVE_ASSETS__;
const candidate =
  !!inputAssets &&
  typeof inputAssets === 'object' &&
  !Array.isArray(inputAssets) &&
  'kind' in inputAssets &&
  inputAssets.kind === 'candidate';
if (candidate && Object.keys(inputAssets).length !== 1) throw Error('invalid_native_assets');
const windowsHandoff =
  candidate && process.platform === 'win32' ? parseWindowsNativeHandoff(process.argv) : undefined;
const formalAssets = candidate ? resolveNativeCandidate(app.getAppPath()) : undefined;
const assets = formalAssets ?? parseNativeAssets(inputAssets);
declare const __KITE_DESKTOP_DEVELOPMENT__: unknown;
const development = parseDesktopDevelopment(
  typeof __KITE_DESKTOP_DEVELOPMENT__ === 'undefined' ? null : __KITE_DESKTOP_DEVELOPMENT__,
  !candidate && assets.kind === 'development',
);
let activeAssets = assets;
const windowsAsset =
  formalAssets?.windowsAsset ??
  (__KITE_DESKTOP_WINDOWS_ACCESS__
    ? {
        path: join(app.getAppPath(), __KITE_DESKTOP_WINDOWS_ACCESS__.relativePath),
        sha256: __KITE_DESKTOP_WINDOWS_ACCESS__.sha256,
      }
    : undefined);
app.setName('kite-native');
if (process.platform === 'win32') app.setAppUserModelId('dev.kite-code.native');
const mica = process.platform === 'win32' && Number(release().split('.')[2]) >= 22621;
const windowMaterial: NativeWindowAppearance['backgroundMaterial'] = mica
  ? 'mica'
  : process.platform === 'darwin'
    ? 'vibrancy'
    : 'none';
let window: BrowserWindow | undefined, caller: NativeCaller | undefined;
let tray: Tray | undefined;
let opening: Promise<NativeCaller> | undefined;
let closingNativeResources: Promise<void> | undefined;
let stoppingNativeProcess: Promise<void> | undefined;
let paired: Awaited<ReturnType<typeof launchPairedService>> | undefined;
let ownedPairedChild: ReturnType<typeof spawnNodePairedChild> | undefined;
let privateData: PrivateData | undefined;
let scheduledTasks: ScheduledTaskRunner | undefined;
let privateAccess: DesktopProfileAccess | undefined;
let windowsArtifactAccess: WindowsNativeCandidateAccess | undefined;
const acquireFormalWindowsAccess = () => {
  if (!formalAssets || !windowsAsset || !formalAssets.windowsCandidateFiles || !windowsHandoff)
    throw Object.assign(Error('native_windows_bootstrap_unqualified'), {
      code: 'native_windows_bootstrap_unqualified',
    });
  const lease = acquireWindowsNativeCandidate({
    root: formalAssets.candidateRoot,
    windowsAsset,
    files: formalAssets.windowsCandidateFiles,
    handoff: windowsHandoff,
  });
  try {
    // The native factory independently hashes every original file and binds
    // the raw manifest to this ID. Its live owner also checks closed inventory.
    lease.verify();
    windowsArtifactAccess = lease;
    return lease;
  } catch (error) {
    try {
      lease.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'native_windows_candidate_close_unknown');
    }
    throw error;
  }
};
// Acquisition occurs before BrowserWindow, private Profile, SQLite or paired Service admission.
let artifactAccess: { close(): void }[] = windowsHandoff ? [acquireFormalWindowsAccess()] : [];
let startupDiagnostic: ServiceStartupDiagnostic | undefined;
let quitting = false,
  exitAllowed = false;
let quitDecision: Promise<void> | undefined;
let resolveQuitDecision: (() => void) | undefined;
let developmentReload: Promise<void> | undefined;
let switchingService = false;
function finishQuitDecision() {
  const resolve = resolveQuitDecision;
  quitDecision = undefined;
  resolveQuitDecision = undefined;
  resolve?.();
}
function setQuitting(value: boolean) {
  quitting = value;
  if (!value) finishQuitDecision();
  if (value) void scheduledTasks?.stop().catch(() => {});
  else scheduledTasks?.start();
  sendLifecycle(value);
}
function sendLifecycle(value: boolean) {
  try {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send(nativeEventChannel, {
        kind: 'lifecycle',
        phase: value ? 'quitting' : 'active',
      });
  } catch {
    // A disappearing renderer cannot receive lifecycle events; shutdown still settles its resources.
  }
}
async function openCaller(): Promise<NativeCaller> {
  if (quitting || switchingService) throw Error('native_draining');
  if (caller) return caller;
  opening ??= (async () => {
    startupDiagnostic = undefined;
    if (formalAssets) {
      if (windowsHandoff) {
        if (!artifactAccess.length) artifactAccess.push(acquireFormalWindowsAccess());
        if (!windowsArtifactAccess) throw Error('native_windows_bootstrap_unqualified');
        windowsArtifactAccess.verify();
        assertNativeSqliteEngine(formalAssets.sqlite);
      } else {
        for (const root of [formalAssets.candidateRoot, formalAssets.terminalRoot])
          artifactAccess.push(
            await acquireNodeArtifactAccess({
              root,
              bunExecutable: assets.bunExecutable,
              bunSha256: assets.bunSha256,
              helperPath: formalAssets.artifactHelper.path,
              helperSha256: formalAssets.artifactHelper.sha256,
              ...(windowsAsset ? { windowsAsset } : {}),
            }),
          );
        const fresh = resolveNativeCandidate(app.getAppPath());
        if (
          fresh.runtimeProtection.manifestSha256 !== formalAssets.runtimeProtection.manifestSha256
        )
          throw Error('native_asset_identity_mismatch');
        assertNativeSqliteEngine(fresh.sqlite);
      }
    }
    verifyNativeAsset(activeAssets.serviceEntrypoint, activeAssets.serviceSha256);
    verifyNativeAsset(activeAssets.bunExecutable, activeAssets.bunSha256);
    const profile = selectProfile(
      assets.profile ?? {
        dataRoot: join(homedir(), '.kite-code', 'unified-agent'),
        profile: 'default',
      },
    );
    const helper = __KITE_DESKTOP_PROFILE_ACCESS__;
    if (helper.relativePath !== 'profile-access.js' || !/^[0-9a-f]{64}$/.test(helper.sha256))
      throw Error('native_profile_helper_invalid');
    const acquirePrivateAccess = () =>
      acquireDesktopProfileAccess({
        profile,
        bunExecutable: assets.bunExecutable,
        bunSha256: assets.bunSha256,
        helperPath: join(app.getAppPath(), helper.relativePath),
        helperSha256: helper.sha256,
        ...(windowsAsset ? { windowsAsset } : {}),
      });
    // Windows Main holds its own native Profile SH before the independent Service starts.
    if (process.platform === 'win32') privateAccess = await acquirePrivateAccess();
    paired = await launchPairedService({
      profile,
      entrypoint: activeAssets.serviceEntrypoint,
      executable: activeAssets.bunExecutable,
      spawnChild(command, options) {
        ownedPairedChild = spawnNodePairedChild(command, options);
        return ownedPairedChild;
      },
      instanceId: crypto.randomUUID(),
      buildId: activeAssets.buildId,
      apiMajor: assets.apiMajor,
      requiredCapabilities: assets.requiredCapabilities,
      ...(formalAssets ? { runtimeProtection: formalAssets.runtimeProtection } : {}),
      ...(windowsHandoff
        ? {
            retainWindowsArtifact(proof, actual) {
              if (!windowsArtifactAccess) throw Error('native_windows_bootstrap_unqualified');
              return retainWindowsNativePairedArtifact(windowsArtifactAccess, proof, actual);
            },
          }
        : {}),
    });
    if (quitDecision) await quitDecision;
    if (quitting || switchingService) {
      await paired.close();
      throw Error('native_draining');
    }
    if (process.platform === 'win32' && !paired.bootstrap.storeId)
      throw Error('native_profile_store_unavailable');
    privateAccess ??= await acquirePrivateAccess();
    if (quitDecision) await quitDecision;
    if (quitting || switchingService) {
      privateAccess.close();
      await paired.close();
      throw Error('native_draining');
    }
    privateData = openPrivateData(profile.profilePath, privateAccess);
    const admittedService = paired;
    let admissionAvailable = true;
    caller = new NativeCaller(
      paired.client,
      (event) => {
        if (window && !window.isDestroyed()) window.webContents.send(nativeEventChannel, event);
      },
      privateData,
      [
        profile.profilePath,
        canonicalProtectedPath(join(homedir(), '.kite-code')),
        ...(formalAssets ? [formalAssets.candidateRoot, formalAssets.terminalRoot] : []),
      ],
      {
        client: admittedService.client,
        consume: () => {
          const available = admissionAvailable;
          admissionAvailable = false;
          return available && paired === admittedService && !quitting;
        },
      },
    );
    scheduledTasks = new ScheduledTaskRunner(paired.client, privateData);
    caller.setScheduledTasks(scheduledTasks);
    scheduledTasks.start();
    return caller;
  })().catch(async (error) => {
    if (error instanceof PairedServiceError) startupDiagnostic = error.startupDiagnostic;
    try {
      privateData?.close();
      privateAccess?.close();
      await paired?.close();
      for (const lease of artifactAccess.reverse()) lease.close();
    } catch (cleanup) {
      // Keep the rejected opening and every original owner. A cleanup error
      // must neither mask the startup cause nor permit a replacement launch.
      throw new AggregateError([error, cleanup], 'native_startup_cleanup_unknown');
    }
    artifactAccess = [];
    windowsArtifactAccess = undefined;
    opening = undefined;
    throw error;
  });
  return opening;
}
function closeNativeResources(): Promise<void> {
  if (closingNativeResources) return closingNativeResources;
  const closing = (async () => {
    await opening?.catch(() => {});
    await scheduledTasks?.stop();
    scheduledTasks = undefined;
    await caller?.close();
    privateData?.close();
    privateAccess?.close();
    await paired?.close();
    if (paired && (await paired.exited) !== 0) throw Error('native_service_cleanup_unverified');
    for (const lease of artifactAccess.reverse()) lease.close();
    artifactAccess = [];
    windowsArtifactAccess = undefined;
    caller = undefined;
    opening = undefined;
    paired = undefined;
    privateData = undefined;
    privateAccess = undefined;
    ownedPairedChild = undefined;
  })();
  closingNativeResources = closing;
  void closing.then(
    () => {
      if (closingNativeResources === closing) closingNativeResources = undefined;
    },
    () => {},
  );
  return closing;
}
function stopNativeProcess(code = 0): void {
  if (exitAllowed || stoppingNativeProcess) return;
  setQuitting(true);
  finishQuitDecision();
  stoppingNativeProcess = Promise.resolve()
    .then(async () => {
      // Commit the stop owner before destroying the last window. Its close
      // events must not quit Main while it still owns the background drain.
      const closingWindow = window;
      window = undefined;
      tray?.destroy();
      tray = undefined;
      if (closingWindow && !closingWindow.isDestroyed()) closingWindow.destroy();
      if (process.platform === 'darwin') {
        app.hide();
        app.dock?.hide();
      }
      const outcome = await settleDesktopQuit({
        closeService: async () => {
          await developmentReload?.catch(() => {});
          await closeNativeResources();
        },
      });
      if (outcome === 'force') {
        forceExit();
        return;
      }
      exitAllowed = true;
      app.exit(code);
    })
    .catch(() => forceExit());
}
const terminateNativeProcess = () => stopNativeProcess();
process.on('SIGINT', terminateNativeProcess);
process.on('SIGTERM', terminateNativeProcess);
app.once('will-quit', () => {
  process.removeListener('SIGINT', terminateNativeProcess);
  process.removeListener('SIGTERM', terminateNativeProcess);
});
async function reloadDevelopmentService(request: DevelopmentServiceReload) {
  if (!development || quitting || developmentReload) throw Error('native_draining');
  const next = parseNativeAssets({
    ...activeAssets,
    serviceEntrypoint: join(app.getAppPath(), 'services', request.id, 'main.js'),
    serviceSha256: request.sha256,
    buildId: `development-${request.sha256}`,
  });
  verifyNativeAsset(next.serviceEntrypoint, next.serviceSha256);
  switchingService = true;
  sendLifecycle(true);
  developmentReload = (async () => {
    await closeNativeResources();
    if (quitDecision) await quitDecision;
    if (quitting) throw Error('native_draining');
    activeAssets = next;
    switchingService = false;
    await openCaller();
    if (!window || window.isDestroyed()) throw Error('native_window_unavailable');
    await window.loadURL(development.rendererUrl);
  })();
  await developmentReload;
  developmentReload = undefined;
}
let reportDevelopmentStartup: (error?: unknown) => void = () => {};
if (development) {
  const parent = connect({ host: '127.0.0.1', port: development.control.port });
  let startup: { kind: 'desktop.ready' } | { kind: 'desktop.failed'; code: string } | undefined;
  let sent = false;
  const sendStartup = () => {
    if (!startup || sent || parent.connecting || parent.destroyed) return;
    sent = true;
    parent.write(`${JSON.stringify({ ...startup, token: development.control.token })}\n`);
  };
  parent.once('connect', sendStartup);
  reportDevelopmentStartup = (error) => {
    if (startup) return;
    const code =
      error instanceof Error ? ('code' in error ? String(error.code) : error.message) : '';
    startup =
      error === undefined
        ? { kind: 'desktop.ready' }
        : {
            kind: 'desktop.failed',
            code: /^[a-z][a-z0-9_]{0,80}$/.test(code) ? code : 'native_startup_failed',
          };
    sendStartup();
  };
  parent.on('error', () => stopNativeProcess(1));
  const stop = serveDevelopmentReload({
    stream: parent,
    reply: (line) => {
      if (!parent.destroyed && parent.writable) parent.write(line);
    },
    reload: reloadDevelopmentService,
  });
  app.once('will-quit', () => {
    stop();
    parent.destroy();
  });
  parent.once('end', () => stopNativeProcess());
  parent.once('close', (hadError) => stopNativeProcess(hadError ? 1 : 0));
}
void app
  .whenReady()
  .then(async () => {
    if (stoppingNativeProcess || exitAllowed) return;
    const rendererPath = join(app.getAppPath(), 'index.html'),
      rendererUrl = development?.rendererUrl ?? pathToFileURL(rendererPath).href;
    window = new BrowserWindow({
      title: 'Kite',
      ...(process.platform === 'win32' ? { icon: join(app.getAppPath(), 'app-icon.ico') } : {}),
      width: 1100,
      minWidth: 800,
      height: 780,
      ...(process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 13, y: 19 } }
        : {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: {
              color: '#00000000',
              symbolColor: nativeTheme.shouldUseDarkColors ? '#eeeeee' : '#222222',
              height: 32,
            },
          }),
      show: false,
      ...(mica ? { backgroundMaterial: 'mica' as const } : {}),
      ...(windowMaterial === 'vibrancy'
        ? { vibrancy: 'sidebar' as const, visualEffectState: 'active' as const }
        : {}),
      backgroundColor:
        windowMaterial !== 'none'
          ? '#00000000'
          : nativeTheme.shouldUseDarkColors
            ? '#191919'
            : '#fafafa',
      webPreferences: {
        preload: join(app.getAppPath(), 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    if (process.platform === 'win32') {
      tray = new Tray(join(app.getAppPath(), 'app-icon.ico'));
      tray.setToolTip('Kite');
      tray.on('double-click', showMainWindow);
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: '打开 Kite', click: showMainWindow },
          { type: 'separator' },
          { label: '退出', click: () => app.quit() },
        ]),
      );
      app.setAboutPanelOptions({ applicationName: 'Kite', applicationVersion: app.getVersion() });
      const menuOptions = {
        applicationEnabled: true,
        dispatch(action: import('../src/native-menu-bridge').NativeWindowMenuAction) {
          if (
            !quitting &&
            window &&
            !window.isDestroyed() &&
            window.webContents.mainFrame.url.split('#')[0] === rendererUrl
          )
            window.webContents.send(nativeWindowMenuActionChannel, action);
        },
      };
      // Retain native accelerators without adding a second row below the immersive titlebar.
      window.setMenu(Menu.buildFromTemplate(nativeWindowMenuTemplate(menuOptions)));
      window.setMenuBarVisibility(false);
      window.webContents.on('before-input-event', (event, input) => {
        // Let F10 and Alt navigation reach the immersive menu instead of the hidden system row.
        window!.webContents.setIgnoreMenuShortcuts(input.alt || input.key === 'F10');
        const action = nativeWindowMenuShortcut(input);
        if (action) {
          event.preventDefault();
          menuOptions.dispatch(action);
        }
      });
      registerNativeWindowMenuIpc({
        ipcMain,
        window: () => window,
        rendererUrl,
        platform: process.platform,
        showMenu(host, request) {
          const menu = Menu.buildFromTemplate(
            nativeWindowMenuTemplate({
              ...menuOptions,
              applicationEnabled: request.applicationEnabled && !quitting,
            }),
          ).getMenuItemById(request.menu)!.submenu!;
          return new Promise<void>((resolve) =>
            menu.popup({
              window: host,
              x: request.x,
              y: request.y,
              callback: resolve,
            }),
          );
        },
      });
    } else if (process.platform !== 'darwin') window.removeMenu();
    const updateSystemBackground = () => {
      if (window && !window.isDestroyed()) {
        window.setBackgroundColor(
          windowMaterial !== 'none'
            ? '#00000000'
            : nativeTheme.shouldUseDarkColors
              ? '#191919'
              : '#fafafa',
        );
        if (process.platform !== 'darwin')
          window.setTitleBarOverlay({
            symbolColor: nativeTheme.shouldUseDarkColors ? '#eeeeee' : '#222222',
          });
      }
    };
    nativeTheme.on('updated', updateSystemBackground);
    window.once('closed', () => nativeTheme.off('updated', updateSystemBackground));
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.webContents.on('will-navigate', (event, url) => {
      if (url.split('#')[0] !== rendererUrl) event.preventDefault();
    });
    window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) caller?.detach();
    });
    window.webContents.on('render-process-gone', () => caller?.detach());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, complete) =>
      complete(false),
    );
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.session.webRequest.onHeadersReceived((details, complete) =>
      complete({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [desktopContentSecurityPolicy(development)],
        },
      }),
    );
    registerNativeBrowserIpc({ ipcMain, window, rendererUrl });
    registerNativeThemeIpc({
      ipcMain,
      window: () => window,
      rendererUrl,
      setTheme(theme) {
        nativeTheme.themeSource = theme;
        updateSystemBackground();
      },
    });
    registerNativeWindowIpc({
      ipcMain,
      window: () => window,
      rendererUrl,
      getAppearance: () => ({ backgroundMaterial: windowMaterial }),
      writeClipboardText: (text) => clipboard.writeText(text),
    });
    registerNativeStartupIpc({
      ipcMain,
      window: () => window,
      rendererUrl,
      report: () =>
        startupDiagnostic && !quitting ? formatServiceStartupReport(startupDiagnostic) : null,
      async pickPath(window) {
        const result = await dialog.showSaveDialog(window, {
          title: '保存启动诊断',
          defaultPath: 'kite-startup-diagnostic.json',
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        return result.canceled || !result.filePath ? null : result.filePath;
      },
      write: (path, report) =>
        writeFile(path, report, { encoding: 'utf8', flag: 'wx', mode: 0o600 }),
    });
    registerNativeIpc({
      ipcMain,
      window: () => window,
      rendererUrl,
      caller: openCaller,
      async confirmWorkspaceRemoval(label) {
        const result = await dialog.showMessageBox(window!, {
          type: 'warning',
          title: `移除空间“${label}”？`,
          message: `移除空间“${label}”？`,
          detail:
            '将移除本地项目登记及全部会话列表，并请求停止运行中的任务。历史先保留；任务结束并过宽限期后，可在退出客户端后通过离线维护清理。未结束或结果未知的执行证据会继续保留。不会删除工作目录中的文件。',
          buttons: ['保留空间', '移除空间'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        return result.response === 1;
      },
      async pickWorkspace(generation, host) {
        await host.invoke({ method: 'state', generation });
        const selected = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] });
        if (selected.canceled || selected.filePaths.length !== 1) return;
        await host.invoke({ method: 'state', generation });
        const path = realpathSync(selected.filePaths[0]!);
        const id = randomUUID();
        const workspace = await host.registerWorkspace(generation, {
          id,
          rootUri: pathToFileURL(path).href,
          name: basename(path),
        });
        return { workspaceId: workspace.id };
      },
    });
    window.on('close', (event) => {
      if (!exitAllowed) {
        event.preventDefault();
        window?.hide();
      }
    });
    window.once('ready-to-show', () => {
      if (!stoppingNativeProcess && !exitAllowed && window && !window.isDestroyed()) window.show();
    });
    if (development) {
      await window.loadURL(rendererUrl);
      try {
        await openCaller();
        reportDevelopmentStartup();
      } catch (error) {
        reportDevelopmentStartup(error);
      }
    } else await window.loadFile(rendererPath);
  })
  .catch((error) => {
    if (development) {
      reportDevelopmentStartup(error);
      return;
    }
    if (quitting) {
      stopNativeProcess(1);
      return;
    }
    dialog.showErrorBox('Kite 无法启动', '原生调用者初始化失败。请核对发行资源。');
    app.exit(1);
  });
function showMainWindow() {
  if (quitting || stoppingNativeProcess || exitAllowed || !window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
app.on('activate', showMainWindow);
app.on('window-all-closed', () => {
  if (!stoppingNativeProcess && !quitting) app.quit();
});
app.on('before-quit', (event) => {
  if (exitAllowed) return;
  event.preventDefault();
  if (quitting) return;
  quitDecision = new Promise<void>((resolve) => {
    resolveQuitDecision = resolve;
  });
  setQuitting(true);
  const ownsQuit = () => !stoppingNativeProcess && !exitAllowed;
  void (async () => {
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
    }
    const active = developmentReload
      ? true
      : caller
        ? await inspectNativeQuitWork((signal) => caller!.hasActiveWork(signal), 2000)
        : !!opening;
    if (!ownsQuit()) return;
    if (active) {
      const options = {
        type: 'warning' as const,
        message: '仍有活动工作，或尚不能完整核实。退出会停止本应用拥有的服务。',
        detail: '确认后立即关闭窗口，未完成的任务清理将在后台继续。',
        buttons: ['保留服务', '退出'],
        defaultId: 0,
        cancelId: 0,
      };
      const result =
        window && !window.isDestroyed()
          ? await dialog.showMessageBox(window, options)
          : await dialog.showMessageBox(options);
      if (!ownsQuit()) return;
      if (result.response !== 1) {
        setQuitting(false);
        return;
      }
    }
    stopNativeProcess();
  })().catch(() => {
    if (!ownsQuit()) return;
    stopNativeProcess(1);
  });
});

function forceExit() {
  try {
    ownedPairedChild?.kill('SIGKILL');
  } finally {
    exitAllowed = true;
    app.exit(1);
  }
}
