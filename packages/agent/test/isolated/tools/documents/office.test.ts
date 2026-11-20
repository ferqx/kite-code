import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bundledOfficeSkillDirectory } from '../../../../src/skills/office-source';
import { createBuiltinSkillSources } from '../../../../src/skills/registry';

const verifier = join(import.meta.dir, '../../../../src/tools/documents/kite-documents.ts');

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
    expect(loaded.body).toContain('report its actual absolute path');
  } else {
    const path = join(bundledOfficeSkillDirectory()!, key, 'SKILL.md');
    expect(loaded.body).toBe(await readFile(path, 'utf8'));
    expect(loaded.body).toContain('Kite provides the bundled `officecli` on the Shell PATH.');
    expect(loaded.body).toContain('<!-- Modified by Kite from the upstream OfficeCLI skill. -->');
    expect(loaded.body).toContain('OFFICECLI_NO_AUTO_RESIDENT');
    expect(loaded.body).toContain('stage --input');
    expect(loaded.body).toContain('absolutePath');
    expect(loaded.body).not.toMatch(/d\.officecli\.ai\/install|officecli\s+--version/u);
  }
  if (key === 'xlsx') {
    expect(loaded.body).toContain('verify-sum.ts');
    const helper = await source.readResource({
      skillId: id,
      version: loaded.version,
      path: 'verify-sum.ts',
    });
    expect(helper.body).toContain('OFFICECLI_NO_AUTO_RESIDENT');
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

test('staging reports the saved absolute path and Markdown target before collection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'document-delivery-'));
  try {
    const workspace = join(root, 'workspace');
    const staging = join(root, 'staging', 'job', 'out');
    await mkdir(workspace);
    await mkdir(staging, { recursive: true });
    const name = '新品 #1 终稿 %23 &amp;.pptx';
    const saved = join(workspace, name);
    await writeFile(saved, 'verified draft');
    const helper = join(import.meta.dir, '../../../../src/tools/documents/kite-documents.ts');
    const stage = (input: string) =>
      Bun.spawnSync([process.execPath, '--no-install', helper, 'stage', '--input', input], {
        cwd: workspace,
        env: { ...process.env, KITE_OUTPUT_DIR: staging },
      });
    const receipt = stage(name);
    expect(receipt.stderr.toString()).toBe('');
    expect(receipt.exitCode).toBe(0);
    const absolutePath = await realpath(saved);
    const directory = dirname(absolutePath);
    const parent = process.platform === 'win32' ? directory.replaceAll('\\', '/') : directory;
    expect(JSON.parse(receipt.stdout.toString())).toEqual({
      success: true,
      absolutePath,
      markdownTarget: `${parent}/新品 #1 终稿 %2523 %26amp;.pptx`,
    });
    const staged = join(staging, name);
    expect(await readFile(staged, 'utf8')).toBe('verified draft');
    for (const input of [name, staged, 'missing.pptx']) {
      const failed = stage(input);
      expect(failed.exitCode).toBe(1);
      expect(failed.stdout.toString()).toBe('');
      expect(JSON.parse(failed.stderr.toString())).toMatchObject({ success: false });
    }
    await rm(staged);
    expect(await readFile(absolutePath, 'utf8')).toBe('verified draft');
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

test('XLSX sum verification refuses unsupported operations and does not search PATH', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kite-xlsx-sum-'));
  try {
    const input = join(directory, 'working.xlsx');
    const output = join(directory, 'final.xlsx');
    const helper = join(bundledOfficeSkillDirectory()!, 'xlsx', 'verify-sum.ts');
    await writeFile(input, 'source belongs to caller');
    for (const [formula, reason] of [
      ['SUM(B2:C200)', 'xlsx_sum_check_unsupported'],
      ['SUM(B2:D2)', 'xlsx_sum_check_unsupported'],
      ['SUM(B2:C2)', 'xlsx_sum_check_cli_unavailable'],
    ]) {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          '--no-install',
          helper,
          input,
          output,
          '/Sheet1/D2',
          formula!,
          '33',
        ],
        env: { ...process.env, KITE_OFFICE_CLI: '' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr.toString())).toEqual({ success: false, error: reason });
      expect(await Bun.file(output).exists()).toBe(false);
      expect(await Bun.file(input).text()).toBe('source belongs to caller');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const formulaXml = (cellAttributes: string, formulaAttributes: string) =>
  `<m:worksheet xmlns:m="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><m:sheetData><m:row r="2"><m:c r="D2"${cellAttributes}><m:f${formulaAttributes}>SUM(B2:C2)</m:f></m:c></m:row></m:sheetData></m:worksheet>`;

test('XLSX guard proves a single plain formula in namespaced target XML', () => {
  const xml = formulaXml('', '');
  const cases: [string, boolean][] = [
    [xml, true],
    [formulaXml('', ' t="normal"'), true],
    [formulaXml('', ' t="shared" ref="D2:D3" si="0"'), false],
    [formulaXml('', ' t="array" ref="D2:D2"'), false],
    [formulaXml('', ' t="dataTable" ref="D2:D3"'), false],
    [formulaXml(' cm="1"', ''), false],
    [formulaXml(' vm="1"', ''), false],
    [xml.replace('r="D2"', 'r="D3"'), false],
    [xml.replace('SUM(B2:C2)', 'SUM(B2:C3)'), false],
    [xml.replace('/2006/main', '/2006/other'), false],
    [xml.replace('</m:row>', '<m:c r="D2"/> </m:row>'), false],
    [`<!DOCTYPE x>${xml}`, false],
    [xml.slice(0, -20), false],
  ];
  for (const [xml, accepted] of cases) {
    const result = Bun.spawnSync({
      cmd: [process.execPath, '--no-install', verifier, 'xlsx-formula-guard', '--input', '-'],
      stdin: Buffer.from(JSON.stringify({ xml, address: 'D2', formula: 'SUM(B2:C2)' })),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(accepted ? 0 : 1);
    if (accepted) expect(JSON.parse(result.stdout.toString())).toEqual({ success: true });
    else
      expect(JSON.parse(result.stderr.toString())).toEqual({
        success: false,
        error: 'xlsx_sum_check_formula_unverified',
      });
  }
});

test
  .skipIf(process.platform === 'win32')
  .each(['Sheet1', 'workbook', 'styles', 'sharedstrings', 'theme', '--help', 'Rows '])(
  'XLSX verification publishes only the reopened cached result for %s',
  async (sheet) => {
    const directory = await mkdtemp(join(tmpdir(), 'kite-xlsx-sum-success-'));
    try {
      const input = join(directory, 'working.xlsx');
      const output = join(directory, 'final.xlsx');
      const cli = join(directory, 'fixture-officecli');
      const helper = join(bundledOfficeSkillDirectory()!, 'xlsx', 'verify-sum.ts');
      const rewriteLog = join(directory, 'rewrites');
      await writeFile(input, 'uncached');
      await writeFile(
        cli,
        `#!/bin/sh
[ "$OFFICECLI_NO_AUTO_RESIDENT" = 1 ] && [ "$OFFICECLI_SKIP_UPDATE" = 1 ] || exit 10
if [ "$1" = set ]; then
  [ "$3" = "/${sheet}/D2" ] && [ "$4" = --prop ] && [ "$5" = 'formula=SUM(B2:C2)' ] || exit 11
  printf rewrite >> "$FIXTURE_REWRITE_LOG"
  printf cached > "$2"
  printf '%s' '{"success":true}'
elif [ "$1" = raw ]; then
  [ "$3" = "//${sheet}" ] && [ "$4" = --start ] && [ "$5" = 2 ] && [ "$6" = --end ] && [ "$7" = 2 ] && [ "$8" = --cols ] && [ "$9" = D ] || exit 12
  printf '%s' "$FIXTURE_FORMULA_XML"
elif [ "$3" = "/${sheet}/B2:C2" ]; then
  printf '%s' '{"success":true,"data":{"matches":1,"results":[{"path":"/${sheet}/B2:C2","children":[{"path":"/${sheet}/B2","text":"12","format":{"type":"Number"}},{"path":"/${sheet}/C2","text":"21","format":{"type":"Number"}}]}]}}'
elif [ "$3" = "/${sheet}/D2" ]; then
  if [ "$(cat "$2")" = cached ]; then cache=',"cachedValue":"33"'; else cache=; fi
  printf '%s%s%s' '{"success":true,"data":{"matches":1,"results":[{"path":"/${sheet}/D2","format":{"type":"Number","formula":"SUM(B2:C2)","computedValue":"33","evaluated":true' "$cache" '}}]}}'
else
  exit 13
fi
`,
        { mode: 0o700 },
      );
      const run = (expected: string, formulaAttributes = '') =>
        Bun.spawnSync({
          cmd: [
            process.execPath,
            '--no-install',
            helper,
            input,
            output,
            `/${sheet}/D2`,
            'SUM(B2:C2)',
            expected,
          ],
          env: {
            ...process.env,
            KITE_OFFICE_CLI: cli,
            KITE_DOCUMENTS_HELPER: verifier,
            FIXTURE_FORMULA_XML: JSON.stringify({
              success: true,
              data: formulaXml('', formulaAttributes),
            }),
            FIXTURE_REWRITE_LOG: rewriteLog,
            OFFICECLI_SKIP_UPDATE: '0',
            OFFICECLI_NO_AUTO_RESIDENT: '0',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
      expect(run('34').exitCode).toBe(1);
      expect(await Bun.file(output).exists()).toBe(false);
      const shared = run('33', ' t="shared" ref="D2:D3" si="0"');
      expect(shared.exitCode).toBe(1);
      expect(JSON.parse(shared.stderr.toString()).error).toBe('xlsx_sum_check_formula_unverified');
      expect(await Bun.file(output).exists()).toBe(false);
      expect(await Bun.file(rewriteLog).exists()).toBe(false);
      expect(await Bun.file(input).text()).toBe('uncached');
      const result = run('33');
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toMatchObject({
        success: true,
        cachedValue: '33',
      });
      expect(await Bun.file(output).text()).toBe('cached');
      expect(await Bun.file(input).text()).toBe('uncached');
      expect(run('33').exitCode).toBe(1);
      expect(await Bun.file(output).text()).toBe('cached');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
