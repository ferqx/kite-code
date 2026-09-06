import { existsSync, readFileSync } from 'node:fs';
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

export interface DocumentationImpactItem {
  ruleId: string;
  sources: string[];
  authorities: string[];
  changedAuthorities: string[];
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
): DocumentationImpactItem[] {
  const changed = new Set(changedFiles.map(normalize));
  const impacts: DocumentationImpactItem[] = [];
  for (const rule of map.rules) {
    const matchedSources = [...changed].filter(
      (path) =>
        rule.sources.some((pattern) => matchesDocumentationPattern(path, pattern)) &&
        !rule.excludeSources?.some((pattern) => matchesDocumentationPattern(path, pattern)),
    );
    if (matchedSources.length === 0) continue;
    impacts.push({
      ruleId: rule.id,
      sources: matchedSources,
      authorities: rule.authorities,
      changedAuthorities: rule.authorities.filter((document) => changed.has(normalize(document))),
    });
  }
  return impacts;
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

export function isCurrentDocumentation(path: string): boolean {
  return (
    path === 'README.md' ||
    path === 'README.zh-CN.md' ||
    path === 'tests/README.md' ||
    path === 'docs/AGENTS.md' ||
    (/^docs\/(?:handbook|development)\/.+\.md$/u.test(path) &&
      !path.endsWith('/README.md') &&
      path !== 'docs/development/architecture.md') ||
    /^docs\/(?:active|runbooks)\/[^/]+\.md$/u.test(path) ||
    /^(?:packages|apps)\/[^/]+\/(?:README\.md|docs\/.+\.md)$/u.test(path)
  );
}

export function validateDocumentationMap(value: unknown, root: string): DocumentationMap {
  const map = value as DocumentationMap | null;
  if (map?.version !== 2 || !Array.isArray(map.rules) || map.rules.length === 0) {
    throw new Error('Documentation map must contain version 2 and non-empty rules.');
  }
  const ids = new Set<string>();
  for (const rule of map.rules) {
    if (!rule || typeof rule.id !== 'string' || !rule.id.trim() || ids.has(rule.id)) {
      throw new Error('Documentation rule id must be non-empty and unique.');
    }
    ids.add(rule.id);
    if (
      'documents' in rule ||
      !Array.isArray(rule.sources) ||
      !rule.sources.length ||
      !Array.isArray(rule.authorities) ||
      !rule.authorities.length ||
      (rule.excludeSources !== undefined && !Array.isArray(rule.excludeSources))
    ) {
      throw new Error(`Invalid documentation rule: ${rule.id}`);
    }
    for (const pattern of [...rule.sources, ...(rule.excludeSources ?? [])]) {
      if (
        typeof pattern !== 'string' ||
        documentationPatternError(pattern) ||
        pattern.startsWith('/') ||
        pattern.split('/').includes('..') ||
        !existsSync(join(root, documentationPatternBase(pattern)))
      ) {
        throw new Error(`${rule.id}: invalid or missing source ${String(pattern)}`);
      }
    }
    for (const document of rule.authorities) {
      if (
        typeof document !== 'string' ||
        document.split('/').includes('..') ||
        !isCurrentDocumentation(document) ||
        !existsSync(join(root, document))
      ) {
        throw new Error(`${rule.id}: invalid or missing current document ${String(document)}`);
      }
    }
  }
  return map;
}

function loadMap(root: string): DocumentationMap {
  return validateDocumentationMap(
    JSON.parse(readFileSync(join(root, 'docs', 'documentation-map.json'), 'utf8')),
    root,
  );
}

if (import.meta.main) {
  let options: DocumentationImpactOptions;
  try {
    options = parseDocumentationImpactOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  try {
    const changed = changedFilesForScope(options);
    const impacts = evaluateDocumentationImpact(changed, loadMap(process.cwd()));
    console.log(
      `Documentation impact review (scope=${options.scope}, changed=${changed.length}, rules=${impacts.length}).`,
    );
    if (impacts.length === 0)
      console.log('No mapped source changes; this is not a semantic no-impact conclusion.');
    for (const impact of impacts) {
      console.log(`\n[${impact.ruleId}] ${impact.sources.join(', ')}`);
      for (const document of impact.authorities) {
        const state = impact.changedAuthorities.includes(document)
          ? 'changed; review content'
          : 'review unchanged';
        console.log(`  ${state}: ${document}`);
      }
    }
    console.log(
      'Confirm product/client impact and document accuracy in the review. Changed paths do not prove semantic correctness.',
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
