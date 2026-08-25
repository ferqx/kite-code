import type {
  BuiltinModelToolCatalogEntry,
  BuiltinToolCatalogProjection,
} from '@kite-ai/builtin-runtime';

/** Resolve one model-visible Builtin entry from the frozen turn projection. */
export function modelBuiltinEntry(
  catalog: BuiltinToolCatalogProjection,
  name: string,
): BuiltinModelToolCatalogEntry | undefined {
  return catalog.entries.find(
    (entry): entry is BuiltinModelToolCatalogEntry =>
      entry.visibility === 'model' && entry.name === name,
  );
}
