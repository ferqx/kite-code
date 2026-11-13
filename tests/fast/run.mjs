import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { testFileCommand } from '../../scripts/tooling/test-command.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const groups = new Map([
  [
    'trajectory',
    [
      'packages/trajectory/test/display.test.ts',
      'packages/trajectory/test/presentation.test.ts',
      'packages/trajectory/test/projection.test.ts',
      'packages/trajectory/test/protocol.test.ts',
    ],
  ],
  [
    'agent',
    [
      'packages/agent/test/context/context-estimate.test.ts',
      'packages/agent/test/context/context-projection.test.ts',
    ],
  ],
  [
    'ai',
    [
      'packages/ai/test/input-images.test.ts',
      'packages/ai/test/model.test.ts',
      'packages/ai/test/request-snapshot.test.ts',
      'packages/ai/test/usage.test.ts',
    ],
  ],
  [
    'tui',
    [
      'packages/ui/test/tui/composer.test.ts',
      'packages/ui/test/tui/drafts.test.ts',
      'packages/ui/test/tui/executions.test.ts',
      'packages/ui/test/tui/mcp-prompts.test.ts',
    ],
  ],
  [
    'desktop',
    [
      'packages/ui/test/desktop-file-diff-model.test.ts',
      'packages/ui/test/desktop-message-time.test.ts',
      'packages/ui/test/desktop-reading-state.test.ts',
      'packages/ui/test/trajectory-loop-causality.test.ts',
      'packages/ui/test/trajectory-related.test.ts',
      'packages/ui/test/trajectory-tree.test.ts',
    ],
  ],
]);

function run() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { node: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    console.log('Usage: node tests/fast/run.mjs [--node] [group ...]');
    console.log(`Groups: ${[...groups.keys()].join(', ')}. Omit groups to run them all.`);
    return 0;
  }
  const names = positionals.length ? new Set(positionals) : groups.keys();
  const files = [];
  for (const name of names) {
    const selected = groups.get(name);
    if (!selected)
      throw Error(`Unknown test group '${name}'. Choose ${[...groups.keys()].join(', ')}.`);
    for (const file of selected) {
      const absolute = join(repository, file);
      if (!statSync(absolute, { throwIfNoEntry: false })?.isFile())
        throw Error(`Test file is missing: ${file}`);
      files.push(absolute);
    }
  }
  const [command, ...args] = values.node
    ? testFileCommand(['--only-failures', ...files])
    : [
        'bun',
        'test',
        '--no-config',
        '--no-env-file',
        '--no-install',
        '--only-failures',
        '--max-concurrency=1',
        '--tsconfig-override',
        fileURLToPath(new URL('./tsconfig.json', import.meta.url)),
        ...files,
      ];
  console.log(`Local unit tests on ${values.node ? 'Node' : 'Bun'} (${files.length} files)`);
  const result = spawnSync(command, args, { cwd: repository, stdio: 'inherit' });
  if (result.error?.code === 'ENOENT' && !values.node) {
    console.error('Bun was not found. Run the same tests with node tests/fast/run.mjs --node.');
    return 2;
  }
  if (result.error) throw result.error;
  if (result.signal) return 128 + constants.signals[result.signal];
  return result.status ?? 1;
}

try {
  process.exitCode = run();
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
