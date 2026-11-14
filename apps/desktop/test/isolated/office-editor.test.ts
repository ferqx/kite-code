import { expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeOfficeEditor } from '../../electron/office-editor';
import { historyFixture } from '../office-history.fixture';

test('historical reader exposes no local editing API', () => {
  for (const name of ['apply', 'compileOfficeEdit', 'decodeOfficeEditAction', 'publish'])
    expect(name in NativeOfficeEditor.prototype).toBe(false);
});

test.skipIf(process.platform === 'win32')(
  'retained versions read, export and reopen without mutations',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'kite-history-'));
    const f = historyFixture(join(root, 'history'));
    let reader = new NativeOfficeEditor({ root: join(root, 'history') });
    const input = { sourceKey: f.sourceKey, name: 'deck.pptx', check() {} };
    const before = await Promise.all(
      (await readdir(f.dir)).map(
        async (name) => [name, await readFile(join(f.dir, name))] as const,
      ),
    );
    try {
      expect(await reader.open(input)).toEqual(f.snapshots[1]!);
      const [old, current] = await Promise.all([reader.resolve(f.editorId, 0), reader.open(input)]);
      expect(old.snapshot).toEqual(f.snapshots[0]!);
      expect(current).toEqual(f.snapshots[1]!);
      const chunks: Buffer[] = [];
      for await (const chunk of old.openStream()) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(f.bytes[0]!);
      const output = join(root, 'export.pptx');
      await reader.materialize(f.editorId, 0, output, () => {});
      expect(await readFile(output)).toEqual(f.bytes[0]!);
      await reader.close();
      reader = new NativeOfficeEditor({ root: join(root, 'history') });
      expect(await reader.open(input)).toEqual(f.snapshots[1]!);
      await expect(reader.open({ ...input, sourceKey: 'missing' })).rejects.toThrow(
        'office_editor_revision_unavailable',
      );
      for (const [name, bytes] of before)
        expect(await readFile(join(f.dir, name as string))).toEqual(bytes);
      await reader.close();
      await writeFile(
        join(f.dir, '1.json'),
        JSON.stringify({ ...f.snapshots[1], sourceHash: '0'.repeat(64) }),
      );
      reader = new NativeOfficeEditor({ root: join(root, 'history') });
      await expect(reader.open(input)).rejects.toThrow('office_editor_recovery_invalid');
      await rm(join(f.dir, 'current.json'));
      await expect(reader.open(input)).rejects.toThrow('office_editor_revision_unavailable');
      expect(await readdir(f.dir)).not.toContain('current.json');
    } finally {
      await reader.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);

test.skipIf(process.platform !== 'win32')(
  'Windows reader rejects missing genuine storage without writes',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'kite-history-refusal-'));
    const reader = new NativeOfficeEditor({ root: join(root, 'missing') });
    try {
      await expect(
        reader.open({ sourceKey: 'unavailable', name: 'deck.pptx', check() {} }),
      ).rejects.toThrow('office_editor_windows_storage_unavailable');
      expect(await readdir(root)).toEqual([]);
    } finally {
      await reader.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
