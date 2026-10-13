import { rejectRetiredEntrypoint } from '../../../../scripts/development/retired-entrypoints';

export type { KiteCliExecutableOptions } from './legacy-executable';
export let runCli: typeof import('./legacy-executable').runCli;

if (import.meta.main) rejectRetiredEntrypoint('terminal');
else ({ runCli } = require('./legacy-executable'));
