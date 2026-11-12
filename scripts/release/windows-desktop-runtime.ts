import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import ts from 'typescript';
import {
  windowsDesktopModulePlugin,
  windowsDesktopModuleSpecifier,
} from '../../packages/agent/scripts/windows-desktop-bundling';
import { terminalBundledNotices } from './terminal-dependencies';

export function windowsDesktopModuleMap(
  workspaces: readonly { name: string; exports: Record<string, string> }[],
): ReadonlyMap<string, string> {
  const modules = new Map([
    ['jsdom', './vendor/jsdom.cjs'],
    ['sharp', './vendor/sharp.cjs'],
    ['@napi-rs/keyring', './vendor/keyring.cjs'],
    ['pdfjs-dist/legacy/build/pdf.mjs', './vendor/pdf.mjs'],
    ['web-tree-sitter', './vendor/tree-sitter.mjs'],
    ['zod', './vendor/zod.mjs'],
  ]);
  for (const { name, exports } of workspaces)
    for (const [subpath, path] of Object.entries(exports))
      modules.set(
        subpath === '.' ? name : `${name}${subpath.slice(1)}`,
        `./${name}/${path.slice(2)}`,
      );
  return modules;
}

/** Use the workspace's existing build entries and resolve external modules in the bundler. */
export async function buildWindowsDesktopWorkspace(
  workspace: string,
  args: readonly string[],
  modules: ReadonlyMap<string, string>,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      target: { type: 'string' },
      packages: { type: 'string' },
      outdir: { type: 'string' },
      root: { type: 'string' },
      external: { type: 'string', multiple: true, default: [] },
      splitting: { type: 'boolean' },
    },
  });
  const { target, packages, outdir, root, external, splitting } = values;
  if (
    (target !== 'bun' && target !== 'browser') ||
    (packages !== 'bundle' && packages !== 'external') ||
    !outdir ||
    !positionals.length
  )
    throw Error('desktop_runtime_build_options_invalid');
  const imports = [...modules.keys()].filter(
    (name) =>
      packages === 'external' || external.some((pkg) => name === pkg || name.startsWith(`${pkg}/`)),
  );
  const built = await Bun.build({
    entrypoints: positionals.map((path) => resolve(workspace, path)),
    outdir: resolve(workspace, outdir),
    ...(root ? { root: resolve(workspace, root) } : {}),
    target,
    packages,
    external,
    splitting,
    define: { __KITE_WINDOWS_DESKTOP_ASSETS__: 'true' },
    plugins: [windowsDesktopModulePlugin(imports)],
  });
  if (!built.success)
    throw new AggregateError(built.logs, 'desktop_runtime_workspace_build_failed');
}

/** Validate emitted code without rewriting it. Bun's import scan omits shared require aliases. */
function verifyWindowsDesktopImports(
  workspaces: readonly string[],
  imports: Readonly<Record<string, string>>,
): void {
  const scanner = new Bun.Transpiler({ loader: 'js' });
  for (const workspace of workspaces) {
    for (const name of readdirSync(workspace, { encoding: 'utf8', recursive: true })) {
      if (!name.endsWith('.js')) continue;
      const path = join(workspace, name);
      const source = readFileSync(path, 'utf8');
      const verify = (specifier: string) => {
        if (
          !specifier.startsWith('.') &&
          !specifier.startsWith('bun:') &&
          !isBuiltin(specifier) &&
          !Object.hasOwn(imports, specifier)
        )
          throw Error(`desktop_runtime_module_unbundled:${name}:${specifier}`);
      };
      for (const item of scanner.scanImports(source)) verify(item.path);
      const file = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        false,
        ts.ScriptKind.JS,
      );
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const fn = node.expression;
          const metaRequire =
            ts.isPropertyAccessExpression(fn) &&
            fn.name.text === 'require' &&
            ts.isMetaProperty(fn.expression) &&
            fn.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
          const specifier = node.arguments[0];
          if (
            specifier &&
            ts.isStringLiteralLike(specifier) &&
            (metaRequire || (ts.isIdentifier(fn) && /^(?:__)?require\d*$/u.test(fn.text)))
          )
            verify(specifier.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
  }
}

export function writeWindowsDesktopImports(
  codeRoot: string,
  workspaces: readonly string[],
  modules: ReadonlyMap<string, string>,
): void {
  const imports = Object.fromEntries(
    [...modules].map(([specifier, path]) => [windowsDesktopModuleSpecifier(specifier), path]),
  );
  for (const path of Object.values(imports))
    if (!existsSync(join(codeRoot, path))) throw Error(`desktop_runtime_module_missing:${path}`);
  verifyWindowsDesktopImports(workspaces, imports);
  writeFileSync(
    join(codeRoot, 'package.json'),
    `${JSON.stringify({ type: 'module', imports }, null, 2)}\n`,
  );
}

function replaceUpstream(
  source: string,
  pattern: string | RegExp,
  count: number,
  replacement: string,
) {
  const matches =
    typeof pattern === 'string'
      ? source.split(pattern).length - 1
      : [...source.matchAll(pattern)].length;
  if (matches !== count) throw Error(`desktop_runtime_dependency_changed:${pattern}`);
  return source.replaceAll(pattern, () => replacement);
}

/** Bundle the remaining JS against the lockfile and copy only the Windows x64 runtime assets. */
export async function buildWindowsDesktopRuntime(
  repository: string,
  root: string,
  workspaces: readonly string[],
  modules: ReadonlyMap<string, string>,
) {
  const vendor = join(root, 'code/vendor');
  mkdirSync(vendor, { recursive: true });
  const installed = realpathSync(join(repository, 'node_modules'));
  const agent = join(repository, 'packages/agent');
  const trajectory = join(repository, 'packages/trajectory');
  const from = (workspace: string) => createRequire(join(workspace, 'package.json'));
  const require = from(agent);
  const dependency = (path: string) => {
    const canonical = realpathSync(path);
    const item = relative(installed, canonical);
    if (!item || item.startsWith('..') || isAbsolute(item))
      throw Error(`desktop_runtime_dependency_escape:${path}`);
    return canonical;
  };
  const copy = (source: string, destination: string) => {
    const output = join(root, 'assets', destination);
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(dependency(source), output);
  };

  const pdf = dirname(require.resolve('pdfjs-dist/package.json'));
  const canvas = require.resolve('@napi-rs/canvas');
  const canvasNative = dependency(createRequire(canvas).resolve('@napi-rs/canvas-win32-x64-msvc'));
  const sharp = require.resolve('sharp');
  const sharpPackage = createRequire(sharp).resolve('@img/sharp-win32-x64/package');
  const sharpVersion = (
    JSON.parse(readFileSync(dependency(sharpPackage), 'utf8')) as { version: string }
  ).version;
  const sharpNative = dependency(
    join(dirname(sharpPackage), 'lib', `sharp-win32-x64-${sharpVersion}.node`),
  );
  const keyring = require.resolve('@napi-rs/keyring');
  const keyringNative = dependency(
    createRequire(keyring).resolve('@napi-rs/keyring-win32-x64-msvc'),
  );
  const browser = dirname(require.resolve('agent-browser/package.json'));
  const treeSitter = dirname(require.resolve('web-tree-sitter/tree-sitter.wasm'));
  const grammar = dirname(require.resolve('tree-sitter-bash/package.json'));
  const jsdom = require.resolve('jsdom');
  const jsdomRoot = dirname(jsdom);
  const pdfMain = join(pdf, 'legacy/build/pdf.mjs');

  for (const file of ['package.json', 'LICENSE', 'bin/agent-browser-win32-x64.exe'])
    copy(join(browser, file), `agent-browser/${file}`);
  copy(join(treeSitter, 'tree-sitter.wasm'), 'shell/tree-sitter.wasm');
  copy(join(grammar, 'tree-sitter-bash.wasm'), 'shell/tree-sitter-bash.wasm');
  for (const file of [canvasNative, join(dirname(canvasNative), 'icudtl.dat')])
    copy(file, `pdf/${basename(file)}`);
  for (const file of [
    sharpNative,
    join(dirname(sharpNative), 'libvips-42.dll'),
    join(dirname(sharpNative), 'libvips-cpp-8.18.7.dll'),
  ])
    copy(file, `sharp/${basename(file)}`);
  copy(keyringNative, `credentials/${basename(keyringNative)}`);

  const bundle = async (
    entry: string,
    output: string,
    format: 'cjs' | 'esm',
    transforms = new Map<string, (source: string) => string>(),
  ) => {
    const result = await Bun.build({
      entrypoints: [dependency(entry)],
      outdir: dirname(output),
      target: 'bun',
      format,
      naming: basename(output),
      minify: true,
      plugins: transforms.size
        ? [
            {
              name: 'windows-desktop-runtime',
              setup(build) {
                build.onLoad({ filter: /\.(?:mjs|cjs|js)$/u }, (args) => {
                  const transform = transforms.get(args.path.toLowerCase());
                  return transform
                    ? { contents: transform(readFileSync(args.path, 'utf8')), loader: 'js' }
                    : undefined;
                });
              },
            },
          ]
        : [],
    });
    if (!result.success || result.outputs.length !== 1)
      throw new AggregateError(result.logs, `desktop_runtime_bundle_failed:${basename(output)}`);
  };
  const transforms = (entries: [string, (source: string) => string][]) =>
    new Map(entries.map(([path, transform]) => [dependency(path).toLowerCase(), transform]));
  // Bun inlines __dirname from bundled CJS dependencies. Resolve from the installed Bun instead.
  const installedPath = (path: string) =>
    `require('node:path').resolve(process.execPath, '../..', ${JSON.stringify(path)})`;
  const nativeLoader = (file: string, asset: string) =>
    `module.exports = require(${installedPath(`assets/${asset}/${basename(file)}`)});`;
  const jsdomTransforms = transforms([
    [
      join(jsdomRoot, 'jsdom/living/css/helpers/computed-style.js'),
      (source) =>
        replaceUpstream(
          source,
          /fs\.readFileSync\(\s*path\.resolve\(__dirname, "\.\.\/\.\.\/\.\.\/browser\/default-stylesheet\.css"\),\s*\{ encoding: "utf-8" \}\s*\)/gu,
          1,
          JSON.stringify(
            readFileSync(join(jsdomRoot, 'jsdom/browser/default-stylesheet.css'), 'utf8'),
          ),
        ),
    ],
    [
      join(jsdomRoot, 'jsdom/living/xhr/XMLHttpRequest-impl.js'),
      (source) =>
        replaceUpstream(
          source,
          'require.resolve("./xhr-sync-worker.js")',
          1,
          installedPath('code/vendor/xhr-sync-worker.cjs'),
        ),
    ],
    [
      join(jsdomRoot, 'jsdom/utils.js'),
      (source) =>
        replaceUpstream(source, 'exports.Canvas = require("canvas");', 1, 'exports.Canvas = null;'),
    ],
  ]);
  await bundle(jsdom, join(vendor, 'jsdom.cjs'), 'cjs', jsdomTransforms);
  await bundle(
    join(jsdomRoot, 'jsdom/living/xhr/xhr-sync-worker.js'),
    join(vendor, 'xhr-sync-worker.cjs'),
    'cjs',
    jsdomTransforms,
  );
  await bundle(
    sharp,
    join(vendor, 'sharp.cjs'),
    'cjs',
    transforms([[join(dirname(sharp), 'sharp.cjs'), () => nativeLoader(sharpNative, 'sharp')]]),
  );
  await bundle(
    canvas,
    join(vendor, 'canvas.cjs'),
    'cjs',
    transforms([[join(dirname(canvas), 'js-binding.js'), () => nativeLoader(canvasNative, 'pdf')]]),
  );
  await bundle(
    keyring,
    join(vendor, 'keyring.cjs'),
    'cjs',
    transforms([[keyring, () => nativeLoader(keyringNative, 'credentials')]]),
  );
  await bundle(
    pdfMain,
    join(vendor, 'pdf.mjs'),
    'esm',
    transforms([
      [
        pdfMain,
        (source) =>
          replaceUpstream(source, 'require("@napi-rs/canvas")', 2, 'require("./canvas.cjs")'),
      ],
    ]),
  );
  await bundle(join(pdf, 'legacy/build/pdf.worker.mjs'), join(vendor, 'pdf.worker.mjs'), 'esm');
  await bundle(join(treeSitter, 'tree-sitter.js'), join(vendor, 'tree-sitter.mjs'), 'esm');
  await bundle(
    join(dirname(from(trajectory).resolve('zod')), 'index.js'),
    join(vendor, 'zod.mjs'),
    'esm',
  );

  for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
    for (const name of readdirSync(join(pdf, directory))) {
      const source = join(pdf, directory, name);
      const asset = `pdf/${directory}/${name}`;
      if (name.endsWith('.js')) await bundle(source, join(root, 'assets', asset), 'esm');
      else copy(source, asset);
    }
  }
  writeWindowsDesktopImports(join(root, 'code'), workspaces, modules);

  const notices = [
    terminalBundledNotices({
      repositoryRoot: repository,
      workspaceRoot: agent,
      names: [
        'jsdom',
        'sharp',
        '@napi-rs/canvas',
        '@napi-rs/keyring',
        'pdfjs-dist',
        'web-tree-sitter',
        'tree-sitter-bash',
        'agent-browser',
      ],
    }),
    terminalBundledNotices({
      repositoryRoot: repository,
      workspaceRoot: trajectory,
      names: ['zod'],
    }),
  ];
  writeFileSync(
    join(vendor, 'THIRD_PARTY_BUNDLED.txt'),
    notices
      .flatMap((notice) => notice.packages)
      .map(
        (pkg) =>
          `${pkg.name} ${pkg.version}\n${pkg.manifestText}\n${pkg.notices.map(({ name, text }) => `${name}\n${text}`).join('\n\n')}`,
      )
      .join('\n\n'),
  );
}
