import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ripgrepAsset } from '../jobs/ripgrep';
import type { LiteralRead } from './shell-command-policy';
import { windowsGitQuery } from './windows-git-read';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// Bundled-rg options only: unknown arity cannot prove where `--` ends options.
// Execution hooks (--pre/--hostname-bin) and external decompression (-z/--search-zip) stay excluded.
const rgValueOptions = new Set(
  `regexp file pre-glob dfa-size-limit encoding engine max-count regex-size-limit threads
  glob iglob ignore-file max-depth max-filesize type type-not type-add type-clear
  after-context before-context color colors context context-separator field-context-separator
  field-match-separator hyperlink-format max-columns path-separator replace sort sortr generate context-separator`.split(
    /\s+/,
  ),
);
const rgFlagOptions = new Set(
  `case-sensitive crlf fixed-strings ignore-case invert-match line-regexp mmap multiline
  multiline-dotall unicode null-data pcre2 smart-case stop-on-nonmatch text word-regexp
  auto-hybrid-regex pcre2-unicode binary follow glob-case-insensitive hidden ignore-file-case-insensitive
  ignore ignore-dot ignore-exclude ignore-files ignore-global ignore-parent ignore-vcs require-git
  one-file-system unrestricted block-buffered byte-offset column heading help include-zero
  line-buffered line-number max-columns-preview null only-matching passthru pretty quiet trim vimgrep
  with-filename filename sort-files count count-matches files-with-matches files-without-match json
  debug ignore-messages messages stats trace files no-config pcre2-version type-list version
  no-pre no-search-zip`.split(/\s+/),
);
const rgShortValueOptions = new Set('efEmjgdtTABCMr');
const rgShortFlagOptions = new Set('sFivxUPSawLa.ubhnN0opqHIclV');

/** Read operands for the bundled binary, excluding options that launch external helpers. */
export function readOnlyRipgrepPaths(args: readonly string[]): string[] | undefined {
  const operands: string[] = [];
  const files: string[] = [];
  let patternOption = false;
  let listFiles = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') {
      for (let literal = index + 1; literal < args.length; literal++) operands.push(args[literal]!);
      break;
    }
    if (arg === '-' || !arg.startsWith('-')) {
      operands.push(arg);
      continue;
    }
    if (arg.startsWith('--')) {
      const separator = arg.indexOf('=');
      const name = arg.slice(2, separator < 0 ? undefined : separator);
      if (rgValueOptions.has(name)) {
        const value = separator < 0 ? args[++index] : arg.slice(separator + 1);
        if (value === undefined) return;
        if (name === 'file' || name === 'ignore-file') files.push(value);
        if (name === 'regexp' || name === 'file') patternOption = true;
      } else if (
        separator >= 0 ||
        !(rgFlagOptions.has(name) || (name.startsWith('no-') && rgFlagOptions.has(name.slice(3))))
      ) {
        return;
      }
      if (name === 'files') listFiles = true;
      continue;
    }
    for (let offset = 1; offset < arg.length; offset++) {
      const name = arg[offset]!;
      if (rgShortValueOptions.has(name)) {
        const value = offset === arg.length - 1 ? args[++index] : arg.slice(offset + 1);
        if (value === undefined) return;
        if (name === 'f') files.push(value);
        if (name === 'e' || name === 'f') patternOption = true;
        break;
      }
      if (!rgShortFlagOptions.has(name)) return;
    }
  }
  return files.concat(operands.slice(listFiles || patternOption ? 0 : 1));
}

/** Every leaf is a literal query; callers supply only a single command or a verified && chain. */
export function readOnlySearchCommand(
  classification: { readonly readOnlyCommands: readonly (readonly string[])[] | null },
  shellExecutable: string,
) {
  const commands = classification.readOnlyCommands;
  if (!commands?.length) return;
  const rewritten = commands.map((command) => readOnlySearchLeaf(command, shellExecutable));
  if (rewritten.some((command) => command === undefined)) return;
  return rewritten.join(' && ');
}

function readOnlySearchLeaf(command: readonly string[], shellExecutable: string, windows = false) {
  const [name, ...args] = command;
  const rg = ripgrepAsset();
  if (name === 'rg' || name === 'rg.exe' || name === rg) {
    const paths = readOnlyRipgrepPaths(args);
    if (!paths || (windows && !windowsLiteralArguments(paths))) return;
    return [quote(rg.replaceAll('\\', '/')), '--no-config', ...args.map(quote)].join(' ');
  }
  if (name === 'pwd' && args.length === 0) return 'pwd';
  if (name === 'ls') {
    if (process.platform === 'win32' && !/(?:bash|sh)\.exe$/i.test(shellExecutable)) return;
    const executable =
      process.platform === 'win32'
        ? join(dirname(shellExecutable), 'ls.exe')
        : realpathSync.native('/bin/ls');
    return [quote(executable.replaceAll('\\', '/')), ...args.map(quote)].join(' ');
  }
  return undefined;
}

const textReaders = new Set(['cat', 'head', 'tail', 'wc', 'grep']);
const textOptions: Record<string, ReadonlySet<string>> = {
  cat: new Set(['-n', '-b', '-s', '-A', '-T', '-E', '-v']),
  head: new Set(['-n', '--lines', '-c', '--bytes', '-q', '-v']),
  tail: new Set(['-n', '--lines', '-c', '--bytes', '-q', '-v']),
  wc: new Set(['-l', '-w', '-c', '-m', '-L']),
  grep: new Set([
    '-n',
    '-i',
    '-v',
    '-F',
    '-E',
    '-w',
    '-x',
    '-l',
    '-L',
    '-r',
    '-R',
    '-c',
    '-q',
    '-H',
    '-h',
    '-e',
    '-f',
    '--line-number',
    '--fixed-strings',
    '--ignore-case',
    '--color=never',
  ]),
};

function windowsLiteralArguments(args: readonly string[]) {
  return args.every(
    (arg) =>
      !/^(?:[\\/]{2}|[a-z]:(?![\\/]))/iu.test(arg) &&
      Array.from(arg).every((character) => character.charCodeAt(0) >= 32),
  );
}

/** Preserve Bash operator precedence while pinning every executable in the read. */
export function windowsBashRead(
  expression: LiteralRead,
  shell: string,
  git: string | undefined,
): { command: string; gitQuery?: true } | undefined {
  if ('argv' in expression) {
    const [name, ...args] = expression.argv;
    // Win32 native argv transport is not equivalent to Bash quoting for
    // embedded double quotes. Leave those inputs on the ordinary Shell path.
    if (args.some((arg) => arg.includes('"'))) return;
    if (!windowsLiteralArguments(args)) return;
    if (git && (name === 'git' || name === 'git.exe')) {
      const query = windowsGitQuery(args);
      if (query)
        return {
          command: ['exec', quote(git.replaceAll('\\', '/')), ...query.map(quote)].join(' '),
          gitQuery: true,
        };
      return;
    }
    const search = readOnlySearchLeaf(expression.argv, shell, true);
    if (search) return { command: search };
    if (!name || !textReaders.has(name)) return;
    const options = textOptions[name]!;
    for (const arg of args) {
      if (arg === '--') break;
      if (
        arg.startsWith('-') &&
        arg !== '-' &&
        !options.has(arg) &&
        !(
          (name === 'head' || name === 'tail') &&
          /^-(?:[nc])?\d+$|^--(?:lines|bytes)=\+?\d+$/u.test(arg)
        ) &&
        !(name === 'grep' && /^-[nivFEwxlLrRcqHh]+$/u.test(arg))
      )
        return;
    }
    const executable = join(dirname(shell), `${name}.exe`).replaceAll('\\', '/');
    return { command: [quote(executable), ...args.map(quote)].join(' ') };
  }
  const left = windowsBashRead(expression.left, shell, git);
  const right = windowsBashRead(expression.right, shell, git);
  if (!left || !right || left.gitQuery || right.gitQuery) return;
  return { command: `${left.command} ${expression.operator} ${right.command}` };
}
