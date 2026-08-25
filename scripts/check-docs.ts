import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { documentationPatternBase, documentationPatternError } from './check-docs-impact';

const root = process.cwd();
const activeDir = join(root, 'docs', 'active');
const requiredMetadata = ['状态：active', '读取时机：', '验证：'];
let failed = false;

interface DocumentationMap {
  version?: number;
  rules?: Array<{
    id: string;
    sources?: string[];
    excludeSources?: string[];
    authorities?: string[];
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
  if (map.version !== 2) fail('docs/documentation-map.json must use version 2.');
  const rules = map.rules ?? [];
  if (rules.length === 0) fail('docs/documentation-map.json must contain non-empty rules.');
  const ids = new Set<string>();
  for (const rule of rules) {
    if (!rule.id?.trim()) fail('docs/documentation-map.json contains a rule without an id.');
    if (ids.has(rule.id))
      fail(`docs/documentation-map.json contains duplicate rule id: ${rule.id}`);
    ids.add(rule.id);
    if (rule.documents !== undefined) {
      fail(`docs/documentation-map.json rule ${rule.id} still uses retired documents.`);
    }
    if (!rule.sources || rule.sources.length === 0) {
      fail(`docs/documentation-map.json rule ${rule.id} must have non-empty sources.`);
    }
    if (!rule.authorities || rule.authorities.length === 0) {
      fail(`docs/documentation-map.json rule ${rule.id} must have non-empty authorities.`);
    }
    for (const pattern of [...(rule.sources ?? []), ...(rule.excludeSources ?? [])]) {
      const patternError = documentationPatternError(pattern);
      if (patternError) {
        fail(
          `docs/documentation-map.json rule ${rule.id} has invalid pattern ${pattern}: ${patternError}`,
        );
        continue;
      }
      const base = documentationPatternBase(pattern);
      if (!existsSync(join(root, base))) {
        fail(`docs/documentation-map.json rule ${rule.id} references missing source: ${pattern}`);
      }
    }
    for (const authority of rule.authorities ?? []) {
      const isCurrentAuthority =
        authority === 'README.md' ||
        authority === 'README.zh-CN.md' ||
        authority === 'docs/README.md' ||
        /^docs\/(?:active|runbooks)\/[^/]+\.md$/u.test(authority) ||
        /^(?:packages|apps)\/[^/]+\/README\.md$/u.test(authority) ||
        /^(?:packages|apps)\/[^/]+\/docs\/.+\.md$/u.test(authority) ||
        authority === 'tests/README.md';
      if (!isCurrentAuthority) {
        fail(
          `docs/documentation-map.json rule ${rule.id} uses non-current authority: ${authority}`,
        );
      } else if (!existsSync(join(root, authority))) {
        fail(
          `docs/documentation-map.json rule ${rule.id} references missing authority: ${authority}`,
        );
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
  join(root, 'docs', 'README.md'),
  join(root, 'docs', 'AGENTS.md'),
  ...collectMarkdownFiles(join(root, 'docs', 'active')),
  ...collectMarkdownFiles(join(root, 'docs', 'book')),
  ...collectMarkdownFiles(join(root, 'docs', 'runbooks')),
  join(root, 'docs', 'adr', 'README.md'),
  join(root, 'docs', 'space', 'index.md'),
  join(root, 'docs', 'space', 'plans', 'index.md'),
  ...collectMarkdownFiles(join(root, 'packages')),
  ...collectMarkdownFiles(join(root, 'apps')),
  join(root, 'tests', 'README.md'),
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
