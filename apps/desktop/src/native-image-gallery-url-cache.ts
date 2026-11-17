import type { NativeImageGalleryImage } from './native-image-gallery-bridge';

type ReadyImage = Extract<NativeImageGalleryImage, { status: 'ready' }>;
type Entry = {
  key: string;
  id: string;
  src: string;
  size: number;
  pixels: number;
  mimeType: ReadyImage['mimeType'];
  retired: boolean;
};
/** Encoded bytes and conservative derivative RGBA estimates, not a browser heap limit. */
export const nativeImageGalleryUrlBudget = {
  bytes: 64 * 1024 * 1024,
  pixels: 128 * 1024 * 1024,
  entries: 32,
};

/** A single opaque gallery session. A cache hit is usable only after a current ready DTO. */
export function createNativeImageGalleryUrlCache(options: {
  create: (image: ReadyImage) => string;
  revoke: (src: string) => void;
  maxBytes?: number;
  maxEntries?: number;
  maxPixels?: number;
}) {
  const maxBytes = options.maxBytes ?? nativeImageGalleryUrlBudget.bytes;
  const maxEntries = options.maxEntries ?? nativeImageGalleryUrlBudget.entries;
  const maxPixels = options.maxPixels ?? nativeImageGalleryUrlBudget.pixels;
  const reusable = new Map<string, Entry>();
  const live = new Map<string, Entry>();
  let bytes = 0;
  let pixels = 0;
  let displayed: string | undefined;
  let candidate: string | undefined;
  let disposed = false;
  const pinned = (entry: Entry) => entry.src === displayed || entry.src === candidate;
  const revoke = (entry: Entry) => {
    if (reusable.get(entry.key) === entry) reusable.delete(entry.key);
    live.delete(entry.src);
    bytes -= entry.size;
    pixels -= entry.pixels;
    options.revoke(entry.src);
  };
  const prune = (extraBytes = 0, extraEntries = 0, extraPixels = 0) => {
    for (const entry of live.values())
      if (
        !pinned(entry) &&
        (entry.retired ||
          bytes + extraBytes > maxBytes ||
          pixels + extraPixels > maxPixels ||
          live.size + extraEntries > maxEntries)
      )
        revoke(entry);
    if (
      bytes + extraBytes > maxBytes ||
      pixels + extraPixels > maxPixels ||
      live.size + extraEntries > maxEntries
    )
      throw Error('image_gallery_presentation_budget');
  };
  const touch = (entry: Entry) => {
    live.delete(entry.src);
    live.set(entry.src, entry);
  };
  return {
    admit(id: string, image: ReadyImage) {
      if (disposed) throw Error('image_gallery_session_retired');
      const key = JSON.stringify([id, image.revision]);
      candidate = undefined;
      const existing = reusable.get(key);
      if (existing) {
        if (existing.size !== image.bytes.byteLength || existing.mimeType !== image.mimeType)
          throw Error('image_gallery_revision_mismatch');
        candidate = existing.src;
        touch(existing);
        prune();
        return existing.src;
      }
      const size = image.bytes.byteLength;
      // Conservative RGBA estimate of bounded derivatives, not Chromium heap accounting.
      const pixelCost = image.display ? image.display.edge ** 2 * 4 : 0;
      prune(size, 1, pixelCost);
      const src = options.create(image);
      const entry = {
        key,
        id,
        src,
        size,
        pixels: pixelCost,
        mimeType: image.mimeType,
        retired: false,
      };
      reusable.set(key, entry);
      live.set(src, entry);
      bytes += size;
      pixels += pixelCost;
      candidate = src;
      return src;
    },
    selecting() {
      if (disposed) return;
      candidate = undefined;
      prune();
    },
    commit(src: string) {
      if (disposed || src !== candidate || !live.has(src)) return;
      displayed = src;
      touch(live.get(src)!);
      prune();
    },
    retry(id: string) {
      if (disposed) return;
      for (const entry of live.values()) {
        if (entry.id !== id) continue;
        entry.retired = true;
        if (reusable.get(entry.key) === entry) reusable.delete(entry.key);
        if (entry.src === candidate) candidate = undefined;
      }
      prune();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      displayed = undefined;
      candidate = undefined;
      for (const entry of live.values()) revoke(entry);
    },
    snapshot() {
      return { bytes, entries: live.size };
    },
  };
}
