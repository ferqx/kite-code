import { readFileSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import '../development/node-loader.mjs';

const legacyCli = new URL('../../apps/kite-cli/src/', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '#kite-test')
      return nextResolve(new URL('./test.ts', import.meta.url).href, context);
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error?.code !== 'ERR_MODULE_NOT_FOUND' ||
        !specifier.startsWith('#kite-cli/') ||
        !context.parentURL?.startsWith(legacyCli) ||
        typeof error.url !== 'string' ||
        !error.url.startsWith(legacyCli)
      )
        throw error;
      for (const suffix of ['.ts', '.tsx']) {
        const candidate = new URL(error.url + suffix);
        if (statSync(fileURLToPath(candidate), { throwIfNoEntry: false })?.isFile())
          return nextResolve(candidate.href, context);
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    const source = new URL(url);
    if (source.protocol === 'file:' && source.pathname.endsWith('.tsx')) {
      const filename = fileURLToPath(source);
      return {
        format: 'module',
        shortCircuit: true,
        source: transformSync(readFileSync(filename, 'utf8'), {
          loader: 'tsx',
          format: 'esm',
          jsx: 'automatic',
          sourcefile: filename,
          sourcemap: 'inline',
          target: 'esnext',
          tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
        }).code,
      };
    }
    return nextLoad(url, context);
  },
});
