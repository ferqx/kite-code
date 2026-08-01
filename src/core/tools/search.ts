import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import type { ProtectedPathEvaluatorV1 } from '@/core/policies/protected-path';
import type { ShellResult } from '@/core/types';
import { readTextContentAsync } from './file';
import {
  canonicalPathForComparison,
  isPathInsideWorkspace,
  msys2ToWindowsPath,
} from './path-utils';

interface SearchFilesInput {
  workspace: string;
  pattern: unknown;
  path?: unknown;
  allowExternal?: boolean;
  protectedPathEvaluator?: ProtectedPathEvaluatorV1;
}

interface SearchContentInput {
  workspace: string;
  pattern: unknown;
  path?: unknown;
  glob?: unknown;
  allowExternal?: boolean;
  protectedPathEvaluator?: ProtectedPathEvaluatorV1;
}

// .git 目录永远跳过（与 ripgrep 一致；git 不追踪自身，gitignore 也无法重新包含它）。
// The .git directory is always skipped (same as ripgrep).
const SKIP_DIRS = new Set(['.git']);

// 遍历与文件读取全部走 node:fs/promises：每次 await 都会让出事件循环，
// 使 TUI 的动画定时器（StatusBar/ToolCard spinner）在搜索期间持续渲染。
// 结果顺序与历史同步实现一致（readdir 目录序 + 深度优先递归）。
// The walk and file reads all use node:fs/promises: every await yields the
// event loop so TUI animation timers keep rendering while a search runs.
// Result ordering matches the former sync implementation (readdir order +
// depth-first recursion).

export async function searchFiles(input: SearchFilesInput): Promise<ShellResult> {
  try {
    const pattern = String(input.pattern || '*');
    const rawPath = msys2ToWindowsPath(String(input.path || '.'));
    const root = resolve(input.workspace, rawPath);
    const workspaceRoot = canonicalPathForComparison(input.workspace);
    const matches: string[] = [];

    for await (const file of walkFiles(
      input.workspace,
      root,
      input.allowExternal,
      input.protectedPathEvaluator,
    )) {
      const rel = toPosix(relative(workspaceRoot, file));
      if (matchesFilePattern(rel, pattern)) {
        matches.push(rel);
      }
    }

    matches.sort();
    return {
      ok: true,
      command: `search_files ${pattern}`,
      exitCode: 0,
      stdout: matches.length ? `${matches.join('\n')}\n` : '',
      stderr: '',
    };
  } catch (error) {
    return failed(`search_files ${String(input.pattern || '')}`, error);
  }
}

export async function searchContent(input: SearchContentInput): Promise<ShellResult> {
  const pattern = String(input.pattern || '');
  try {
    const rawPath = msys2ToWindowsPath(String(input.path || '.'));
    const root = resolve(input.workspace, rawPath);
    const workspaceRoot = canonicalPathForComparison(input.workspace);
    const regex = new RegExp(pattern);
    const glob = input.glob === undefined ? null : String(input.glob);
    const lines: string[] = [];

    for await (const file of walkFiles(
      input.workspace,
      root,
      input.allowExternal,
      input.protectedPathEvaluator,
    )) {
      const rel = toPosix(relative(workspaceRoot, file));
      if (glob && !matchesFilePattern(rel, glob)) {
        continue;
      }

      const read = await readTextContentAsync(input.workspace, rel, {
        allowExternal: input.allowExternal,
      });
      if (!read.ok) {
        continue;
      }

      const fileLines = read.content.split('\n');
      for (let index = 0; index < fileLines.length; index++) {
        const line = fileLines[index]!;
        if (regex.test(line)) {
          lines.push(`${rel}:${index + 1}:${line}`);
        }
      }
    }

    return {
      ok: true,
      command: `search_content ${pattern}`,
      exitCode: 0,
      stdout: lines.length ? `${lines.join('\n')}\n` : '',
      stderr: '',
    };
  } catch (error) {
    return failed(`search_content ${pattern}`, error);
  }
}

// ============================================================================
// .gitignore 过滤 / .gitignore filtering
//
// 工作区内搜索遵循 .gitignore 忽略规则（与 ripgrep 的默认语义对齐）：
// - 作用域为工作区根目录：从工作区根到搜索根的祖先链上的 .gitignore，
//   以及遍历中每个子目录的 .gitignore 都会生效；工作区之上的仓库级配置
//   （如 .git/info/exclude、全局 excludesFile）不在范围内。
// - 支持：空行/注释、`!` 反选、目录专用尾斜杠、前导/中段 `/` 锚定、
//   `*`、`?`、`[abc]`/`[!abc]`、`**`（前导 `**/`、尾随 `/**`、中段 `/**/`）、
//   反斜杠转义；按目录叠加，后匹配的规则覆盖先匹配的。
// - 被排除的目录整体剪枝（git 语义：父目录被排除后，内部规则无法重新包含）。
// - 显式搜索单个文件时不做忽略过滤（显式路径优先，与历史行为一致）。
// - 显式目录搜索根本身不被剪枝：即使该目录名命中忽略规则，遍历仍进入，
//   但其内条目继续受祖先链规则过滤（与 ripgrep 略有差异的已记录子集）。
// - 工作区外搜索（allowExternal）不做过滤。
//
// Searches inside the workspace honor .gitignore rules (aligned with
// ripgrep's default semantics). Scope is the workspace root: .gitignore
// files along the ancestor chain from the workspace root down to the search
// root apply, plus each directory's own .gitignore encountered during the
// walk. Repo-level config above the workspace (.git/info/exclude, global
// excludesFile) is out of scope. Excluded directories are pruned wholesale
// during recursion; an explicitly requested directory root is itself never
// pruned (documented divergence from ripgrep).
// ============================================================================

interface IgnoreRule {
  /** 匹配相对于规则所属目录的 POSIX 路径 / Tests against the path relative to the rule's directory. */
  regex: RegExp;
  negate: boolean;
  dirOnly: boolean;
  /** 规则所属目录相对工作区根的 POSIX 路径（根为 ''）/ POSIX path of the owning directory relative to the workspace root. */
  base: string;
}

function parseIgnoreLine(line: string, base: string): IgnoreRule | null {
  // 去除行尾未被转义的空白：仅当紧邻空白前的反斜杠为奇数个时，最后一个空白
  // 视为被转义（保留一个空格）。`foo\ ` → 模式 'foo '；`foo\\ ` → 模式 'foo\'。
  // Strip unescaped trailing whitespace: a run of backslashes immediately
  // before the whitespace escapes the last space iff its length is odd.
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  let backslashes = 0;
  for (let k = end - 1; k >= 0 && line[k] === '\\'; k--) backslashes++;
  if (backslashes % 2 === 1 && end < line.length) end += 1;
  let pattern = line.slice(0, end);
  if (pattern === '') return null;
  if (pattern.startsWith('#')) return null;
  // `!` 反选判定必须在 `\!` 处理之前：`\!foo` 是字面模式 '!foo'（匹配名为
  // '!foo' 的文件），不是反选。转义序列由转换阶段的通用反斜杠处理消化。
  // The negation check must run before escape handling: `\!foo` is a literal
  // pattern '!foo' (matches a file named '!foo'), not a negation. Escape
  // sequences are consumed by the generic backslash handling in the converter.
  let negate = false;
  if (pattern.startsWith('!')) {
    negate = true;
    pattern = pattern.slice(1);
  }
  let dirOnly = false;
  if (pattern.endsWith('/')) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }
  if (pattern === '') return null;

  // 前导或中段分隔符 → 锚定到规则目录；否则按 basename 在任意层级匹配。
  // Leading or middle slash anchors to the rule's directory; otherwise the
  // pattern matches a basename at any level below it.
  let anchored = false;
  if (pattern.startsWith('/')) {
    anchored = true;
    pattern = pattern.slice(1);
  } else if (pattern.includes('/')) {
    anchored = true;
  }

  const regex = ignorePatternToRegExp(pattern, anchored);
  if (!regex) return null;
  return { regex, negate, dirOnly, base };
}

interface ParsedCharClass {
  /** 已转义的类体（不含分隔符）/ Escaped class body (separator never included). */
  body: string;
  negated: boolean;
  /** 闭合 `]` 的下标 / Index of the closing `]`. */
  end: number;
}

/** 按 git wildmatch 规则解析字符类：`[!` 取反；紧跟 `[`（或 `[!`）的 `]`
 * 是字面成员；类内反斜杠为字面；未闭合的 `[` 使整个模式不匹配（返回 null）。
 * Parse a character class with git wildmatch rules: `[!` negates; a `]`
 * directly after `[` (or `[!`) is a literal member; backslashes inside the
 * class are literal; an unterminated `[` makes the whole pattern non-matching
 * (null). The path separator never matches a class (git WM_PATHNAME). */
function parseCharClass(pattern: string, start: number): ParsedCharClass | null {
  let j = start + 1;
  let negated = false;
  if (pattern[j] === '!') {
    negated = true;
    j++;
  }
  let body = '';
  let first = true;
  for (; j < pattern.length; j++) {
    const char = pattern[j]!;
    if (char === ']' && !first) {
      return { body, negated, end: j };
    }
    first = false;
    if (char === '\\' && pattern[j + 1] !== undefined) {
      body += escapeRegExp(pattern[j + 1]!);
      j++;
      continue;
    }
    // '/' 永不匹配（WM_PATHNAME）；`]` `^` `-` 保持原义（`]` 需转义，
    // `-` 保留区间语义，`^` 在非首位无特殊含义但转义无害）。
    // '/' never matches (WM_PATHNAME); keep '-', escape regex-class specials.
    if (char === '/') continue;
    body += char === ']' || char === '\\' || char === '^' ? `\\${char}` : char;
  }
  return null;
}

function ignorePatternToRegExp(pattern: string, anchored: boolean): RegExp | null {
  let body = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    const prev = pattern[i - 1];
    const next = pattern[i + 1];
    if (char === '*' && next === '*') {
      const after = pattern[i + 2];
      const atSegmentStart = prev === undefined || prev === '/';
      if (atSegmentStart && after === '/') {
        // `**/` — 零个或多个目录 / zero or more leading directories
        body += '(?:.*/)?';
        i += 2;
      } else if (atSegmentStart && after === undefined) {
        // 尾随 `**` — 目录内全部内容 / trailing `**` — everything inside
        body += '.*';
        i += 1;
      } else {
        // 退化为普通双星 / degenerate: treat as two regular stars
        body += '[^/]*[^/]*';
        i += 1;
      }
    } else if (char === '*') {
      body += '[^/]*';
    } else if (char === '?') {
      body += '[^/]';
    } else if (char === '[') {
      const parsed = parseCharClass(pattern, i);
      if (!parsed) return null; // 畸形字符类 → git 不匹配 → 整条规则无效
      // 取反类用负前瞻 + 非分隔符表达，保证 '/' 不被匹配。
      // Negated classes use a lookahead so '/' can never match.
      body += parsed.negated ? `(?:(?![${parsed.body}])[^/])` : `[${parsed.body}]`;
      i = parsed.end;
    } else if (char === '\\') {
      if (next !== undefined) {
        body += escapeRegExp(next);
        i++;
      } else {
        // 行尾孤立反斜杠：git wildmatch 视为不匹配 → 整条规则无效。
        // Trailing lone backslash: git wildmatch treats it as non-matching.
        return null;
      }
    } else {
      body += escapeRegExp(char);
    }
  }
  const source = anchored ? `^${body}$` : `(?:^|/)${body}$`;
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

async function loadIgnoreRules(dir: string, base: string): Promise<IgnoreRule[]> {
  let text: string;
  try {
    text = await readFile(join(dir, '.gitignore'), 'utf8');
  } catch {
    // 不存在或不可读 → 无规则。读取失败按无规则处理是搜索工具的刻意取舍：
    // 宁可多返回结果，也不因一个损坏的 .gitignore 中断整个搜索。
    // Missing or unreadable → no rules. Failing open (more results rather
    // than aborting the whole search over one broken .gitignore) is a
    // deliberate tradeoff for a search tool.
    return [];
  }
  // 剥离 UTF-8 BOM（Windows 编辑器常见），否则首条模式被静默破坏。
  // Strip a UTF-8 BOM (common from Windows editors) or the first pattern
  // would be silently corrupted.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rules: IgnoreRule[] = [];
  for (const line of text.split(/\r?\n/)) {
    const rule = parseIgnoreLine(line, base);
    if (rule) rules.push(rule);
  }
  return rules;
}

function isIgnored(relPath: string, isDir: boolean, rules: readonly IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    const target =
      rule.base === ''
        ? relPath
        : relPath.startsWith(`${rule.base}/`)
          ? relPath.slice(rule.base.length + 1)
          : null;
    if (target === null) continue;
    if (rule.regex.test(target)) ignored = !rule.negate;
  }
  return ignored;
}

// ── 遍历 / Walk ──

async function* walkFiles(
  workspace: string,
  root: string,
  allowExternal?: boolean,
  protectedPathEvaluator?: ProtectedPathEvaluatorV1,
): AsyncGenerator<string> {
  const workspaceRoot = canonicalPathForComparison(workspace);
  const resolvedRoot = canonicalPathForComparison(root);
  const rootProtectedPathDecision = protectedPathEvaluator?.evaluate({
    path: resolvedRoot,
    operation: 'read',
  });
  if (rootProtectedPathDecision && rootProtectedPathDecision.outcome !== 'allow') {
    throw new Error(`Refusing search of protected path: ${rootProtectedPathDecision.reason}`);
  }
  if (!allowExternal) {
    if (!isPathInsideWorkspace(workspaceRoot, resolvedRoot)) {
      throw new Error(`Refusing search outside workspace: ${root}`);
    }
  }

  const statResult = await stat(resolvedRoot);
  if (statResult.isFile()) {
    // 显式文件目标不受忽略规则过滤 / Explicit file targets bypass ignore rules
    yield resolvedRoot;
    return;
  }
  if (!statResult.isDirectory()) {
    return;
  }

  const relRoot = toPosix(relative(workspaceRoot, resolvedRoot));
  let rules: IgnoreRule[] = [];
  if (!allowExternal) {
    // 预加载工作区根到搜索根的祖先链 .gitignore
    // Preload .gitignore files along the ancestor chain from the workspace root
    const segments = relRoot === '' ? [] : relRoot.split('/');
    let cursor = workspaceRoot;
    let base = '';
    rules = [...rules, ...(await loadIgnoreRules(cursor, ''))];
    for (const segment of segments) {
      cursor = join(cursor, segment);
      base = base === '' ? segment : `${base}/${segment}`;
      rules = [...rules, ...(await loadIgnoreRules(cursor, base))];
    }
  }

  yield* walkDir(
    workspaceRoot,
    resolvedRoot,
    relRoot,
    rules,
    allowExternal,
    protectedPathEvaluator,
  );
}

async function* walkDir(
  workspaceRoot: string,
  dir: string,
  relDir: string,
  rules: IgnoreRule[],
  allowExternal?: boolean,
  protectedPathEvaluator?: ProtectedPathEvaluatorV1,
): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = resolve(dir, entry.name);
    const relChild = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
    const protectedPathDecision = protectedPathEvaluator?.evaluate({
      path: child,
      operation: 'read',
    });
    if (protectedPathDecision && protectedPathDecision.outcome !== 'allow') {
      continue;
    }
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      // 先用父级规则判定排除；被排除目录整体剪枝，其内部 .gitignore 不参与
      // （git 语义：父目录被排除后无法用内部规则重新包含）。
      // Evaluate exclusion with parent rules first; pruned directories never
      // consult their own .gitignore (git: no re-inclusion under an excluded
      // parent).
      if (!allowExternal && isIgnored(relChild, true, rules)) {
        continue;
      }
      const childRules = allowExternal
        ? rules
        : [...rules, ...(await loadIgnoreRules(child, relChild))];
      yield* walkDir(
        workspaceRoot,
        child,
        relChild,
        childRules,
        allowExternal,
        protectedPathEvaluator,
      );
    } else if (entry.isFile()) {
      if (!allowExternal && isIgnored(relChild, false, rules)) {
        continue;
      }
      yield child;
    }
  }
}

// ── 文件名 glob / File name globbing ──

const globRegexCache = new Map<string, RegExp>();

function matchesFilePattern(relativePath: string, pattern: string): boolean {
  const normalized = toPosix(pattern || '*');
  const target = normalized.includes('/') ? relativePath : basename(relativePath);
  return globToRegExp(normalized).test(target);
}

function globToRegExp(glob: string): RegExp {
  const cached = globRegexCache.get(glob);
  if (cached) return cached;
  let pattern = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    const next = glob[i + 1];
    if (char === '*') {
      if (next === '*') {
        pattern += '.*';
        i++;
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else if (char === '{') {
      const close = glob.indexOf('}', i + 1);
      if (close !== -1) {
        const choices = glob
          .slice(i + 1, close)
          .split(',')
          .map((choice) => escapeRegExp(choice))
          .join('|');
        pattern += `(?:${choices})`;
        i = close;
      } else {
        pattern += '\\{';
      }
    } else {
      pattern += escapeRegExp(char);
    }
  }
  const regex = new RegExp(`${pattern}$`);
  globRegexCache.set(glob, regex);
  return regex;
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function failed(command: string, error: unknown): ShellResult {
  return {
    ok: false,
    command,
    exitCode: -1,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
  };
}
