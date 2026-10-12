import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, type Node, Parser } from 'web-tree-sitter';
import { AgentError } from '../storage/types';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let initialization: Promise<void> | undefined;
let initializedRuntimeDigest: string | undefined;
let loadedLanguage: Promise<Language> | undefined;
let loadedGrammarDigest: string | undefined;
const containers = new Set(['program', 'list', 'pipeline', 'command', 'command_name']);
const wordKinds = new Set([
  'word',
  'number',
  'string',
  'string_content',
  'raw_string',
  'concatenation',
]);
const punctuation = new Set(['&&', '||', ';', '|', '"', "'"]);
const presentNode = (node: Node | null): node is Node => node !== null;
// Private scanner marker: an opaque argument retains its position but never
// becomes an asserted literal path or an executable name.
const unknownArgument = '\0kite-opaque-argument\0';

/** Return only source words whose spelling is already their literal argv value. */
function literal(node: Node): string | null {
  if (node.type === 'word' || node.type === 'number') {
    if (node.namedChildCount || /^[=]/u.test(node.text) || /[{}*?[\]\\~^#$`]/u.test(node.text))
      return null;
    return node.text;
  }
  if (node.type === 'raw_string') return node.text.slice(1, -1);
  if (node.type === 'string') {
    if (node.namedChildren.some((part) => part === null || part.type !== 'string_content'))
      return null;
    const content = node.text.slice(1, -1);
    return /\\[$`"\\\n]/u.test(content) ? null : content;
  }
  if (node.type === 'concatenation') {
    const parts = node.namedChildren.map((part) => (part ? literal(part) : null));
    return parts.some((part) => part === null) ? null : parts.join('');
  }
  return null;
}

function invocation(node: Node, partial: boolean): readonly string[] | null {
  const name = node.namedChildren.find((part) => part?.type === 'command_name');
  const first = name?.firstNamedChild ? literal(name.firstNamedChild) : null;
  if (first === null) return null;
  const words = [first];
  let afterName = false;
  for (const child of node.namedChildren) {
    if (!child) return null;
    if (child === name || child.id === name?.id) {
      afterName = true;
      continue;
    }
    if (!afterName) {
      if (!partial) return null;
      continue;
    }
    const value = literal(child);
    if (value === null) {
      if (!partial) return null;
      if (!['file_redirect', 'heredoc_redirect', 'herestring_redirect'].includes(child.type))
        words.push(unknownArgument);
      continue;
    }
    words.push(value);
  }
  return words;
}

const executable = (value: string) =>
  value
    .replace(/\\/gu, '/')
    .split('/')
    .at(-1)
    ?.toLowerCase()
    .replace(/\.(exe|cmd|com)$/u, '') ?? '';
function unwrap(words: readonly string[], cwd: string): { words: readonly string[]; cwd: string } {
  let index = 0;
  for (let depth = 0; depth < 8; depth += 1) {
    const name = executable(words[index] ?? '');
    if (name === 'env') {
      index += 1;
      while (index < words.length) {
        const value = words[index]!;
        if (value === '--') {
          index += 1;
          break;
        }
        if (
          /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value) ||
          value === '-i' ||
          value === '--ignore-environment' ||
          value.startsWith('--unset=')
        ) {
          index += 1;
          continue;
        }
        if (value.startsWith('--chdir=')) {
          cwd = pathAt(value.slice('--chdir='.length), cwd);
          index += 1;
          continue;
        }
        if (value === '-u' || value === '--unset' || value === '-C' || value === '--chdir') {
          if ((value === '-C' || value === '--chdir') && words[index + 1])
            cwd =
              words[index + 1] === unknownArgument
                ? unknownArgument
                : pathAt(words[index + 1]!, cwd);
          index += 2;
          continue;
        }
        break;
      }
    } else if (['command', 'builtin', 'exec', 'nohup', 'sudo', 'runas'].includes(name)) {
      index += 1;
      while (words[index] === '--' || words[index] === '-p') index += 1;
    } else break;
  }
  return { words: words.slice(index), cwd };
}

const windowsPath = (value: string) =>
  /^[a-z]:[\\/]/iu.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(value);
// A normalized Windows UNC directory uses forward slashes. An initial //path
// or a command argument in a POSIX directory retains its POSIX interpretation.
const windowsDirectory = (value: string) =>
  windowsPath(value) || /^\/\/[^\\/]+\/[^\\/]+/u.test(value);

function pathAt(value: string, cwd: string): string {
  if (value === unknownArgument) return unknownArgument;
  if (cwd === unknownArgument && !posix.isAbsolute(value) && !win32.isAbsolute(value))
    return unknownArgument;
  return windowsPath(value) || windowsDirectory(cwd)
    ? win32.resolve(cwd, value).replace(/\\/gu, '/')
    : posix.resolve(cwd, value);
}
function critical(value: string): boolean {
  const normalized = value.replace(/\\/gu, '/').toLowerCase().replace(/\/$/u, '') || '/';
  return [
    '/',
    '/etc',
    '/boot',
    '/bin',
    '/sbin',
    '/lib',
    '/lib64',
    '/sys',
    '/proc',
    '/dev',
    'c:/windows',
  ].some((root) => normalized === root || (root !== '/' && normalized.startsWith(`${root}/`)));
}
function dangerous(words: readonly string[], cwd: string): string | null {
  const unwrapped = unwrap(words, cwd);
  const args = unwrapped.words;
  cwd = unwrapped.cwd;
  const name = executable(args[0] ?? '');
  if (name === 'rm') {
    const options = args.slice(1, args.indexOf('--') < 0 ? undefined : args.indexOf('--'));
    const forced = options.some((arg) => arg === '--force' || /^-[^-]*f/u.test(arg));
    if (forced && args.slice(1).some((arg) => !arg.startsWith('-') && critical(pathAt(arg, cwd))))
      return 'shell_critical_system_removal';
  }
  if (
    name !== 'git' ||
    !args.some((arg) => ['checkout', 'clean', 'reset', 'restore', 'rm'].includes(arg))
  )
    return null;
  let directory = cwd;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '-C' && args[index + 1]) {
      directory = pathAt(args[++index]!, directory);
      if (critical(directory)) return 'shell_critical_system_git_destruction';
    } else if (arg.startsWith('-C') && arg.length > 2) {
      directory = pathAt(arg.slice(2), directory);
      if (critical(directory)) return 'shell_critical_system_git_destruction';
    } else if (arg === '--git-dir' || arg === '--work-tree') {
      if (args[index + 1] && critical(pathAt(args[++index]!, directory)))
        return 'shell_critical_system_git_destruction';
    } else if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) {
      if (critical(pathAt(arg.slice(arg.indexOf('=') + 1), directory)))
        return 'shell_critical_system_git_destruction';
    }
  }
  return critical(directory) ? 'shell_critical_system_git_destruction' : null;
}

/** Keep possible literal directories; a failed or conditional cd can retain its caller's cwd. */
function scanTree(root: Node, cwd: string, parser: Parser, depth: number): string | null {
  const stack = [{ node: root, directories: new Set([cwd]) }];
  const isolated = new Set([
    'subshell',
    'command_substitution',
    'process_substitution',
    'function_definition',
  ]);
  while (stack.length) {
    const item = stack.pop()!;
    const { node } = item;
    const directories = isolated.has(node.type) ? new Set(item.directories) : item.directories;
    if (node.type === 'command') {
      const words = invocation(node, true);
      if (words) {
        for (const directory of directories) {
          const reason = scanDanger(words, directory, parser, depth);
          if (reason !== null) return reason;
        }
        // env/exec and external cd programs cannot change the parent Shell.
        // Only the literal builtin, optionally through command/builtin, is tracked.
        let index = 0;
        while (['command', 'builtin'].includes(words[index] ?? '')) {
          index += 1;
          while (words[index] === '--' || words[index] === '-p') index += 1;
        }
        if (words[index] === 'cd') {
          index += 1;
          while (['-L', '-P', '-e'].includes(words[index] ?? '')) index += 1;
          if (words[index] === '--') index += 1;
          const target = words.length === index + 1 ? words[index] : unknownArgument;
          for (const directory of [...directories])
            directories.add(pathAt(target ?? unknownArgument, directory));
          // Never discard known critical possibilities to satisfy an analysis budget.
          if (directories.size > 64) throw new AgentError('shell_command_analysis_limit');
        }
      }
    }
    const children = node.namedChildren.filter(presentNode);
    for (const child of [...children].reverse())
      if (child)
        stack.push({
          node: child,
          // Earlier pipeline elements cannot change the enclosing cwd. The last
          // may run in the parent (zsh or Bash lastpipe), so retain that possibility.
          directories:
            node.type === 'pipeline' && child !== children.at(-1)
              ? new Set(directories)
              : directories,
        });
  }
  return null;
}

function scanDanger(
  words: readonly string[],
  cwd: string,
  parser: Parser,
  depth = 0,
): string | null {
  const direct = dangerous(words, cwd);
  if (direct !== null || depth >= 8) return direct;
  const unwrapped = unwrap(words, cwd);
  const args = unwrapped.words;
  cwd = unwrapped.cwd;
  if (
    !['bash', 'zsh', 'sh', 'dash'].includes(executable(args[0] ?? '')) ||
    !['-c', '-lc'].includes(args[1] ?? '') ||
    args[2] === undefined ||
    args[2] === unknownArgument
  )
    return null;
  const nested = parser.parse(args[2]);
  if (!nested) throw new AgentError('shell_parser_failed');
  try {
    return scanTree(nested.rootNode, cwd, parser, depth + 1);
  } finally {
    nested.delete();
  }
}

/** Shared classification never launches a process or authorizes an execution scope. */
export async function createShellCommandPolicy(input: {
  cwd: string;
  shellExecutable: string;
}): Promise<{
  assets: readonly { path: string; digest: string }[];
  classify(
    command: string,
  ): Promise<{ plainCommands: readonly (readonly string[])[] | null; hardDenied: string | null }>;
}> {
  let assets: readonly { path: string; digest: string }[];
  let language: Language;
  try {
    const runtime = realpathSync(
      fileURLToPath(import.meta.resolve('web-tree-sitter/tree-sitter.wasm')),
    );
    const grammar = realpathSync(
      join(
        dirname(fileURLToPath(import.meta.resolve('tree-sitter-bash/package.json'))),
        'tree-sitter-bash.wasm',
      ),
    );
    const runtimeBytes = readFileSync(runtime);
    const grammarBytes = readFileSync(grammar);
    assets = Object.freeze([
      Object.freeze({ path: runtime, digest: digest(runtimeBytes) }),
      Object.freeze({ path: grammar, digest: digest(grammarBytes) }),
    ]);
    if (initializedRuntimeDigest !== undefined && initializedRuntimeDigest !== assets[0]!.digest)
      throw Error('changed_runtime');
    initializedRuntimeDigest = assets[0]!.digest;
    initialization ??= Parser.init({ wasmBinary: runtimeBytes });
    await initialization;
    if (loadedGrammarDigest !== undefined && loadedGrammarDigest !== assets[1]!.digest)
      throw Error('changed_grammar');
    loadedGrammarDigest = assets[1]!.digest;
    loadedLanguage ??= Language.load(grammarBytes);
    language = await loadedLanguage;
  } catch {
    throw new AgentError('shell_parser_asset_unavailable');
  }
  // Absolute analysis inputs retain their path syntax on every host. Relative
  // inputs still refer to the real caller's working directory.
  const cwd = windowsPath(input.cwd)
    ? win32.resolve(input.cwd).replace(/\\/gu, '/')
    : posix.isAbsolute(input.cwd)
      ? posix.resolve(input.cwd)
      : resolve(input.cwd);
  const supported = ['bash', 'zsh', 'sh', 'dash'].includes(basename(input.shellExecutable));
  return {
    assets,
    async classify(command) {
      try {
        for (const asset of assets)
          if (
            realpathSync(asset.path) !== asset.path ||
            digest(readFileSync(asset.path)) !== asset.digest
          )
            throw Error('changed');
      } catch {
        throw new AgentError('shell_parser_asset_changed');
      }
      if (!supported) return { plainCommands: null, hardDenied: null };
      const parser = new Parser();
      try {
        parser.setLanguage(language);
        const tree = parser.parse(command);
        if (!tree) throw new AgentError('shell_parser_failed');
        try {
          const stack = [tree.rootNode];
          const commands: Node[] = [];
          // A Shell can execute an earlier complete line before reporting a
          // later syntax error. Error recovery never proves argv, but known
          // literal critical operations still participate in hard denial.
          let plain = !tree.rootNode.hasError;
          while (stack.length) {
            const node = stack.pop()!;
            if (node.type === 'command') commands.push(node);
            if (node.isNamed) {
              if (!containers.has(node.type) && !wordKinds.has(node.type)) plain = false;
              if ((node.type === 'word' || node.type === 'number') && literal(node) === null)
                plain = false;
            } else if (!punctuation.has(node.type) && node.type.trim()) plain = false;
            stack.push(...node.children.filter(presentNode));
          }
          commands.sort((left, right) => left.startIndex - right.startIndex);
          const exact = commands.map((node) => invocation(node, false));
          const hardDenied = scanTree(tree.rootNode, cwd, parser, 0);
          return {
            plainCommands:
              plain && exact.every((words) => words !== null)
                ? (exact as readonly (readonly string[])[])
                : null,
            hardDenied,
          };
        } finally {
          tree.delete();
        }
      } finally {
        parser.delete();
      }
    },
  };
}
