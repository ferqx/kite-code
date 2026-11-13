import { statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const checkout = new URL('../../', import.meta.url).href;

function checkoutSource(url) {
  const href = url instanceof URL ? url.href : url;
  return (
    typeof href === 'string' &&
    href.startsWith(checkout) &&
    !href.slice(checkout.length).includes('/node_modules/')
  );
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        !context.parentURL ||
        !checkoutSource(context.parentURL) ||
        !specifier.startsWith('.') ||
        !['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT'].includes(error?.code)
      )
        throw error;

      const requested = new URL(specifier, context.parentURL);
      if (!checkoutSource(requested.href)) throw error;
      for (const suffix of ['.ts', '.tsx', '.js', '/index.ts', '/index.tsx', '/index.js']) {
        const url = new URL(requested.href.replace(/\/$/u, '') + suffix);
        if (statSync(fileURLToPath(url), { throwIfNoEntry: false })?.isFile())
          return nextResolve(url.href, context);
      }
      throw error;
    }
  },
});
