import { createHash } from 'node:crypto';
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
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import ts from 'typescript';
import { terminalBundledNotices } from './terminal-dependencies';

function localSpecifier(importer: string, target: string): string {
  const path = relative(dirname(importer), target).replaceAll('\\', '/');
  return path.startsWith('.') ? path : `./${path}`;
}

function bareModule(name: string): boolean {
  return !name.startsWith('.') && !name.startsWith('bun:') && !isBuiltin(name);
}

/** Preserve the workspace bundles' shared chunks and asset-relative locations. */
function linkWorkspaces(workspaces: readonly string[], modules: ReadonlyMap<string, string>) {
  const scanner = new Bun.Transpiler({ loader: 'js' });
  for (const workspace of workspaces) {
    for (const name of readdirSync(workspace, { encoding: 'utf8', recursive: true })) {
      if (!name.endsWith('.js')) continue;
      const path = join(workspace, name);
      const source = readFileSync(path, 'utf8');
      if (!scanner.scanImports(source).some((item) => bareModule(item.path))) continue;
      const file = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      const edits: { start: number; end: number; value: string }[] = [];
      const replace = (node: ts.Node | undefined) => {
        if (!node || !ts.isStringLiteralLike(node) || !bareModule(node.text)) return;
        const target = modules.get(node.text);
        if (!target) throw Error(`desktop_runtime_module_unbundled:${name}:${node.text}`);
        edits.push({
          start: node.getStart(file),
          end: node.end,
          value: JSON.stringify(localSpecifier(path, target)),
        });
      };
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          replace(node.moduleSpecifier);
        } else if (ts.isCallExpression(node)) {
          const fn = node.expression;
          if (
            fn.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(fn) && /^(?:__)?require$/u.test(fn.text))
          )
            replace(node.arguments[0]);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      let linked = source;
      for (const { start, end, value } of edits.sort((a, b) => b.start - a.start))
        linked = linked.slice(0, start) + value + linked.slice(end);
      const unlinked = scanner.scanImports(linked).find((item) => bareModule(item.path));
      if (unlinked) throw Error(`desktop_runtime_module_unbundled:${name}:${unlinked.path}`);
      writeFileSync(path, linked);
      const checksum = path.replace(/\.js$/u, '.sha256');
      if (existsSync(checksum)) {
        const sha = (text: string) => createHash('sha256').update(text).digest('hex');
        if (readFileSync(checksum, 'utf8').trim() !== sha(source))
          throw Error(`desktop_runtime_worker_checksum_invalid:${name}`);
        writeFileSync(checksum, `${sha(linked)}\n`);
      }
    }
  }
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
  const modules = new Map<string, string>([
    ['jsdom', join(vendor, 'jsdom.cjs')],
    ['sharp', join(vendor, 'sharp.cjs')],
    ['@napi-rs/keyring', join(vendor, 'keyring.cjs')],
    ['pdfjs-dist/legacy/build/pdf.mjs', join(vendor, 'pdf.mjs')],
    ['web-tree-sitter', join(vendor, 'tree-sitter.mjs')],
    ['zod', join(vendor, 'zod.mjs')],
  ]);
  for (const workspace of workspaces) {
    const { name, exports } = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
      name: string;
      exports: Record<string, string>;
    };
    for (const [subpath, file] of Object.entries(exports))
      modules.set(subpath === '.' ? name : `${name}${subpath.slice(1)}`, join(workspace, file));
    // The export table is build input for linking. Keep the package type and identity only.
    writeFileSync(join(workspace, 'package.json'), `${JSON.stringify({ name, type: 'module' })}\n`);
  }
  linkWorkspaces(workspaces, modules);

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
