#!/usr/bin/env bun
import { rejectRetiredEntrypoint } from '../../../scripts/development/retired-entrypoints';

export type { KiteServiceMainDependencies } from './legacy-executable';
export let runKiteServiceMain: typeof import('./legacy-executable').runKiteServiceMain;
export let isKiteServiceMcpStdioInvocation: typeof import('./legacy-executable').isKiteServiceMcpStdioInvocation;

const args = process.argv.slice(2);
// Only the original private helper families retain their historical executable route.
// Their exact parsing and execution remain in the unchanged historical router.
const mcpMarker = '--kite-internal-mcp-stdio-v1';
const mcpHelper = (argv: readonly string[]) =>
  argv.filter((argument) => argument === mcpMarker).length === 1 &&
  argv.at(-1) === mcpMarker &&
  !argv.some((argument) => argument.startsWith('--kite-internal-') && argument !== mcpMarker);
const historicalHelper =
  (args.length === 1 &&
    ['--kite-internal-history-page-v1', '--kite-internal-process-tree-v1'].includes(args[0]!)) ||
  (args[0] === '--kite-internal-posix-supervisor-v1' &&
    !args.slice(1).some((argument) => argument.startsWith('--kite-internal-'))) ||
  mcpHelper(args) ||
  mcpHelper(process.argv);

if (import.meta.main && !historicalHelper) rejectRetiredEntrypoint('service');
else {
  ({ runKiteServiceMain, isKiteServiceMcpStdioInvocation } = await import('./legacy-executable'));
  if (import.meta.main)
    await runKiteServiceMain().catch(async (error: unknown) => {
      const { encodeServiceStartupDiagnostic } = await import(
        '@kite-ai/kite-local-runtime/startup-diagnostic'
      );
      process.stderr.write(
        encodeServiceStartupDiagnostic(error) ?? '[kite-service] service failed\n',
      );
      process.exitCode = 1;
    });
}
