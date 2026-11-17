import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { terminalBundledNotices } from '../../../../scripts/release/terminal-dependencies';
import { buildImageDisplay } from '../../scripts/build-image-display';

// Real Electron Root/isolated preload/IPC/Main/child, without a Service, model or user profile.
// Linux needs its graphical test environment; the pure codec suite remains independent.
const available = process.platform !== 'linux' || !!process.env.DISPLAY;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
test.skipIf(!available)(
  'default display assets resolve from real Electron app before and after relocation',
  async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kite-image-display-bundle-'));
    let directory = join(parent, 'native-build');
    try {
      const built = await buildImageDisplay(directory);
      const source = await sharp({
        create: { width: 96, height: 48, channels: 3, background: '#d8324b' },
      })
        .png()
        .toBuffer();
      const originalHash = sha256(source);
      await writeFile(join(directory, 'source.png'), source);
      await writeFile(
        join(directory, 'index.html'),
        '<!doctype html><html><body><div id="root"></div></body></html>',
      );
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({ name: 'isolated-display-bundle', version: '0.0.0', main: 'main.cjs' }),
      );
      const service = fileURLToPath(
        new URL('../../electron/image-display-service.ts', import.meta.url),
      );
      const host = fileURLToPath(new URL('../../electron/image-display-host.ts', import.meta.url));
      const entry = join(parent, 'entry.ts');
      await writeFile(
        entry,
        `import {app,BrowserWindow,ipcMain} from 'electron';
import {join} from 'node:path';import {readFile,writeFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';
import {createNativeImageDisplayHost} from ${JSON.stringify(host)};
import {disposeImageDisplay} from ${JSON.stringify(service)};
const root=app.getAppPath();app.setPath('userData',join(root,'fixture-profile'));app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{let window;let host;try{
window=new BrowserWindow({show:false,webPreferences:{preload:join(root,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
const url=pathToFileURL(join(root,'index.html')).href;host=createNativeImageDisplayHost({window,rootUrl:url,ipcMain});await window.loadURL(url);
const bytes=await readFile(join(root,'source.png'));
const reply=await window.webContents.executeJavaScript('window.kiteNativeImageDisplay.render({id:"probe",bytes:new Uint8Array('+JSON.stringify([...bytes])+'),mediaType:"image/png",edge:512})');
const region={left:12,top:8,width:24,height:16};
const roi=await window.webContents.executeJavaScript('window.kiteNativeImageDisplay.render({id:"roi-probe",bytes:new Uint8Array('+JSON.stringify([...bytes])+'),mediaType:"image/png",edge:2048,region:'+JSON.stringify(region)+'})');
await writeFile(join(root,'reply.json'),JSON.stringify(reply.ok?{ok:true,width:reply.value.width,height:reply.value.height,mimeType:reply.value.mimeType,bytes:reply.value.bytes.byteLength,roi:roi.ok?{width:roi.value.width,height:roi.value.height,sourceWidth:roi.value.sourceWidth,sourceHeight:roi.value.sourceHeight,region:roi.value.region}:roi}:reply));
host.dispose();await disposeImageDisplay();window.destroy();app.exit(reply.ok&&roi.ok?0:2);
}catch(error){await writeFile(join(root,'reply.json'),JSON.stringify({error:String(error),stack:error?.stack}));host?.dispose();await disposeImageDisplay().catch(()=>{});window?.destroy();app.exit(3);}});`,
      );
      const main = await Bun.build({
        entrypoints: [entry],
        target: 'node',
        format: 'cjs',
        external: ['electron'],
        outdir: directory,
        naming: 'main.cjs',
        define: { __KITE_DESKTOP_IMAGE_DISPLAY__: JSON.stringify(built) },
      });
      expect(main.success).toBe(true);
      const preload = await Bun.build({
        entrypoints: [fileURLToPath(new URL('../../electron/preload.ts', import.meta.url))],
        target: 'node',
        format: 'cjs',
        external: ['electron'],
        outdir: directory,
        naming: 'preload.cjs',
      });
      expect(preload.success).toBe(true);
      const executable = createRequire(import.meta.url)('electron') as string;
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      for (const relocate of [false, true]) {
        if (relocate) {
          const moved = join(parent, 'relocated-native');
          await rename(directory, moved);
          directory = moved;
        }
        const codecRoot = join(directory, 'image-display-codec');
        const paths = await readdir(codecRoot, { recursive: true });
        expect(paths.some((path) => /(?:^|[\\/])node_modules(?:[\\/]|$)/i.test(path))).toBe(false);
        const entries = await readdir(codecRoot, { withFileTypes: true, recursive: true });
        expect(entries.every((entry) => !entry.isSymbolicLink())).toBe(true);
        expect(entries.some((entry) => entry.name.endsWith('.node'))).toBe(true);
        const notices = await readFile(join(codecRoot, 'THIRD_PARTY_BUNDLED.txt'), 'utf8');
        const expected = terminalBundledNotices({
          repositoryRoot: resolve(import.meta.dir, '../../../..'),
          workspaceRoot: resolve(import.meta.dir, '../..'),
          names: ['sharp'],
        });
        for (const pkg of expected.packages) {
          expect(notices).toContain(`${pkg.name} ${pkg.version}`);
          for (const notice of pkg.notices) expect(notices).toContain(notice.text);
        }
        expect(sha256(await readFile(join(directory, built.relativePath)))).toBe(built.sha256);
        const child = spawn(executable, [directory], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let closed = false,
          diagnostic = '';
        const exit = new Promise<number | null>((resolve, reject) => {
          child.once('close', (code) => {
            closed = true;
            resolve(code);
          });
          child.once('error', reject);
        });
        child.stdout.on('data', () => {});
        child.stderr.on('data', (bytes: Buffer) => {
          diagnostic = (diagnostic + bytes.toString()).slice(-4096);
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const code = await Promise.race([
            exit,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(Error(`electron_display_timeout:${diagnostic}`)),
                15000,
              );
            }),
          ]);
          const reply = JSON.parse(
            await readFile(join(directory, 'reply.json'), 'utf8').catch((cause) => {
              throw Error(`electron_display_failed:${code}:${diagnostic}`, { cause });
            }),
          );
          expect({ code, reply }).toEqual({
            code: 0,
            reply: {
              ok: true,
              width: 96,
              height: 48,
              mimeType: 'image/webp',
              bytes: expect.any(Number),
              roi: {
                width: 24,
                height: 16,
                sourceWidth: 96,
                sourceHeight: 48,
                region: { left: 12, top: 8, width: 24, height: 16 },
              },
            },
          });
          expect(sha256(await readFile(join(directory, 'source.png')))).toBe(originalHash);
        } finally {
          if (timer) clearTimeout(timer);
          if (!closed) child.kill('SIGKILL');
          await exit;
        }
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
  45000,
);

test('private codec has no node_modules or ambient package lookup and missing native binding fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kite-image-display-private-'));
  try {
    const asset = await buildImageDisplay(directory);
    const child = join(directory, asset.relativePath),
      codecRoot = join(directory, 'image-display-codec');
    const files = await readdir(codecRoot, { recursive: true });
    expect(files.some((path) => /(?:^|[\\/])node_modules(?:[\\/]|$)/i.test(path))).toBe(false);
    const native = files.find((path) => path.endsWith('.node'))!;
    expect(native.startsWith('assets')).toBe(true);
    const guard = join(directory, 'module-guard.cjs');
    await writeFile(
      guard,
      `const Module=require('node:module');const path=require('node:path');const fs=require('node:fs');const root=fs.realpathSync(${JSON.stringify(codecRoot)});const original=Module._resolveFilename;Module._resolveFilename=function(request,...args){if(!Module.isBuiltin(request)&&!path.isAbsolute(request)){process.stderr.write('ambient_lookup:'+request);process.exit(91)}const resolved=original.call(this,request,...args);if(!Module.isBuiltin(request)&&!fs.realpathSync(resolved).startsWith(root+path.sep)){process.stderr.write('outside_codec:'+resolved);process.exit(92)}return resolved};`,
    );
    const source = await sharp({
      create: { width: 20, height: 10, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    const run = async () => {
      const process = spawn(
        Bun.which('node')!,
        ['--require', guard, child, 'image/png', '512', String(source.length), 'null'],
        { cwd: directory, env: {}, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const output: Buffer[] = [],
        errors: Buffer[] = [];
      process.stdout.on('data', (bytes: Buffer) => output.push(bytes));
      process.stderr.on('data', (bytes: Buffer) => errors.push(bytes));
      process.stdin.on('error', () => {});
      process.stdin.end(source);
      const code = await new Promise<number | null>((resolve, reject) => {
        process.once('close', resolve);
        process.once('error', reject);
      });
      return { code, output: Buffer.concat(output), errors: Buffer.concat(errors).toString() };
    };
    const success = await run();
    expect({ code: success.code, errors: success.errors }).toEqual({ code: 0, errors: '' });
    const header = success.output.readUInt32BE(0);
    expect(JSON.parse(success.output.toString('utf8', 4, 4 + header))).toMatchObject({
      width: 20,
      height: 10,
      mimeType: 'image/webp',
    });
    await rename(join(codecRoot, native), join(codecRoot, `${native}.missing`));
    const failure = await run();
    expect(failure.code).not.toBe(0);
    expect(failure.output.length).toBe(0);
    expect(failure.errors).not.toContain('ambient_lookup:');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
