import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Json } from '@kite-ai/agent/extensions';
import { type ProfileSelection, selectProfile } from '@kite-ai/agent/profile';
import { startDevelopmentWeb } from '@kite-ai/service/development-web';
import { launchPairedService } from '@kite-ai/service/paired';
import { validateTrustedAssets } from '@kite-ai/web';
import type { AssetManifest, TrustedAsset } from '@kite-ai/web/assets';

const repositoryRoot = resolve(import.meta.dir, '../..');
export interface DevelopmentWebSelection {
  readonly profile: ProfileSelection;
  readonly entrypoint: string;
  readonly buildId: string;
  readonly instanceId: string;
  readonly apiMajor: 1;
  readonly requiredCapabilities: readonly string[];
  readonly hostConfiguration?: Json;
}
export class WebLaunchError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
/** Pure selection; never discovers a legacy daemon/profile or reads its data. */
export function selectDevelopmentWeb(
  argv: readonly string[],
  root = repositoryRoot,
): DevelopmentWebSelection {
  let dataRoot = join(root, '.kite-code', 'unified-development');
  if (argv.length) {
    if (argv.length !== 2 || argv[0] !== '--data-root' || !argv[1] || !isAbsolute(argv[1]))
      throw new WebLaunchError('invalid_web_development_arguments');
    dataRoot = argv[1];
  }
  const entrypoint = join(root, 'apps/service/dist/main.js');
  let bytes: Uint8Array;
  try {
    const stat = lstatSync(entrypoint);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new WebLaunchError('development_service_asset_unavailable');
    bytes = readFileSync(entrypoint);
  } catch {
    throw new WebLaunchError('development_service_asset_unavailable');
  }
  return Object.freeze({
    profile: Object.freeze(selectProfile({ dataRoot, profile: 'development' })),
    entrypoint,
    // This binds the selected development entry bytes, not a complete release candidate.
    buildId: `development-${createHash('sha256').update(bytes).digest('hex')}`,
    instanceId: crypto.randomUUID(),
    apiMajor: 1,
    requiredCapabilities: Object.freeze(['sessions', 'history']),
  });
}

/** Trusted host composition only. Browser receives only the finite Gateway origin. */
export async function launchDevelopmentWeb(input: {
  readonly selection: DevelopmentWebSelection;
  readonly assets: ReadonlyMap<string, TrustedAsset>;
  readonly manifest: AssetManifest;
}) {
  const selected = {
    ...input.selection,
    profile: Object.freeze({ ...input.selection.profile }),
    requiredCapabilities: [...input.selection.requiredCapabilities],
    ...(input.selection.hostConfiguration === undefined
      ? {}
      : { hostConfiguration: structuredClone(input.selection.hostConfiguration) }),
  };
  const assets = new Map(
    [...input.assets].map(([path, asset]) => [path, Object.freeze({ ...asset })]),
  );
  await validateTrustedAssets(assets, structuredClone(input.manifest));
  const paired = await launchPairedService(selected);
  let gateway: ReturnType<typeof startDevelopmentWeb>;
  try {
    gateway = startDevelopmentWeb({ admittedClient: paired.client, assets });
  } catch (error) {
    await paired.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      try {
        await gateway.close();
      } finally {
        await paired.close();
      }
    })();
    return closing;
  };
  // A dead owned Service cannot leave a Gateway advertising its stale identity.
  void paired.exited.then(close).catch(() => {});
  return { endpoint: gateway.endpoint, close, paired };
}

export async function runDevelopmentWeb(
  input: {
    readonly selection?: DevelopmentWebSelection;
    readonly assets?: ReadonlyMap<string, TrustedAsset>;
    readonly manifest?: AssetManifest;
  } = {},
): Promise<void> {
  const selected = input.selection ?? selectDevelopmentWeb(process.argv.slice(2));
  let stopRequested = false;
  let stop!: () => void;
  const ended = new Promise<void>((resolveEnd) => {
    stop = () => {
      stopRequested = true;
      resolveEnd();
    };
  });
  const eof = () => stop();
  const invalidInput = () => stop();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdin.once('end', eof);
  process.stdin.once('error', eof);
  // stdin is a liveness channel only; credentials or commands are never accepted here.
  process.stdin.on('data', invalidInput);
  process.stdin.resume();
  let host: Awaited<ReturnType<typeof launchDevelopmentWeb>> | undefined;
  try {
    const builtAssets =
      input.assets && input.manifest ? undefined : await import('@kite-ai/web/assets');
    host = await launchDevelopmentWeb({
      selection: selected,
      assets: input.assets ?? builtAssets!.getTrustedAssets(),
      manifest: input.manifest ?? builtAssets!.assetManifest,
    });
    if (!stopRequested) process.stdout.write(`${host.endpoint}\n`);
    const exit = await Promise.race([ended, host.paired.exited]);
    if (typeof exit === 'number' && exit !== 0)
      throw new WebLaunchError('development_service_exited');
  } finally {
    await host?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.stdin.removeListener('end', eof);
    process.stdin.removeListener('error', eof);
    process.stdin.removeListener('data', invalidInput);
    process.stdin.pause();
  }
}
if (import.meta.main) {
  try {
    await runDevelopmentWeb();
  } catch (error) {
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[a-z][a-z0-9_]{0,80}$/.test(error.code)
        ? error.code
        : 'web_development_launch_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
