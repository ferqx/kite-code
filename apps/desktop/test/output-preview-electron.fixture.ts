/** Explicit isolated fixture only. Exercises actual Electron views and converter, not product debug UI. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BaseWindow, WebContentsView } from 'electron';
import type { NativeRootWindow } from '../electron/native-root-window';
import { NativeOutputPreview, registerOutputPreviewScheme } from '../electron/output-preview';

registerOutputPreviewScheme();
const directory = process.env.KITE_PREVIEW_FIXTURE_DIRECTORY!;
app.setPath('userData', join(directory, 'profile'));
void app.whenReady().then(async () => {
  await mkdir(directory, { recursive: true });
  const root = new BaseWindow({ width: 1000, height: 700, show: true });
  const primary = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  root.contentView.addChildView(primary);
  primary.setBounds({ x: 0, y: 0, width: 1000, height: 700 });
  await primary.webContents.loadURL(
    'data:text/html,<body><textarea id="draft">keep draft</textarea><p>conversation retained</p>',
  );
  const window = root as NativeRootWindow;
  Object.defineProperty(window, 'webContents', { value: primary.webContents });
  const preview = new NativeOutputPreview(process.env.KITE_PREVIEW_FIXTURE_ASSETS);
  async function observe(stage: string, view: WebContentsView) {
    await view.webContents.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    await writeFile(
      join(directory, `${stage}.png`),
      (await view.webContents.capturePage()).toPNG(),
    );
    await writeFile(
      join(directory, 'stage.json'),
      JSON.stringify({ stage, pid: process.pid, url: view.webContents.getURL() }),
    );
    if (process.env.KITE_PREVIEW_FIXTURE_OBSERVE === '1') {
      const deadline = Date.now() + 600_000;
      while (true) {
        try {
          await access(join(directory, `${stage}.continue`));
          break;
        } catch {}
        if (Date.now() > deadline) throw Error(`observation_timeout:${stage}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  const target = {
    storeId: 'store',
    sessionId: 'session',
    fileId: 'file',
    locator: { kind: 'delivery' as const, key: 'delivery/00000000000000000001/job/file' },
  };
  const snapshots: string[] = [];
  const timings: { source: string; firstMs: number; repeatedMs: number; katexNodes: number }[] = [];
  try {
    const text = 'A saved report\n中文和空格\n';
    await preview.open({
      id: 'text',
      generation: 1,
      target,
      bounds: { x: 500, y: 80, width: 480, height: 600 },
      window,
      check() {},
      async materialize(path) {
        await writeFile(path, text);
        return {
          ...target,
          name: '报告.txt',
          mediaType: 'text/plain',
          size: String(Buffer.byteLength(text)),
          ownerRunId: 'run',
          publishedAt: new Date().toISOString(),
        };
      },
    });
    const view = root.contentView.children.at(-1) as WebContentsView;
    assert.notEqual(view, primary);
    assert.deepEqual(
      await view.webContents.executeJavaScript(
        '[typeof require,typeof process,typeof window.kiteNative]',
      ),
      ['undefined', 'undefined', 'undefined'],
    );
    assert.match(
      await view.webContents.executeJavaScript('document.body.textContent'),
      /中文和空格/,
    );
    assert.equal(
      await primary.webContents.executeJavaScript('document.querySelector("textarea").value'),
      'keep draft',
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
    assert.equal(
      await view.webContents.executeJavaScript(
        'fetch("file:///etc/passwd").then(()=>false,()=>true)',
      ),
      true,
    );
    assert.equal(
      await view.webContents.executeJavaScript('window.open("https://example.com")===null'),
      true,
    );
    const oldURL = view.webContents.getURL();
    await view.webContents.executeJavaScript('location.href="https://example.com"');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(view.webContents.getURL(), oldURL);
    await observe('text', view);
    snapshots.push('text.png');
    preview.close('wrong-id');
    assert.equal(view.webContents.isDestroyed(), false);
    preview.close('text');
    assert.equal(root.contentView.children.length, 1);
    const sources: string[] = process.env.KITE_PREVIEW_FIXTURE_SOURCES
      ? JSON.parse(process.env.KITE_PREVIEW_FIXTURE_SOURCES)
      : process.env.KITE_PREVIEW_FIXTURE_SOURCE
        ? [process.env.KITE_PREVIEW_FIXTURE_SOURCE]
        : [];
    for (const [index, source] of sources.entries()) {
      const bytes = await readFile(source);
      const request: Parameters<NativeOutputPreview['open']>[0] = {
        id: `office-${index}`,
        generation: 1,
        target: { ...target, fileId: `office-${index}` },
        bounds: { x: 400, y: 80, width: 580, height: 600 },
        window,
        check() {},
        async materialize(path) {
          await copyFile(source, path);
          return {
            ...target,
            fileId: `office-${index}`,
            name: source.split('/').at(-1)!,
            mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            size: String(bytes.length),
            sourceHash: createHash('sha256').update(bytes).digest('hex'),
            ownerRunId: 'run',
            publishedAt: new Date().toISOString(),
          };
        },
      };
      const started = performance.now();
      await preview.open(request);
      const firstMs = performance.now() - started;
      const office = root.contentView.children.at(-1) as WebContentsView;
      assert.match(
        await office.webContents.executeJavaScript('document.documentElement.outerHTML'),
        /<html/i,
      );
      assert.deepEqual(
        await office.webContents.executeJavaScript(
          '[typeof require,typeof process,typeof window.kiteNative]',
        ),
        ['undefined', 'undefined', 'undefined'],
      );
      const stage = `office-${index}-${source.split('.').at(-1)}`;
      await writeFile(
        join(directory, `${stage}.html`),
        await office.webContents.executeJavaScript('document.documentElement.outerHTML'),
      );
      await observe(stage, office);
      const katexNodes = await office.webContents.executeJavaScript(
        'document.querySelectorAll(".katex").length',
      );
      if (source.includes('math.')) assert.ok(katexNodes > 0, 'offline_math_must_render');
      snapshots.push(`${stage}.png`);
      preview.close(`office-${index}`);
      assert.equal(root.contentView.children.length, 1);
      const repeated = performance.now();
      await preview.open({ ...request, id: `repeat-${index}` });
      const repeatedMs = performance.now() - repeated;
      preview.close(`repeat-${index}`);
      timings.push({ source, firstMs, repeatedMs, katexNodes });
    }
    assert.equal(
      await primary.webContents.executeJavaScript('document.querySelector("textarea").value'),
      'keep draft',
    );
    await assert.rejects(
      preview.open({
        id: 'unsupported',
        generation: 1,
        target,
        bounds: { x: 400, y: 80, width: 580, height: 600 },
        window,
        check() {},
        async materialize(path) {
          await writeFile(path, 'unpreviewable');
          return {
            ...target,
            name: 'data.bin',
            mediaType: 'application/octet-stream',
            size: '13',
            ownerRunId: 'run',
            publishedAt: new Date().toISOString(),
          };
        },
      }),
      /preview_format_unavailable/,
    );
    assert.equal(root.contentView.children.length, 1);
    assert.equal(
      await primary.webContents.executeJavaScript('document.querySelector("textarea").value'),
      'keep draft',
    );
    await observe('closed-retained-draft', primary);
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify(
        {
          passed: true,
          electron: process.versions.electron,
          snapshots,
          timings,
          checks: [
            'isolated view',
            'native bridge absent',
            'network denied',
            'localhost denied',
            'file denied',
            'new window denied',
            'navigation denied',
            'exact close id',
            'retained draft',
          ],
        },
        null,
        2,
      ),
    );
    root.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    preview.close();
    root.destroy();
    app.exit(1);
  }
});
