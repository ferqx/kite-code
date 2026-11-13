import sharp from 'sharp';
import { AgentError } from '../../storage/types';
import {
  imageContainer,
  imageInputBytes,
  imageInputDimension,
  imageInputPixels,
  imageOutputBytes,
  imageOutputDimension,
} from './format';

async function write(stream: NodeJS.WritableStream, value: string | Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(value, (error) => (error ? reject(error) : resolve()));
  });
}

// This fixed one-shot program accepts only bytes. No user path, URL, code, or provider state.
sharp.cache(false);
sharp.concurrency(1);
async function main() {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const value of process.stdin) {
    const part = Buffer.from(value);
    size += part.length;
    if (size > imageInputBytes) throw new AgentError('image_input_too_large');
    chunks.push(part);
  }
  const input = Buffer.concat(chunks, size);
  chunks.length = 0;
  const format = imageContainer(input);
  const options = {
    failOn: 'warning' as const,
    limitInputPixels: imageInputPixels,
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
    width > imageInputDimension ||
    height > imageInputDimension ||
    width * height > imageInputPixels
  )
    throw new AgentError('image_dimensions_exceeded');
  let dimension = imageOutputDimension;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, info } = await sharp(input, options)
      .rotate()
      .resize({ width: dimension, height: dimension, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 3 })
      .toBuffer({ resolveWithObject: true });
    if (data.length > imageOutputBytes) {
      dimension = Math.max(
        1,
        Math.floor(dimension * Math.sqrt(imageOutputBytes / data.length) * 0.9),
      );
      continue;
    }
    const orientedWidth = (source.orientation ?? 1) >= 5 ? height : width;
    const orientedHeight = (source.orientation ?? 1) >= 5 ? width : height;
    const header = Buffer.from(
      JSON.stringify({
        sourceFormat: format,
        sourceWidth: width,
        sourceHeight: height,
        width: info.width,
        height: info.height,
        orientationApplied: source.orientation ?? 1,
        resized: info.width !== orientedWidth || info.height !== orientedHeight,
        frame: 0,
        animated: (source.pages ?? 1) > 1,
        mediaType: 'image/png',
        size: data.length,
      }),
    );
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    await write(process.stdout, Buffer.concat([length, header, data]));
    return;
  }
  throw new AgentError('image_output_too_large');
}
try {
  await main();
} catch (error) {
  // Native diagnostics can contain internal details; only a closed public code leaves the child.
  const code = error instanceof AgentError ? error.code : 'image_decode_failed';
  await write(process.stderr, code);
  process.exitCode = 1;
}
