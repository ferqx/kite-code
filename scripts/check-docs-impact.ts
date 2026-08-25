import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DocumentationRule {
  id: string;
  sources: string[];
  excludeSources?: string[];
  authorities: string[];
}

export interface DocumentationMap {
  version: 2;
  rules: DocumentationRule[];
}

export interface DocumentationImpactFailure {
  ruleId: string;
  sources: string[];
  expectedAuthorities: string[];
}

export type DocumentationImpactScope = 'all' | 'staged' | 'range';

export interface DocumentationImpactOptions {
  scope: DocumentationImpactScope;
  base?: string;
}

function normalize(path: string): string {
  return path.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

export function documentationPatternError(pattern: string): string | undefined {
  const normalized = normalize(pattern);
  if (normalized.length === 0) return 'pattern must not be empty';
  if (!normalized.includes('*')) return undefined;
  if (!normalized.endsWith('/**')) return 'wildcards are only allowed as a terminal /**';
  if (normalized.slice(0, -3).includes('*')) {
    return 'wildcards are only allowed as a terminal /**';
  }
  return undefined;
}

export function documentationPatternBase(pattern: string): string {
  const normalized = normalize(pattern);
  return normalized.endsWith('/**') ? normalized.slice(0, -3) : normalized;
}

export function matchesDocumentationPattern(path: string, pattern: string): boolean {
  if (documentationPatternError(pattern)) return false;
  const candidate = normalize(path);
  const normalizedPattern = normalize(pattern);
  if (normalizedPattern.endsWith('/**')) {
    return candidate.startsWith(`${normalizedPattern.slice(0, -3)}/`);
  }
  return candidate === normalizedPattern;
}

export function evaluateDocumentationImpact(
  changedFiles: readonly string[],
  map: DocumentationMap,
): DocumentationImpactFailure[] {
  const changed = new Set(changedFiles.map(normalize));
  const failures: DocumentationImpactFailure[] = [];
  for (const rule of map.rules) {
    const matchedSources = [...changed].filter(
      (path) =>
        rule.sources.some((pattern) => matchesDocumentationPattern(path, pattern)) &&
        !rule.excludeSources?.some((pattern) => matchesDocumentationPattern(path, pattern)),
    );
    if (matchedSources.length === 0) continue;
    if (rule.authorities.some((document) => changed.has(normalize(document)))) continue;
    failures.push({
      ruleId: rule.id,
      sources: matchedSources,
      expectedAuthorities: rule.authorities,
    });
  }
  return failures;
}

function gitPaths(args: readonly string[], repositoryRoot: string): string[] {
  const result = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
  return result.stdout.toString().split('\0').filter(Boolean);
}

export function changedFilesForScope(
  options: DocumentationImpactOptions,
  repositoryRoot = process.cwd(),
): string[] {
  const common = ['--name-only', '--no-renames', '--diff-filter=ACMRD', '-z'] as const;
  if (options.scope === 'staged') {
    return gitPaths(['diff', '--cached', ...common], repositoryRoot);
  }
  if (options.scope === 'range') {
    const base = options.base?.trim();
    if (!base) throw new Error('range scope requires --base=<git-revision> or DOCS_IMPACT_BASE');
    return gitPaths(['diff', ...common, `${base}...HEAD`], repositoryRoot);
  }
  return [
    ...new Set([
      ...gitPaths(['diff', '--cached', ...common], repositoryRoot),
      ...gitPaths(['diff', ...common], repositoryRoot),
      ...gitPaths(['ls-files', '--others', '--exclude-standard', '-z'], repositoryRoot),
    ]),
  ];
}

export function parseDocumentationImpactOptions(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DocumentationImpactOptions {
  let scope: DocumentationImpactScope = 'all';
  let base = environment.DOCS_IMPACT_BASE;
  for (const argument of args) {
    if (argument.startsWith('--scope=')) {
      const value = argument.slice('--scope='.length);
      if (value !== 'all' && value !== 'staged' && value !== 'range') {
        throw new Error(`unsupported documentation impact scope: ${value}`);
      }
      scope = value;
      continue;
    }
    if (argument.startsWith('--base=')) {
      base = argument.slice('--base='.length);
      continue;
    }
    throw new Error(`unknown documentation impact argument: ${argument}`);
  }
  if (scope === 'range' && !base?.trim()) {
    throw new Error('range scope requires --base=<git-revision> or DOCS_IMPACT_BASE');
  }
  return { scope, ...(base?.trim() ? { base: base.trim() } : {}) };
}

function loadMap(root: string): DocumentationMap {
  return JSON.parse(
    readFileSync(join(root, 'docs', 'documentation-map.json'), 'utf8'),
  ) as DocumentationMap;
}

if (import.meta.main) {
  let options: DocumentationImpactOptions;
  try {
    options = parseDocumentationImpactOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const changed = changedFilesForScope(options);
  const failures = evaluateDocumentationImpact(changed, loadMap(process.cwd()));
  if (failures.length === 0) {
    console.log(
      `Documentation impact checks passed (scope=${options.scope}, changed=${changed.length}).`,
    );
  } else {
    console.error('Documentation impact check failed. Update a mapped current authority:');
    for (const failure of failures) {
      console.error(`\n[${failure.ruleId}] changed implementation:`);
      for (const source of failure.sources) console.error(`  - ${source}`);
      console.error('Expected one of:');
      for (const document of failure.expectedAuthorities) console.error(`  - ${document}`);
    }
    process.exitCode = 1;
  }
}
