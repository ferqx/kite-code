import type { BunBuildPlugin } from '../../../scripts/tooling/bun-build';

/** Private subpath imports resolve only against the shipped code/package.json. */
export function desktopModuleSpecifier(name: string): string {
  return `#kite-runtime/${name}`;
}

export function desktopModulePlugin(moduleNames: Iterable<string>): BunBuildPlugin {
  const modules = new Set(moduleNames);
  return {
    name: 'desktop-modules',
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, ({ path }) =>
        modules.has(path) ? { path: desktopModuleSpecifier(path), external: true } : undefined,
      );
    },
  };
}
