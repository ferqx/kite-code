import type { BunPlugin } from 'bun';

/** Private subpath imports resolve only against the shipped code/package.json. */
export function windowsDesktopModuleSpecifier(name: string): string {
  return `#kite-runtime/${name}`;
}

export function windowsDesktopModulePlugin(moduleNames: Iterable<string>): BunPlugin {
  const modules = new Set(moduleNames);
  return {
    name: 'windows-desktop-modules',
    setup(build) {
      build.onResolve({ filter: /^[^./]/u }, ({ path }) =>
        modules.has(path)
          ? { path: windowsDesktopModuleSpecifier(path), external: true }
          : undefined,
      );
    },
  };
}
