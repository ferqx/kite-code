/**
 * search 工具 .gitignore 过滤测试
 * .gitignore filtering tests for the search tools.
 *
 * 工作区内搜索遵循 .gitignore 忽略规则（与 ripgrep 默认语义对齐）：
 * 祖先链与子目录的 .gitignore 均生效，`!` 反选、目录专用尾斜杠、锚定模式、
 * `**` 与字符类受支持；被排除目录整体剪枝（内部规则无法重新包含）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalWorkspaceFilesystemProviderV1,
  WorkspaceFilesystemGrantAuthorityV1,
  workspaceFilesystemProtectedBoundaryDigestV1,
} from '@kite/builtin-runtime/filesystem';
import { createProtectedPathEvaluatorV1 } from '@kite/builtin-runtime/sandbox';
import type {
  WorkspaceFilesystemObserveObservationV1,
  WorkspaceFilesystemObserveOperationV1,
} from '@kite/runtime-spi';

async function builtinFilesystemFixture(workspace: string) {
  const authority = new WorkspaceFilesystemGrantAuthorityV1({
    integrityKey: new Uint8Array(32).fill(23),
    idSource: (() => {
      let id = 0;
      return () => `search-ignore-grant-${++id}`;
    })(),
  });
  const evaluator = createProtectedPathEvaluatorV1({ workspaceRoot: workspace, mode: 'deny' });
  const unsignedBoundary = {
    schema: 'kite.workspace-filesystem-protected-boundary.v1' as const,
    ...structuredClone(evaluator.projectFilesystemBoundary()),
  };
  const protectedBoundary = {
    ...unsignedBoundary,
    boundaryDigest: workspaceFilesystemProtectedBoundaryDigestV1(unsignedBoundary),
  };
  const binding = {
    threadId: 'search-ignore-thread',
    turnId: 'search-ignore-turn',
    toolCallId: 'search-ignore-call',
    invocationId: 'search-ignore-invocation',
    attempt: 1,
    intentDigest: `sha256:${'2'.repeat(64)}`,
    searchBoundaryDigest: protectedBoundary.boundaryDigest,
    capabilityRevision: 'search-ignore-capability',
    effectDigest: 'search-ignore-effect',
    canonicalWorkspace: await realpath(workspace),
    protectedPathRevision: 'search-ignore-protected-path',
    approvalSummary: 'search ignore test fixture',
  };
  const provider = new LocalWorkspaceFilesystemProviderV1(authority.verifier());
  return async (
    operation: WorkspaceFilesystemObserveOperationV1,
  ): Promise<
    | { readonly ok: true; readonly observation: WorkspaceFilesystemObserveObservationV1 }
    | { readonly ok: false; readonly failure: { readonly code: string; readonly message: string } }
  > =>
    provider.observe({
      grant: authority.issueObserveGrant({
        binding,
        operation,
        protectedBoundary,
        ttlMs: 30_000,
      }),
    });
}

async function observeWorkspaceFilesystem(
  workspace: string,
  operation: WorkspaceFilesystemObserveOperationV1,
) {
  const observe = await builtinFilesystemFixture(workspace);
  return observe(operation);
}

describe('search tools honor .gitignore rules', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'openpx-search-ignore-'));

    const put = async (rel: string, content = 'needle\n') => {
      const target = join(workspace, rel);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, content);
    };

    await put(
      '.gitignore',
      [
        'node_modules/',
        '*.log',
        '!keep.log',
        'build/',
        '/root-only.tmp',
        'docs/private/',
        'assets/**',
        '**/tmp-file.dat',
        '*.bak[0-9]',
        'pruned/',
        '',
      ].join('\n'),
    );
    await put('src/.gitignore', 'gen/\n');
    await put('sub/.gitignore', 'secret.txt\n');
    // 被剪枝目录内部的反选规则不能生效（git 语义）
    // Negations inside a pruned directory must not take effect (git semantics)
    await put('pruned/.gitignore', '!*\n');

    // 应被忽略 / expected ignored
    await put('debug.log');
    await put('root-only.tmp');
    await put('old.bak1');
    await put('tmp-file.dat');
    await put('deep/nest/tmp-file.dat');
    await put('node_modules/dep/index.js');
    await put('build/out.js');
    await put('assets/packed.js');
    await put('assets/sub/deep.js');
    await put('docs/private/notes.txt');
    await put('src/gen/g.ts');
    await put('sub/secret.txt');
    await put('pruned/back.txt');

    // 应被收录 / expected included
    await put('keep.log'); // `!keep.log` 反选 / negation re-includes
    await put('keep.txt');
    await put('old.bakx'); // 字符类 [0-9] 不匹配 x / char class does not match x
    await put('docs/build'); // 'build/' 是目录专用模式，不忽略同名文件 / dir-only pattern
    await put('src/a.ts');

    // 子目录搜索根：祖先链规则（根 *.log）与 src/.gitignore 都必须生效
    // Subdirectory search root: ancestor rules (root *.log) and src/.gitignore
    await put('src/err.log');
    await put('sub/open.txt');
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  // .gitignore 文件本身不被忽略（pruned/.gitignore 除外——其父目录被剪枝）
  // .gitignore files are not themselves ignored (except pruned/.gitignore —
  // its parent directory is pruned).
  const EXPECTED_INCLUDED = [
    '.gitignore',
    'docs/build',
    'keep.log',
    'keep.txt',
    'old.bakx',
    'src/.gitignore',
    'src/a.ts',
    'sub/.gitignore',
    'sub/open.txt',
  ];

  test('search_files excludes gitignored files and keeps negations', async () => {
    const result = await observeWorkspaceFilesystem(workspace, {
      kind: 'search_files',
      path: '.',
      pathScope: 'workspace_only',
      pattern: '*',
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.observation.kind !== 'search_files') {
      throw new Error('search_files unexpectedly failed');
    }
    expect(result.observation.matches).toEqual(EXPECTED_INCLUDED);
  });

  // search_content 按遍历序输出（不排序），readdir 顺序依赖文件系统
  // （NTFS 字母序、ext4/XFS 未必）——断言前必须排序，否则 Linux CI 失败。
  // search_content emits walk order (unsorted) and readdir order is
  // filesystem-dependent (NTFS is alphabetical, ext4/XFS are not) —
  // assertions must sort first or they break on Linux CI.
  test('search_content skips gitignored files', async () => {
    const result = await observeWorkspaceFilesystem(workspace, {
      kind: 'search_content',
      path: '.',
      pathScope: 'workspace_only',
      pattern: 'needle',
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.observation.kind !== 'search_content') {
      throw new Error('search_content unexpectedly failed');
    }
    // .gitignore 文件不含 needle，不会出现在内容搜索结果中
    // .gitignore files contain no needle, so they never appear in content results
    expect(result.observation.matches.map((match) => match.path).sort()).toEqual(
      EXPECTED_INCLUDED.filter((file) => !file.endsWith('.gitignore')),
    );
  });

  test('gitignore filtering composes with the glob filter', async () => {
    const result = await observeWorkspaceFilesystem(workspace, {
      kind: 'search_content',
      path: '.',
      pathScope: 'workspace_only',
      pattern: 'needle',
      glob: '*.{log,txt}',
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.observation.kind !== 'search_content') {
      throw new Error('glob search_content unexpectedly failed');
    }
    expect(result.observation.matches.map((match) => match.path).sort()).toEqual([
      'keep.log',
      'keep.txt',
      'sub/open.txt',
    ]);
  });

  test('explicit file target bypasses ignore rules', async () => {
    const result = await observeWorkspaceFilesystem(workspace, {
      kind: 'search_files',
      path: 'debug.log',
      pathScope: 'workspace_only',
      pattern: '*.log',
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.observation.kind !== 'search_files') {
      throw new Error('explicit file search unexpectedly failed');
    }
    expect(result.observation.matches).toEqual(['debug.log']);
  });

  test('subdirectory search root applies ancestor-chain and own rules', async () => {
    // 覆盖祖先链预加载：根 .gitignore 的 *.log 与 src/.gitignore 的 gen/
    // Covers the ancestor-chain preload: root *.log and src/.gitignore gen/
    const result = await observeWorkspaceFilesystem(workspace, {
      kind: 'search_files',
      path: 'src',
      pathScope: 'workspace_only',
      pattern: '*',
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.observation.kind !== 'search_files') {
      throw new Error('subdirectory search unexpectedly failed');
    }
    // 结果路径相对工作区根（既有行为）；gen/ 被 src/.gitignore 剪枝，
    // err.log 被祖先链的根 *.log 排除。
    // Result paths are workspace-relative (existing behavior); gen/ pruned by
    // src/.gitignore, err.log excluded by the ancestor root *.log.
    expect(result.observation.matches).toEqual(['src/.gitignore', 'src/a.ts']);
  });
});

describe('gitignore syntax edges', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'openpx-search-syntax-'));
    const put = async (rel: string, content = 'needle\n') => {
      const target = join(workspace, rel);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, content);
    };

    // BOM 前缀 + CRLF 行尾（Windows 编辑器常见形态）
    // BOM prefix + CRLF line endings (common Windows editor output)
    await put(
      '.gitignore',
      '\uFEFF' +
        [
          '# comment line — 注释必须被忽略 / comments must be ignored',
          'ignored-first/', // BOM 后首条模式必须生效 / first pattern after BOM must work
          'x[!1]', // 取反字符类 / negated character class
          'mid/**/target/', // 中段 ** / middle **
          '\\!important', // 字面 '!' 模式，不是反选 / literal '!' pattern, not negation
          '/anchored.txt', // 锚定到根 / anchored to root
          'q?.dat', // 单字符通配 / single-char wildcard
          '*.tmp',
          '!re.tmp',
          're.tmp', // 后匹配覆盖 → 重新忽略 / last match wins → re-ignored
          'trailing\\', // 行尾孤立反斜杠 → 整条无效 / lone trailing backslash → rule void
          '',
        ].join('\r\n'),
    );
    await put('src/.gitignore', '/nested-anchor.txt\r\n');

    await put('ignored-first/f.ts');
    await put('x2'); // x[!1] 命中 / matched by x[!1]
    await put('mid/target/f.ts');
    await put('mid/a/target/f.ts');
    await put('!important'); // 字面模式 '\!important' 命中 / literal pattern match
    await put('anchored.txt');
    await put('a.tmp');
    await put('re.tmp'); // 最终被 're.tmp' 重新忽略 / re-ignored by last match
    await put('src/nested-anchor.txt'); // '/nested-anchor.txt' 锚定于 src / anchored in src

    await put('q1.dat'); // q?.dat 命中 / matched by q?.dat
    await put('x1'); // x[!1] 不匹配 / not matched
    await put('q12.dat'); // '?' 只匹配单字符 / '?' matches exactly one char
    await put('mid/targets/f.ts'); // 'target' ≠ 'targets'
    await put('important'); // 不是反选目标 / not a negation target
    await put('sub/anchored.txt'); // 锚定模式不到子目录 / anchor does not reach subdirs
    await put('src/deep/nested-anchor.txt'); // 嵌套锚定不到更深目录 / nested anchor stays at src
    await put('trailing'); // 'trailing\' 无效 → 不忽略 / void rule → not ignored
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test('BOM/CRLF, negated class, middle **, escapes, anchoring, last-match-wins', async () => {
    const result = await observeWorkspaceFilesystem(workspace, {
      kind: 'search_files',
      path: '.',
      pathScope: 'workspace_only',
      pattern: '*',
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.observation.kind !== 'search_files') {
      throw new Error('syntax edge search unexpectedly failed');
    }
    expect(result.observation.matches).toEqual([
      '.gitignore',
      'important',
      'mid/targets/f.ts',
      'q12.dat',
      'src/.gitignore',
      'src/deep/nested-anchor.txt',
      'sub/anchored.txt',
      'trailing',
      'x1',
    ]);
  });
});

describe('search without .gitignore keeps former behavior', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'openpx-search-noignore-'));
    const put = async (rel: string) => {
      const target = join(workspace, rel);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, 'needle\n');
    };
    await put('src/a.ts');
    await put('node_modules/dep/index.js');
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test('search_files still walks node_modules when nothing is ignored', async () => {
    const result = await observeWorkspaceFilesystem(workspace, {
      kind: 'search_files',
      path: '.',
      pathScope: 'workspace_only',
      pattern: '*',
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.observation.kind !== 'search_files') {
      throw new Error('no-ignore search unexpectedly failed');
    }
    expect(result.observation.matches).toEqual(['node_modules/dep/index.js', 'src/a.ts']);
  });
});
