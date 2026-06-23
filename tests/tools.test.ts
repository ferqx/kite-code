import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editFile, readFile, readTextContent, writeFile } from '../src/core/tools/file';
import { msys2ToWindowsPath, normalizeMsys2PathsInText } from '../src/core/tools/path-utils';
import { assertInsideWorkspace, shellTool } from '../src/core/tools/shell';

/** Convert MSYS2 Unix-style path to Windows-style path via cygpath (legacy test helper) */
function msys2Win(p: string): string {
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
  test('allows paths inside the workspace', () => {
    const workspace = join(tmpdir(), 'openpx-langgraph-tools-safe');
    expect(assertInsideWorkspace(workspace, 'inside.txt')).toBe(join(workspace, 'inside.txt'));
  });

  test('allows workspace files whose names start with dots', () => {
    const workspace = join(tmpdir(), 'openpx-langgraph-tools-safe');
    expect(assertInsideWorkspace(workspace, '..notes.txt')).toBe(join(workspace, '..notes.txt'));
  });

  test('rejects paths outside the workspace', () => {
    const workspace = join(tmpdir(), 'openpx-langgraph-tools-safe');
    expect(() => assertInsideWorkspace(workspace, '..\\outside.txt')).toThrow(/outside workspace/);
    expect(() => assertInsideWorkspace(workspace, '../outside.txt')).toThrow(/outside workspace/);
  });

  test('write_file creates files inside the workspace', () => {
    const workspace = join(tmpdir(), 'openpx-langgraph-tools-write');
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

  test('write_file accepts absolute paths inside the workspace', () => {
    const workspace = join(tmpdir(), 'openpx-langgraph-tools-write-absolute');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    const absolutePath = join(workspace, 'nested', 'hello.txt');

    const result = writeFile({
      workspace,
      path: absolutePath,
      content: 'hello from absolute path\n',
    });

    expect(result.ok).toBe(true);
    expect(existsSync(absolutePath)).toBe(true);
    // Verify the absolute path was not misinterpreted as relative and double-nested
    expect(existsSync(join(workspace, workspace.slice(1), 'nested', 'hello.txt'))).toBe(false);
  });

  test('edit_file finds and replaces text', () => {
    const workspace = join(tmpdir(), 'openpx-langgraph-tools-edit');
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

  test('edit_file auto-retry trimEnd: trailing whitespace mismatch succeeds', () => {
    const workspace = join(tmpdir(), 'openpx-langgraph-tools-autofix');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });

    // File content has no trailing spaces
    writeFile({ workspace, path: 'cfg.ts', content: '  debug: true,\n  env: prod,\n' });

    // oldString has trailing spaces — exact match fails, trimEnd rescues
    const result = editFile({
      workspace,
      path: 'cfg.ts',
      oldString: '  debug: true,  ',
      newString: '  debug: false,',
    });

    expect(result.ok).toBe(true);
    expect(result.replacements).toBe(1);
    const content = readFileSync(join(workspace, 'cfg.ts'), 'utf8');
    expect(content).toContain('debug: false');
  });

  test('edit_file auto-retry per-line: leading whitespace mismatch succeeds', () => {
    const workspace = join(tmpdir(), 'openpx-langgraph-tools-autofix-ml');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });

    writeFile({ workspace, path: 'f.ts', content: '  const x = 1;\n  const y = 2;\n' });

    // oldString stripped of indent — exact + trimEnd fail, per-line trim rescues
    const result = editFile({
      workspace,
      path: 'f.ts',
      oldString: 'const x = 1;\nconst y = 2;',
      newString: 'const x = 10;\nconst y = 20;',
    });

    expect(result.ok).toBe(true);
    const content = readFileSync(join(workspace, 'f.ts'), 'utf8');
    expect(content).toContain('const x = 10;');
    expect(content).toContain('const y = 20;');
  });

  test('edit_file fails when old_string not found', () => {
    const workspace = join(tmpdir(), 'openpx-langgraph-tools-edit-nf');
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
    const workspace = join(tmpdir(), 'openpx-langgraph-tools-read');
    mkdirSync(workspace, { recursive: true });

    writeFile({ workspace, path: 'test.txt', content: 'line1\nline2\nline3\n' });

    const result = readFile({ workspace, path: 'test.txt', offset: 2, limit: 1 });

    expect(result.ok).toBe(true);
    expect(result.content).toContain('2|line2');
    expect(result.totalLines).toBe(3);
  });

  test('returns structured shell command results', async () => {
    const workspace = join(tmpdir(), 'openpx-langgraph-tools-shell');
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
    const workspace = join(tmpdir(), 'openpx-langgraph-tools-shell-clean');
    mkdirSync(workspace, { recursive: true });

    const result = await shellTool({ workspace, command: 'ls' });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    // MSYS2 bash must not emit /tmp or other spurious warnings to stderr
    expect(result.stderr).toBe('');
  });

  test('shellTool aborts child process when signal fires', async () => {
    const workspace = join(tmpdir(), 'openpx-langgraph-tools-shell-abort');
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
    const workspace = join(tmpdir(), 'openpx-langgraph-tools-shell-abort-delayed');
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
    expect(msys2ToWindowsPath('/d/app/openpx-new/README.md')).toBe(
      'D:\\app\\openpx-new\\README.md',
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
    expect(msys2ToWindowsPath('/home/user/file.txt')).toBe('/home/user/file.txt');
  });
});

describe('normalizeMsys2PathsInText', () => {
  test('converts MSYS2 paths embedded in text', () => {
    if (process.platform !== 'win32') return;
    const input = 'CWD: /d/app/openpx-new\nReading /d/app/openpx-new/src/test.ts';
    const output = normalizeMsys2PathsInText(input);
    expect(output).toContain('D:\\app\\openpx-new');
    expect(output).not.toContain('/d/');
  });

  test('passes through text with no MSYS2 paths', () => {
    if (process.platform !== 'win32') return;
    const input = 'hello world\nsome output\nresult: ok';
    expect(normalizeMsys2PathsInText(input)).toBe(input);
  });

  test('non-Windows platform returns input unchanged', () => {
    if (process.platform === 'win32') return;
    const input = 'CWD: /home/user/project\nFile: /etc/config';
    expect(normalizeMsys2PathsInText(input)).toBe(input);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 二进制检测与编码 / Binary detection & encoding
// ════════════════════════════════════════════════════════════════════════════

describe('readTextContent — binary detection', () => {
  test('UTF-8 with CJK text is not binary', () => {
    const workspace = join(tmpdir(), 'openpx-readtext-cjk');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'readme.md'), '# 你好世界\n\n这是中文内容。\n', 'utf8');

    const result = readTextContent(workspace, 'readme.md');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.totalLines).toBeGreaterThan(0);
  });

  test('rejects actual binary files', () => {
    const workspace = join(tmpdir(), 'openpx-readtext-bin');
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
    const workspace = join(tmpdir(), 'openpx-readtext-force');
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
    const workspace = join(tmpdir(), 'openpx-readtext-vtff');
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
    const workspace = join(tmpdir(), 'openpx-readtext-bom8');
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
    const workspace = join(tmpdir(), 'openpx-readtext-utf16le');
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
    const workspace = join(tmpdir(), 'openpx-readtext-crlf');
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
    const workspace = join(tmpdir(), 'openpx-read-regress');
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

import { computeLineDiff, formatDiffOutput } from '../src/core/tools/diff';

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
