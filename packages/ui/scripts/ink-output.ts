import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { BunPlugin } from 'bun';

const originalSerialization = `const lineWithoutEmptyItems = line.filter(item => item !== undefined);
            return styledCharsToString(lineWithoutEmptyItems).trimEnd();`;

/** Preserve Ink's cells and styling; avoid ANSI diffs only for entirely unstyled rows. */
export function plainInkOutput(inkDirectory: string): BunPlugin {
  const manifest = JSON.parse(readFileSync(join(inkDirectory, '../package.json'), 'utf8'));
  if (manifest.name !== 'ink' || manifest.version !== '7.1.1')
    throw Error('tui_ink_build_version_unreviewed');
  const output = realpathSync(join(inkDirectory, 'output.js'));
  return {
    name: 'ink-plain-output',
    setup(build) {
      build.onLoad({ filter: /output\.js$/ }, ({ path }) => {
        if (realpathSync(path) !== output) return undefined;
        const source = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
        if (source.split(originalSerialization).length !== 2)
          throw Error('tui_ink_output_contract_changed');
        return {
          loader: 'js',
          contents: source.replace(
            originalSerialization,
            `const lineWithoutEmptyItems = line.filter(item => item !== undefined);
            return (lineWithoutEmptyItems.every(item => item.styles.length === 0)
                ? lineWithoutEmptyItems.map(item => item.value).join('')
                : styledCharsToString(lineWithoutEmptyItems)).trimEnd();`,
          ),
        };
      });
    },
  };
}
