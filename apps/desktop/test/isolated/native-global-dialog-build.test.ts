import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { buildNativeDesktop } from '../../scripts/build-native';

test('native builds retain fixed renderer entries while development uses only Vite renderer assets', async () => {
  const temporary = mkdtempSync(
    join(resolve(import.meta.dir, '../../../..'), '.cache/native-global-dialog-build-'),
  );
  const service = join(temporary, 'service.js');
  writeFileSync(service, 'export {};\n'); // Build input only; no Service or client is executed.
  const bun = realpathSync(process.execPath);
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const assets = {
    kind: 'development' as const,
    serviceEntrypoint: service,
    serviceSha256: hash(service),
    bunExecutable: bun,
    bunSha256: hash(bun),
    buildId: 'dialog-build-fixture',
    apiMajor: 1,
    requiredCapabilities: [],
  };
  try {
    for (const development of [
      undefined,
      {
        rendererUrl: 'http://127.0.0.1:2042/',
        cspNonce: 'a'.repeat(32),
        control: { port: 2043, token: 'b'.repeat(64) },
      },
    ]) {
      const output = join(temporary, development ? 'development' : 'ordinary');
      await buildNativeDesktop(assets, output, { development });
      for (const file of ['main.cjs', 'preload.cjs', 'global-dialog-preload.cjs'])
        expect(existsSync(join(output, file))).toBe(true);
      const preload = readFileSync(join(output, 'global-dialog-preload.cjs'), 'utf8');
      expect(preload).toContain('kiteGlobalDialog');
      expect(preload).not.toContain('kiteNative');
      expect(JSON.parse(readFileSync(join(output, 'package.json'), 'utf8')).main).toBe('main.cjs');
      if (development) {
        for (const file of [
          'index.html',
          'renderer.js',
          'global-dialog.html',
          'global-dialog-renderer.js',
        ])
          expect(existsSync(join(output, file))).toBe(false);
        continue;
      }
      const html = readFileSync(join(output, 'global-dialog.html'), 'utf8');
      expect(html).toContain('./global-dialog-renderer.js');
      expect(html).not.toContain('src/native-global-dialog-main.tsx');
      const styleFiles = [...html.matchAll(/href="([^"]+\.css)"/g)].map((match) => match[1]!);
      expect(styleFiles.length).toBeGreaterThan(0);
      const css = styleFiles.map((file) => readFileSync(join(output, file), 'utf8')).join('\n');
      expect(css).toContain('.full-permission-dialog');
      expect(css).toContain('background:transparent');
      expect(readFileSync(join(output, 'index.html'), 'utf8')).toContain('./renderer.js');
      expect(existsSync(join(output, 'renderer.js'))).toBe(true);
      // Fixed confirmations also avoid the unrelated conversation parser closure.
      const dialog = readFileSync(join(output, 'global-dialog-renderer.js'), 'utf8');
      expect(Buffer.byteLength(dialog)).toBeLessThan(500_000);
      expect(dialog).not.toContain('katex');
      expect(dialog).not.toContain('mermaid');
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}, 120000);
