import { AgentError } from '../../storage/types';

export const imageInputBytes = 16 * 1024 * 1024;
export const imageOutputBytes = 8 * 1024 * 1024;
export const imageInputPixels = 32_000_000;
export const imageInputDimension = 16384;
export const imageOutputDimension = 2048;
export const imageTimeoutMs = 30_000;
export const imageBatchCount = 10;
export const imageBatchBytes = 16 * 1024 * 1024;

const invalid = (): never => {
  throw new AgentError('image_invalid');
};
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** Container validation runs in the codec process, before native pixel decoding. */
export function imageContainer(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | 'gif' {
  if (!bytes.length) invalid();
  if (bytes.length > imageInputBytes) throw new AgentError('image_input_too_large');
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    let offset = 8,
      count = 0,
      pixels = false;
    while (offset + 12 <= data.length) {
      const size = data.readUInt32BE(offset),
        end = offset + size + 12;
      if (end > data.length) invalid();
      const kind = data.toString('ascii', offset + 4, offset + 8);
      if (count++ === 0 && (kind !== 'IHDR' || size !== 13)) invalid();
      let crc = 0xffffffff;
      for (let at = offset + 4; at < end - 4; at++)
        crc = crcTable[(crc ^ data[at]!) & 255]! ^ (crc >>> 8);
      if ((crc ^ 0xffffffff) >>> 0 !== data.readUInt32BE(end - 4)) invalid();
      if (kind === 'IDAT') pixels = true;
      if (kind === 'IEND') {
        if (size || !pixels || end !== data.length) invalid();
        return 'png';
      }
      offset = end;
    }
    return invalid();
  }
  if (data[0] === 255 && data[1] === 216) {
    // Native failOn:warning additionally validates scan data, including partial MCU rows.
    if (data.length < 4 || data[data.length - 2] !== 255 || data[data.length - 1] !== 217)
      invalid();
    return 'jpeg';
  }
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    if (data.length < 20 || data.readUInt32LE(4) + 8 !== data.length) invalid();
    let offset = 12;
    while (offset + 8 <= data.length) {
      const size = data.readUInt32LE(offset + 4);
      offset += 8 + size + (size & 1);
      if (offset > data.length) invalid();
    }
    if (offset !== data.length) invalid();
    return 'webp';
  }
  if (['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) {
    if (data.length < 14) invalid();
    let offset = 13 + (data[10]! & 128 ? 3 * (1 << ((data[10]! & 7) + 1)) : 0),
      frames = 0;
    const blocks = () => {
      for (;;) {
        if (offset >= data.length) invalid();
        const size = data[offset++]!;
        if (!size) return;
        offset += size;
        if (offset > data.length) invalid();
      }
    };
    while (offset < data.length) {
      const kind = data[offset++];
      if (kind === 0x3b) {
        if (!frames || offset !== data.length) invalid();
        return 'gif';
      }
      if (kind === 0x21) {
        if (offset++ >= data.length) invalid();
        blocks();
      } else if (kind === 0x2c) {
        if (offset + 9 >= data.length) invalid();
        const packed = data[offset + 8]!;
        offset += 9 + (packed & 128 ? 3 * (1 << ((packed & 7) + 1)) : 0);
        if (offset >= data.length || data[offset]! < 2 || data[offset]! > 8) invalid();
        offset++;
        blocks();
        frames++;
      } else invalid();
    }
    return invalid();
  }
  throw new AgentError('image_format_unsupported');
}
