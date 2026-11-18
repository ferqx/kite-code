// Mark only a verified lookup of the content-addressed file itself, not general ENOENT,
// permission, path, or reference errors. Preserve the original exception for existing readers.
const absent = new WeakMap<object, string>();
export function markMissingPublishedImage(error: object, hash: string) {
  absent.set(error, hash);
}
export function isMissingPublishedImage(error: unknown, hash: string) {
  return !!error && typeof error === 'object' && absent.get(error) === hash;
}
