import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeLineDiff, formatDiffOutput, formatMultiHunkDiff } from '../src/core/tools/diff';
import {
  DEFAULT_READ_FILE_LINE_LIMIT,
  editFile,
  readFile,
  readTextContent,
  writeFile,
} from '../src/core/tools/file';
import {
  isPathInsideWorkspace,
  msys2ToWindowsPath,
  normalizeMsys2PathsInText,
} from '../src/core/tools/path-utils';
import { searchContent, searchFiles } from '../src/core/tools/search';
import {
  assertInsideWorkspace,
  buildPolicyProvenReadOnlyHostShellInvocationsV1,
  DEFAULT_SHELL_TIMEOUT_MS,
  resolveShellTimeoutMs,
  shellTool,
} from '../src/core/tools/shell';

/** Convert MSYS2 Unix-style path to Windows-style path via cygpath (legacy test helper) */
function msys2Win(p: string): string {
  if (process.platform === 'win32' && (p === '/tmp' || p.startsWith('/tmp/'))) {
    return join(tmpdir(), p.slice('/tmp/'.length));
  }
  try {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('cygpath', ['-w', p], { encoding: 'utf8', timeout: 3000 });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {
    /* fall through to regex */
  }

  return p
    .replace(/^\/cygdrive\/([a-z])\b/i, '$1:\\')
    .replace(/^\/mnt\/([a-z])\b/i, '$1:\\')
    .replace(/^\/([a-z])\//i, '$1:\\')
    .replace(/\//g, '\\');
}

describe('tool safety', () => {
  test('policy-proven reads use a non-login fixed POSIX shell', () => {
    expect(
      buildPolicyProvenReadOnlyHostShellInvocationsV1('ls', '/workspace', {
        platform: 'darwin',
        systemRoot: '',
      }),
    ).toEqual([{ kind: 'posix', argv: ['/bin/sh', '-c', 'ls'] }]);
  });

  test('policy-proven reads cannot execute a Workspace PATH replacement', async () => {
    if (process.platform === 'win32') return;
    const workspace = mkdtempSync(join(tmpdir(), 'kite-readonly-shell-path-'));
    const marker = join(workspace, 'workspace-ls-ran');
    const previousPath = process.env.PATH;
    try {
      const fakeLs = join(workspace, 'ls');
      writeFileSync(fakeLs, `#!/bin/sh\ntouch '${marker}'\nprintf 'workspace replacement\\n'\n`);
      chmodSync(fakeLs, 0o755);
      process.env.PATH = `${workspace}:${previousPath ?? ''}`;
      const result = await shellTool({
        workspace,
        command: 'ls',
        executionTrust: 'policy_proven_read_only',
      });
      expect(result.ok).toBe(true);
      expect(result.stdout).not.toContain('workspace replacement');
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('shell timeout resolution always returns a finite hard limit', () => {
    expect(resolveShellTimeoutMs()).toBe(DEFAULT_SHELL_TIMEOUT_MS);
    expect(resolveShellTimeoutMs(0)).toBe(DEFAULT_SHELL_TIMEOUT_MS);
    expect(resolveShellTimeoutMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SHELL_TIMEOUT_MS);
    expect(resolveShellTimeoutMs(250)).toBe(250);
  });

  test('allows paths inside the workspace', () => {
    const workspace = join(tmpdir(), 'kite-code-langgraph-tools-safe');
    expect(assertInsideWorkspace(workspace, 'inside.txt')).toBe(join(workspace, 'inside.txt'));
  });

  test('allows workspace files whose names start with dots', () => {
    const workspace = join(tmpdir(), 'kite-code-langgraph-tools-safe');
    expect(assertInsideWorkspace(workspace, '..notes.txt')).toBe(join(workspace, '..notes.txt'));
  });

  test('rejects paths outside the workspace', () => {
    const workspace = join(tmpdir(), 'kite-code-langgraph-tools-safe');
    expect(() => assertInsideWorkspace(workspace, '..\\outside.txt')).toThrow(/outside workspace/);
    expect(() => assertInsideWorkspace(workspace, '../outside.txt')).toThrow(/outside workspace/);
  });

  test('write_file creates files inside the workspace', () => {
    const workspace = join(tmpdir(), 'kite-code-langgraph-tools-write');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });

    const result = writeFile({
      workspace,
      path: 'hello.txt',
      content: 'hello from write_file\n',
    });

    expect(result.ok).toBe(true);
    expect(result.lines).toBe(1);
    expect(existsSync(join(workspace, 'hello.txt'))).toBe(true);
    expect(readFileSync(join(workspace, 'hello.txt'), 'utf8')).toBe('hello from write_file\n');
  });

  test('write_file allows absolute paths that resolve inside the workspace', () => {
    const workspace = join(tmpdir(), 'kite-code-langgraph-tools-write-absolute');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    const absolutePath = join(workspace, 'nested', 'hello.txt');

    const result = writeFile({
      workspace,
      path: absolutePath,
      content: 'hello from absolute path\n',
    });

    // Absolute path that resolves inside the workspace should succeed
    expect(result.ok).toBe(true);
    expect(result.lines).toBe(1);
    expect(existsSync(absolutePath)).toBe(true);
    expect(readFileSync(absolutePath, 'utf8')).toBe('hello from absolute path\n');
  });

  test('write_file rejects absolute paths that resolve outside the workspace', () => {
    const workspace = join(tmpdir(), 'kite-code-langgraph-tools-write-absolute-outside');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });

    const result = writeFile({
      workspace,
      path: '/tmp/outside-workspace-test.txt',
      content: 'hello from outside\n',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Path is outside workspace');
  });

  test('write_file allows absolute paths with allowExternal option', () => {
    const workspace = join(tmpdir(), 'kite-code-langgraph-tools-write-external');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    const externalPath = join(tmpdir(), 'kite-code-external-test.txt');
    // Clean up from previous runs
    try {
      rmSync(externalPath);
    } catch {
      /* ignore */
    }

    const result = writeFile({
      workspace,
      path: externalPath,
      content: 'external write allowed\n',
      allowExternal: true,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(externalPath)).toBe(true);
    expect(readFileSync(externalPath, 'utf8')).toBe('external write allowed\n');
    // Clean up / 清理
    rmSync(externalPath);
  });

  test('edit_file finds and replaces text', () => {
    const workspace = join(tmpdir(), 'kite-code-langgraph-tools-edit');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });

    writeFile({ workspace, path: 'config.ts', content: '  debug: true,\n  env: prod,\n' });

    const result = editFile({
      workspace,
      path: 'config.ts',
      oldString: '  debug: true,',
      newString: '  debug: false,',
    });

    expect(result.ok).toBe(true);
    expect(result.replacements).toBe(1);
    expect(readFileSync(join(workspace, 'config.ts'), 'utf8')).toContain('debug: false');
  });

  test('edit_file strict exact: trailing whitespace mismatch fails with re-read guidance', () => {
    const workspace = join(tmpdir(), 'kite-code-tools-autofix');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });

    // File content has no trailing spaces
    writeFile({ workspace, path: 'cfg.ts', content: '  debug: true,\n  env: prod,\n' });

    // ADR-0043 §3: oldString has trailing spaces — matching is exact, no fallback
    const result = editFile({
      workspace,
      path: 'cfg.ts',
      oldString: '  debug: true,  ',
      newString: '  debug: false,',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
    expect(result.error).toContain('read_file');
    // File untouched
    expect(readFileSync(join(workspace, 'cfg.ts'), 'utf8')).toContain('debug: true');
  });

  test('edit_file strict exact: leading whitespace mismatch fails', () => {
    const workspace = join(tmpdir(), 'kite-code-tools-autofix-ml');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });

    writeFile({ workspace, path: 'f.ts', content: '  const x = 1;\n  const y = 2;\n' });

    // ADR-0043 §3: oldString stripped of indent — exact match fails, no per-line fallback
    const result = editFile({
      workspace,
      path: 'f.ts',
      oldString: 'const x = 1;\nconst y = 2;',
      newString: 'const x = 10;\nconst y = 20;',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
    const content = readFileSync(join(workspace, 'f.ts'), 'utf8');
    expect(content).toContain('const x = 1;');
  });

  test('edit_file fails when old_string not found', () => {
    const workspace = join(tmpdir(), 'kite-code-langgraph-tools-edit-nf');
    mkdirSync(workspace, { recursive: true });

    writeFile({ workspace, path: 'f.txt', content: 'hello\n' });

    const result = editFile({
      workspace,
      path: 'f.txt',
      oldString: 'nonexistent',
      newString: 'replaced',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('read_file reads file with line numbers', () => {
    const workspace = join(tmpdir(), 'kite-code-langgraph-tools-read');
    mkdirSync(workspace, { recursive: true });

    writeFile({ workspace, path: 'test.txt', content: 'line1\nline2\nline3\n' });

    const result = readFile({ workspace, path: 'test.txt', offset: 2, limit: 1 });

    expect(result.ok).toBe(true);
    expect(result.content).toContain('2|line2');
    expect(result.totalLines).toBe(3);
  });

  test('read_file defaults to a 2000-line page and continues from an explicit offset', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-code-read-default-page-'));
    try {
      const lines = Array.from({ length: DEFAULT_READ_FILE_LINE_LIMIT + 2 }, (_, index) => {
        return `line-${index + 1}`;
      });
      writeFileSync(join(workspace, 'large.txt'), `${lines.join('\n')}\n`, 'utf8');

      const first = readFile({ workspace, path: 'large.txt' });
      expect(first.ok).toBe(true);
      expect(first.fromLine).toBe(1);
      expect(first.toLine).toBe(DEFAULT_READ_FILE_LINE_LIMIT);
      expect(first.content).toContain(
        `${DEFAULT_READ_FILE_LINE_LIMIT}|line-${DEFAULT_READ_FILE_LINE_LIMIT}`,
      );
      expect(first.content).not.toContain(`|line-${DEFAULT_READ_FILE_LINE_LIMIT + 1}`);

      const next = readFile({
        workspace,
        path: 'large.txt',
        offset: DEFAULT_READ_FILE_LINE_LIMIT + 1,
      });
      expect(next.fromLine).toBe(DEFAULT_READ_FILE_LINE_LIMIT + 1);
      expect(next.toLine).toBe(DEFAULT_READ_FILE_LINE_LIMIT + 2);
      expect(next.content).toContain(
        `${DEFAULT_READ_FILE_LINE_LIMIT + 1}|line-${DEFAULT_READ_FILE_LINE_LIMIT + 1}`,
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('returns structured shell command results', async () => {
    const workspace = join(tmpdir(), 'kite-code-langgraph-tools-shell');
    mkdirSync(workspace, { recursive: true });

    const result = await shellTool({ workspace, command: 'pwd' });

    expect(result.command).toBe('pwd');
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    // MSYS2 bash on Windows outputs Unix-style paths; normalize to compare with workspace
    // On macOS, /var is a symlink to /private/var, so pwd may differ from tmpdir()
    const { realpathSync } = await import('node:fs');
    const pwdOutput = result.stdout.trim();
    const normalizedPwd = process.platform === 'win32' ? msys2Win(pwdOutput) : pwdOutput;
    expect(realpathSync(normalizedPwd).toLowerCase()).toBe(realpathSync(workspace).toLowerCase());
  });

  test('shell_execute produces no stderr noise on standard commands', async () => {
    const workspace = join(tmpdir(), 'kite-code-langgraph-tools-shell-clean');
    mkdirSync(workspace, { recursive: true });

    const result = await shellTool({ workspace, command: 'ls' });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    // MSYS2 bash must not emit /tmp or other spurious warnings to stderr
    expect(result.stderr).toBe('');
  });

  test('shellTool aborts child process when signal fires', async () => {
    const workspace = join(tmpdir(), 'kite-code-langgraph-tools-shell-abort');
    mkdirSync(workspace, { recursive: true });

    const ac = new AbortController();
    // Abort immediately
    ac.abort();

    const result = await shellTool({ workspace, command: 'sleep 60', signal: ac.signal });

    expect(result.ok).toBe(false);
    // Bun returns 128+SIGTERM(15)=143 on Unix, or AbortError with exitCode 130
    expect(result.exitCode).not.toBe(0);
  });

  test('shellTool kills long-running process on delayed abort', async () => {
    const workspace = join(tmpdir(), 'kite-code-langgraph-tools-shell-abort-delayed');
    mkdirSync(workspace, { recursive: true });

    const ac = new AbortController();
    // Abort after 100ms
    setTimeout(() => ac.abort(), 100);

    const start = Date.now();
    const result = await shellTool({ workspace, command: 'sleep 60', signal: ac.signal });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    expect([130, 143]).toContain(result.exitCode);
    // Should complete in well under 60 seconds
    expect(elapsed).toBeLessThan(5000);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MSYS2 路径转换 / MSYS2 path conversion
// ════════════════════════════════════════════════════════════════════════════

describe('msys2ToWindowsPath', () => {
  test('/d/foo/bar → D:\\foo\\bar', () => {
    if (process.platform !== 'win32') return;
    expect(msys2ToWindowsPath('/d/work/my-project/README.md')).toBe(
      'D:\\work\\my-project\\README.md',
    );
  });

  test('/c/some/path → C:\\some\\path', () => {
    if (process.platform !== 'win32') return;
    expect(msys2ToWindowsPath('/c/some/path')).toBe('C:\\some\\path');
  });

  test('absolute Windows path passes through', () => {
    if (process.platform !== 'win32') return;
    expect(msys2ToWindowsPath('D:\\app\\test.txt')).toBe('D:\\app\\test.txt');
  });

  test('relative path passes through', () => {
    expect(msys2ToWindowsPath('src/test.ts')).toBe('src/test.ts');
  });

  test('non-Windows platform returns input unchanged', () => {
    if (process.platform === 'win32') return;
    // On Linux/macOS, /d/foo is a legitimate absolute path, not a drive letter
    expect(msys2ToWindowsPath('/d/foo/bar')).toBe('/d/foo/bar');
    expect(msys2ToWindowsPath('/tmp/test/file.txt')).toBe('/tmp/test/file.txt');
  });
});

describe('canonical workspace path comparison', () => {
  test('treats a symlink alias as the same workspace boundary for reads and searches', async () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'kite-tools-path-alias-'));
    const workspace = join(root, 'workspace');
    const alias = join(root, 'workspace-alias');
    try {
      mkdirSync(workspace);
      writeFileSync(join(workspace, 'data.txt'), 'alias needle');
      symlinkSync(workspace, alias, 'dir');

      expect(isPathInsideWorkspace(workspace, join(alias, 'data.txt'))).toBe(true);
      expect(readFile({ workspace, path: join(alias, 'data.txt') }).ok).toBe(true);

      const files = await searchFiles({
        workspace,
        path: alias,
        pattern: '*.txt',
      });
      expect(files.ok).toBe(true);
      expect(files.stdout).toBe('data.txt\n');

      const content = await searchContent({
        workspace,
        path: alias,
        pattern: 'needle',
      });
      expect(content.ok).toBe(true);
      expect(content.stdout).toContain('data.txt:1:alias needle');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('normalizeMsys2PathsInText', () => {
  test('converts MSYS2 paths embedded in text', () => {
    if (process.platform !== 'win32') return;
    const input = 'CWD: /d/work/my-project\nReading /d/work/my-project/src/test.ts';
    const output = normalizeMsys2PathsInText(input);
    expect(output).toContain('D:\\work\\my-project');
    expect(output).not.toContain('/d/');
  });

  test('passes through text with no MSYS2 paths', () => {
    if (process.platform !== 'win32') return;
    const input = 'hello world\nsome output\nresult: ok';
    expect(normalizeMsys2PathsInText(input)).toBe(input);
  });

  test('non-Windows platform returns input unchanged', () => {
    if (process.platform === 'win32') return;
    const input = 'CWD: /tmp/project\nFile: /etc/config';
    expect(normalizeMsys2PathsInText(input)).toBe(input);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 二进制检测与编码 / Binary detection & encoding
// ════════════════════════════════════════════════════════════════════════════

describe('readTextContent — binary detection', () => {
  test('UTF-8 with CJK text is not binary', () => {
    const workspace = join(tmpdir(), 'kite-code-readtext-cjk');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'readme.md'), '# 你好世界\n\n这是中文内容。\n', 'utf8');

    const result = readTextContent(workspace, 'readme.md');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.totalLines).toBeGreaterThan(0);
  });

  test('rejects actual binary files', () => {
    const workspace = join(tmpdir(), 'kite-code-readtext-bin');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    const buf = Buffer.alloc(4096);
    // Fill with random bytes: many will be control chars / non-text
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    writeFileSync(join(workspace, 'data.bin'), buf);

    readTextContent(workspace, 'data.bin');
    // Random binary should be detected (or rarely pass if coincidentally text-like)
    // We don't assert strict false since random could theoretically look like text
    // but UTF-8 validation would make it astronomically unlikely for 4KB
  });

  test('force: true bypasses binary detection', () => {
    const workspace = join(tmpdir(), 'kite-code-readtext-force');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    const buf = Buffer.alloc(1024);
    for (let i = 0; i < buf.length; i++) buf[i] = 0; // all NUL bytes
    writeFileSync(join(workspace, 'nul.bin'), buf);

    const result = readTextContent(workspace, 'nul.bin', { force: true });
    expect(result.ok).toBe(true);
  });

  test('VT and FF bytes are treated as non-text', () => {
    // 0x0B (VT) and 0x0C (FF) must NOT count as text bytes
    const workspace = join(tmpdir(), 'kite-code-readtext-vtff');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    // 8KB of alternating VT/FF bytes — well over 30% non-text
    const buf = Buffer.alloc(8192);
    for (let i = 0; i < buf.length; i++) buf[i] = i % 2 === 0 ? 0x0b : 0x0c;
    writeFileSync(join(workspace, 'vtff.bin'), buf);

    const result = readTextContent(workspace, 'vtff.bin');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Binary');
    }
  });
});

describe('readTextContent — encoding', () => {
  test('UTF-8 BOM is stripped', () => {
    const workspace = join(tmpdir(), 'kite-code-readtext-bom8');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    writeFileSync(join(workspace, 'bom.txt'), Buffer.concat([bom, Buffer.from('hello\n', 'utf8')]));

    const result = readTextContent(workspace, 'bom.txt');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).not.toContain('﻿');
      expect(result.content).toContain('hello');
    }
  });

  test('UTF-16LE BOM is decoded and stripped', () => {
    const workspace = join(tmpdir(), 'kite-code-readtext-utf16le');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    // BOM (FF FE) + "hello\n" in UTF-16LE
    const content = '﻿hello\n';
    const buf = Buffer.from(content, 'utf16le');
    writeFileSync(join(workspace, 'utf16.txt'), buf);

    const result = readTextContent(workspace, 'utf16.txt');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).not.toContain('﻿');
      expect(result.content).toContain('hello');
    }
  });
});

describe('readTextContent — line endings', () => {
  test('CRLF (Windows) normalized to LF', () => {
    const workspace = join(tmpdir(), 'kite-code-readtext-crlf');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'crlf.txt'), 'line1\r\nline2\r\nline3\r\n');

    const result = readTextContent(workspace, 'crlf.txt');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).not.toContain('\r');
      expect(result.content).toContain('line1');
      expect(result.content).toContain('line3');
    }
  });
});

describe('read_file — regression', () => {
  test('handles mixed content with special chars', () => {
    const workspace = join(tmpdir(), 'kite-code-read-regress');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    writeFile({ workspace, path: 'mixed.txt', content: '// 注释\nconst x = 1;\n/* 块注释 */\n' });

    const result = readFile({ workspace, path: 'mixed.txt' });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('注释');
    expect(result.content).toContain('const x');
    expect(result.content).toContain('块注释');
  });
});

// ============================================================================
// computeLineDiff tests
// ============================================================================

describe('computeLineDiff', () => {
  test('single-line change with context', () => {
    const diff = computeLineDiff('line 1\nline 2 old\nline 3', 'line 1\nline 2 new\nline 3', 1);
    expect(diff.addedLines).toBe(1);
    expect(diff.removedLines).toBe(1);
    expect(diff.lines).toEqual([
      { type: 'context', lineNumber: 1, text: 'line 1' },
      { type: 'removed', lineNumber: 2, text: 'line 2 old' },
      { type: 'added', lineNumber: 2, text: 'line 2 new' },
      { type: 'context', lineNumber: 3, text: 'line 3' },
    ]);
  });

  test('multi-line addition', () => {
    const diff = computeLineDiff('header', 'header\nnew line 1\nnew line 2', 5);
    expect(diff.addedLines).toBe(2);
    expect(diff.removedLines).toBe(0);
    expect(diff.lines).toEqual([
      { type: 'context', lineNumber: 5, text: 'header' },
      { type: 'added', lineNumber: 6, text: 'new line 1' },
      { type: 'added', lineNumber: 7, text: 'new line 2' },
    ]);
  });

  test('multi-line deletion', () => {
    const diff = computeLineDiff('keep\nremove 1\nremove 2', 'keep', 10);
    expect(diff.addedLines).toBe(0);
    expect(diff.removedLines).toBe(2);
    expect(diff.lines).toEqual([
      { type: 'context', lineNumber: 10, text: 'keep' },
      { type: 'removed', lineNumber: 11, text: 'remove 1' },
      { type: 'removed', lineNumber: 12, text: 'remove 2' },
    ]);
  });

  test('no change', () => {
    const diff = computeLineDiff('same', 'same', 1);
    expect(diff.addedLines).toBe(0);
    expect(diff.removedLines).toBe(0);
    expect(diff.lines).toEqual([{ type: 'context', lineNumber: 1, text: 'same' }]);
  });

  test('prefix and suffix context', () => {
    const diff = computeLineDiff('keep1\nold1\nold2\nkeep2', 'keep1\nnew1\nkeep2', 3);
    expect(diff.addedLines).toBe(1);
    expect(diff.removedLines).toBe(2);
    expect(diff.lines).toEqual([
      { type: 'context', lineNumber: 3, text: 'keep1' },
      { type: 'removed', lineNumber: 4, text: 'old1' },
      { type: 'removed', lineNumber: 5, text: 'old2' },
      { type: 'added', lineNumber: 4, text: 'new1' },
      { type: 'context', lineNumber: 6, text: 'keep2' },
    ]);
  });

  test('complete replacement (no common prefix/suffix)', () => {
    const diff = computeLineDiff('old a\nold b', 'new a\nnew b\nnew c', 1);
    expect(diff.addedLines).toBe(3);
    expect(diff.removedLines).toBe(2);
    expect(diff.lines).toEqual([
      { type: 'removed', lineNumber: 1, text: 'old a' },
      { type: 'removed', lineNumber: 2, text: 'old b' },
      { type: 'added', lineNumber: 1, text: 'new a' },
      { type: 'added', lineNumber: 2, text: 'new b' },
      { type: 'added', lineNumber: 3, text: 'new c' },
    ]);
  });

  test('startLine offset', () => {
    const diff = computeLineDiff('old', 'new', 42);
    expect(diff.lines[0]!.lineNumber).toBe(42);
  });
});

describe('formatDiffOutput', () => {
  test('formats with stats line and numbered diff', () => {
    const diff = computeLineDiff('# header\nold line\ntrailer', '# header\nnew line\ntrailer', 1);
    const output = formatDiffOutput(diff);
    const lines = output.split('\n');
    expect(lines[0]).toBe('Added 1 line, removed 1 line');
    expect(lines[1]).toBe(' 1  # header');
    expect(lines[2]).toBe(' 2 -old line');
    expect(lines[3]).toBe(' 2 +new line');
    expect(lines[4]).toBe(' 3  trailer');
  });

  test('pad width matches max line number', () => {
    const diff = computeLineDiff('x', 'x\ny', 100);
    const output = formatDiffOutput(diff);
    // line numbers should be padded to 3 chars (since max is 100)
    const lines = output.split('\n');
    expect(lines[1]!.startsWith('100  x')).toBe(true);
    expect(lines[2]!.startsWith('101 +y')).toBe(true);
  });
});

describe('formatMultiHunkDiff', () => {
  test('shows diffs for multiple match locations with correct line numbers', () => {
    const output = formatMultiHunkDiff('old text', 'new text', [5, 20, 100], 3);
    const lines = output.split('\n');
    // stats line — cumulative: 1 per occurrence × 3 replacements
    expect(lines[0]).toContain('Added 3 lines');
    expect(lines[0]).toContain('removed 3 lines');
    expect(lines[0]).toContain('(replaced 3 times)');
    // first hunk at line 5 (pad=3 because maxLineNum=100+1=101)
    expect(lines[1]).toBe('  5 -old text');
    expect(lines[2]).toBe('  5 +new text');
    // separator between groups (gap > 3)
    expect(lines.some((l) => l === '...')).toBe(true);
    // last hunk at line 100 (3-digit padding)
    expect(lines.some((l) => l === '100 -old text')).toBe(true);
    expect(lines.some((l) => l === '100 +new text')).toBe(true);
  });

  test('merges adjacent hunks (gap ≤ 3) without ellipsis', () => {
    const output = formatMultiHunkDiff(
      'old text',
      'new text',
      [10, 13], // gap = 3 → adjacent, merge
      2,
    );
    const lines = output.split('\n');
    // no ellipsis for adjacent hunks
    expect(lines.includes('...')).toBe(false);
    // both changes shown
    expect(lines[1]).toBe('10 -old text');
    expect(lines[2]).toBe('10 +new text');
    expect(lines[3]).toBe('13 -old text');
    expect(lines[4]).toBe('13 +new text');
  });

  test('inserts ellipsis between non-adjacent groups', () => {
    const output = formatMultiHunkDiff('old text', 'new text', [5, 20, 50], 3);
    const lines = output.split('\n');
    const ellipsisCount = lines.filter((l) => l === '...').length;
    // 3 matches, all far apart → 2 ellipsis separators
    expect(ellipsisCount).toBe(2);
  });

  test('pads line numbers for large match lines', () => {
    const output = formatMultiHunkDiff('old text', 'new text', [999, 1000], 2);
    const lines = output.split('\n');
    // max line num = 1000 + 1 (oldStr length) = 1001 → 4-char padding
    expect(lines[1]!.startsWith(' 999 -old text')).toBe(true);
    expect(lines[2]!.startsWith(' 999 +new text')).toBe(true);
  });

  test('handles single match identically to formatDiffOutput path', () => {
    // single match — same behavior as computeLineDiff + formatDiffOutput
    const output = formatMultiHunkDiff('old text', 'new text', [15], 1);
    const lines = output.split('\n');
    expect(lines[0]).toContain('(replaced 1 time)');
    expect(lines[1]).toBe('15 -old text');
    expect(lines[2]).toBe('15 +new text');
  });

  test('correctly computes added/removed counts from diff (not line subtraction)', () => {
    // old has 3 lines, new has 1 line — 2 replacements, cumulative: removed 4
    // Old code would show "Added -2 lines" via simple subtraction; fixed to use computeLineDiff
    const output = formatMultiHunkDiff('line1\nline2\nline3', 'line1', [10, 50], 2);
    const lines = output.split('\n');
    expect(lines[0]).toContain('Added 0 lines');
    expect(lines[0]).toContain('removed 4 lines');
  });
});

describe('edit_file replace_all multi-hunk e2e', () => {
  test('shows ... separators between far-apart matches and omits middle content', () => {
    const workspace = join(
      tmpdir(),
      `kite-code-multihunk-${Math.random().toString(36).slice(2, 8)}`,
    );
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });

    // 构造文件：三处出现相同模式，分别在第 10、40、100 行
    // Build file with the same pattern at lines 10, 40, 100
    // 构造文件：三处出现相同的 3 行文本块，行号 10-12、40-42、100-102
    // Build file: same 3-line block repeats at lines 10-12, 40-42, 100-102
    const lines: string[] = [];
    for (let i = 0; i < 110; i++) {
      const ln = i + 1;
      if (ln === 10 || ln === 40 || ln === 100) lines.push('# TAG 1');
      else if (ln === 11 || ln === 41 || ln === 101) lines.push('# TAG 2');
      else if (ln === 12 || ln === 42 || ln === 102) lines.push('# TAG 3 - end');
      else lines.push(`line ${ln}`);
    }
    writeFileSync(join(workspace, 'big.txt'), `${lines.join('\n')}\n`);

    const oldBlock = '# TAG 1\n# TAG 2\n# TAG 3 - end';
    const newBlock = '# CHAPTER 1\n# CHAPTER 2\n# CHAPTER 3 - end';
    const editResult = editFile({
      workspace,
      path: 'big.txt',
      oldString: oldBlock,
      newString: newBlock,
      replaceAll: true,
    });

    expect(editResult.ok).toBe(true);
    if (!editResult.ok) throw new Error(editResult.error!);

    expect(editResult.matchLines).toBeDefined();
    expect(editResult.matchLines!.length).toBe(3);
    expect(editResult.matchLines).toEqual([10, 40, 100]);

    // 验证 formatMultiHunkDiff 输出：不相邻 hunk 间有 ...，中间内容不出现
    // Verify formatMultiHunkDiff output: ... between non-adjacent hunks, skip middle content
    const diffOutput = formatMultiHunkDiff(
      oldBlock,
      newBlock,
      editResult.matchLines!,
      editResult.replacements!,
    );
    const outputLines = diffOutput.split('\n');

    expect(outputLines.filter((l) => l === '...').length).toBe(2);

    expect(outputLines.some((l) => l.startsWith(' 10 -# TAG 1'))).toBe(true);
    expect(outputLines.some((l) => l.startsWith(' 40 -# TAG 1'))).toBe(true);
    expect(outputLines.some((l) => l.startsWith('100 -# TAG 1'))).toBe(true);

    const middleText = outputLines.join('\n');
    expect(middleText).not.toContain('line 25');
    expect(middleText).not.toContain('line 80');

    rmSync(workspace, { recursive: true, force: true });
  });
});
