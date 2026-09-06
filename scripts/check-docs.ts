import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { validateDocumentationMap } from './check-docs-impact';

const root = process.cwd();
const activeDir = join(root, 'docs', 'active');
const requiredMetadata = ['状态：active', '读取时机：', '验证：'];
let failed = false;

function fail(message: string): void {
  failed = true;
  console.error(message);
}

function collectMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return collectMarkdownFiles(path);
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  });
}

function sourceWithoutCode(source: string): string {
  return source.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

function checkInternalMarkdownLinks(path: string, source: string): void {
  const relativePath = relative(root, path);
  const content = sourceWithoutCode(source);
  const wikiLinks = content.match(/\[\[[^\]]+\]\]/g);
  if (wikiLinks) {
    fail(`${relativePath} contains unsupported wiki-style links: ${wikiLinks.join(', ')}`);
  }

  const links = /!?\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)\n]+))(?:\s+['"][^)]*['"])?\)/g;
  for (const match of content.matchAll(links)) {
    const rawTarget = match[1] ?? match[2];
    if (!rawTarget) continue;
    const target = rawTarget.split('#', 1)[0]!;
    if (
      target.length === 0 ||
      target.startsWith('#') ||
      /^[a-z][a-z\d+.-]*:/i.test(target) ||
      target.startsWith('//')
    ) {
      continue;
    }
    const resolved = resolve(dirname(path), decodeURI(target));
    if (!existsSync(resolved)) {
      fail(`${relativePath} links to missing local target: ${rawTarget}`);
    }
  }
}

function checkActiveMetadata(path: string, source: string): void {
  const metadataBlock = source.split(/^##\s/m, 1)[0]!;
  for (const field of requiredMetadata) {
    const occurrences = metadataBlock.match(new RegExp(`^${field}`, 'gm')) ?? [];
    if (occurrences.length !== 1) {
      fail(`${relative(root, path)} must declare ${field} exactly once before its first section.`);
    }
  }
}

function checkDocumentationMap(): void {
  try {
    validateDocumentationMap(
      JSON.parse(readFileSync(join(root, 'docs/documentation-map.json'), 'utf8')),
      root,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (!existsSync(activeDir)) {
  fail('docs/active/ is missing.');
} else {
  for (const entry of readdirSync(activeDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const path = join(activeDir, entry.name);
    const source = readFileSync(path, 'utf8');
    for (const field of requiredMetadata) {
      if (!source.includes(field)) fail(`${relative(root, path)} is missing ${field}`);
    }
    checkActiveMetadata(path, source);
  }
}

for (const path of [
  ...[root, join(root, 'docs')].flatMap((directory) =>
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => join(directory, entry.name)),
  ),
  ...collectMarkdownFiles(join(root, 'docs', 'active')),
  ...collectMarkdownFiles(join(root, 'docs', 'handbook')),
  ...collectMarkdownFiles(join(root, 'docs', 'development')),
  ...collectMarkdownFiles(join(root, 'docs', 'runbooks')),
  join(root, 'docs', 'adr', 'README.md'),
  join(root, 'docs', 'plans', 'README.md'),
  ...collectMarkdownFiles(join(root, 'packages')),
  ...collectMarkdownFiles(join(root, 'apps')),
  join(root, 'tests', 'README.md'),
]) {
  if (existsSync(path)) checkInternalMarkdownLinks(path, readFileSync(path, 'utf8'));
}

checkDocumentationMap();

for (const path of [
  'docs/handbook/README.md',
  'docs/development/README.md',
  'docs/plans/README.md',
]) {
  if (!existsSync(join(root, path))) fail(`${path} is missing.`);
}
for (const parent of ['apps', 'packages']) {
  for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      existsSync(join(root, parent, entry.name, 'package.json')) &&
      !existsSync(join(root, parent, entry.name, 'README.md'))
    )
      fail(`${parent}/${entry.name}/README.md is missing.`);
  }
}
if (failed) process.exitCode = 1;
else console.log('Documentation structure checks passed.');
