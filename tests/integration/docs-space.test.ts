import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = join(import.meta.dir, '../..');

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
  test('keeps every workspace README on the V2 owner-authority template', () => {
    const readmes = [
      'packages/runtime-contract/README.md',
      'packages/agent-kernel/README.md',
      'packages/runtime-spi/README.md',
      'packages/runtime-host/README.md',
      'packages/runtime-storage-sqlite/README.md',
      'packages/builtin-runtime/README.md',
      'apps/kite-cli/README.md',
    ];
    const required = [
      '## 定位',
      '## 拥有职责',
      '## 不拥有职责',
      '## 允许依赖',
      '## 公开入口',
      '## 关键不变量',
      '## 测试',
      '## 文档影响',
    ];
    for (const path of readmes) {
      const source = readFileSync(join(repoRoot, path), 'utf8');
      for (const heading of required) expect(source, `${path}: ${heading}`).toContain(heading);
      expect(source).toMatch(/[\u3400-\u9fff]/u);
    }
  });

  test('keeps active space records indexed and present', () => {
    const indexPath = join(repoRoot, 'docs', 'space', 'index.md');
    const index = readFileSync(indexPath, 'utf8');
    const indexedActiveRecords = Array.from(
      index.matchAll(/\| `(\.\.\/active\/[^`]+)` \| active \|/g),
      (match) => match[1]!.replace(/^\.\.\/active\//, ''),
    ).sort();

    const activeRecords = collectFilesIfExists(join(repoRoot, 'docs', 'active'))
      .map((path) => relative(join(repoRoot, 'docs', 'active'), path).replace(/\\/g, '/'))
      .filter((path) => path.endsWith('.md'))
      .sort();

    expect(indexedActiveRecords).toEqual(activeRecords);

    for (const record of activeRecords) {
      const source = readFileSync(join(repoRoot, 'docs', 'active', record), 'utf8');
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
