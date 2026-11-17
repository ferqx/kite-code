import { nativeImageDisplaySourceByteLimit } from '../src/native-image-display-bridge';

const invalid = (): never => {
  throw Error('native_image_display_invalid');
};
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** Container validation runs in the codec process, before native pixel decoding. */
export function imageDisplayContainer(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | 'gif' {
  if (!bytes.length) invalid();
  if (bytes.length > nativeImageDisplaySourceByteLimit)
    throw Error('native_image_display_source_too_large');
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
        if (size || !pixels) invalid();
        return 'png';
      }
      offset = end;
    }
    return invalid();
  }
  if (data[0] === 255 && data[1] === 216) {
    // JPEG can carry padding or Motion Photo video after EOI. Native failOn:warning
    // validates complete scans/EOI; format sniffing must not require EOI at EOF.
    if (data.length < 4) invalid();
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
  throw Error('native_image_display_format_unsupported');
}

/** Read dimensions of the fixed codec output without loading a decoder in Main. */
export function imageDisplayWebpDimensions(bytes: Uint8Array): { width: number; height: number } {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (imageDisplayContainer(data) !== 'webp') throw Error('native_image_display_output_invalid');
  const kind = data.toString('ascii', 12, 16);
  if (kind === 'VP8X' && data.length >= 30)
    return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
  if (kind === 'VP8L' && data.length >= 25 && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8 ' && data.length >= 30 && data.subarray(23, 26).toString('hex') === '9d012a')
    return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
  throw Error('native_image_display_output_invalid');
}
