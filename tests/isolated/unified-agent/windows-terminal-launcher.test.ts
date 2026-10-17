import { expect, test } from 'bun:test';
import { sealWindowsSystemImportSearch } from '../../../scripts/release/build-windows-terminal-launcher';

function image() {
  const bytes = Buffer.alloc(2048);
  bytes.write('MZ');
  bytes.writeUInt32LE(128, 60);
  bytes.write('PE\0\0', 128);
  bytes.writeUInt16LE(0x8664, 132);
  bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(240, 148);
  const optional = 152;
  bytes.writeUInt16LE(0x20b, optional);
  bytes.writeUInt16LE(3, optional + 68);
  bytes.writeUInt32LE(16, optional + 108);
  bytes.writeUInt32LE(4096, optional + 120);
  bytes.writeUInt32LE(40, optional + 124);
  bytes.writeUInt32LE(4352, optional + 192);
  bytes.writeUInt32LE(80, optional + 196);
  const section = optional + 240;
  bytes.writeUInt32LE(4096, section + 12);
  bytes.writeUInt32LE(1536, section + 16);
  bytes.writeUInt32LE(512, section + 20);
  bytes.writeUInt32LE(4480, 512 + 12);
  bytes.writeUInt32LE(4640, 512 + 16);
  bytes.write('kernel32.dll\0', 896);
  bytes.writeUInt32LE(80, 768);
  // Both bytes differ from 0x0800 so the transformation's exact extent is visible.
  bytes.writeUInt16LE(0x1234, 846);
  return bytes;
}

test('owned PE copy seals only its existing dependent import flags and preserves source bytes', () => {
  const original = image();
  const before = Buffer.from(original);
  const sealed = sealWindowsSystemImportSearch(original);
  expect(original).toEqual(before);
  expect(sealed).not.toBe(original);
  expect(sealed.readUInt16LE(846)).toBe(0x800);
  expect([...sealed.keys()].filter((index) => sealed[index] !== before[index])).toEqual([846, 847]);
  expect(sealWindowsSystemImportSearch(sealed)).toEqual(sealed);
});

test('incomplete loader fields, path imports, unterminated or empty imports and malformed delay imports remain denied', () => {
  const malformed: Buffer[] = [];
  let bytes = image();
  bytes.writeUInt32LE(79, 152 + 196);
  malformed.push(bytes);
  bytes = image();
  bytes.writeUInt32LE(6000, 152 + 192);
  malformed.push(bytes);
  bytes = image();
  bytes.writeUInt32LE(81, 768);
  malformed.push(bytes);
  bytes = image();
  bytes.fill(0, 896, 1152);
  bytes.write('..\\kernel32.dll\0', 896);
  malformed.push(bytes);
  bytes = image();
  bytes.fill(0x61, 896, 1152);
  malformed.push(bytes);
  bytes = image();
  bytes.fill(0, 512, 552);
  malformed.push(bytes);
  bytes = image();
  bytes.writeUInt32LE(4096, 152 + 216);
  bytes.writeUInt32LE(32, 152 + 220);
  malformed.push(bytes);
  for (const value of malformed) {
    const before = Buffer.from(value);
    expect(() => sealWindowsSystemImportSearch(value)).toThrow(
      'windows_terminal_launcher_pe_invalid',
    );
    expect(value).toEqual(before);
  }
});

function delayedImage() {
  const bytes = Buffer.alloc(2560 + 24);
  bytes.write('MZ');
  bytes.writeUInt32LE(128, 60);
  bytes.write('PE\0\0', 128);
  bytes.writeUInt16LE(0x8664, 132);
  bytes.writeUInt16LE(3, 134);
  bytes.writeUInt16LE(240, 148);
  const optional = 152;
  bytes.writeUInt16LE(0x20b, optional);
  bytes.writeUInt16LE(3, optional + 68);
  bytes.writeBigUInt64LE(0x140000000n, optional + 24);
  bytes.writeUInt32LE(16, optional + 108);
  for (const [index, rva, size] of [
    [1, 0x2000, 40],
    [10, 0x2300, 80],
    [13, 0x2100, 64],
  ]) {
    bytes.writeUInt32LE(rva!, optional + 112 + index! * 8);
    bytes.writeUInt32LE(size!, optional + 116 + index! * 8);
  }
  for (const [index, rva, raw, size, flags] of [
    [0, 0x1000, 0x200, 0x200, 0x60000020],
    [1, 0x2000, 0x400, 0x400, 0x40000040],
    [2, 0x3000, 0x800, 0x200, 0xc0000040],
  ]) {
    const row = 392 + index! * 40;
    bytes.writeUInt32LE(size!, row + 8);
    bytes.writeUInt32LE(rva!, row + 12);
    bytes.writeUInt32LE(size!, row + 16);
    bytes.writeUInt32LE(raw!, row + 20);
    bytes.writeUInt32LE(flags!, row + 36);
  }
  bytes.writeUInt32LE(0x2200, 0x400);
  bytes.writeUInt32LE(0x2240, 0x40c);
  bytes.writeUInt32LE(0x3000, 0x410);
  bytes.writeBigUInt64LE(0x2260n, 0x600);
  bytes.writeBigUInt64LE(0x2260n, 0x800);
  bytes.write('kernel32.dll\0', 0x640);
  bytes.write('GetCurrentProcessId\0', 0x662);
  bytes.writeUInt32LE(1, 0x500);
  bytes.writeUInt32LE(0x2280, 0x504);
  bytes.writeUInt32LE(0x3040, 0x508);
  bytes.writeUInt32LE(0x3020, 0x50c);
  bytes.writeUInt32LE(0x22a0, 0x510);
  bytes.write('userenv.dll\0', 0x680);
  bytes.writeBigUInt64LE(0x22c0n, 0x6a0);
  bytes.writeBigUInt64LE((1n << 63n) | 77n, 0x6a8);
  bytes.write('GetUserProfileDirectoryW\0', 0x6c2);
  bytes.writeBigUInt64LE(0x140001000n, 0x820);
  bytes.writeBigUInt64LE(0x140001000n, 0x828);
  bytes.writeUInt32LE(80, 0x700);
  bytes.write('standalone Bun overlay!', 2560);
  return bytes;
}

test('simple delay imports become eager at their original IAT addresses while code, file offsets and the standalone overlay stay exact', () => {
  const original = delayedImage(),
    before = Buffer.from(original);
  const sealed = sealWindowsSystemImportSearch(original);
  expect(original).toEqual(before);
  expect(sealed.length).toBe(original.length);
  expect(sealed.subarray(0x200, 0x400)).toEqual(original.subarray(0x200, 0x400));
  expect(sealed.subarray(0x800)).toEqual(original.subarray(0x800));
  expect(sealed.readUInt32LE(152 + 120)).toBe(0x2100);
  expect(sealed.readUInt32LE(152 + 124)).toBe(60);
  expect(sealed.readUInt32LE(152 + 216)).toBe(0);
  expect(sealed.readUInt32LE(152 + 220)).toBe(0);
  expect(sealed.subarray(0x500, 0x514)).toEqual(original.subarray(0x400, 0x414));
  expect(sealed.readUInt32LE(0x514)).toBe(0x22a0);
  expect(sealed.readUInt32LE(0x520)).toBe(0x2280);
  expect(sealed.readUInt32LE(0x524)).toBe(0x3020);
  expect(sealed.subarray(0x528, 0x540).every((v) => !v)).toBe(true);
  expect(sealed.readUInt16LE(0x74e)).toBe(0x800);
  expect(sealWindowsSystemImportSearch(sealed)).toEqual(sealed);
});

test('unconfirmed delay shapes, aliases, bound/unload state, relocations and insufficient retired storage fail without touching input', () => {
  const mutate: ((bytes: Buffer) => void)[] = [
    (b) => b.writeUInt32LE(0, 0x500),
    (b) => b.writeUInt32LE(3, 0x500),
    (b) => b.writeUInt32LE(0x2200, 0x514),
    (b) => b.writeUInt32LE(0x2200, 0x518),
    (b) => b.writeUInt32LE(1, 0x51c),
    (b) => b.writeUInt32LE(0x2240, 0x504),
    (b) => b.write('..\\evil.dll\0', 0x680),
    (b) => b.writeUInt32LE(0x3041, 0x508),
    (b) => b.writeBigUInt64LE(1n, 0x840),
    (b) => b.writeUInt32LE(0x3028, 0x510),
    (b) => b.writeUInt32LE(0x2100, 0x50c),
    (b) => b.writeBigUInt64LE((1n << 63n) | (1n << 40n) | 77n, 0x6a8),
    (b) => b.writeBigUInt64LE(0x100000000n, 0x6a0),
    (b) => b.writeUInt32LE(0xfffffff8, 0x510),
    (b) => b.writeBigUInt64LE(0x140003000n, 0x820),
    (b) => b.writeBigUInt64LE(1n, 0x830),
    (b) => b.writeUInt32LE(0x2300, 152 + 216),
    (b) => b.writeUInt32LE(63, 152 + 220),
    (b) => b.writeUInt32LE(0x60000040, 432 + 36),
    (b) => b.writeUInt32LE(0xc0000040, 432 + 36),
    (b) => b.writeUInt32LE(0x200, 432 + 20),
    (b) => b.writeUInt32LE(0x1000, 432 + 12),
    (b) => b.writeUInt32LE(0xfffffff0, 432 + 20),
    (b) => {
      b.writeUInt32LE(0x23a0, 152 + 152);
      b.writeUInt32LE(12, 152 + 156);
      b.writeUInt32LE(0x2000, 0x7a0);
      b.writeUInt32LE(12, 0x7a4);
      b.writeUInt16LE(0xa100, 0x7a8);
    },
    (b) => {
      b.writeUInt32LE(0x2100, 152 + 112);
      b.writeUInt32LE(64, 152 + 116);
    },
    (b) => {
      b.writeUInt32LE(60, 152 + 124);
      b.copy(b, 0x414, 0x400, 0x414);
      b.writeUInt32LE(0x22f0, 0x420);
      b.write('ntdll.dll\0', 0x6f0);
      b.writeUInt32LE(0x3060, 0x424);
      b.writeBigUInt64LE(0x2260n, 0x860);
    },
  ];
  for (const change of mutate) {
    const bytes = delayedImage();
    change(bytes);
    const before = Buffer.from(bytes);
    expect(() => sealWindowsSystemImportSearch(bytes)).toThrow(
      'windows_terminal_launcher_pe_invalid',
    );
    expect(bytes).toEqual(before);
  }
});

test('Electron GUI delay imports retain exact IATs and only the two known non-DLL system basenames', () => {
  for (const name of ['userenv.dll', 'WINSPOOL.DRV', 'bthprops.cpl']) {
    const original = delayedImage();
    original.writeUInt16LE(2, 152 + 68);
    original.fill(0, 0x680, 0x6a0);
    original.write(name + '\0', 0x680);
    const before = Buffer.from(original);
    const sealed = sealWindowsSystemImportSearch(original, 'electron');
    expect(original).toEqual(before);
    expect(sealed.readUInt32LE(152 + 216)).toBe(0);
    expect(sealed.readUInt32LE(152 + 220)).toBe(0);
    expect(sealed.readUInt16LE(0x74e)).toBe(0xa00);
    expect(sealed.readUInt32LE(0x524)).toBe(0x3020);
    expect(sealed.subarray(0x800)).toEqual(before.subarray(0x800));
    expect(sealWindowsSystemImportSearch(sealed, 'electron')).toEqual(sealed);
  }
  for (const name of ['evil.drv', 'evil.cpl', '..\\WINSPOOL.DRV', 'C:winspool.drv']) {
    const invalid = delayedImage();
    invalid.fill(0, 0x680, 0x6a0);
    invalid.write(name + '\0', 0x680);
    expect(() => sealWindowsSystemImportSearch(invalid, 'electron')).toThrow(
      'windows_terminal_launcher_pe_invalid',
    );
  }
  const console = delayedImage();
  console.fill(0, 0x680, 0x6a0);
  console.write('winspool.drv\0', 0x680);
  expect(() => sealWindowsSystemImportSearch(console)).toThrow(
    'windows_terminal_launcher_pe_invalid',
  );
});

test('owned Electron EXE and DLL copies seal private application plus System32 search without relaxing malformed loader guards', () => {
  for (const subsystem of [2, 3]) {
    const original = image();
    original.writeUInt16LE(subsystem, 152 + 68);
    const before = Buffer.from(original);
    const sealed = sealWindowsSystemImportSearch(original, 'electron');
    expect(original).toEqual(before);
    expect(sealed.readUInt16LE(846)).toBe(0xa00);
    expect([...sealed.keys()].filter((index) => sealed[index] !== before[index])).toEqual([
      846, 847,
    ]);
    const delay = Buffer.from(original);
    delay.writeUInt32LE(4096, 152 + 216);
    delay.writeUInt32LE(32, 152 + 220);
    expect(() => sealWindowsSystemImportSearch(delay, 'electron')).toThrow(
      'windows_terminal_launcher_pe_invalid',
    );
    const bad = Buffer.from(original);
    bad.writeUInt16LE(1, 152 + 68);
    expect(() => sealWindowsSystemImportSearch(bad, 'electron')).toThrow(
      'windows_terminal_launcher_pe_invalid',
    );
  }
  const gui = image();
  gui.writeUInt16LE(2, 152 + 68);
  expect(() => sealWindowsSystemImportSearch(gui)).toThrow('windows_terminal_launcher_pe_invalid');
});
