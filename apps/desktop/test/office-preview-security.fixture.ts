/** Isolated hostile-render fixture: production Chromium/session/IPC boundaries, no converter or user files. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BaseWindow, WebContentsView, webContents } from 'electron';
import JSZip from 'jszip';
import type { NativeRootWindow } from '../electron/native-root-window';
import { NativeOutputPreview, registerOutputPreviewScheme } from '../electron/output-preview';

const root = resolve(process.argv[2]!);
registerOutputPreviewScheme();
// Keep Main alive until the owned teardown receipt has been flushed.
app.on('window-all-closed', () => {});
app.setPath('userData', join(root, 'profile'));
app.setPath('crashDumps', join(root, 'crash'));
app.setPath('downloads', join(root, 'downloads'));
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (message) => {
    if (message.level === 'error') console.error('preview-console', message.message);
  });
});
const checks: string[] = [];
// Electron exposes this diagnostic on the actual object, outside its public TS surface.
// This narrow adapter exists only in the isolated fixture, never product code.
function webPreferences(contents: unknown) {
  return (
    contents as {
      getLastWebPreferences(): {
        sandbox?: boolean;
        contextIsolation?: boolean;
        nodeIntegration?: boolean;
        preload?: string;
      };
    }
  ).getLastWebPreferences();
}
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const pause = () => new Promise((resolve) => setTimeout(resolve, 60));
async function hostileDeck() {
  const archive = new JSZip();
  const p = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const a = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  archive.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  );
  archive.file(
    'ppt/presentation.xml',
    `<p:presentation xmlns:p="${p}" xmlns:r="${r}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="6096000" cy="3429000"/></p:presentation>`,
  );
  archive.file(
    'ppt/_rels/presentation.xml.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${r}/slide" Target="slides/slide1.xml"/></Relationships>`,
  );
  archive.file(
    'ppt/slides/slide1.xml',
    `<p:sld xmlns:p="${p}" xmlns:a="${a}" showMasterSp="0"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Source shape"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="95250" y="95250"/><a:ext cx="4000000" cy="500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>&lt;script&gt;window.attackStarted=true&lt;/script&gt;</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
  );
  archive.file('ppt/private.txt', 'This package member has no preview URL.');
  return archive.generateAsync({ type: 'nodebuffer' });
}
void app
  .whenReady()
  .then(async () => {
    const window = new BaseWindow({ width: 1000, height: 700, show: false });
    const primary = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.contentView.addChildView(primary);
    await primary.webContents.loadURL('data:text/html,<p>fixture owner</p>');
    Object.defineProperty(window, 'webContents', { value: primary.webContents });
    const preview = new NativeOutputPreview();
    let passed = false;
    try {
      assert.equal(app.commandLine.hasSwitch('no-sandbox'), false);
      assert.equal(window.isVisible(), false);
      const body = await hostileDeck();
      const sourceHash = hash(body);
      const target = {
        storeId: 'store',
        sessionId: 'session',
        fileId: 'A',
        locator: { kind: 'delivery' as const, key: 'delivery/A' },
      };
      const open = (id: string) =>
        preview.open({
          id,
          generation: 1,
          target: { ...target, fileId: id },
          window: window as NativeRootWindow,
          bounds: { x: 0, y: 0, width: 900, height: 600 },
          check() {},
          async materialize(path) {
            await writeFile(path, body, { flag: 'wx' });
            return {
              ...target,
              fileId: id,
              ownerRunId: 'seed',
              name: `${id}.pptx`,
              mediaType: 'application/octet-stream',
              size: String(body.length),
              publishedAt: new Date().toISOString(),
              sourceHash,
            };
          },
        });
      await open('A');
      const document = window.contentView.children.at(-1) as WebContentsView;
      const contents = document.webContents,
        origin = `kite-preview://${new URL(contents.getURL()).host}`;
      const preferences = webPreferences(contents);
      assert.equal(preferences.sandbox, true);
      assert.equal(preferences.contextIsolation, true);
      assert.equal(preferences.nodeIntegration, false);
      assert.ok(!preferences.preload);
      assert.match(
        await contents.executeJavaScript(
          'document.querySelector(".slide [data-path]").textContent',
        ),
        /<script>window\.attackStarted=true<\/script>/,
      );
      assert.equal(
        await contents.executeJavaScript('typeof require + ":" + typeof process'),
        'undefined:undefined',
      );
      await contents.executeJavaScript(`(() => {
      const script=document.createElement('script');script.textContent='window.attackStarted=true';document.head.append(script);
      window.kiteOfficeInteraction = {read:()=>({selection:{kind:'powerpoint',slide:999},
        sourceHash:'forged',target:{fileId:'other'},inlineRequest:{requestId:'attack',prompt:'send'}})};
      window.kiteOfficeRequest = {read:()=>({cancelled:false,pending:{serial:1,prompt:'forged'}})};
      const shape=document.querySelector('[data-path]');
      shape.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));
      shape.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2}));
      document.querySelectorAll('button').forEach(b=>b.click());
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      document.dispatchEvent(new KeyboardEvent('keydown',{ctrlKey:true,shiftKey:true,code:'KeyX',bubbles:true}));
    })()`);
      assert.equal(await contents.executeJavaScript('typeof window.attackStarted'), 'undefined');
      checks.push('normal-sandbox-native-preview-and-script-free-source');
      const attack = await preview.readInteraction('A', 1);
      assert.equal(attack.selection, null);
      assert.equal(attack.inlineRequest, undefined);
      assert.equal(attack.requestOpen, false);
      assert.equal(attack.target.fileId, 'A');
      assert.equal(attack.sourceHash, sourceHash);
      checks.push('main-world-forged-controller-and-synthetic-input-cannot-request');

      const privateFile = join(root, 'not-in-manifest.txt');
      await writeFile(privateFile, 'fixture-private-marker', { flag: 'wx' });
      for (const url of [
        'https://example.invalid/office-preview',
        'http://127.0.0.1:9/',
        pathToFileURL(privateFile).href,
        'file://preview-test.invalid/share/marker',
        'kite-preview://other-origin/index.html',
        `${origin}/missing`,
        `${origin}/%2e%2e/not-in-manifest.txt`,
        `${origin}/%2Fnot-in-manifest.txt`,
      ]) {
        const blocked = await contents.executeJavaScript(
          `fetch(${JSON.stringify(url)}).then(()=>false,()=>true)`,
        );
        assert.equal(blocked, true, url);
      }
      // Main's session fetch tests the production closed manifest independent of CSP.
      const allowed = await contents.session.fetch(`${origin}/presentation.pptx`);
      assert.equal(allowed.status, 200);
      assert.equal(hash(Buffer.from(await allowed.arrayBuffer())), sourceHash);
      for (const [url, method] of [
        [`${origin}/missing`, 'GET'],
        [`${origin}/presentation.pptx`, 'POST'],
        [`${origin}/ppt/private.txt`, 'GET'],
        ['kite-preview://other-origin/index.html', 'GET'],
        [`${origin}/%2e%2e/not-in-manifest.txt`, 'GET'],
      ]) {
        const response = await contents.session.fetch(url!, { method }).catch(() => undefined);
        assert.equal(response?.ok ?? false, false);
      }
      assert.equal(
        await contents.executeJavaScript('window.open("https://example.invalid/") === null'),
        true,
      );
      const frameFailures: number[] = [];
      contents.on('did-fail-load', (_event, code, _message, url, mainFrame) => {
        if (!mainFrame && url === `${origin}/index.html`) frameFailures.push(code);
      });
      await contents.executeJavaScript(`(() => {
      const frame=document.createElement('iframe'); frame.src='${origin}/index.html';document.body.append(frame);
      const link=document.createElement('a');link.href='${origin}/presentation.pptx';link.download='forbidden.pptx';link.click();
    })()`);
      await pause();
      assert.equal(contents.getURL(), `${origin}/index.html`);
      assert.ok(frameFailures.includes(-30), 'iframe rejected with ERR_BLOCKED_BY_CSP');
      checks.push('network-local-file-unc-cross-origin-path-method-popup-frame-denied');

      // An authorized host action may open a form; document scripts still cannot fill/send/read it.
      await preview.control('A', 1, { kind: 'request-edit' });
      const opened = await preview.readInteraction('A', 1);
      assert.equal(opened.requestOpen, true);
      assert.equal(opened.inlineRequest, undefined);
      const trusted = window.contentView.children.at(-1) as WebContentsView;
      const trustedContents = trusted.webContents;
      assert.notEqual(trusted, document);
      assert.notEqual(trustedContents.session, contents.session);
      assert.equal(webPreferences(trustedContents).sandbox, true);
      assert.ok(!webPreferences(trustedContents).preload);
      assert.equal(
        await trustedContents.executeJavaScript('typeof kiteOfficeRequest'),
        'undefined',
      );
      await trustedContents.executeJavaScript(`(() => {
      const input=document.querySelector('textarea');input.value='trusted-input-marker';
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      document.querySelector('[data-send]').click();
    })()`);
      await contents.executeJavaScript(`(() => {
      window.kiteOfficeRequest.pending={serial:100,prompt:'forged'};
      window.postMessage({method:'submit',prompt:'forged'},'*');
      document.querySelector('[data-path]').setAttribute('data-path','/slide[999]/evil');
      document.querySelector('[data-path]').textContent='replacement';
    })()`);
      const pending = await preview.readInteraction('A', 1);
      assert.equal(pending.inlineRequest, undefined);
      assert.equal(
        await contents.executeJavaScript(
          'document.body.textContent.includes("trusted-input-marker")',
        ),
        false,
      );
      assert.equal(
        await trustedContents.executeJavaScript('document.querySelector("textarea").value'),
        'trusted-input-marker',
      );
      assert.equal(
        await trustedContents.executeJavaScript(
          'fetch("https://example.invalid/").then(()=>false,()=>true)',
        ),
        true,
      );
      checks.push('separate-script-free-input-not-readable-or-submittable-by-document');

      const oldSession = contents.session;
      await open('B');
      assert.equal(contents.isDestroyed(), true);
      assert.equal(trustedContents.isDestroyed(), true);
      await assert.rejects(preview.readInteraction('A', 1), /preview_replaced/);
      await assert.rejects(
        preview.settleRequest('A', 1, 'attack', { status: 'accepted' }),
        /preview_replaced/,
      );
      const current = await preview.readInteraction('B', 1);
      assert.equal(current.target.fileId, 'B');
      assert.equal(current.inlineRequest, undefined);
      assert.equal(current.requestOpen, false);
      assert.equal(
        (await oldSession.fetch(`${origin}/index.html`).catch(() => undefined))?.ok ?? false,
        false,
      );
      checks.push('replacement-retires-old-document-input-resource-and-request');
      assert.equal(await readFile(privateFile, 'utf8'), 'fixture-private-marker');
      assert.deepEqual(await readdir(join(root, 'downloads')), []);
      passed = true;
    } catch (error) {
      console.error(error);
    } finally {
      preview.close();
      primary.webContents.close();
      window.destroy();
      await pause();
      const viewsDestroyed = webContents.getAllWebContents().length === 0;
      await writeFile(
        join(root, 'receipt.json'),
        JSON.stringify({
          passed,
          checks,
          viewsDestroyed,
          normalSandbox: !app.commandLine.hasSwitch('no-sandbox'),
          windowWasHidden: true,
        }),
      );
      app.exit(passed && viewsDestroyed ? 0 : 1);
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
