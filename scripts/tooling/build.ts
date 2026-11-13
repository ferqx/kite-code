import { createRequire } from 'node:module';
import { extname, relative, resolve } from 'node:path';
import type { BuildOptions, Message, OutputFile, Plugin, PluginBuild } from 'esbuild';

export type { Plugin, PluginBuild };
export type BuildConfig = Omit<
  BuildOptions,
  | 'absWorkingDir'
  | 'bundle'
  | 'entryNames'
  | 'entryPoints'
  | 'metafile'
  | 'outbase'
  | 'packages'
  | 'platform'
  | 'target'
> & {
  entrypoints: string[];
  target?: 'node' | 'browser';
  root?: string;
  naming?: string | { entry?: string; chunk?: string; asset?: string };
  packages?: 'bundle' | 'external';
};

function outputMime(path: string) {
  switch (extname(path)) {
    case '.js':
    case '.cjs':
    case '.mjs':
      return 'text/javascript;charset=utf-8';
    case '.css':
      return 'text/css;charset=utf-8';
    case '.json':
    case '.map':
      return 'application/json;charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    default:
      return 'application/octet-stream';
  }
}
export interface BuildArtifact extends Blob {
  readonly path: string;
  readonly kind: 'entry-point' | 'chunk' | 'asset' | 'sourcemap';
}
export interface BuildResult {
  readonly success: boolean;
  readonly outputs: BuildArtifact[];
  readonly logs: { text: string; location?: { file: string; line: number } | null }[];
}
function artifact(file: OutputFile, path: string, kind: BuildArtifact['kind']): BuildArtifact {
  return Object.assign(new Blob([new Uint8Array(file.contents)], { type: outputMime(path) }), {
    path,
    kind,
  });
}
const jsOutput = /\.[cm]?js$/u;

/** Bundle with explicit platform, package and output policy. No runtime dependencies are injected. */
export async function build(config: BuildConfig): Promise<BuildResult> {
  const {
    entrypoints,
    target = 'browser',
    root,
    naming,
    packages,
    format = 'esm',
    outdir,
    outfile,
    write,
    banner,
    define,
    plugins,
    ...options
  } = config;
  if (!entrypoints.length) throw Error('build_entrypoints_required');
  const cwd = process.cwd();
  const entryName = typeof naming === 'string' ? naming : naming?.entry;
  const extension = entryName?.match(jsOutput)?.[0];
  const entryNames = extension ? entryName?.slice(0, -extension.length) : entryName;
  const memory = write === false || (!outdir && !outfile);
  const destination = outdir ?? (outfile ? undefined : cwd);
  const platform = target === 'browser' ? 'browser' : 'node';
  const bannerJs = [
    // Bundled CommonJS dependencies sometimes still require Node builtins.
    platform === 'node' && format === 'esm'
      ? 'import {createRequire as __kite_createRequire} from "node:module";const require=__kite_createRequire(import.meta.url);'
      : '',
    platform === 'node' && format === 'cjs'
      ? 'const __kite_import_meta={get url(){return require("node:url").pathToFileURL(__filename).href;}};'
      : '',
    banner?.js,
  ]
    .filter(Boolean)
    .join('\n');
  // Keep Node-API and Electron native modules as loader-owned files at their reviewed paths.
  const nativeModules: Plugin = {
    name: 'external-native-modules',
    setup(builder) {
      builder.onResolve({ filter: /\.node$/ }, ({ path }) => ({ path, external: true }));
    },
  };
  const input = {
    ...options,
    entryPoints: entrypoints,
    absWorkingDir: cwd,
    outbase: root,
    bundle: true,
    platform,
    packages: packages === 'external' ? 'external' : undefined,
    format,
    outdir: destination,
    outfile,
    write: false,
    metafile: true,
    entryNames: entryNames ?? '[dir]/[name]',
    chunkNames: typeof naming === 'object' ? naming.chunk : undefined,
    assetNames: typeof naming === 'object' ? naming.asset : undefined,
    outExtension: extension ? { ...options.outExtension, '.js': extension } : options.outExtension,
    banner: { ...banner, ...(bannerJs ? { js: bannerJs } : {}) },
    define: {
      ...(platform === 'node' && format === 'cjs'
        ? {
            'import.meta.url': '__kite_import_meta.url',
            'import.meta.dirname': '__dirname',
            'import.meta.filename': '__filename',
          }
        : {}),
      ...define,
    },
    plugins: [...(plugins ?? []), ...(platform === 'node' ? [nativeModules] : [])],
    logLevel: options.logLevel ?? 'silent',
  } satisfies BuildOptions;
  try {
    const esbuild = createRequire(import.meta.url)('esbuild') as typeof import('esbuild');
    const output = await esbuild.build(input);
    const { mkdir, writeFile } = await import('node:fs/promises');
    if (!memory)
      for (const file of output.outputFiles) {
        await mkdir(resolve(file.path, '..'), { recursive: true });
        await writeFile(file.path, file.contents);
      }
    const outputs = output.outputFiles.map((file) => {
      const key = relative(cwd, file.path).replaceAll('\\', '/');
      const info = output.metafile.outputs[key] ?? output.metafile.outputs[file.path];
      const kind = info?.entryPoint
        ? 'entry-point'
        : jsOutput.test(file.path)
          ? 'chunk'
          : file.path.endsWith('.map')
            ? 'sourcemap'
            : 'asset';
      const path = !outdir && !outfile ? `./${key}` : file.path;
      return artifact(file, path, kind);
    });
    return { success: true, outputs, logs: output.warnings };
  } catch (error) {
    if (!error || typeof error !== 'object' || !('errors' in error)) throw error;
    return { success: false, outputs: [], logs: (error as { errors: Message[] }).errors };
  }
}
