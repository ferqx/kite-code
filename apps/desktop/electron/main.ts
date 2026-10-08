import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron';
import { nativeEventChannel } from '../src/native-bridge';
import { acquireNodeArtifactAccess } from './artifact-access';
import { parseNativeAssets, resolveNativeCandidate, verifyNativeAsset } from './native-assets';
import { NativeCaller } from './native-caller';
import { registerNativeIpc, registerNativeThemeIpc } from './native-ipc';
import { spawnNodePairedChild } from './node-process';
import { openPrivateData, type PrivateData } from './private-data';
import { acquireDesktopProfileAccess, type DesktopProfileAccess } from './profile-access';
import { assertNativeSqliteEngine } from './sqlite-engine';

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
if (candidate && process.platform === 'win32')
  throw Object.assign(
    Error(
      'native_windows_bootstrap_unqualified: Windows 正式候选尚未具备加载前绑定原生资产身份的资格，已停止启动。',
    ),
    { code: 'native_windows_bootstrap_unqualified' },
  );
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
let privateData: PrivateData | undefined;
let privateAccess: DesktopProfileAccess | undefined;
let artifactAccess: { close(): void }[] = [];
let quitting = false,
  exitAllowed = false;
async function openCaller(): Promise<NativeCaller> {
  if (quitting) throw Error('native_draining');
  if (caller) return caller;
  opening ??= (async () => {
    if (formalAssets) {
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
      spawnChild: spawnNodePairedChild,
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
    );
    return caller;
  })().catch(async (error) => {
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
  void (async () => {
    const active = caller ? await caller.hasActiveWork().catch(() => true) : !!opening;
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
    await opening?.catch(() => {});
    await caller?.close();
    privateData?.close();
    privateAccess?.close();
    await paired?.close();
    for (const lease of artifactAccess.reverse()) lease.close();
    artifactAccess = [];
    exitAllowed = true;
    app.quit();
  })().catch(() => {
    quitting = false;
    dialog.showErrorBox('服务结果待核实', '无法确认清理完成；没有将未知结果标记为成功。');
  });
});
