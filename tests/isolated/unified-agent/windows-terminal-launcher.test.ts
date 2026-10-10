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

test('incomplete loader fields, path imports, unterminated or empty imports and delay imports remain denied', () => {
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
