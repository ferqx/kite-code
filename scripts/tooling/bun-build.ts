import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildArtifact, BuildConfig, BuildResult } from './build';

interface Filter {
  filter: RegExp;
  namespace?: string;
}
type ResolveArgs = { path: string; importer: string };
type ResolveResult = { path: string; external?: boolean; namespace?: string };
type LoadArgs = { path: string };
type LoadResult = { contents: string; loader: 'js' };
type Hook<Args, Result> = {
  options: Filter;
  callback(args: Args): Result | null | undefined | Promise<Result | null | undefined>;
};
export interface BunBuildPlugin {
  name: string;
  setup(builder: BunPluginBuilder): void;
}
export interface BunPluginBuilder {
  onResolve(options: Filter, callback: Hook<ResolveArgs, ResolveResult>['callback']): void;
  onLoad(options: Filter, callback: Hook<LoadArgs, LoadResult>['callback']): void;
}

export type BunBundleConfig = Pick<
  BuildConfig,
  | 'entrypoints'
  | 'target'
  | 'root'
  | 'naming'
  | 'packages'
  | 'format'
  | 'outdir'
  | 'outfile'
  | 'write'
  | 'define'
  | 'external'
  | 'splitting'
  | 'minify'
> & { plugins?: readonly BunBuildPlugin[] };

type CompilerOptions = Omit<BunBundleConfig, 'plugins' | 'outfile' | 'write'> & {
  env: 'disable';
  banner?: string;
};
type Artifact = { path: string; kind: BuildArtifact['kind']; type: string; contents: string };
type CallbackReply = { kind: 'callback'; id: number } & (
  | { value: ResolveResult | LoadResult | null | undefined }
  | { error: string }
);
type Reply =
  | { kind: 'result'; success: boolean; outputs: Artifact[]; logs: BuildResult['logs'] }
  | { kind: 'resolve'; index: number; id: number; args: ResolveArgs }
  | { kind: 'load'; index: number; id: number; args: LoadArgs };

const worker = fileURLToPath(new URL('./bun-build-worker.mjs', import.meta.url));

function diagnostic(error: unknown): BuildResult['logs'][number] {
  const item = error as { message?: string; position?: { file?: string; line: number } } | null;
  const position = item?.position;
  return {
    text: item?.message ?? String(error),
    location: position?.file ? { file: position.file, line: position.line } : null,
  };
}

export async function compileInBun(
  options: CompilerOptions,
  plugins: readonly BunBuildPlugin[],
): Promise<BuildResult> {
  const expected = '1.4.4';
  if (process.versions.bun !== expected)
    throw Error(`Bun ${expected} is required for bundling (found ${process.versions.bun}).`);
  const bun = Reflect.get(globalThis, 'Bun') as {
    build(config: CompilerOptions & { plugins: readonly BunBuildPlugin[] }): Promise<{
      outputs: BuildArtifact[];
      logs: unknown[];
    }>;
  };
  try {
    const { outputs, logs } = await bun.build({ ...options, plugins });
    return { success: true, outputs: options.outdir ? [] : outputs, logs: logs.map(diagnostic) };
  } catch (error) {
    return {
      success: false,
      outputs: [],
      logs: (error instanceof AggregateError ? error.errors : [error]).map(diagnostic),
    };
  }
}

function filters(hooks: readonly { options: Filter }[]) {
  return hooks.map(({ options: { filter, namespace } }) => ({
    source: filter.source,
    flags: filter.flags,
    namespace,
  }));
}

/** Share bundle options between the Bun build scripts and the Node release tools. */
export async function build(config: BunBundleConfig, output?: 'files'): Promise<BuildResult> {
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
    define,
    external,
    splitting,
    minify,
    plugins = [],
  } = config;
  if (!entrypoints.length || (outfile && (outdir || entrypoints.length !== 1 || splitting)))
    throw Error('bun_build_arguments_invalid');
  if (format !== 'esm' && format !== 'cjs' && format !== 'iife')
    throw Error('bun_build_format_invalid');

  const destination = resolve(outdir ?? (outfile ? dirname(outfile) : '.'));
  const commonjs = target === 'node' && format === 'cjs';
  const esm = target === 'node' && format === 'esm';
  const options: CompilerOptions = {
    entrypoints: entrypoints.map((path) => resolve(path)),
    target,
    root: root ? resolve(root) : undefined,
    naming: outfile ? basename(outfile) : naming,
    packages,
    format,
    // A plain directory build needs diagnostics only. Other callers use the in-memory artifacts.
    outdir: output === 'files' && outdir && write !== false ? destination : undefined,
    env: 'disable',
    splitting,
    minify,
    external: target === 'node' ? [...(external ?? []), '*.node'] : external,
    banner: esm
      ? 'import {createRequire as __kite_createRequire} from "node:module";const require=__kite_createRequire(import.meta.url);'
      : commonjs
        ? 'const __kite_import_meta={get url(){return require("node:url").pathToFileURL(__filename).href;}};'
        : undefined,
    define: {
      ...(target === 'node' ? { 'process.env.NODE_ENV': 'process.env.NODE_ENV' } : {}),
      ...(commonjs
        ? {
            'import.meta.url': '__kite_import_meta.url',
            'import.meta.dirname': '__dirname',
            'import.meta.filename': '__filename',
          }
        : {}),
      ...define,
    },
  };
  const result = process.versions.bun
    ? await compileInBun(options, plugins)
    : await compileInWorker(options, plugins);
  const outputs = await Promise.all(
    result.outputs.map(async (output) => {
      const path = resolve(destination, output.path);
      const name = relative(destination, path);
      if (!name || isAbsolute(name) || /^\.\.(?:[\\/]|$)/u.test(name))
        throw Error('bun_build_output_path');
      if (write !== false && (outdir || outfile)) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, new Uint8Array(await output.arrayBuffer()));
      }
      return Object.assign(output.slice(0, output.size, output.type), {
        path: outdir || outfile ? path : `./${name.replaceAll('\\', '/')}`,
        kind: output.kind,
      });
    }),
  );
  return { success: result.success, outputs, logs: result.logs };
}

async function compileInWorker(
  config: CompilerOptions,
  plugins: readonly BunBuildPlugin[],
): Promise<BuildResult> {
  const resolvers: Hook<ResolveArgs, ResolveResult>[] = [];
  const loaders: Hook<LoadArgs, LoadResult>[] = [];
  const builder: BunPluginBuilder = {
    onResolve: (options, callback) => void resolvers.push({ options, callback }),
    onLoad: (options, callback) => void loaders.push({ options, callback }),
  };
  for (const plugin of plugins) plugin.setup(builder);
  const request = {
    kind: 'build',
    config,
    resolvers: filters(resolvers),
    loaders: filters(loaders),
  };
  const env = { ...process.env };
  delete env.BUN_BE_BUN;
  delete env.BUN_OPTIONS;
  const result = await new Promise<Extract<Reply, { kind: 'result' }>>((resolveResult, reject) => {
    const child = spawn('bun', ['--no-config', '--no-env-file', '--no-install', worker], {
      env,
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      serialization: 'json',
      windowsHide: true,
    });
    let result: Extract<Reply, { kind: 'result' }> | undefined;
    function send(message: typeof request | CallbackReply) {
      child.send(message, (error) => {
        if (!error) return;
        reject(error);
        child.kill();
      });
    }
    child.on('message', async (message: Reply) => {
      if (message.kind === 'result') {
        result = message;
        return;
      }
      let reply: CallbackReply;
      try {
        const value =
          message.kind === 'resolve'
            ? await resolvers[message.index]!.callback(message.args)
            : await loaders[message.index]!.callback(message.args);
        reply = { kind: 'callback', id: message.id, value };
      } catch (error) {
        reply = { kind: 'callback', id: message.id, error: String(error) };
      }
      if (child.connected) send(reply);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'ENOENT' ? Error('Bun is required on PATH for bundling.') : error);
    });
    child.once('close', (code, signal) => {
      if (code === 0 && result) resolveResult(result);
      else reject(Error(`bun_build_worker_failed:${code ?? signal}`));
    });
    child.once('spawn', () => send(request));
  });
  const outputs = result.outputs.map(({ path, kind, type, contents }) =>
    Object.assign(new Blob([new Uint8Array(Buffer.from(contents, 'base64'))], { type }), {
      path,
      kind,
    }),
  );
  return { success: result.success, outputs, logs: result.logs };
}
