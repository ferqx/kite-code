import { rejectRetiredEntrypoint } from '../../../../scripts/development/retired-entrypoints';

export type { KiteTuiProps } from './legacy-executable';
export let runTui: typeof import('./legacy-executable').runTui;

if (import.meta.main) rejectRetiredEntrypoint('terminal');
else ({ runTui } = require('./legacy-executable'));
