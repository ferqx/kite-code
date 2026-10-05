import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

/** Resolve a not-yet-created destination without allowing an ancestor alias to hide overlap. */
export function rejectBundleOutput(bundleRoot: string, output: string): void {
  let ancestor = resolve(output);
  const missing: string[] = [];
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  const destination = join(realpathSync(ancestor), ...missing);
  if (destination === bundleRoot || destination.startsWith(bundleRoot + sep))
    throw Error('terminal_destination_overlaps_bundle');
}
