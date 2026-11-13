/** Isolated real IPC/Service integration. Never a production entry point. */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@kite-ai/client';
import { app, BrowserWindow, type IpcMain, ipcMain, nativeTheme } from 'electron';
import { NativeCaller } from '../electron/native-caller';
import { registerNativeIpc } from '../electron/native-ipc';
import { NativeOfficeRequestView } from '../electron/office-request-view';
import { registerOutputPreviewScheme } from '../electron/output-preview';
import { openPrivateData } from '../electron/private-data';
import { acquireDesktopProfileAccess } from '../electron/profile-access';
import { nativeEventChannel } from '../src/native-bridge';

const root = resolve(process.argv.find((a) => a.startsWith('--fixture-root='))!.slice(15));
const repo = resolve(root, '../repo');
const allowedRoots = [
  'inline-service-5',
  'inline-formats-word-1',
  'inline-formats-word-2',
  'inline-formats-excel-1',
  'inline-formats-ppt-1',
  'inline-edit-word-1',
  'inline-edit-word-2',
  'inline-edit-word-3',
  'inline-edit-word-4',
  'inline-edit-word-5',
  'inline-edit-excel-1',
  'inline-edit-excel-2',
  'inline-edit-excel-3',
  'inline-edit-excel-4',
  'inline-edit-ppt-1',
  'inline-edit-ppt-2',
  'inline-edit-ppt-3',
  'inline-edit-ppt-4',
  'inline-range-excel-1',
  'inline-sheet-excel-1',
  'inline-page-ppt-1',
  'inline-page-word-1',
  'inline-edit-ppt-5',
  'inline-style-excel-1',
  'inline-style-excel-2',
  'inline-style-excel-3',
  'inline-style-excel-4',
  'inline-style-excel-5',
  'inline-style-excel-6',
  'inline-style-excel-7',
  'inline-style-excel-8',
  'inline-style-excel-9',
  'inline-style-word-1',
  'inline-style-ppt-1',
].map((name) => resolve(repo, '..', name));
if (!allowedRoots.includes(root)) throw Error('fixture_root_invalid');
const keyboardOnly = root !== resolve(repo, '../inline-service-5');
nativeTheme.themeSource = 'light';
registerOutputPreviewScheme();
app.setPath('userData', join(root, 'electron-profile'));
const hashFile = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
void (async () => {
  const setup = JSON.parse(await readFile(join(root, 'bootstrap.json'), 'utf8'));
  if (keyboardOnly && setup.keyboardOnly !== true) throw Error('keyboard_fixture_required');
  const profile = { dataRoot: setup.profile.dataRoot, profile: setup.profile.profile };
  if (resolve(profile.dataRoot) !== join(root, 'data')) throw Error('fixture_profile_invalid');
  const bun = 'D:\\nvm\\v24.15.0\\node_modules\\bun\\bin\\bun.exe';
  const helper = join(root, 'app/profile-access.js');
  const native = resolve(repo, '../native-inline-readonly/windows-access.node');
  const access = await acquireDesktopProfileAccess({
    profile,
    bunExecutable: bun,
    bunSha256: hashFile(bun),
    helperPath: helper,
    helperSha256: hashFile(helper),
    windowsAsset: {
      path: native,
      sha256: '1f5eabc56da6cb67bdead6e2b7f37c130046987106ad9285065421c97e695f5b',
    },
  });
  const data = openPrivateData(join(profile.dataRoot, profile.profile), access);
  const client = createClient({
    endpoint: setup.endpoint,
    token: setup.bootstrap.token,
    bootstrap: setup.bootstrap,
    expected: {
      profile: setup.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['commands', 'output_files', 'input_files'],
    },
  });
  await client.connect();
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    show: true,
    title: 'Kite · Windows Office real Service verification',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(root, 'app/preload.cjs'),
    },
  });
  const events: unknown[] = [];
  let writes = Promise.resolve();
  const log = (event: object) => {
    events.push({ time: new Date().toISOString(), ...event });
    writes = writes.then(() =>
      writeFile(join(root, 'ui-events.json'), JSON.stringify(events, null, 2)),
    );
  };
  // Test-only passive observer. It never dispatches events, changes focus or exposes a bridge.
  // Capture native composition ordering separately from logical user submissions.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-finish-load', () => {
      if (
        !contents.getURL().startsWith('data:text/html,') ||
        !window.contentView.children.some(
          (child) => (child as import('electron').WebContentsView).webContents === contents,
        )
      )
        return;
      contents.on('console-message', (_event, _level, message) => {
        if (message.startsWith('KITE_FIXTURE_INPUT_EVENT:')) {
          try {
            log({
              phase: 'input-event',
              viewId: contents.id,
              event: JSON.parse(message.slice(25)),
            });
          } catch (error) {
            log({ fixtureObserverError: String(error) });
          }
        }
      });
      void contents
        .executeJavaScriptInIsolatedWorld(1015, [
          {
            code: `(() => {
              let count = 0;
              for (const type of ['compositionstart','compositionupdate','compositionend','keydown','keyup','beforeinput','input']) {
                document.addEventListener(type, (event) => {
                  if (!(event.target instanceof HTMLTextAreaElement) || count >= 1024) return;
                  count += 1;
                  console.log('KITE_FIXTURE_INPUT_EVENT:' + JSON.stringify({
                    index: count, limit: 1024, type: event.type, trusted: event.isTrusted, key: event.key,
                    code: event.code, keyCode: event.keyCode, isComposing: event.isComposing,
                    inputType: event.inputType, data: event.data, repeat: event.repeat,
                    value: event.target.value, stamp: event.timeStamp
                  }));
                }, true);
              }
              return 'observer-ready';
            })()`,
          },
        ])
        .then(() => log({ phase: 'input-observer-ready', viewId: contents.id }))
        .catch((error) => log({ fixtureObserverError: String(error) }));
    });
  });
  const caller = new NativeCaller(
    client,
    (e) => {
      if (!window.isDestroyed()) window.webContents.send(nativeEventChannel, e);
    },
    data,
    [profile.dataRoot],
  );
  const assets = join(repo, 'packages/agent/dist/tools/documents/office-assets');
  caller.configureOfficeRuntime(assets);
  let lastInteraction = '';
  const loggedIpc = {
    handle(channel, handler) {
      ipcMain.handle(channel, async (event, request) => {
        const track = [
          'submit',
          'input.files.fromOutput',
          'draft.write',
          'draft.read',
          'outputs.preview.open',
          'outputs.info',
          'outputs.query',
          'outputs.preview.request.result',
        ].includes(request?.method);
        if (track) log({ phase: 'request', request });
        if (keyboardOnly && request?.method === 'submit') await captureViews('auto-sending');
        const result = await handler(event, request);
        if (keyboardOnly && request?.method === 'outputs.preview.interaction') {
          const snapshot = JSON.stringify(result);
          if (snapshot !== lastInteraction) {
            lastInteraction = snapshot;
            log({ phase: 'interaction', result });
          }
        }
        if (track) log({ phase: 'reply', method: request.method, result });
        return result;
      });
    },
    removeHandler(channel) {
      ipcMain.removeHandler(channel);
    },
  } as IpcMain;
  const unregister = registerNativeIpc({
    ipcMain: loggedIpc,
    window: () => window,
    rendererUrl: pathToFileURL(join(root, 'app/index.html')).href,
    officeAssetsRoot: assets,
    caller: async () => caller,
  });
  window.webContents.on('console-message', (_event, _level, message) =>
    log({ rendererConsole: message }),
  );
  window.webContents.on('render-process-gone', (_event, details) => log({ rendererGone: details }));
  await window.loadFile(join(root, 'app/index.html'));
  window.show();
  async function captureViews(stage: string) {
    await writeFile(
      join(root, `${stage}-toolbar.png`),
      (await window.webContents.capturePage()).toPNG(),
    );
    for (const child of window.contentView.children) {
      const view = child as import('electron').WebContentsView;
      if (view.webContents && view.webContents !== window.webContents) {
        const name = view.webContents.getURL().startsWith('data:') ? 'input' : 'preview';
        await writeFile(
          join(root, `${stage}-${name}.png`),
          (await view.webContents.capturePage()).toPNG(),
        );
      }
    }
  }
  async function previewSnapshot() {
    const view = (window.contentView.children as import('electron').WebContentsView[]).find((v) =>
      v.webContents?.getURL().startsWith('kite-preview:'),
    );
    if (!view) return null;
    return view.webContents.executeJavaScriptInIsolatedWorld(1016, [
      {
        code: `(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ALL);
      let nodes = 0; while (walker.nextNode() && nodes <= 50000) nodes++;
      const paths = document.querySelectorAll('[data-path]');
      const bar = document.querySelector('.kite-excel-value');
      const selection = window.getSelection();
      const textSelection = {length:(selection?.toString()||'').length,text:(selection?.toString()||'').slice(0,4096),
        rangeCount:selection?.rangeCount??0,activeIsValue:document.activeElement===bar,
        anchorInValue:!!(bar && selection?.anchorNode && bar.contains(selection.anchorNode)),
        focusInValue:!!(bar && selection?.focusNode && bar.contains(selection.focusNode)),
        value:(bar?.textContent||'').slice(0,4096)};
      const scrollAreas = Array.from(document.querySelectorAll('.table-wrapper')).slice(0,16)
        .map(e=>({left:e.scrollLeft,top:e.scrollTop,width:e.clientWidth,height:e.clientHeight,
          scrollWidth:e.scrollWidth,scrollHeight:e.scrollHeight,visible:!!e.getClientRects().length}));
      const summary = (e) => ({tag:e.tagName,id:e.id,text:(e.textContent||'').slice(0,100),
        path:e.getAttribute('data-path'),sheet:e.getAttribute('data-sheet'),
        role:e.getAttribute('role'),display:getComputedStyle(e).display});
      return {evidenceKind:'read-only-document-snapshot',textSelection,scrollAreas,nodes,nodeBudget:50000,
        paths:paths.length,pathBudget:10000,visibility:document.visibilityState,
        wordPagination:{state:document.documentElement.getAttribute('data-kite-word-pagination-state'),
          generation:document.documentElement.getAttribute('data-kite-word-pagination-generation'),
          pageCount:document.querySelectorAll('.page').length,
          pages:Array.from(document.querySelectorAll('.page')).slice(0,20).map((page,i)=>({page:i+1,
            blocks:Array.from(page.querySelectorAll('[data-path]')).slice(0,256).map(e=>({path:e.getAttribute('data-path'),text:(e.textContent||'').slice(0,4096)}))}))},
        tables:Array.from(document.querySelectorAll('table')).slice(0,16).map(summary),
        tabs:Array.from(document.querySelectorAll('[role=tab],.sheet-tab,.tab')).slice(0,32).map(summary),
        rangeStatus:document.querySelector('.kite-office-range-status')?.textContent??null,
        selected:Array.from(document.querySelectorAll('[data-kite-selected]')).slice(0,256).map(summary)};
    })()`,
      },
    ]);
  }
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || !existsSync(join(root, 'ui-command.json'))) return;
    busy = true;
    try {
      const command = JSON.parse(await readFile(join(root, 'ui-command.json'), 'utf8'));
      await rename(join(root, 'ui-command.json'), join(root, `ui-command-${Date.now()}.json`));
      if (command.kind === 'security') {
        const documentView = (
          window.contentView.children as import('electron').WebContentsView[]
        ).find((v) => v.webContents?.getURL().startsWith('kite-preview:'));
        assert.ok(documentView, 'real Office preview is required');
        const anchor = await documentView.webContents.executeJavaScript(
          "(()=>{const e=document.querySelector('[data-path*=shape]');if(!e)throw Error('source_object_missing');const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()",
        );
        const requestView = new NativeOfficeRequestView(window, anchor);
        try {
          await requestView.open(documentView.getBounds(), '程序集成安全校验 · 不发送请求');
          const inputView = (
            window.contentView.children as import('electron').WebContentsView[]
          ).find((v) => v.webContents?.getURL().startsWith('data:text/html,'));
          assert.ok(inputView, 'input View was constructed');
          assert.notEqual(inputView.webContents.session, documentView.webContents.session);
          const checks: string[] = [];
          for (const [name, view] of [
            ['input', inputView],
            ['preview', documentView],
          ] as const) {
            const prefs = (
              view.webContents as unknown as {
                getLastWebPreferences(): {
                  sandbox?: boolean;
                  contextIsolation?: boolean;
                  nodeIntegration?: boolean;
                  preload?: string;
                  webSecurity?: boolean;
                };
              }
            ).getLastWebPreferences();
            assert.equal(prefs.sandbox, true);
            assert.equal(prefs.contextIsolation, true);
            assert.equal(prefs.nodeIntegration, false);
            assert.ok(!prefs.preload);
            checks.push(`${name}:sandbox+contextIsolation+noNode+noPreload`);
            assert.deepEqual(
              await view.webContents.executeJavaScript(
                '[typeof require,typeof process,typeof window.kiteNative,typeof window.fixture]',
              ),
              ['undefined', 'undefined', 'undefined', 'undefined'],
            );
            checks.push(`${name}:noMainWorldBridge`);
            assert.equal(
              await view.webContents.executeJavaScript(
                'fetch("https://example.com").then(()=>false,()=>true)',
              ),
              true,
            );
            assert.equal(
              await view.webContents.executeJavaScript(
                'fetch("http://127.0.0.1:1").then(()=>false,()=>true)',
              ),
              true,
            );
            checks.push(`${name}:externalAndLoopbackNetworkDenied`);
          }
          assert.equal(
            await inputView.webContents.executeJavaScript('typeof globalThis.kiteOfficeRequest'),
            'undefined',
          );
          assert.equal(
            await inputView.webContents.executeJavaScript(
              '(()=>{const s=document.createElement("script");s.textContent="window.injected=true";document.body.append(s);return typeof window.injected})()',
            ),
            'undefined',
          );
          assert.equal(
            await documentView.webContents.executeJavaScript(
              'document.querySelector("textarea")===null',
            ),
            true,
          );
          assert.deepEqual(await requestView.read(), { cancelled: false });
          checks.push(
            'input:isolatedWorldOnly',
            'input:CSPPageScriptDenied',
            'preview:noInputDOM',
            'input:noSubmission',
          );
          const proof = {
            ok: true,
            evidenceKind: 'production-view-security-contract-not-keyboard',
            checks,
            sourceUnchanged: hashFile(setup.source) === setup.sourceSha,
          };
          assert.equal(proof.sourceUnchanged, true);
          await writeFile(
            join(root, '04-security-input.png'),
            (await inputView.webContents.capturePage()).toPNG(),
          );
          await writeFile(join(root, 'security-proof.json'), JSON.stringify(proof, null, 2));
          log({ securityProof: proof });
        } finally {
          requestView.close();
        }
      } else if (command.kind === 'observe-performance' && /^[a-zA-Z0-9-]+$/.test(command.stage)) {
        const view = (window.contentView.children as import('electron').WebContentsView[]).find(
          (v) => v.webContents?.getURL().startsWith('kite-preview:'),
        );
        if (!view) throw Error('fixture_preview_required');
        log({ fixturePerformanceStarted: command.stage });
        const frames = await view.webContents.executeJavaScriptInIsolatedWorld(1016, [
          {
            code: `new Promise(resolve => {
          const start=performance.now(); let previous=start,id=0,done=false; const gaps=[];
          function finish(reason) { if(done)return;done=true;clearTimeout(timer);cancelAnimationFrame(id);
            resolve({durationMs:performance.now()-start,gaps,visibility:document.visibilityState,reason}); }
          const timer=setTimeout(()=>finish('wall-clock-limit'),22000);
          function frame(now) { if(done)return;gaps.push(now-previous);previous=now;
            if(now-start<20000 && gaps.length<2400) id=requestAnimationFrame(frame);
            else finish('frame-window-complete');
          }
          id=requestAnimationFrame(frame);
        })`,
          },
        ]);
        await writeFile(
          join(root, `${command.stage}-performance.json`),
          JSON.stringify(
            {
              evidenceKind: 'bounded-read-only-RAF-observation-not-input-or-benchmark',
              frames,
              snapshot: await previewSnapshot(),
            },
            null,
            2,
          ),
        );
        log({ fixturePerformanceFinished: command.stage });
      } else if (command.kind === 'theme' && ['light', 'dark'].includes(command.value)) {
        nativeTheme.themeSource = command.value;
        await window.webContents.executeJavaScript(
          `document.documentElement.dataset.theme=${JSON.stringify(command.value)};document.documentElement.style.colorScheme=${JSON.stringify(command.value)}`,
        );
        log({ fixtureTheme: command.value });
      } else if (command.kind === 'contract') {
        if (keyboardOnly) throw Error('programmatic_submission_disabled');
        const result = await window.webContents.executeJavaScript(
          'globalThis.fixtureOfficeContract?.()',
        );
        if (!result) throw Error('fixture_contract_not_ready');
        await writes;
        await writeFile(
          join(root, 'integration-contract.json'),
          JSON.stringify({ result, state: caller.state(), events }, null, 2),
        );
      } else if (command.kind === 'capture' && /^[a-zA-Z0-9-]+$/.test(command.stage)) {
        const stage = command.stage;
        await captureViews(stage);
        await writes;
        await writeFile(
          join(root, `${stage}.json`),
          JSON.stringify(
            {
              state: caller.state(),
              events,
              dom: await window.webContents.executeJavaScript('document.body.innerText'),
              previewSnapshot: await previewSnapshot(),
              keyboardOnly,
              contractExposed: await window.webContents.executeJavaScript(
                "typeof globalThis.fixtureOfficeContract !== 'undefined'",
              ),
              callbackEvidence: await window.webContents.executeJavaScript(
                'globalThis.fixtureOfficeEvidence?.() ?? []',
              ),
            },
            null,
            2,
          ),
        );
      } else if (command.kind === 'close') {
        clearInterval(timer);
        unregister();
        await caller.close();
        await writes;
        data.close();
        access.close();
        window.destroy();
        app.quit();
      }
    } catch (error) {
      log({ fixtureError: String(error) });
    } finally {
      busy = false;
    }
  }, 200);
  console.log('WINDOWS_REAL_SERVICE_UI_READY', process.pid);
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
