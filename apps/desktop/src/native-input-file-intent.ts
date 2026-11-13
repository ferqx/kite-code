/** Prepared attachments are host-owned IDs, never renderer placeholder URIs. */
export function nativeInputFileIntent(
  files: readonly { name: string; uri: string; prepared?: boolean }[],
) {
  const links = files.filter((file) => !file.prepared).map(({ name, uri }) => ({ name, uri }));
  return links.length ? { files: links } : {};
}
