import sharp from 'sharp';
import {
  isNativeImageDisplayEdge,
  isNativeImageDisplayMediaType,
  isNativeImageDisplayRegion,
  nativeImageDisplayDimensionLimit,
  nativeImageDisplayOutputByteLimit,
  nativeImageDisplayPixelLimit,
  nativeImageDisplayRegionFits,
  nativeImageDisplaySourceByteLimit,
} from '../src/native-image-display-bridge';
import { imageDisplayContainer } from './image-display-format';

// One-shot, byte-only codec. No file/URL inputs or application credentials.
// Sequential reads and resize do not guarantee bounded libvips RSS: PNG may fully decode.
sharp.cache(false);
sharp.concurrency(1);
// The IPC channel is liveness only: Main never accepts messages from this codec.
// Main crash/forced exit closes it, so a stuck decode does not become an orphan.
process.on('disconnect', () => process.exit(1));
process.channel?.unref();
async function main() {
  const mediaType = process.argv[2],
    edge = Number(process.argv[3]),
    expectedSize = Number(process.argv[4]);
  if (!isNativeImageDisplayMediaType(mediaType) || !isNativeImageDisplayEdge(edge))
    throw Error('native_image_display_invalid');
  const region: unknown = process.argv[5] ? JSON.parse(process.argv[5]) : null;
  if (region !== null && (!isNativeImageDisplayRegion(region) || edge > 2048))
    throw Error('native_image_display_invalid');
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 1 ||
    expectedSize > nativeImageDisplaySourceByteLimit
  )
    throw Error('native_image_display_source_too_large');
  let size = 0;
  const input = Buffer.allocUnsafe(expectedSize);
  for await (const value of process.stdin) {
    const part = value as Buffer;
    if (size + part.byteLength > expectedSize) throw Error('native_image_display_invalid');
    input.set(part, size);
    size += part.byteLength;
  }
  if (size !== expectedSize) throw Error('native_image_display_invalid');
  const format = imageDisplayContainer(input);
  if (mediaType !== `image/${format}`) throw Error('native_image_display_format_unsupported');
  const options = {
    failOn: 'warning' as const,
    limitInputPixels: nativeImageDisplayPixelLimit,
    pages: 1,
    sequentialRead: true,
  };
  const source = await sharp(input, options).metadata();
  const width = source.width!,
    height = source.pageHeight ?? source.height!;
  if (
    source.format !== format ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > nativeImageDisplayDimensionLimit ||
    height > nativeImageDisplayDimensionLimit ||
    width * height > nativeImageDisplayPixelLimit
  )
    throw Error('native_image_display_dimensions_exceeded');
  const sourceWidth = (source.orientation ?? 1) >= 5 ? height : width;
  const sourceHeight = (source.orientation ?? 1) >= 5 ? width : height;
  if (region !== null && !nativeImageDisplayRegionFits(region, sourceWidth, sourceHeight))
    throw Error('native_image_display_invalid');
  const animated = (source.pages ?? 1) > 1;
  let dimension: number = edge;
  for (let attempt = 0; attempt < 3; attempt++) {
    let pipeline = sharp(input, options).rotate();
    if (region !== null) pipeline = pipeline.extract(region);
    const { data, info } = await pipeline
      .resize({ width: dimension, height: dimension, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90, alphaQuality: 100, effort: 3 })
      .toBuffer({ resolveWithObject: true });
    if (data.length > nativeImageDisplayOutputByteLimit) {
      dimension = Math.max(
        1,
        Math.floor(dimension * Math.sqrt(nativeImageDisplayOutputByteLimit / data.length) * 0.9),
      );
      continue;
    }
    const header = Buffer.from(
      JSON.stringify({
        mimeType: 'image/webp',
        width: info.width,
        height: info.height,
        sourceWidth,
        sourceHeight,
        animated,
        frame: animated ? 'first' : 'static',
        ...(region === null ? {} : { region }),
      }),
    );
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(Buffer.concat([length, header, data]), (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    return;
  }
  throw Error('native_image_display_output_invalid');
}
main().catch((error) => {
  const message = error instanceof Error ? error.message : '';
  const code =
    /^native_image_display_(?:invalid|format_unsupported|source_too_large|dimensions_exceeded|output_invalid)$/.test(
      message,
    )
      ? message
      : 'native_image_display_decode_failed';
  process.stderr.write(code);
  process.exitCode = 1;
});
