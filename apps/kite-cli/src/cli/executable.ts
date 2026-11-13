import { rejectRetiredEntrypoint } from '../../../../scripts/development/retired-entrypoints.ts';

export type { KiteCliExecutableOptions } from './legacy-executable';
export let runCli: typeof import('./legacy-executable').runCli;

if (import.meta.main) rejectRetiredEntrypoint('terminal');
else ({ runCli } = await import('./legacy-executable.ts'));
