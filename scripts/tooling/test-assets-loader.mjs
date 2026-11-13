import { registerHooks } from 'node:module';

const styleRoots = ['../../apps/desktop/src/', '../../packages/ui/src/desktop/'].map(
  (path) => new URL(path, import.meta.url).href,
);
const appIcon = new URL('../../apps/desktop/app-icon.svg', import.meta.url).href;

// These imports supply styles to Vite. Node-only DOM fixtures exercise component behavior;
// the browser and Electron fixtures still compile and load the actual styles.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css') && styleRoots.some((root) => url.startsWith(root)))
      return { format: 'module', source: 'export {};', shortCircuit: true };
    if (url === appIcon)
      return {
        format: 'module',
        source: `export default ${JSON.stringify(url)};`,
        shortCircuit: true,
      };
    return nextLoad(url, context);
  },
});
