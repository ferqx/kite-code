import { expect, test } from 'bun:test';
import fontkit from '@pdf-lib/fontkit';

type Point = [number, number];
type Command = { command: string; args: number[] };
// No external font asset is needed to exercise the pinned subset encoder. The
// empty sfnt directory is parsed, but no font table/glyph is read in this test.
const subset = fontkit
  .create(Buffer.from('000100000000000000000000', 'hex'))
  .createSubset() as ReturnType<ReturnType<typeof fontkit.create>['createSubset']> & {
  glyphEncoder: {
    encodeSimple(path: { commands: Command[]; bbox: object }, instructions: number[]): Uint8Array;
  };
};

function roundTrip(contours: Point[][]) {
  const points = contours.flat();
  const commands: Command[] = contours.flatMap((contour) => [
    ...contour.map((args, index) => ({ command: index ? 'lineTo' : 'moveTo', args })),
    { command: 'closePath', args: [] },
  ]);
  const bytes = Buffer.from(
    subset.glyphEncoder.encodeSimple(
      {
        commands,
        bbox: {
          minX: Math.min(...points.map(([x]) => x)),
          minY: Math.min(...points.map(([, y]) => y)),
          maxX: Math.max(...points.map(([x]) => x)),
          maxY: Math.max(...points.map(([, y]) => y)),
        },
      },
      [],
    ),
  );
  expect(bytes.readInt16BE(0)).toBe(contours.length);
  let count = 0;
  for (const [index, contour] of contours.entries()) {
    count += contour.length;
    expect(bytes.readUInt16BE(10 + index * 2)).toBe(count - 1);
  }
  let offset = 10 + contours.length * 2;
  const instructionLength = bytes.readUInt16BE(offset);
  offset += 2 + instructionLength;
  const flags: number[] = [];
  while (flags.length < points.length) {
    const flag = bytes[offset++]!;
    const repeat = flag & 8 ? bytes[offset++]! : 0;
    for (let i = 0; i <= repeat; i++) flags.push(flag);
  }
  expect(flags.length).toBe(points.length);
  const decode = (shortBit: number, sameBit: number) => {
    let position = 0;
    return flags.map((flag) => {
      if (flag & shortBit) position += bytes[offset++]! * (flag & sameBit ? 1 : -1);
      else if (!(flag & sameBit)) {
        position += bytes.readInt16BE(offset);
        offset += 2;
      }
      return position;
    });
  };
  const xs = decode(2, 16),
    ys = decode(4, 32);
  expect(xs.map((x, index) => [x, ys[index]])).toEqual(points);
  expect(bytes.subarray(offset).every((byte) => byte === 0)).toBe(true);
  expect(bytes.length - offset).toBeLessThanOrEqual(4);
}

test('fontkit subset flush leaves a final non-repeated flag unchanged', () => {
  roundTrip([
    [
      [0, 0],
      [1, 1],
      [1, 2],
    ],
  ]);
});

test('fontkit subset flush preserves final runs at, below and above the 255 repeat limit', () => {
  for (const repeated of [1, 254, 255, 256, 257, 511])
    roundTrip([Array.from({ length: repeated + 2 }, (_, index) => [index, index])]);
});

test('fontkit subset flush preserves flag runs and point counts across contours', () => {
  roundTrip([
    [
      [0, 0],
      [1, 1],
      [2, 2],
    ],
    [
      [3, 3],
      [4, 4],
      [5, 5],
    ],
  ]);
});
