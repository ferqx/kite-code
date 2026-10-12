import { expect, test } from 'bun:test';
import { decodeWindowsCandidateRecords } from '../host/file-candidate-windows';

function records(names: readonly string[]) {
  const parts = names.map((name, index) => {
    const encoded = Buffer.from(name, 'utf16le'),
      size = Math.ceil((104 + encoded.length) / 8) * 8;
    const bytes = Buffer.alloc(size);
    bytes.writeUInt32LE(index + 1 === names.length ? 0 : size, 0);
    bytes.writeUInt32LE(index === 0 ? 0x10 : index === 1 ? 0x400 : 0, 56);
    bytes.writeUInt32LE(encoded.length, 60);
    bytes.writeBigUInt64LE(BigInt(index + 10), 96);
    encoded.copy(bytes, 104);
    return bytes;
  });
  return Buffer.concat(parts);
}

test('Windows directory records preserve complete Unicode names, dot filtering and reparse types', () => {
  expect(decodeWindowsCandidateRecords(records(['目录🙂', 'junction', '雪e\u0301.txt']))).toEqual([
    { name: '目录🙂', type: 4 },
    { name: 'junction', type: 10 },
    { name: '雪e\u0301.txt', type: 8 },
  ]);
  expect(decodeWindowsCandidateRecords(records(['.', '..', '.gitignore']))).toEqual([
    { name: '.gitignore', type: 8 },
  ]);
  const slice = records(['完整.txt']);
  const container = Buffer.concat([Buffer.alloc(7), slice, Buffer.alloc(9)]);
  expect(decodeWindowsCandidateRecords(container.subarray(7, 7 + slice.length))[0]!.name).toBe(
    '完整.txt',
  );
});

test('Windows directory records reject incomplete framing and UTF16 without yielding partial candidates', () => {
  for (const mutate of [
    (bytes: Buffer) => bytes.subarray(0, 103),
    (bytes: Buffer) => {
      bytes.writeUInt32LE(3, 60);
      return bytes;
    },
    (bytes: Buffer) => {
      bytes.writeUInt32LE(bytes.length, 60);
      return bytes;
    },
    (bytes: Buffer) => {
      bytes.writeUInt32LE(105, 0);
      return bytes;
    },
    (bytes: Buffer) => {
      bytes.writeUInt32LE(104, 0);
      return bytes;
    },
    (bytes: Buffer) => {
      bytes.writeUInt32LE(bytes.length, 0);
      return bytes;
    },
    (bytes: Buffer) => {
      bytes.writeUInt16LE(0xd800, 104);
      return bytes;
    },
  ])
    expect(() => decodeWindowsCandidateRecords(mutate(records(['a', 'b'])))).toThrow();
});

test('Windows directory records preserve exact case and reject aliases, unsafe components and duplicate records', () => {
  for (const name of [
    'a/b',
    'a\\b',
    'a:stream',
    'a\0b',
    'a\nb',
    'a.',
    'a ',
    'CON.txt',
    'COM¹',
    '*',
    'a?b',
  ])
    expect(() => decodeWindowsCandidateRecords(records([name]))).toThrow();
  expect(
    decodeWindowsCandidateRecords(records(['same', 'SAME'])).map((entry) => entry.name),
  ).toEqual(['same', 'SAME']);
  expect(() => decodeWindowsCandidateRecords(records(['same', 'same']))).toThrow();
  const device = records(['device']);
  device.writeUInt32LE(0x40, 56);
  expect(() => decodeWindowsCandidateRecords(device)).toThrow();
});
