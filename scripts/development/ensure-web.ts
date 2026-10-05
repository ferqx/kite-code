import { resolve } from 'node:path';
import { parseCLIArguments } from '../../apps/cli/src/arguments';
import { runSourceTerminalCLI, terminalEntrypoint } from '../release/source-terminal';

const repositoryRoot = resolve(import.meta.dir, '../..');
/** Validate both finite calls before starting anything; workspace belongs only to start. */
export function sourceServerArguments(argv: readonly string[]): {
  start: readonly string[];
  web: readonly string[];
} {
  if (argv.includes('--help') || argv.includes('--version')) {
    parseCLIArguments(argv);
    return { start: Object.freeze([...argv]), web: Object.freeze([]) };
  }
  const start = ['server', 'start', ...argv.filter((arg) => arg !== '--json')];
  const web = ['web'];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--workspace') {
      index++;
      continue;
    }
    web.push(argv[index]!);
  }
  parseCLIArguments(start);
  parseCLIArguments(web);
  return { start: Object.freeze(start), web: Object.freeze(web) };
}
export async function runSourceServer(
  argv: readonly string[] = process.argv.slice(2),
  root = repositoryRoot,
): Promise<number> {
  const selected = sourceServerArguments(argv);
  const started = await runSourceTerminalCLI(selected.start, root);
  if (started !== 0 || selected.web.length === 0) return started;
  return runSourceTerminalCLI(selected.web, root);
}
if (import.meta.main) await terminalEntrypoint(() => runSourceServer());
