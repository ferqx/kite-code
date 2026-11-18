import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledOfficeSkillDirectory } from '../../../../src/skills/office-source';
import { createBuiltinSkillSources } from '../../../../src/skills/registry';

const officeSkills = [
  ['docx', 'docx'],
  ['pdf', 'pdf'],
  ['pptx', 'pptx'],
  ['xlsx', 'xlsx'],
] as const;

test('packaged registry lists the OfficeCLI and PDF skills alongside computer use', () => {
  expect(createBuiltinSkillSources().map(({ id }) => id)).toEqual([
    'computer-use',
    ...officeSkills.map(([key]) => `office.${key}`),
  ]);
});

test.each(officeSkills)('packaged %s skill loads its pinned document', async (key, name) => {
  const { source } = createBuiltinSkillSources().find((entry) => entry.id === `office.${key}`)!;
  const id = `builtin:office.${key}`;
  await expect(source.load({ id })).rejects.toThrow('skill_not_discovered');

  const [entry] = (await source.list()).entries;
  expect(entry).toMatchObject({ id, name, requiredCapabilities: [] });
  const loaded = await source.load({ id, version: entry!.version });
  if (key === 'pdf') {
    expect(loaded.body).toContain('KITE_OFFICE_SKILLS_DIR');
    expect(loaded.body).toContain('KITE_OUTPUT_DIR');
  } else {
    const path = join(bundledOfficeSkillDirectory()!, key, 'SKILL.md');
    expect(loaded.body).toBe(await readFile(path, 'utf8'));
    expect(loaded.body).toContain('Kite provides the bundled `officecli` on the Shell PATH.');
    expect(loaded.body).toContain('<!-- Modified by Kite from the upstream OfficeCLI skill. -->');
    expect(loaded.body).toContain('OFFICECLI_NO_AUTO_RESIDENT');
    expect(loaded.body).toContain('KITE_OUTPUT_DIR');
    expect(loaded.body).not.toMatch(/d\.officecli\.ai\/install|officecli\s+--version/u);
  }
  expect(
    await source.readDocument({ id, version: loaded.version, maxTextBytes: 1048576 }),
  ).toMatchObject({ body: loaded.body, version: loaded.version });
  await expect(
    source.readResource({ skillId: id, version: loaded.version, path: '../LICENSE.txt' }),
  ).rejects.toThrow('skill_resource_not_declared');
  await expect(source.load({ id, version: 'old' })).rejects.toThrow('skill_version_changed');
  await expect(
    source.readDocument({ id, version: loaded.version, maxTextBytes: 1 }),
  ).rejects.toThrow('skill_text_limit');
  await source.dispose();
  await expect(source.list()).rejects.toThrow('knowledge_source_closed');
});

test.each([
  ['pdf', 'FORMS.md', 'form'],
  ['pdf', 'LICENSE.txt', 'Apache License'],
] as const)('packaged %s exposes declared text resource %s', async (key, path, sample) => {
  const { source } = createBuiltinSkillSources().find((entry) => entry.id === `office.${key}`)!;
  const { id, version } = (await source.list()).entries[0]!;
  const loaded = await source.load({ id, version });
  const resource = await source.readResource({ skillId: id, version, path });
  expect(loaded.resources).toContainEqual({ id: resource.id, path });
  expect(resource.body).toContain(sample);
  await source.dispose();
});

test('stable exporter bounds bytes, denies links and leaves no partial output on cancellation', async () => {
  const { exportDocument, readBoundedDocument } = await import(
    '../../../../src/tools/documents/document-export'
  );
  const { readdir, symlink } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'document-export-test-'));
  try {
    const source = join(root, 'source.bin'),
      out = join(root, 'out.bin');
    await writeFile(source, '12345');
    await expect(readBoundedDocument(source, 4)).rejects.toThrow('document_source_invalid');
    expect((await readBoundedDocument(source, 5)).toString()).toBe('12345');
    const signal = AbortSignal.abort(Error('cancelled'));
    await expect(exportDocument(source, out, signal)).rejects.toThrow('cancelled');
    expect((await readdir(root)).sort()).toEqual(['source.bin']);
    if (process.platform !== 'win32') {
      const linked = join(root, 'linked.bin');
      await symlink(source, linked);
      await expect(readBoundedDocument(linked)).rejects.toThrow();
    }
    await exportDocument(source, out);
    expect(await readFile(out, 'utf8')).toBe('12345');
    expect((await readdir(root)).some((name) => name.startsWith('.kite-export-'))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publication uses a private destination sibling and concurrent exports never overwrite', async () => {
  const { exportDocument } = await import('../../../../src/tools/documents/document-export');
  const { mkdir, readdir, symlink } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'document-publication-'));
  try {
    const source = join(root, 'source.bin'),
      destination = join(root, 'workspace');
    await mkdir(destination);
    await writeFile(source, 'stable original');
    const out = join(destination, 'result.bin');
    const controller = new AbortController();
    let checks = 0;
    const checkAbort = controller.signal.throwIfAborted.bind(controller.signal);
    controller.signal.throwIfAborted = () => {
      if (++checks === 2) controller.abort(Error('cancelled during publication'));
      checkAbort();
    };
    await expect(exportDocument(source, out, controller.signal)).rejects.toThrow(
      'cancelled during publication',
    );
    expect(await readdir(destination)).toEqual([]);
    const attempts = await Promise.allSettled([
      exportDocument(source, out),
      exportDocument(source, out),
    ]);
    expect(attempts.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((v) => v.status === 'rejected')).toHaveLength(1);
    expect(await readFile(out, 'utf8')).toBe('stable original');
    expect(await readdir(destination)).toEqual(['result.bin']);
    await writeFile(source, 'different bytes');
    await expect(exportDocument(source, out)).rejects.toThrow();
    expect(await readFile(out, 'utf8')).toBe('stable original');
    await expect(exportDocument(source, join(root, 'missing', 'result.bin'))).rejects.toThrow();
    if (process.platform !== 'win32') {
      await symlink(source, join(destination, 'linked.bin'));
      await expect(exportDocument(source, join(destination, 'linked.bin'))).rejects.toThrow();
      expect(await readFile(source, 'utf8')).toBe('different bytes');
    }
    expect((await readdir(destination)).some((name) => name.startsWith('.kite-export-'))).toBe(
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
