import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuiltinOfficeSkillSource } from '../../../../src/skills/office';
import { createBuiltinSkillSources } from '../../../../src/skills/registry';
import {
  createOfficeDocument,
  inspectExcelIssues,
  inspectOfficeBatch,
} from '../../../../src/tools/documents/office-command';
import {
  officePreviewFontCss,
  officePreviewRecipeVersion,
  offlineOfficeHtml,
} from '../../../../src/tools/documents/office-preview';
import {
  type OfficeProcessResult,
  type OfficeRunner,
  officeEnvironment,
} from '../../../../src/tools/documents/office-runtime';

const result = (data: unknown, code = 0, warnings?: unknown[]): OfficeProcessResult => ({
  code,
  stderr: '',
  stdout: JSON.stringify({ success: true, data, warnings }),
});
test('packaged registry retains computer use and binds office resources to its immutable version', async () => {
  const entries = createBuiltinSkillSources();
  expect(entries.map((entry) => entry.id)).toEqual(['computer-use', 'office-documents']);
  const source = createBuiltinOfficeSkillSource();
  await expect(source.load({ id: 'builtin:office-documents' })).rejects.toThrow(
    'skill_not_discovered',
  );
  const entry = (await source.list()).entries[0]!;
  expect(entry.requiredCapabilities).toEqual([]);
  const loaded = await source.load({ id: entry.id });
  expect(loaded.resources.map((resource) => resource.path)).toEqual([
    'docx.md',
    'xlsx.md',
    'pptx.md',
    'pdf.md',
  ]);
  const resource = await source.readResource({
    skillId: entry.id,
    version: entry.version,
    path: 'xlsx.md',
  });
  expect(resource.body).toContain('formula_eval_error');
  await expect(
    source.readResource({ skillId: entry.id, version: entry.version, path: '../secret' }),
  ).rejects.toThrow('skill_resource_not_declared');
  await expect(source.load({ id: entry.id, version: 'old' })).rejects.toThrow(
    'skill_version_changed',
  );
  await expect(
    source.readDocument({ id: entry.id, version: entry.version, maxTextBytes: 1 }),
  ).rejects.toThrow('skill_text_limit');
  await source.dispose();
  await expect(source.list()).rejects.toThrow('knowledge_source_closed');
});
test('office skill scopes shell portability and recovery to confirmed delivery', async () => {
  const source = createBuiltinOfficeSkillSource();
  const entry = (await source.list()).entries[0]!;
  const loaded = await source.load({ id: entry.id });
  expect(loaded.body).toContain('Use POSIX-compatible shell syntax');
  expect(loaded.body).toContain('node:crypto with the existing KITE_DOCUMENTS_BUN');
  expect(loaded.body).toContain('Inspect added and removed package parts');
  expect(loaded.body).toContain('matching content-type and relationship');
  expect(loaded.body).toContain('Do not assume Bash process substitution');
  expect(loaded.body).toContain('never hide them with || true');
  expect(loaded.body).toContain('the whole producer Shell must finish successfully');
  expect(loaded.body).toContain("After a nonzero exit, that attempt's files are not collected");
  expect(loaded.body).toContain('inspect the existing execution status before retrying');
  expect(loaded.body).toContain("not a previous Shell's temporary KITE_OUTPUT_DIR");
  expect(loaded.body).toContain("new Shell's current KITE_OUTPUT_DIR");
  expect(loaded.body).toContain('Do not repeat mutations blindly');
  expect(loaded.body).toContain('If recovery or collection cannot be confirmed');
  expect(loaded.body).toContain('no new tool is required');
  for (const resource of loaded.resources) {
    const { body } = await source.readResource({
      skillId: entry.id,
      version: entry.version,
      path: resource.path,
    });
    for (const match of body.matchAll(/```sh\n([\s\S]*?)```/g)) {
      // Parse examples without executing helpers, modifying files or using credentials.
      const parsed = Bun.spawnSync(['/bin/sh', '-n'], { stdin: Buffer.from(match[1]!) });
      expect(parsed.exitCode).toBe(0);
    }
  }
  await source.dispose();
});
test('applied LaTeX warning is accepted only with explicit successful results', () => {
  const data = { results: [{ index: 0, success: true }] };
  expect(inspectOfficeBatch(result(data, 2, [{ code: 'unrecognized_latex_command' }]), 1)).toEqual([
    'unrecognized_latex_command',
  ]);
  expect(() => inspectOfficeBatch(result(data, 2), 1)).toThrow('office_batch_exit_unexplained');
  expect(() =>
    inspectOfficeBatch(result({ results: [{ index: 0, success: false }] }, 1), 1),
  ).toThrow('office_batch_failed');
  expect(() => inspectOfficeBatch(result(data), 2)).toThrow('office_batch_failed');
  expect(() => inspectOfficeBatch({ code: 0, stdout: 'garbage', stderr: '' }, 1)).toThrow(
    'office_result_invalid',
  );
});
test('Excel inspection rejects calculation errors and keeps incomplete status explicit', () => {
  for (const subtype of ['formula_eval_error', 'formula_ref_missing_sheet'])
    expect(() => inspectExcelIssues(result({ issues: [{ subtype, severity: 0 }] }))).toThrow(
      'office_formula_invalid',
    );
  for (const subtype of ['formula_not_evaluated', 'formula_cache_stale'])
    expect(inspectExcelIssues(result({ issues: [{ subtype, severity: 1 }] }))).toEqual([
      'calculation_not_fully_verified',
    ]);
  expect(inspectExcelIssues(result({ issues: [{}] }))).toEqual(['calculation_not_fully_verified']);
  expect(inspectExcelIssues(result({ count: 0, issues: [] }))).toEqual([]);
});
test('offline recipe rewrites initial and fallback KaTeX/font URLs and removes 3D modules', () => {
  const html =
    '<html><head><script type="importmap">{"imports":{"three":"https://d.officecli.ai/assets/three-0.170.0/build/three.module.js"}}</script></head><body><script>var initial="https://d.officecli.ai/assets/katex-0.16.11/katex.min.js";var fallback="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js";var font="https://fonts.googleapis.com/css2?x"</script><script type="module">import x from "three";</script></body></html>';
  const output = offlineOfficeHtml(html);
  expect(output).toContain('position:fixed');
  expect(output).toContain('<details role="note"');
  expect(output).not.toContain('<div role="note"');
  expect(output).toContain('katex/katex.min.js');
  expect(output).not.toContain('https://cdn.jsdelivr.net');
  expect(output).not.toContain('https://fonts.googleapis.com');
  expect(output).not.toContain('importmap');
  expect(output).not.toContain('import x');
  expect(output).toContain('复杂 3D');
});
test('host fixed switches cannot start resident/update/install implicitly', () =>
  expect(officeEnvironment()).toEqual({
    OFFICECLI_NO_AUTO_RESIDENT: '1',
    OFFICECLI_SKIP_UPDATE: '1',
    OFFICECLI_NO_AUTO_INSTALL: '1',
  }));
test('helper never publishes failed batch, never overwrites existing output, keeps source immutable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-helper-test-'));
  try {
    const source = join(root, 'source.docx'),
      out = join(root, 'out.docx');
    await writeFile(source, 'original');
    let fail = true;
    const run: OfficeRunner = async (args) => {
      if (args[0] === 'batch') {
        await writeFile(args[1]!, 'modified');
        return result({ results: [{ index: 0, success: !fail }] }, fail ? 1 : 0);
      }
      return result({ count: 0, errors: [] });
    };
    const input = { source, out, operations: [{ command: 'set', path: '/body' }], run };
    await expect(createOfficeDocument(input)).rejects.toThrow('office_batch_failed');
    await expect(readFile(out)).rejects.toThrow();
    expect(await readFile(source, 'utf8')).toBe('original');
    fail = false;
    expect(await createOfficeDocument(input)).toMatchObject({ success: true, operations: 1 });
    expect(await readFile(out, 'utf8')).toBe('modified');
    await expect(createOfficeDocument(input)).rejects.toThrow();
    expect(await readFile(source, 'utf8')).toBe('original');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

for (const code of [
  'office_process_cleanup_unconfirmed',
  'office_process_scope_changed',
  'office_process_output_incomplete',
  'windows_path_security_denied',
  'windows_path_security_unavailable',
  'optional_issues_unavailable',
]) {
  test(`Excel optional issues preserves infrastructure failure: ${code}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'office-issues-failure-'));
    const source = join(root, 'source.xlsx'),
      out = join(root, 'out.xlsx');
    try {
      await writeFile(source, 'original');
      const run: OfficeRunner = async (args) => {
        if (args[0] === 'batch') {
          await writeFile(args[1]!, 'modified');
          return result({ results: [{ index: 0, success: true }] });
        }
        if (args[0] === 'view') throw Error(code);
        return result({ count: 0, errors: [] });
      };
      const operation = createOfficeDocument({
        source,
        out,
        operations: [{ command: 'set', path: '/Sheet1/A1' }],
        run,
      });
      if (code === 'optional_issues_unavailable') {
        expect(await operation).toMatchObject({
          success: true,
          warnings: ['calculation_not_fully_verified'],
        });
        expect(await readFile(out, 'utf8')).toBe('modified');
      } else {
        await expect(operation).rejects.toThrow(code);
        await expect(readFile(out)).rejects.toThrow();
      }
      expect(await readFile(source, 'utf8')).toBe('original');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('offline preview preserves author fonts and separates old forced-font cache entries', () => {
  const html =
    '<html><head><style>.author{font-family:Calibri,serif}</style></head><body><p class="author" style="font-family:Arial;font-size:14pt">Author text</p></body></html>';
  const output = offlineOfficeHtml(html);
  expect(output).toContain('.author{font-family:Calibri,serif}');
  expect(output).toContain('style="font-family:Arial;font-size:14pt"');
  expect(output).toContain('href="font.css"');
  expect(officePreviewFontCss).toBe(
    '@font-face{font-family:KiteDocument;src:url("font.ttf") format("truetype");font-display:swap}',
  );
  expect(officePreviewFontCss).not.toContain('body');
  expect(officePreviewFontCss).not.toContain('!important');
  expect(officePreviewFontCss).not.toContain('https:');
  expect(officePreviewRecipeVersion).not.toBe('offline-1');
  expect(officePreviewRecipeVersion).toBe('offline-interactive-word');
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
