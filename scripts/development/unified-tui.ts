import { join, resolve } from 'node:path';
import { parseTUIArguments, runTUIProcess } from '@kite-ai/cli/tui-main';
import { selectDevelopmentServiceArtifact } from './unified-cli';

const repositoryRoot = resolve(import.meta.dir, '../..');
/** Pure vocabulary first; help/version never inspect assets or a profile. */
export function selectDevelopmentTUI(
  argv: readonly string[],
  root = repositoryRoot,
  executable = process.execPath,
) {
  const args = parseTUIArguments(argv);
  const selected = {
    argv: Object.freeze([...argv]),
    dataRoot: join(root, '.kite-code', 'unified-development'),
    profile: 'development' as const,
  };
  return Object.freeze(
    args.kind === 'tui' && !args.server
      ? { ...selected, artifact: selectDevelopmentServiceArtifact(root, executable) }
      : selected,
  );
}

export function runDevelopmentTUI(
  input: {
    readonly argv?: readonly string[];
    readonly root?: string;
    readonly executable?: string;
  } = {},
): Promise<number> {
  return runTUIProcess(
    selectDevelopmentTUI(input.argv ?? process.argv.slice(2), input.root, input.executable),
  );
}
if (import.meta.main) {
  try {
    process.exitCode = await runDevelopmentTUI();
  } catch (error) {
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[a-z][a-z0-9_]{0,80}$/.test(error.code)
        ? error.code
        : 'tui_development_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
