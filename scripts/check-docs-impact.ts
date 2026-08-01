import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DocumentationRule {
  id: string;
  sources: string[];
  excludeSources?: string[];
  documents: string[];
}

export interface DocumentationMap {
  version: number;
  rules: DocumentationRule[];
}

export interface DocumentationImpactFailure {
  ruleId: string;
  sources: string[];
  expectedDocuments: string[];
}

function normalize(path: string): string {
  return path.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

export function matchesDocumentationPattern(path: string, pattern: string): boolean {
  const candidate = normalize(path);
  const normalizedPattern = normalize(pattern);
  if (normalizedPattern.endsWith('/**')) {
    return candidate.startsWith(normalizedPattern.slice(0, -2));
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
    if (rule.documents.some((document) => changed.has(normalize(document)))) continue;
    failures.push({
      ruleId: rule.id,
      sources: matchedSources,
      expectedDocuments: rule.documents,
    });
  }
  return failures;
}

function stagedFiles(): string[] {
  const result = Bun.spawnSync({
    cmd: ['git', 'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
    stdout: 'pipe',
    stderr: 'inherit',
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
  return result.stdout.toString().split('\0').filter(Boolean);
}

function loadMap(root: string): DocumentationMap {
  return JSON.parse(
    readFileSync(join(root, 'docs', 'documentation-map.json'), 'utf8'),
  ) as DocumentationMap;
}

if (import.meta.main) {
  const changed = stagedFiles();
  const failures = evaluateDocumentationImpact(changed, loadMap(process.cwd()));
  if (failures.length === 0) {
    console.log('Documentation impact checks passed.');
  } else {
    console.error(
      'Documentation impact check failed. Stage at least one affected current document:',
    );
    for (const failure of failures) {
      console.error(`\n[${failure.ruleId}] changed implementation:`);
      for (const source of failure.sources) console.error(`  - ${source}`);
      console.error('Expected one of:');
      for (const document of failure.expectedDocuments) console.error(`  - ${document}`);
    }
    process.exitCode = 1;
  }
}
