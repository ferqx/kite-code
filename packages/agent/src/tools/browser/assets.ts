import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';

export const agentBrowserVersion = '0.39.4';
const require = createRequire(import.meta.url);
const unavailable = () =>
  Object.assign(Error('browser_runtime_unavailable'), { code: 'browser_runtime_unavailable' });

/** Installed native dependency only. Never execute a PATH entry, project script or npx fallback. */
function installedAssets() {
  try {
    const manifest = realpathSync(require.resolve('agent-browser/package.json'));
    if (statSync(manifest).size > 65536) throw unavailable();
    const metadata = JSON.parse(readFileSync(manifest, 'utf8'));
    if (metadata.name !== 'agent-browser' || metadata.version !== agentBrowserVersion)
      throw unavailable();
    let platform: string = process.platform;
    let architecture: string = process.arch;
    if (platform === 'linux') {
      const report = process.report?.getReport();
      const header =
        typeof report === 'object' && report && 'header' in report ? report.header : undefined;
      if (
        !header ||
        typeof header !== 'object' ||
        !('glibcVersionRuntime' in header) ||
        !header.glibcVersionRuntime
      )
        platform = 'linux-musl';
    }
    if (platform === 'win32' && architecture === 'arm64') architecture = 'x64';
    if (
      !['linux', 'linux-musl', 'darwin', 'win32'].includes(platform) ||
      !['x64', 'arm64'].includes(architecture)
    )
      throw unavailable();
    const root = dirname(manifest);
    const executable = realpathSync(
      join(
        root,
        'bin',
        `agent-browser-${platform}-${architecture}${platform === 'win32' ? '.exe' : ''}`,
      ),
    );
    if (!executable.startsWith(`${root}${sep}`) || !statSync(executable).isFile())
      throw unavailable();
    const license = realpathSync(join(root, 'LICENSE'));
    return { executable, files: [manifest, executable, license] as readonly string[] };
  } catch {
    throw unavailable();
  }
}
export function agentBrowserExecutableAsset(): string {
  return installedAssets().executable;
}
/** Host includes these exact immutable installation paths in its existing runtime protection. */
export function agentBrowserRuntimeAssets(): readonly string[] {
  return installedAssets().files;
}
