import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = process.cwd();
const activeDir = join(root, 'docs', 'active');
const requiredMetadata = ['状态：active', '读取时机：', '验证：'];
let failed = false;

interface DocumentationMap {
  rules?: Array<{
    id: string;
    sources?: string[];
    documents?: string[];
  }>;
}

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
  const mapPath = join(root, 'docs', 'documentation-map.json');
  if (!existsSync(mapPath)) {
    fail('docs/documentation-map.json is missing.');
    return;
  }
  let map: DocumentationMap;
  try {
    map = JSON.parse(readFileSync(mapPath, 'utf8')) as DocumentationMap;
  } catch {
    fail('docs/documentation-map.json is not valid JSON.');
    return;
  }
  for (const rule of map.rules ?? []) {
    for (const path of [...(rule.sources ?? []), ...(rule.documents ?? [])]) {
      if (!path.includes('*') && !existsSync(join(root, path))) {
        fail(`docs/documentation-map.json rule ${rule.id} references missing path: ${path}`);
      }
    }
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
  join(root, 'README.md'),
  join(root, 'README.zh-CN.md'),
  ...collectMarkdownFiles(join(root, 'docs')),
]) {
  if (existsSync(path)) checkInternalMarkdownLinks(path, readFileSync(path, 'utf8'));
}

checkDocumentationMap();

for (const directory of ['design', 'deprecated', 'adr']) {
  if (!existsSync(join(root, 'docs', directory))) fail(`docs/${directory}/ is missing.`);
}

const planMatrixCheck = Bun.spawnSync({
  cmd: ['bun', 'run', 'scripts/check-plan-execution-matrix.ts'],
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
});
if (planMatrixCheck.exitCode !== 0) failed = true;

if (failed) process.exitCode = 1;
else console.log('Documentation structure and plan governance checks passed.');
