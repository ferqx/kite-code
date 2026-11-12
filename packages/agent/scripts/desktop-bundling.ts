import type { BunPlugin } from 'bun';

/** Private subpath imports resolve only against the shipped code/package.json. */
export function desktopModuleSpecifier(name: string): string {
  return `#kite-runtime/${name}`;
}

export function desktopModulePlugin(moduleNames: Iterable<string>): BunPlugin {
  const modules = new Set(moduleNames);
  return {
    name: 'desktop-modules',
    setup(build) {
      build.onResolve({ filter: /^[^./]/u }, ({ path }) =>
        modules.has(path) ? { path: desktopModuleSpecifier(path), external: true } : undefined,
      );
    },
  };
}
