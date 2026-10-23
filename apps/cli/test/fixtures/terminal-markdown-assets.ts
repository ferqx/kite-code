import { expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Verify the real candidate's bundled code and remaining stylesheet asset closure. */
export function verifyTerminalMarkdownAssets(repository: string, candidate: string): void {
  const sourceRequire = createRequire(join(repository, 'packages/ui/package.json'));
  const uiRoot = join(candidate, 'node_modules/@kite-ai/ui');
  const candidateRequire = createRequire(join(uiRoot, 'package.json'));
  const manifest = JSON.parse(readFileSync(join(uiRoot, 'package.json'), 'utf8'));
  const provenance = JSON.parse(readFileSync(join(uiRoot, 'BUNDLED-DEPENDENCIES.json'), 'utf8'));
  const notices = readFileSync(join(uiRoot, 'THIRD_PARTY_BUNDLED.txt'), 'utf8');
  const bundled = ['github-slugger', 'lowlight', 'mermaid'];
  for (const name of bundled) {
    expect(Object.hasOwn(manifest.dependencies, name)).toBe(false);
    expect(provenance.roots).toContain(name);
    const source = sourceRequire.resolve(`${name}/package.json`);
    const original = readFileSync(source, 'utf8');
    expect(notices).toContain(original);
    for (const file of readdirSync(dirname(source)).filter((file) =>
      /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:[-_.].*)?$/iu.test(file),
    )) {
      const bytes = readFileSync(join(dirname(source), file));
      expect(readFileSync(join(uiRoot, 'desktop/licenses', name, file))).toEqual(bytes);
      expect(notices).toContain(bytes.toString('utf8'));
    }
  }
  const scanner = new Bun.Transpiler({ loader: 'js' });
  const verifyImports = (directory: string) => {
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, file.name);
      if (file.isDirectory()) verifyImports(path);
      else if (file.isFile() && file.name.endsWith('.js'))
        for (const entry of scanner.scanImports(readFileSync(path)))
          expect(
            bundled.some((name) => entry.path === name || entry.path.startsWith(`${name}/`)),
          ).toBe(false);
    }
  };
  verifyImports(join(uiRoot, 'desktop'));
  const sourceKatex = dirname(sourceRequire.resolve('katex/package.json'));
  const candidateKatex = dirname(candidateRequire.resolve('katex/package.json'));
  const css = readFileSync(join(sourceKatex, 'dist/katex.min.css'));
  expect(readFileSync(join(candidateKatex, 'dist/katex.min.css'))).toEqual(css);
  const fonts = new Set(
    [...css.toString('utf8').matchAll(/url\((fonts\/[^)]+)\)/g)].map((m) => m[1]!),
  );
  expect(fonts.size).toBeGreaterThan(0);
  for (const font of fonts)
    expect(readFileSync(join(candidateKatex, 'dist', font))).toEqual(
      readFileSync(join(sourceKatex, 'dist', font)),
    );
}
