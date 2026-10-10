import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import {
  formatServiceStartupReport,
  launchPairedService,
  PairedServiceError,
  type ServiceStartupDiagnostic,
} from '@kite-ai/service/paired';
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme } from 'electron';
import { nativeEventChannel } from '../src/native-bridge';
import { acquireNodeArtifactAccess } from './artifact-access';
import { parseNativeAssets, resolveNativeCandidate, verifyNativeAsset } from './native-assets';
import { NativeCaller } from './native-caller';
import {
  registerNativeIpc,
  registerNativeStartupIpc,
  registerNativeThemeIpc,
  registerNativeWindowIpc,
} from './native-ipc';
import { spawnNodePairedChild } from './node-process';
import { openPrivateData, type PrivateData } from './private-data';
import { acquireDesktopProfileAccess, type DesktopProfileAccess } from './profile-access';
import { inspectNativeQuitWork, settleDesktopQuit } from './quit-settlement';
import { assertNativeSqliteEngine } from './sqlite-engine';
import {
  acquireWindowsNativeCandidate,
  parseWindowsNativeHandoff,
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
const windowsAsset =
  formalAssets?.windowsAsset ??
  (__KITE_DESKTOP_WINDOWS_ACCESS__
    ? {
        path: join(app.getAppPath(), __KITE_DESKTOP_WINDOWS_ACCESS__.relativePath),
        sha256: __KITE_DESKTOP_WINDOWS_ACCESS__.sha256,
      }
    : undefined);
app.setName('kite-native');
let window: BrowserWindow | undefined, caller: NativeCaller | undefined;
let opening: Promise<NativeCaller> | undefined;
let paired: Awaited<ReturnType<typeof launchPairedService>> | undefined;
let ownedPairedChild: ReturnType<typeof spawnNodePairedChild> | undefined;
let privateData: PrivateData | undefined;
let privateAccess: DesktopProfileAccess | undefined;
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
    const fresh = resolveNativeCandidate(app.getAppPath());
    if (fresh.runtimeProtection.manifestSha256 !== formalAssets.runtimeProtection.manifestSha256)
      throw Error('native_asset_identity_mismatch');
    lease.verify();
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
async function openCaller(): Promise<NativeCaller> {
  if (quitting) throw Error('native_draining');
  if (caller) return caller;
  opening ??= (async () => {
    startupDiagnostic = undefined;
    if (formalAssets) {
      if (windowsHandoff) {
        if (!artifactAccess.length) artifactAccess.push(acquireFormalWindowsAccess());
      } else
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
      if (fresh.runtimeProtection.manifestSha256 !== formalAssets.runtimeProtection.manifestSha256)
        throw Error('native_asset_identity_mismatch');
      assertNativeSqliteEngine(fresh.sqlite);
    }
    verifyNativeAsset(assets.serviceEntrypoint, assets.serviceSha256);
    verifyNativeAsset(assets.bunExecutable, assets.bunSha256);
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
      entrypoint: assets.serviceEntrypoint,
      executable: assets.bunExecutable,
      spawnChild(command, options) {
        ownedPairedChild = spawnNodePairedChild(command, options);
        return ownedPairedChild;
      },
      instanceId: crypto.randomUUID(),
      buildId: assets.buildId,
      apiMajor: assets.apiMajor,
      requiredCapabilities: assets.requiredCapabilities,
      ...(formalAssets ? { runtimeProtection: formalAssets.runtimeProtection } : {}),
    });
    if (quitting) {
      await paired.close();
      throw Error('native_draining');
    }
    if (process.platform === 'win32' && !paired.bootstrap.storeId)
      throw Error('native_profile_store_unavailable');
    privateAccess ??= await acquirePrivateAccess();
    if (quitting) {
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
    return caller;
  })().catch(async (error) => {
    if (error instanceof PairedServiceError) startupDiagnostic = error.startupDiagnostic;
    privateData?.close();
    privateAccess?.close();
    await paired?.close();
    for (const lease of artifactAccess.reverse()) lease.close();
    artifactAccess = [];
    opening = undefined;
    throw error;
  });
  return opening;
}
void app
  .whenReady()
  .then(async () => {
    const rendererPath = join(app.getAppPath(), 'index.html'),
      rendererUrl = pathToFileURL(rendererPath).href;
    window = new BrowserWindow({
      title: 'kite',
      width: 1100,
      height: 780,
      ...(process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 13, y: 19 } }
        : {}),
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#191919' : '#fafafa',
      webPreferences: {
        preload: join(app.getAppPath(), 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    const updateSystemBackground = () => {
      if (window && !window.isDestroyed())
        window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#191919' : '#fafafa');
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
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; connect-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
          ],
        },
      }),
    );
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
    window.once('ready-to-show', () => window?.show());
    await window.loadFile(rendererPath);
  })
  .catch(() => {
    dialog.showErrorBox('kite 无法启动', '原生调用者初始化失败。请核对发行资源。');
    app.exit(1);
  });
app.on('activate', () => {
  window?.show();
  window?.focus();
});
app.on('before-quit', (event) => {
  if (exitAllowed) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
  }
  void (async () => {
    const active = caller
      ? await inspectNativeQuitWork((signal) => caller!.hasActiveWork(signal), 2000)
      : !!opening;
    if (active) {
      const result = await dialog.showMessageBox(window!, {
        type: 'warning',
        message: '仍有活动工作，或尚不能完整核实。退出会停止本应用拥有的服务。',
        buttons: ['保留服务', '退出'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) {
        quitting = false;
        return;
      }
    }
    const outcome = await settleDesktopQuit({
      async closeService() {
        await opening?.catch(() => {});
        await caller?.close();
        privateData?.close();
        privateAccess?.close();
        await paired?.close();
        if (paired && (await paired.exited) !== 0) throw Error('native_service_cleanup_unverified');
        for (const lease of artifactAccess.reverse()) lease.close();
        artifactAccess = [];
      },
      confirmForceExit: () => showQuitWarning(true),
      warnFailedCleanup: async () => {
        await showQuitWarning(false);
      },
      waitMs: 20000,
    });
    if (outcome === 'force') {
      forceExit();
      return;
    }
    exitAllowed = true;
    app.quit();
  })().catch(() => {
    quitting = false;
    dialog.showErrorBox('服务结果待核实', '无法确认清理完成；没有将未知结果标记为成功。');
  });
});

async function showQuitWarning(stillWaiting: boolean): Promise<boolean> {
  const options = {
    type: 'warning' as const,
    title: stillWaiting ? '服务仍在收尾' : '服务收尾未正常完成',
    message: stillWaiting
      ? '可以继续等待，或强制退出 kite。'
      : 'kite 无法确认服务已安全收尾，仍可退出应用。',
    detail: '强制退出可能中断正在进行的任务。下次启动后请检查会话和文件结果。',
    buttons: stillWaiting ? ['强制退出', '继续等待'] : ['退出应用'],
    defaultId: stillWaiting ? 1 : 0,
    cancelId: stillWaiting ? 1 : 0,
    noLink: true,
  };
  const result =
    window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
  return result.response === 0;
}

function forceExit() {
  try {
    ownedPairedChild?.kill('SIGKILL');
  } finally {
    exitAllowed = true;
    app.exit(1);
  }
}
