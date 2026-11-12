import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ripgrepAsset } from '../jobs/ripgrep';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// Bundled-rg options only: unknown arity cannot prove where `--` ends options.
// Execution hooks (--pre/--hostname-bin) and external decompression (-z/--search-zip) stay excluded.
const rgValueOptions = new Set(
  `regexp file pre-glob dfa-size-limit encoding engine max-count regex-size-limit threads
  glob iglob ignore-file max-depth max-filesize type type-not type-add type-clear
  after-context before-context color colors context context-separator field-context-separator
  field-match-separator hyperlink-format max-columns path-separator replace sort sortr generate`.split(
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
  context-separator no-pre no-search-zip`.split(/\s+/),
);
const rgShortValueOptions = new Set('efEmjgdtTABCMr');
const rgShortFlagOptions = new Set('sFivxUPSawLa.ubhnN0opqHIclV');

function readOnlyRipgrepArguments(args: readonly string[]) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') return true;
    if (arg === '-' || !arg.startsWith('-')) continue;
    if (arg.startsWith('--')) {
      const separator = arg.indexOf('=');
      const name = arg.slice(2, separator < 0 ? undefined : separator);
      if (rgValueOptions.has(name)) {
        if (separator < 0 && ++index >= args.length) return false;
      } else if (
        separator >= 0 ||
        !(rgFlagOptions.has(name) || (name.startsWith('no-') && rgFlagOptions.has(name.slice(3))))
      ) {
        return false;
      }
      continue;
    }
    for (let offset = 1; offset < arg.length; offset++) {
      const name = arg[offset]!;
      if (rgShortValueOptions.has(name)) {
        if (offset === arg.length - 1 && ++index >= args.length) return false;
        break;
      }
      if (!rgShortFlagOptions.has(name)) return false;
    }
  }
  return true;
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

function readOnlySearchLeaf(command: readonly string[], shellExecutable: string) {
  const [name, ...args] = command;
  const rg = ripgrepAsset();
  if (name === 'rg' || name === 'rg.exe' || name === rg) {
    if (!readOnlyRipgrepArguments(args)) return;
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
