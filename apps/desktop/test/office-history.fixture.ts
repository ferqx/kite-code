import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultWindowsPathSecurity, privateDirectory } from '@kite-ai/agent/windows-path-security';
import type { OfficeEditorSnapshot } from '../src/office-editor-bridge';

// Independent synthetic OOXML fixture, not an Office editor mutation or CLI operation.
export function historyDeck(label: string) {
  const entries = {
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    'ppt/presentation.xml':
      '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst/><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
    'fixture.txt': label,
  };
  const files: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const filename = Buffer.from(name),
      data = Buffer.from(value);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30),
      record = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    files.push(local, filename, data);
    central.push(record, filename);
    offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, directory, end]);
}
export function historyFixture(root: string, sourceKey = 'retained historical source') {
  const directory = (path: string) =>
    process.platform === 'win32'
      ? privateDirectory(path)
      : mkdirSync(path, { recursive: true, mode: 0o700 });
  const write = (path: string, bytes: Uint8Array | string) => {
    const data = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
    if (process.platform === 'win32') defaultWindowsPathSecurity()!.writePrivateFile(path, data);
    else writeFileSync(path, data, { mode: 0o600, flag: 'wx' });
  };
  directory(root);
  const editorId = createHash('sha256').update(sourceKey).digest('hex');
  const dir = join(root, editorId);
  directory(dir);
  const snapshots: OfficeEditorSnapshot[] = [];
  const bytes: ReturnType<typeof historyDeck>[] = [];
  for (let revision = 0; revision < 2; revision++) {
    const content = historyDeck(`retained version ${revision}`);
    bytes.push(content);
    const snapshot = {
      editorId,
      revision,
      name: 'deck.pptx',
      slideCount: 0,
      notes: [],
      sourceHash: createHash('sha256').update(content).digest('hex'),
    };
    snapshots.push(snapshot);
    write(join(dir, `${revision}.pptx`), content);
    write(join(dir, `${revision}.json`), JSON.stringify(snapshot));
  }
  write(join(dir, 'current.json'), JSON.stringify(snapshots[1]));
  return { sourceKey, editorId, snapshots, bytes, dir };
}
