import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = join(import.meta.dir, '..');

function collectFilesIfExists(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? collectFilesIfExists(path) : [path];
  });
}

describe('repository knowledge system', () => {
  test('keeps active space records indexed and present', () => {
    const indexPath = join(repoRoot, 'docs', 'space', 'index.md');
    const index = readFileSync(indexPath, 'utf8');
    const indexedActiveRecords = Array.from(
      index.matchAll(/\| `(execution\/active\/[^`]+)` \| active \|/g),
      (match) => match[1],
    ).sort();

    const activeRecords = collectFilesIfExists(
      join(repoRoot, 'docs', 'space', 'execution', 'active'),
    )
      .map((path) => relative(join(repoRoot, 'docs', 'space'), path).replace(/\\/g, '/'))
      .filter((path) => path.endsWith('.md'))
      .sort();

    expect(indexedActiveRecords).toEqual(activeRecords);

    for (const record of activeRecords) {
      const source = readFileSync(join(repoRoot, 'docs', 'space', record), 'utf8');
      expect(source).toContain('状态：active');
      expect(source).toContain('读取时机：');
      expect(source).toContain('验证：');
    }
  });

  test('keeps superpowers-generated docs out of the repository', () => {
    const files = collectFilesIfExists(join(repoRoot, 'docs', 'superpowers'))
      .map((path) => relative(repoRoot, path))
      .sort();

    expect(files).toEqual([]);
  });

  test('keeps space record metadata labels in Chinese', () => {
    const markdownFiles = collectFilesIfExists(join(repoRoot, 'docs', 'space'))
      .filter((path) => path.endsWith('.md'))
      .map((path) => relative(repoRoot, path));
    const legacyMetadataFiles = markdownFiles.filter((path) => {
      const source = readFileSync(join(repoRoot, path), 'utf8');
      return /^(Status|Date|Last updated|Last verified|Scope|Read when|Related|Verification):/m.test(
        source,
      );
    });

    expect(legacyMetadataFiles).toEqual([]);
  });
});
