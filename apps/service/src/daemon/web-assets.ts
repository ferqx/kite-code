import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

export const daemonWebSelectionSchema = z.strictObject({
  directory: z.string().min(1).max(4096),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type DaemonWebSelection = z.infer<typeof daemonWebSelectionSchema>;
const paths = new Map([
  ['/index.html', 'text/html; charset=utf-8'],
  ['/app.js', 'text/javascript; charset=utf-8'],
  ['/app.css', 'text/css; charset=utf-8'],
]);
const manifestSchema = z
  .array(
    z.strictObject({
      path: z.string(),
      mediaType: z.string(),
      size: z
        .number()
        .int()
        .nonnegative()
        .max(64 * 1024 * 1024),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  )
  .length(paths.size);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function readAsset(path: string, maximum: number) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw Error('daemon_web_assets_invalid');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.byteLength) {
      const read = readSync(fd, bytes, size, bytes.byteLength - size, size);
      if (!read) break;
      size += read;
    }
    if (size !== stat.size) throw Error('daemon_web_assets_invalid');
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}
/** Exact selected build files only. No import/evaluation of a host-provided JavaScript module. */
export function loadDaemonWebAssets(selection: DaemonWebSelection) {
  const input = daemonWebSelectionSchema.parse(selection);
  if (
    !isAbsolute(input.directory) ||
    realpathSync(input.directory) !== input.directory ||
    !lstatSync(input.directory).isDirectory()
  )
    throw Error('daemon_web_assets_invalid');
  const manifestBytes = readAsset(join(input.directory, 'manifest.json'), 16384);
  if (hash(manifestBytes) !== input.manifestSha256)
    throw Error('daemon_web_assets_identity_mismatch');
  const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const manifest = manifestSchema.parse(JSON.parse(decode(manifestBytes)));
  const assets = new Map<string, { content: string; mediaType: string }>();
  for (const item of manifest) {
    if (paths.get(item.path) !== item.mediaType || assets.has(item.path))
      throw Error('daemon_web_assets_invalid');
    const bytes = readAsset(join(input.directory, item.path.slice(1)), 64 * 1024 * 1024);
    if (bytes.byteLength !== item.size || hash(bytes) !== item.sha256)
      throw Error('daemon_web_assets_identity_mismatch');
    assets.set(item.path, Object.freeze({ content: decode(bytes), mediaType: item.mediaType }));
  }
  return assets;
}
