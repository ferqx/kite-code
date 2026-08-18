// ── Shell 命令风险分类共享模块 / Shared shell command risk classification module ──
//
// 本模块提供 shell 命令分类的核心函数，供 approval-policy、authorization-policy、
// tool-policy 等模块共享使用，避免重复实现。
//
// This module provides core shell command classification functions shared by
// approval-policy, authorization-policy, and tool-policy to avoid duplication.

import { isAbsolute, relative, resolve, sep } from 'node:path';

/** 工具风险分类 / Tool risk classification */
export type ToolRisk =
  | 'read'
  | 'plan'
  | 'write_file'
  | 'execute_code'
  | 'destructive'
  | 'network'
  | 'vcs_mutation'
  | 'mcp'
  | 'unknown';

/** 工具调用可叠加的外部副作用 / Additive external side effects of a tool call */
export interface ToolEffects {
  /** 该调用会访问网络 / The call accesses the network */
  network?: true;
  /** 该调用会读取工作区外部 / The call reads outside the workspace */
  externalRead?: true;
  /** 该调用会写入工作区外部 / The call writes outside the workspace */
  externalWrite?: true;
  /** 静态分析无法证明该调用不会出网或外部写入 / Static analysis cannot prove local-only effects */
  uncertainEffects?: true;
}

// ── 内部辅助 / Internal helpers ──

/** 规范化 shell 命令为小写、单空白分隔 / Normalize shell command to lowercase with single spaces */
export function normalizeShell(command: string): string {
  return (command ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// ── Shell 命令分类函数 / Shell command classification functions ──

/**
 * 检测 shell 命令是否具有破坏性（不可逆的数据丢失或系统级操作）。
 *
 * Check whether a shell command is destructive (irreversible data loss or system-level operations).
 */
export function isDestructiveShellCommand(command: string): boolean {
  const normalized = normalizeShell(command);
  return (
    // sudo / runas (Windows) privilege escalation
    /(?:(?:^|[;&|]\s*)|\/)(?:sudo|runas)\b/.test(normalized) ||
    // rm -rf Unix variants
    /\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r|-r\s+-f|-f\s+-r|--recursive.*--force|--force.*--recursive)\b/.test(
      normalized,
    ) ||
    /\brm\s+-[^\s]*f\b/.test(normalized) ||
    // Windows native destructive: del /f /s, rmdir /s /q
    /\b(?:del|rmdir|rd)\s+\/[^\s]*[sq]/i.test(normalized) ||
    // Unix recursive permission/ownership changes
    /\bchmod\s+(?:-[^\s]*[rR]|--recursive)\b/.test(normalized) ||
    /\bchown\s+(?:-[^\s]*[rR]|--recursive)\b/.test(normalized) ||
    /(?:(?:^|[;&|]\s*)|\/)(?:kill|taskkill)(?:all)?\b/.test(normalized) ||
    /\bdd\b.*\bof=\/dev\//.test(normalized) ||
    /\bmkfs\b/.test(normalized) ||
    /\b(?:shutdown|reboot|halt|poweroff)\b/.test(normalized) ||
    /\binit\s+[06]\b/.test(normalized) ||
    /\bfdisk\b/.test(normalized) ||
    /\bparted\b/.test(normalized) ||
    /:\(\)\s*\{.*:.*\|.*:.*\}/.test(normalized) ||
    />\s*\/dev\/sd/.test(normalized) ||
    // Windows diskpart / format
    /\b(?:diskpart|format)\b/.test(normalized)
  );
}

/** 检测命令是否为版本控制变更操作（如 git add/commit/push 等）/ Check if command is a VCS mutation */
export function isVcsMutationCommand(command: string): boolean {
  return /\bgit\s+(?:add|branch|clone|commit|checkout|switch|merge|rebase|tag|restore|stash|pull|fetch|push|reset|clean)\b/.test(
    normalizeShell(command),
  );
}

/** 检测命令是否可能写入文件 / Check if command may write files */
export function isWriteLikeShellCommand(command: string): boolean {
  const normalized = normalizeShell(command);
  return (
    /(^|[^>])>{1,2}(?!&[12])(?:$|[^>])/.test(normalized) ||
    /(?:^|[;&|]\s*)(?:cp|mv|mkdir|touch|tee|rm|unlink)\b/.test(normalized) ||
    /\b(?:bun|npm|pnpm|yarn)\s+(?:install|add|remove|update)\b/.test(normalized) ||
    /\b(?:pip|pip3|cargo|gem|go|brew|apt|apt-get|choco)\s+install\b/.test(normalized)
  );
}

/** 检测命令是否访问网络 / Check if command accesses the network */
export function isNetworkCommand(command: string): boolean {
  const normalized = normalizeShell(command);
  return (
    /\b(?:curl|wget|ssh|scp|sftp|rsync|ftp|nc|ncat|telnet)\b/.test(normalized) ||
    /\bgit\s+(?:clone|fetch|pull|push|ls-remote)\b/.test(normalized) ||
    /\b(?:bun|npm|pnpm|yarn)\s+(?:install|add|remove|update|upgrade)\b/.test(normalized) ||
    /\b(?:pip|pip3|cargo|gem|go|brew|apt|apt-get|choco)\s+(?:install|update|upgrade)\b/.test(
      normalized,
    )
  );
}

/**
 * 分析 shell 调用是否可证明为仅工作区本地操作。
 * 只对白名单文件命令和本地 Git 操作给出肯定结论；其余可执行程序按严格策略要求确认。
 */
export function classifyShellEffects(command: string, workspace: string): ToolEffects {
  const networkEffects: ToolEffects = isNetworkCommand(command) ? { network: true } : {};

  const writeTargets = extractWriteTargets(command);
  if (isVcsMutationCommand(command)) {
    return { ...networkEffects, ...classifyGitFilesystemEffects(command, workspace) };
  }
  if (isWriteLikeShellCommand(command)) {
    if (writeTargets === null) {
      return { ...networkEffects, uncertainEffects: true };
    }
    if (writeTargets.some((target) => !isWorkspacePath(target, workspace))) {
      return { ...networkEffects, externalWrite: true };
    }
    return networkEffects;
  }

  if (isReadOnlyShellCommand(command)) {
    const readTargets = extractReadTargets(command);
    if (readTargets.some((target) => !isWorkspacePath(target, workspace))) {
      return { ...networkEffects, externalRead: true };
    }
    return networkEffects;
  }

  if (isNetworkCommand(command)) {
    return { ...networkEffects, ...classifyNetworkFilesystemEffects(command, workspace) };
  }

  return { uncertainEffects: true };
}

function classifyGitFilesystemEffects(command: string, workspace: string): ToolEffects {
  const trimmed = command.trim();
  if (!trimmed || /[;&|`$(){}[\]*?]/.test(trimmed)) return { uncertainEffects: true };
  const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(stripShellQuotes) ?? [];
  const gitIndex = tokens.findIndex(
    (token) => token.toLowerCase().replace(/\.(?:cmd|exe)$/i, '') === 'git',
  );
  if (gitIndex < 0) return { uncertainEffects: true };
  const args = tokens.slice(gitIndex + 1);
  const targets: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '-C' && args[index + 1]) {
      targets.push(args[index + 1]!);
      index += 1;
    } else if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) {
      targets.push(arg.slice(arg.indexOf('=') + 1));
    }
  }
  const cloneIndex = args.findIndex((arg) => arg.toLowerCase() === 'clone');
  if (cloneIndex >= 0) {
    const operands = args.slice(cloneIndex + 1).filter((arg) => !arg.startsWith('-'));
    if (operands.length >= 2) targets.push(operands.at(-1)!);
  }
  return targets.some((target) => !isWorkspacePath(target, workspace))
    ? { externalWrite: true }
    : {};
}

/**
 * Network clients frequently write without shell redirection (`curl -o`,
 * `wget -O`, `scp`, ...). Keep those filesystem effects independent from the
 * network bit so an approval projects every capability described to the user.
 */
function classifyNetworkFilesystemEffects(command: string, workspace: string): ToolEffects {
  const trimmed = command.trim();
  if (!trimmed) return { uncertainEffects: true };
  const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const program = stripShellQuotes(tokens[0] ?? '')
    .toLowerCase()
    .replace(/\.(?:cmd|exe)$/i, '');
  const args = tokens.slice(1).map(stripShellQuotes);
  const externalWrites: string[] = [];
  const externalReads: string[] = [];

  const optionValue = (shortName: string, longName: string): string[] => {
    const values: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === shortName || arg === longName) {
        if (args[index + 1]) values.push(args[index + 1]!);
        index += 1;
      } else if (arg.startsWith(`${longName}=`)) {
        values.push(arg.slice(longName.length + 1));
      }
    }
    return values;
  };

  // curl's write-out template uses `%{name}` placeholders. They are data for
  // curl, not Bash brace expansion, but the generic control-syntax check must
  // remain strict for every other argument. Remove only recognized, safe
  // templates before that check so an HTTP status probe stays workspace-scoped.
  const writeOutFormats = program === 'curl' ? optionValue('-w', '--write-out') : [];
  let syntaxToCheck = trimmed;
  for (const format of writeOutFormats) {
    if (!isSafeCurlWriteOutFormat(format)) return { uncertainEffects: true };
    syntaxToCheck = syntaxToCheck.replace(format, '');
  }
  if (/[;&|`$(){}[\]*?]/.test(syntaxToCheck)) return { uncertainEffects: true };

  if (program === 'curl') {
    externalWrites.push(...optionValue('-o', '--output'));
    externalReads.push(
      ...optionValue('-T', '--upload-file'),
      ...optionValue('-K', '--config'),
      ...optionValue('-b', '--cookie'),
    );
  } else if (program === 'wget') {
    externalWrites.push(
      ...optionValue('-O', '--output-document'),
      ...optionValue('-P', '--directory-prefix'),
    );
    externalReads.push(...optionValue('-i', '--input-file'));
  } else if (['scp', 'sftp', 'rsync'].includes(program)) {
    // Remote/local operand direction and client-side command files are too
    // varied to prove a narrower filesystem scope from argv alone.
    return { uncertainEffects: true };
  } else {
    return {};
  }

  const effects: ToolEffects = {};
  if (externalWrites.some((target) => !isWorkspacePath(target, workspace))) {
    effects.externalWrite = true;
  }
  if (externalReads.some((target) => !isWorkspacePath(target, workspace))) {
    effects.externalRead = true;
  }
  return effects;
}

function isSafeCurlWriteOutFormat(format: string): boolean {
  const withoutPlaceholders = format.replaceAll(/%\{[A-Za-z0-9_:-]+\}/g, '');
  return !/[;&|`$(){}[\]*?]/.test(withoutPlaceholders);
}

/**
 * 返回已知写入目标；null 表示命令可能写入但无法静态证明其范围。
 * 复杂 shell 语法同样按未知处理，避免通过组合命令绕过边界判断。
 */
function extractWriteTargets(command: string): string[] | null {
  const trimmed = command.trim();
  if (!trimmed || /[;&|`$(){}[\]*?]/.test(trimmed)) return null;

  const redirect = /(?:^|[^>])>{1,2}\s*([^\s]+)/.exec(trimmed);
  if (redirect?.[1]) return [redirect[1]];

  const tokens = trimmed.split(/\s+/);
  const [program, ...args] = tokens;
  if (!program || args.length === 0) return null;
  const paths = args.filter((arg) => !arg.startsWith('-'));

  switch (program.toLowerCase()) {
    case 'touch':
    case 'mkdir':
    case 'tee':
    case 'rm':
    case 'unlink':
      return paths.length > 0 ? paths : null;
    case 'cp':
    case 'mv':
      return paths.length >= 2 ? [paths.at(-1)!] : null;
    default:
      return null;
  }
}

function isWorkspacePath(target: string, workspace: string): boolean {
  const path = target.replace(/^['"]|['"]$/g, '');
  if (!path || path === '-' || path === '/dev/null') return true;
  if (path.startsWith('~') || path.includes('$')) return false;
  if (/^[a-z]:[\\/]/i.test(path) || /^\\{1,2}/.test(path)) return false;

  const workspaceRoot = resolve(workspace);
  const resolvedPath = resolve(workspaceRoot, path.replace(/[\\/]+/g, '/'));
  const relativePath = relative(workspaceRoot, resolvedPath);
  return !(
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

/** Extract path operands from commands already proven read-only. */
function extractReadTargets(command: string): string[] {
  const targets: string[] = [];
  for (const segment of splitReadOnlySegments(command)) {
    const tokens = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    for (let index = 1; index < tokens.length; index += 1) {
      const value = stripShellQuotes(tokens[index] ?? '');
      if (value === '<' && tokens[index + 1]) {
        targets.push(tokens[index + 1]!);
        index += 1;
      } else {
        const attachedInput = /^<([^<&].+)$/.exec(value);
        if (attachedInput?.[1]) targets.push(attachedInput[1]);
      }
    }
    const program = stripShellQuotes(tokens[0] ?? '')
      .toLowerCase()
      .replace(/\.(?:cmd|exe)$/i, '');
    if (!program || ['echo', 'pwd', 'test'].includes(program)) continue;

    if (program === 'git') {
      const cwdIndex = tokens.findIndex((token) => stripShellQuotes(token) === '-C');
      if (cwdIndex >= 0 && tokens[cwdIndex + 1]) targets.push(tokens[cwdIndex + 1]!);
      continue;
    }

    if (program === 'rg' || program === 'grep') {
      for (let index = 1; index < tokens.length; index += 1) {
        const value = stripShellQuotes(tokens[index] ?? '');
        if ((value === '-f' || value === '--file') && tokens[index + 1]) {
          targets.push(tokens[index + 1]!);
          index += 1;
          continue;
        }
        const attachedFile = /^(?:-[^-]*f|--file=)(.+)$/u.exec(value);
        if (attachedFile?.[1]) targets.push(attachedFile[1]);
      }
    }

    if (program === 'file') {
      for (let index = 1; index < tokens.length; index += 1) {
        const value = stripShellQuotes(tokens[index] ?? '');
        if ((value === '-m' || value === '--magic-file') && tokens[index + 1]) {
          targets.push(tokens[index + 1]!);
          index += 1;
          continue;
        }
        const magicFile = /^(?:-m|--magic-file=)(.+)$/u.exec(value);
        if (magicFile?.[1]) targets.push(magicFile[1]);
      }
    }

    if (program === 'sort') {
      for (let index = 1; index < tokens.length; index += 1) {
        const value = stripShellQuotes(tokens[index] ?? '');
        if (value === '--random-source' && tokens[index + 1]) {
          targets.push(tokens[index + 1]!);
          index += 1;
          continue;
        }
        const randomSource = /^--random-source=(.+)$/u.exec(value);
        if (randomSource?.[1]) targets.push(randomSource[1]);
      }
    }

    const operands = tokens.slice(1).filter((token) => {
      const value = stripShellQuotes(token);
      return value !== '<' && value !== '>' && !value.startsWith('<') && !value.startsWith('-');
    });
    if (program === 'grep' || program === 'rg' || program === 'sed' || program === 'awk') {
      targets.push(...operands.slice(1));
    } else {
      targets.push(...operands);
    }
  }
  return targets;
}

// ── rm -rf 安全分类 / rm -rf safety classification ──
// rm -rf on non-critical paths is treated as write_file, not destructive.
// Only workspace root and critical system paths are denied outright.
// Subdirectories (node_modules, src/) are downgraded → auto-review judges.

/**
 * 关键系统路径前缀 — 删除这些路径不可逆。
 * 统一规范化为小写正斜杠格式，支持跨平台匹配。
 *
 * Critical system path prefixes — deleting these is irreversible.
 * Normalized to lowercase forward-slash form for cross-platform matching.
 */
const CRITICAL_SYSTEM_PREFIXES: ReadonlyArray<string> = [
  // Unix
  '/etc/',
  '/etc',
  '/boot/',
  '/boot',
  '/bin/',
  '/bin',
  '/sbin/',
  '/sbin',
  '/lib/',
  '/lib',
  '/lib64/',
  '/lib64',
  '/sys/',
  '/sys',
  '/proc/',
  '/proc',
  '/dev/',
  '/dev',
  // Windows — case-insensitive, stored lowercased
  'c:/windows/',
  'c:/windows',
  'c:/windows/system32/',
  'c:/windows/system32',
];

/** 规范化路径为小写正斜杠格式，用于跨平台比较 / Normalize path to lowercase forward-slash form for cross-platform comparison */
function normalizePathForComparison(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

function isCriticalSystemPath(target: string): boolean {
  const path = target.replace(/^['"]|['"]$/g, '');
  if (!path) return false;
  // Normalize directly without resolve() — must work cross-platform because
  // the command might target a remote system or be tested on a different OS.
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  // rm -rf / or rm -rf C:\ is always denied
  if (normalized === '/' || /^[a-z]:\/$/.test(normalized)) return true;
  return CRITICAL_SYSTEM_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

/** 提取 rm 命令的删除目标，自动剥离 sudo 前缀 / Extract rm targets, stripping sudo prefix */
function extractRmTargets(command: string): string[] | null {
  // Strip sudo / runas prefix: "sudo rm -rf /x" → "rm -rf /x"
  const withoutSudo = command.replace(/^(?:sudo|runas)\s+/i, '').trim();
  if (!withoutSudo || !/\brm\b/.test(normalizeShell(withoutSudo))) return null;
  return extractWriteTargets(withoutSudo);
}

/**
 * 检查 rm -rf 是否直接删除了工作区根目录本身（`.` 或绝对路径）。
 * 只拒绝删除整个工作区；子目录（src/、node_modules 等）降级为 write_file 走 auto-review。
 */
export function isDestructiveRmOnWorkspace(command: string, workspace: string): boolean {
  if (!isDestructiveShellCommand(command)) return false;
  const targets = extractRmTargets(command);
  if (!targets || targets.length === 0) return false;
  const workspaceRoot = normalizePathForComparison(resolve(workspace));
  return targets.some((t) => {
    const path = t.replace(/^['"]|['"]$/g, '');
    // rm -rf . at workspace root → deny
    if (path === '.') return true;
    // rm -rf <absolute workspace path> → deny (handle Unix /x/y and Windows C:\x\y)
    if (isAbsolute(path) && normalizePathForComparison(resolve('/', path)) === workspaceRoot)
      return true;
    return false;
  });
}

/**
 * 检查 rm -rf 是否删除了关键系统路径。
 * 删除 /etc、/bin、/boot 等不可逆，必须拒绝。
 */
export function isDestructiveRmOnCriticalPaths(command: string): boolean {
  if (!isDestructiveShellCommand(command)) return false;
  const targets = extractRmTargets(command);
  if (!targets || targets.length === 0) return false;
  return targets.some((t) => isCriticalSystemPath(t));
}

/**
 * 对 shell 命令进行风险分类。
 *
 * Classify the risk level of a shell command.
 */
export function classifyShellRisk(command: string): ToolRisk {
  if (isReadOnlyShellCommand(command)) return 'read';
  if (isDestructiveShellCommand(command)) return 'destructive';
  if (isVcsMutationCommand(command)) return 'vcs_mutation';
  if (isWriteLikeShellCommand(command)) return 'write_file';
  if (isNetworkCommand(command)) return 'network';
  return 'execute_code';
}

const READ_ONLY_COMMANDS = new Set([
  'awk',
  'cat',
  'cut',
  'du',
  'echo',
  'file',
  'find',
  'grep',
  'head',
  'ls',
  'nl',
  'pwd',
  'rg',
  'sed',
  'sort',
  'stat',
  'tail',
  'test',
  'tr',
  'uniq',
  'wc',
]);

const LOCAL_RUNTIME_VERSION_COMMANDS = new Set(['bun', 'node', 'npm', 'pnpm', 'yarn']);

const FILE_FLAG_OPTIONS = new Set([
  '--brief',
  '--checking-printout',
  '--exclude-quiet',
  '--extension',
  '--keep-going',
  '--mime',
  '--mime-encoding',
  '--mime-type',
  '--no-buffer',
  '--no-pad',
  '--print0',
  '--raw',
  '--special-files',
]);
const FILE_VALUE_OPTIONS = new Set([
  '--apple',
  '--exclude',
  '--magic-file',
  '--parameter',
  '--separator',
]);

function isReadOnlyFile(tokens: string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = stripShellQuotes(tokens[index] ?? '');
    if (token === '--') return true;
    if (!token.startsWith('-') || token === '-') continue;
    if (FILE_FLAG_OPTIONS.has(token)) continue;
    const longName = token.split('=', 1)[0]!;
    if (FILE_VALUE_OPTIONS.has(longName)) {
      if (!token.includes('=') && !tokens[index + 1]) return false;
      if (!token.includes('=')) index += 1;
      continue;
    }
    if (/^-[bcEhikLlNnPrs]+$/.test(token)) continue;
    if (/^-[deFm].+/.test(token)) continue;
    if (['-d', '-e', '-F', '-m'].includes(token)) {
      if (!tokens[index + 1]) return false;
      index += 1;
      continue;
    }
    // Unknown modes fail closed. In particular, -C/--compile writes an .mgc
    // artifact and -z/--uncompress may execute an external decompressor.
    return false;
  }
  return true;
}

const FIND_BOOLEAN_TOKENS = new Set([
  '!',
  '(',
  ')',
  ',',
  '-a',
  '-and',
  '-daystart',
  '-empty',
  '-executable',
  '-false',
  '-follow',
  '-ignore_readdir_race',
  '-ls',
  '-mount',
  '-noignore_readdir_race',
  '-noleaf',
  '-not',
  '-o',
  '-or',
  '-print',
  '-print0',
  '-prune',
  '-quit',
  '-readable',
  '-true',
  '-writable',
  '-xdev',
]);
const FIND_ONE_VALUE_TOKENS = new Set([
  '-amin',
  '-anewer',
  '-atime',
  '-cmin',
  '-cnewer',
  '-ctime',
  '-fstype',
  '-gid',
  '-group',
  '-ilname',
  '-iname',
  '-inum',
  '-ipath',
  '-iregex',
  '-links',
  '-lname',
  '-maxdepth',
  '-mindepth',
  '-mmin',
  '-mtime',
  '-name',
  '-newer',
  '-path',
  '-perm',
  '-printf',
  '-regex',
  '-regextype',
  '-samefile',
  '-size',
  '-type',
  '-uid',
  '-user',
  '-used',
  '-wholename',
  '-xtype',
]);

function isReadOnlyFind(tokens: string[]): boolean {
  let expressionStarted = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = stripShellQuotes(tokens[index] ?? '');
    if (!expressionStarted && (/^-[HLP]$/.test(token) || /^-O\d+$/.test(token))) continue;
    if (!expressionStarted && token === '-D') {
      if (!tokens[index + 1]) return false;
      index += 1;
      continue;
    }
    if (!expressionStarted && !token.startsWith('-') && !['!', '(', ')'].includes(token)) continue;
    expressionStarted = true;
    if (FIND_BOOLEAN_TOKENS.has(token)) continue;
    if (/^-newer[A-Za-z]{2}$/.test(token) || FIND_ONE_VALUE_TOKENS.has(token)) {
      if (!tokens[index + 1]) return false;
      index += 1;
      continue;
    }
    // Unknown find actions are not assumed to be reads. In particular this
    // rejects -delete/-exec/-ok and file-output actions such as -fprint.
    return false;
  }
  return true;
}

function isReadOnlySedScript(script: string): boolean {
  const value = stripShellQuotes(script).trim();
  if (value.length < 4 || value[0] !== 's') return false;
  const delimiter = value[1]!;
  if (/\s|[A-Za-z0-9\\]/.test(delimiter)) return false;
  let cursor = 2;
  const consumeSection = (): boolean => {
    let escaped = false;
    for (; cursor < value.length; cursor += 1) {
      const char = value[cursor]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === delimiter) {
        cursor += 1;
        return true;
      }
    }
    return false;
  };
  if (!consumeSection() || !consumeSection()) return false;
  // Substitution flags that only affect stdout are safe. `e` executes a
  // command and `w FILE` writes, so neither is admitted by this grammar.
  return /^[0-9gimpIM]*$/.test(value.slice(cursor));
}

function isReadOnlySed(tokens: string[]): boolean {
  const scripts: string[] = [];
  let sawBareScript = false;
  let optionsEnded = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = stripShellQuotes(tokens[index] ?? '');
    if (!optionsEnded && token === '--') {
      optionsEnded = true;
      continue;
    }
    if ((sawBareScript || optionsEnded) && token.startsWith('-') && token !== '-') return false;
    if (
      !sawBareScript &&
      [
        '-n',
        '--quiet',
        '--silent',
        '-E',
        '-r',
        '--regexp-extended',
        '-u',
        '--unbuffered',
        '-s',
        '--separate',
        '-z',
        '--null-data',
        '--sandbox',
      ].includes(token)
    ) {
      continue;
    }
    if (!sawBareScript && (token === '-e' || token === '--expression')) {
      const script = tokens[index + 1];
      if (!script) return false;
      scripts.push(script);
      index += 1;
      continue;
    }
    if (!sawBareScript && token.startsWith('--expression=')) {
      scripts.push(token.slice('--expression='.length));
      continue;
    }
    if (!sawBareScript && token.startsWith('-e') && token.length > 2) {
      scripts.push(token.slice(2));
      continue;
    }
    if (!sawBareScript && token.startsWith('-')) return false;
    if (!sawBareScript && scripts.length === 0) {
      scripts.push(tokens[index]!);
      sawBareScript = true;
      continue;
    }
    sawBareScript = true; // Remaining operands are input paths.
  }
  return scripts.length > 0 && scripts.every(isReadOnlySedScript);
}

const SORT_FLAG_OPTIONS = new Set([
  '--check',
  '--debug',
  '--dictionary-order',
  '--general-numeric-sort',
  '--human-numeric-sort',
  '--ignore-case',
  '--ignore-leading-blanks',
  '--ignore-nonprinting',
  '--merge',
  '--month-sort',
  '--numeric-sort',
  '--random-sort',
  '--reverse',
  '--stable',
  '--unique',
  '--version-sort',
  '--zero-terminated',
]);
const SORT_VALUE_OPTIONS = new Set([
  '--batch-size',
  '--field-separator',
  '--key',
  '--parallel',
  '--random-source',
  '--sort',
]);

function isReadOnlySort(tokens: string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = stripShellQuotes(tokens[index] ?? '');
    if (token === '--') return true;
    if (!token.startsWith('-') || token === '-') continue;
    if (SORT_FLAG_OPTIONS.has(token)) continue;
    const longName = token.split('=', 1)[0]!;
    if (SORT_VALUE_OPTIONS.has(longName)) {
      if (!token.includes('=') && !tokens[index + 1]) return false;
      if (!token.includes('=')) index += 1;
      continue;
    }
    if (/^-[bcCdfghinmMNRrSsuvVz]+$/.test(token)) continue;
    if (/^-[kt].+/.test(token)) continue;
    if (token === '-k' || token === '-t') {
      if (!tokens[index + 1]) return false;
      index += 1;
      continue;
    }
    // Unknown options, -o/--output and --compress-program fail closed.
    return false;
  }
  return true;
}

const UNIQ_FLAG_OPTIONS = new Set([
  '--all-repeated',
  '--count',
  '--group',
  '--ignore-case',
  '--repeated',
  '--unique',
  '--zero-terminated',
]);
const UNIQ_VALUE_OPTIONS = new Set(['--check-chars', '--skip-chars', '--skip-fields']);

function isReadOnlyUniq(tokens: string[]): boolean {
  let operands = 0;
  let optionsEnded = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = stripShellQuotes(tokens[index] ?? '');
    if (!optionsEnded && token === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && UNIQ_FLAG_OPTIONS.has(token)) continue;
    if (!optionsEnded) {
      const longName = token.split('=', 1)[0]!;
      if (UNIQ_VALUE_OPTIONS.has(longName)) {
        if (!token.includes('=') && !tokens[index + 1]) return false;
        if (!token.includes('=')) index += 1;
        continue;
      }
      if (/^-[cduiz]+$/.test(token)) continue;
      if (/^-[fsw].+/.test(token)) continue;
      if (['-f', '-s', '-w'].includes(token)) {
        if (!tokens[index + 1]) return false;
        index += 1;
        continue;
      }
      if (token.startsWith('-') && token !== '-') return false;
    }
    operands += 1;
    if (/[*?[\]{}]/.test(token)) return false;
    // POSIX uniq's second operand is an output file.
    if (operands > 1) return false;
  }
  return true;
}

const RG_FLAG_OPTIONS = new Set([
  '--binary',
  '--case-sensitive',
  '--column',
  '--count',
  '--count-matches',
  '--crlf',
  '--debug',
  '--files',
  '--files-with-matches',
  '--files-without-match',
  '--fixed-strings',
  '--follow',
  '--heading',
  '--hidden',
  '--ignore-case',
  '--invert-match',
  '--json',
  '--line-number',
  '--line-regexp',
  '--multiline',
  '--multiline-dotall',
  '--no-config',
  '--no-filename',
  '--no-heading',
  '--no-hidden',
  '--no-ignore',
  '--no-line-number',
  '--no-messages',
  '--no-pcre2',
  '--no-unicode',
  '--null',
  '--null-data',
  '--one-file-system',
  '--only-matching',
  '--passthru',
  '--pcre2',
  '--quiet',
  '--smart-case',
  '--stats',
  '--text',
  '--trace',
  '--trim',
  '--unicode',
  '--vimgrep',
  '--with-filename',
  '--word-regexp',
]);
const RG_VALUE_OPTIONS = new Set([
  '--after-context',
  '--before-context',
  '--color',
  '--colors',
  '--context',
  '--context-separator',
  '--encoding',
  '--engine',
  '--field-context-separator',
  '--field-match-separator',
  '--file',
  '--glob',
  '--iglob',
  '--max-columns',
  '--max-count',
  '--max-depth',
  '--max-filesize',
  '--path-separator',
  '--regexp',
  '--replace',
  '--sort',
  '--sortr',
  '--threads',
  '--type',
  '--type-add',
  '--type-clear',
  '--type-not',
]);

function isReadOnlyRipgrep(tokens: string[]): boolean {
  const shortFlags = new Set('0acHhIiLlnoqSUuvwx'.split(''));
  const shortWithValue = new Set('ABCEefgMmrTt'.split(''));
  for (let index = 1; index < tokens.length; index += 1) {
    const token = stripShellQuotes(tokens[index] ?? '');
    if (token === '--') return true;
    if (!token.startsWith('-') || token === '-') continue;
    if (RG_FLAG_OPTIONS.has(token)) continue;
    const longName = token.split('=', 1)[0]!;
    if (RG_VALUE_OPTIONS.has(longName)) {
      if (!token.includes('=') && !tokens[index + 1]) return false;
      if (!token.includes('=')) index += 1;
      continue;
    }
    if (token.startsWith('--')) return false;
    const flags = token.slice(1);
    for (let flagIndex = 0; flagIndex < flags.length; flagIndex += 1) {
      const flag = flags[flagIndex]!;
      if (shortFlags.has(flag)) continue;
      if (!shortWithValue.has(flag)) return false;
      if (flagIndex === flags.length - 1) {
        if (!tokens[index + 1]) return false;
        index += 1;
      }
      break;
    }
  }
  return true;
}

function withoutHarmlessOutputRedirects(tokens: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = stripShellQuotes(tokens[index] ?? '');
    if (/^\d?>&\d?$/.test(token) || /^\d?>{1,2}\/dev\/null$/.test(token)) continue;
    if (/^\d?>{1,2}$/.test(token) && stripShellQuotes(tokens[index + 1] ?? '') === '/dev/null') {
      index += 1;
      continue;
    }
    result.push(tokens[index]!);
  }
  return result;
}

/** Conservative command-shape classifier used by shell approval and ToolSpec effects. */
export function isReadOnlyShellCommand(command: string): boolean {
  const trimmed = (command ?? '').trim();
  if (!trimmed || /[\r\n]/.test(trimmed) || hasUnsafeOutputRedirect(trimmed)) return false;
  // Expansions can replace a statically safe operand with an effectful option,
  // and process substitutions execute their body independently of argv.
  if (/[$`]/.test(trimmed) || /[<>]\(/.test(trimmed)) return false;
  // Unquoted brace expansion can synthesize effectful options after static
  // token inspection, for example `sort {--output=out,input.txt}`. Preserve
  // quoted regex/glob operands while rejecting shell-expanded braces.
  if (hasUnquotedBraceExpansion(trimmed)) return false;
  const stripped = trimmed.replace(/&&/g, '').replace(/\d?>&\d?/g, '');
  if (stripped.includes('&')) return false;
  return splitReadOnlySegments(trimmed).every(isReadOnlySegment);
}

function hasUnquotedBraceExpansion(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '{' || char === '}') return true;
  }
  return false;
}

function hasUnsafeOutputRedirect(command: string): boolean {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  for (let index = 0; index < tokens.length; index += 1) {
    const rawToken = tokens[index] ?? '';
    if (
      (rawToken.startsWith("'") && rawToken.endsWith("'")) ||
      (rawToken.startsWith('"') && rawToken.endsWith('"'))
    ) {
      continue;
    }
    if (/^\d?>&\d?$/.test(rawToken) || /^\d?>{1,2}\/dev\/null$/.test(rawToken)) continue;
    if (/^\d?>{1,2}$/.test(rawToken) && stripShellQuotes(tokens[index + 1] ?? '') === '/dev/null') {
      index += 1;
      continue;
    }
    if (rawToken.includes('>')) return true;
  }
  return false;
}

function splitReadOnlySegments(command: string): string[] {
  return command
    .split(/\s*(?:\|\||&&|[|;])\s*/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function isReadOnlySegment(segment: string): boolean {
  const tokens = withoutHarmlessOutputRedirects(
    segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [],
  );
  const command = stripShellQuotes(tokens[0] ?? '').toLowerCase();
  if (!command) return false;
  const portableCommand = command.replace(/\.(?:cmd|exe)$/i, '');
  if (LOCAL_RUNTIME_VERSION_COMMANDS.has(portableCommand)) {
    return tokens.length === 2 && ['--version', '-v'].includes(stripShellQuotes(tokens[1] ?? ''));
  }
  // Repository/config-driven helpers (diff/textconv, fsmonitor, external diff,
  // filters) mean generic Git subprocesses are not policy-proven reads. Use the
  // typed brokered git_inspect capability instead.
  if (portableCommand === 'git') return false;
  if (portableCommand === 'file') return isReadOnlyFile(tokens);
  if (portableCommand === 'rg') return isReadOnlyRipgrep(tokens);
  if (portableCommand === 'sed') return isReadOnlySed(tokens);
  if (portableCommand === 'find') return isReadOnlyFind(tokens);
  if (portableCommand === 'sort') return isReadOnlySort(tokens);
  if (portableCommand === 'uniq') return isReadOnlyUniq(tokens);
  // awk is a programming language and xargs appends runtime-controlled argv;
  // neither can be proven read-only from the static command text.
  if (portableCommand === 'awk' || portableCommand === 'xargs') return false;
  return READ_ONLY_COMMANDS.has(portableCommand);
}

function stripShellQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}
