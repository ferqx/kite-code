import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { officeEnvironment } from '@kite-ai/agent/documents';
import { app, BrowserWindow, ipcMain } from 'electron';
import { NativeOutputPreview, registerOutputPreviewScheme } from '../electron/output-preview';

// Isolated component fixture only. Production renderer and NativeOutputPreview,
// synthetic immutable source, no Service/Provider or local Office mutation API.
const root = resolve(process.argv.find((a) => a.startsWith('--fixture-root='))!.slice(15));
const repo = resolve(root, '../repo');
const assetsRoot = join(repo, 'packages/agent/dist/tools/documents/office-assets');
registerOutputPreviewScheme();
app.setPath('userData', join(root, 'electron-profile'));
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
void (async () => {
  await app.whenReady();
  await mkdir(root, { recursive: true });
  const providedSource = process.argv.find((a) => a.startsWith('--fixture-source='))?.slice(17);
  const source = providedSource ? resolve(providedSource) : join(root, 'Windows-preview.pptx');
  if (providedSource && !existsSync(source)) throw Error('fixture_source_missing');
  if (!existsSync(source)) {
    const args = [
      ['create', source],
      ['add', source, '/', '--type', 'slide'],
      [
        'add',
        source,
        '/slide[1]',
        '--type',
        'textbox',
        '--prop',
        'text=Windows 办公文件预览',
        '--prop',
        'x=2cm',
        '--prop',
        'y=2cm',
        '--prop',
        'width=20cm',
        '--prop',
        'height=3cm',
      ],
      ['add', source, '/', '--type', 'slide'],
      [
        'add',
        source,
        '/slide[2]',
        '--type',
        'textbox',
        '--prop',
        'text=第二页 · 保留导航与请求修改',
        '--prop',
        'x=2cm',
        '--prop',
        'y=2cm',
        '--prop',
        'width=24cm',
        '--prop',
        'height=3cm',
      ],
      ['set', source, '/slide[2]', '--prop', 'notes=第二页的只读备注。原始文件保持不变。'],
    ];
    for (const a of args) {
      const r = spawnSync(join(assetsRoot, 'officecli.exe'), a, {
        env: { ...process.env, ...officeEnvironment() },
        windowsHide: true,
        encoding: 'utf8',
      });
      if (r.status !== 0) throw Error(r.stderr || r.stdout);
    }
  }
  const original = await readFile(source);
  const target = {
    storeId: 'fixture',
    sessionId: 'fixture',
    fileId: 'fixture',
    locator: { kind: 'delivery' as const, key: 'delivery/00000000000000000001/job/file' },
  };
  const file = {
    ...target,
    name: basename(source),
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    size: String(original.length),
    ownerRunId: 'synthetic-fixture',
    publishedAt: new Date().toISOString(),
    sourceHash: digest(original),
  };
  const window = new BrowserWindow({
    width: 1240,
    height: 840,
    show: true,
    title: 'Kite · Windows inline Office request verification',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(root, 'app/preload.cjs'),
    },
  });
  const preview = new NativeOutputPreview(assetsRoot);
  let stopping = false;
  let outcome: 'accepted' | 'failed' | 'unknown' = 'accepted';
  const events: Record<string, unknown>[] = [];
  const event = (v: Record<string, unknown>) => {
    events.push({ time: new Date().toISOString(), ...v });
    void writeFile(join(root, 'events.json'), JSON.stringify(events, null, 2));
  };
  ipcMain.handle('fixture', async (e, q) => {
    if (e.sender !== window.webContents) throw Error('fixture_sender');
    if (q.method.startsWith('outputs.office.')) {
      event({ FORBIDDEN_REQUEST: q.method });
      throw Error('local_office_mutation_removed');
    }
    try {
      switch (q.method) {
        case 'outputs.info':
          return { kind: 'outputs.info', file };
        case 'outputs.preview.open': {
          const started = performance.now();
          event({ method: q.method, phase: 'started' });
          await preview.open({
            id: q.previewId,
            generation: q.generation,
            target,
            bounds: q.bounds,
            window: window as never,
            check() {},
            async materialize(p) {
              await copyFile(source, p);
              return file;
            },
          });
          event({ method: q.method, phase: 'ready', elapsedMs: performance.now() - started });
          return { kind: 'outputs.preview', status: 'ready' };
        }
        case 'outputs.preview.interaction':
          return {
            kind: 'outputs.preview.interaction',
            interaction: await preview.readInteraction(q.previewId, q.generation, q.consumeRequest),
          };
        case 'outputs.preview.request.result':
          await preview.settleRequest(q.previewId, q.generation, q.requestId, q.outcome);
          event({ method: q.method, requestId: q.requestId, outcome: q.outcome });
          return null;
        case 'outputs.preview.control':
          await preview.control(q.previewId, q.generation, q.control);
          event({ method: q.method, control: q.control });
          return { kind: 'outputs.preview', status: 'ready' };
        case 'outputs.preview.bounds':
          preview.bounds(q.previewId, q.bounds);
          return { kind: 'outputs.preview', status: 'ready' };
        case 'outputs.preview.close':
          preview.closeOwned(q.previewId, q.generation);
          return { kind: 'outputs.preview', status: 'closed' };
        case 'fixture.submit':
          event({ method: q.method, context: q.context, prompt: q.prompt, outcome });
          await new Promise((resolve) => setTimeout(resolve, 750));
          return { status: outcome };
        case 'fixture.reference':
          event({ method: q.method, context: q.context });
          return {};
        case 'fixture.save':
          await copyFile(source, join(root, 'saved-original.pptx'));
          event({
            method: q.method,
            hash: digest(await readFile(join(root, 'saved-original.pptx'))),
          });
          return {};
        default:
          throw Error('fixture_method_unavailable');
      }
    } catch (err) {
      event({ method: q.method, error: String(err) });
      throw err;
    }
  });
  await window.loadFile(join(root, 'app/index.html'));
  window.show();
  async function capture(stage: string) {
    await writeFile(join(root, `${stage}-toolbar.png`), (await window.capturePage()).toPNG());
    let content = '';
    for (const child of window.contentView.children) {
      const v = child as import('electron').WebContentsView;
      if (v.webContents && v.webContents !== window.webContents) {
        await writeFile(
          join(
            root,
            `${stage}-${v.webContents.getURL().startsWith('data:') ? 'input' : 'preview'}.png`,
          ),
          (await v.webContents.capturePage()).toPNG(),
        );
        content = await v.webContents.executeJavaScript('document.body.innerText');
      }
    }
    const state = {
      stage,
      sourceUnchanged: digest(await readFile(source)) === file.sourceHash,
      dom: await window.webContents.executeJavaScript('document.body.innerText'),
      content,
      events: events.slice(-8),
    };
    await writeFile(join(root, `${stage}.json`), JSON.stringify(state, null, 2));
    console.log(JSON.stringify(state));
  }
  let running = false;
  setInterval(async () => {
    if (running || stopping) return;
    const path = join(root, 'command.json');
    if (!existsSync(path)) return;
    running = true;
    try {
      const command = JSON.parse(await readFile(path, 'utf8'));
      await rename(path, join(root, `command-${Date.now()}.json`));
      if (command.kind === 'security') {
        const views = window.contentView.children as import('electron').WebContentsView[];
        const input = views.find((v) => v.webContents?.getURL().startsWith('data:text/html,'));
        const document = views.find((v) => v.webContents?.getURL().startsWith('kite-preview:'));
        assert.ok(input && document, 'open a selected inline input first');
        for (const view of [input, document]) {
          const prefs = (
            view.webContents as unknown as {
              getLastWebPreferences(): {
                sandbox?: boolean;
                contextIsolation?: boolean;
                nodeIntegration?: boolean;
                preload?: string;
              };
            }
          ).getLastWebPreferences();
          assert.equal(prefs.sandbox, true);
          assert.equal(prefs.contextIsolation, true);
          assert.equal(prefs.nodeIntegration, false);
          assert.ok(!prefs.preload);
          assert.deepEqual(
            await view.webContents.executeJavaScript(
              '[typeof require,typeof process,typeof window.kiteNative,typeof window.fixture]',
            ),
            ['undefined', 'undefined', 'undefined', 'undefined'],
          );
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
        }
        assert.equal(
          await input.webContents.executeJavaScript('typeof globalThis.kiteOfficeRequest'),
          'undefined',
        );
        assert.equal(
          await input.webContents.executeJavaScript(
            '(()=>{const s=document.createElement("script");s.textContent="window.injected=true";document.body.append(s);return typeof window.injected})()',
          ),
          'undefined',
        );
        assert.equal(
          await document.webContents.executeJavaScript('document.querySelector("textarea")===null'),
          true,
        );
        event({ method: 'fixture.security', status: 'passed', assertions: 16 });
      } else if (
        command.kind === 'outcome' &&
        ['accepted', 'failed', 'unknown'].includes(command.status)
      )
        outcome = command.status;
      else if (command.kind === 'capture') await capture(command.stage);
      else if (command.kind === 'close') {
        stopping = true;
        preview.dispose();
        window.destroy();
        app.quit();
      }
    } catch (err) {
      console.error(err);
      event({ commandError: String(err) });
    } finally {
      running = false;
    }
  }, 200);
  console.log('WINDOWS_READONLY_FIXTURE_READY', process.pid);
})().catch((e) => {
  console.error(e);
  app.exit(1);
});
