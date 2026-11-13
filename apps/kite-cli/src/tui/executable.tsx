import { rejectRetiredEntrypoint } from '../../../../scripts/development/retired-entrypoints.ts';

export type { KiteTuiProps } from './legacy-executable';
export let runTui: typeof import('./legacy-executable').runTui;

if (import.meta.main) rejectRetiredEntrypoint('terminal');
else ({ runTui } = await import('./legacy-executable.tsx'));
