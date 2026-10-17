/** One TUI build owns Ink, all hooks and its pure JS helpers; React stays external. */
export const tuiBundledDependencies: readonly string[] = Object.freeze([
  'ink',
  'ink-scroll-list',
  'ink-syntax-highlight',
  'ink-text-input',
  'string-width',
]);
