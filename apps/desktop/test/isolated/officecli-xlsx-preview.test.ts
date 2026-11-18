import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { assertOfficeArchive } from '../../electron/office-preview-source';
import { xlsxPreviewRuntime } from '../../scripts/build-office-previews';

// The Desktop viewer evaluates this published UMD, not ExcelJS's Node entry.
const browser = createRequire(import.meta.url)(xlsxPreviewRuntime) as typeof ExcelJS;
const fixture = (name: string) =>
  readFile(join(import.meta.dir, '../fixtures/officecli', `${name}.xlsx`));
const buffer = (bytes: Uint8Array) => Uint8Array.from(bytes).buffer;

test.each([
  'created',
  'edited',
])('OfficeCLI 1.0.161 %s output opens in the browser reader', async (name) => {
  // Exact OfficeCLI 1.0.161 outputs of the bundled XLSX skill's Quick Start:
  // create + batch; same batch on an existing ExcelJS Sheet1 workbook.
  const bytes = buffer(await fixture(name));
  await assertOfficeArchive(bytes);
  const workbook = new browser.Workbook();
  await workbook.xlsx.load(bytes);
  const sheet = workbook.getWorksheet('Sheet1')!;
  expect(sheet.getCell('A1').value).toBe('月份');
  expect(sheet.getCell('B4').value).toEqual({ formula: 'SUM(B2:B3)', result: 87000 });
});

test('ordinary two-sheet workbook keeps values, formula caches and styles', async () => {
  const control = new browser.Workbook();
  const inputs = control.addWorksheet('Inputs');
  inputs.getCell('A1').value = 42;
  inputs.getCell('A1').numFmt = '#,##0.00';
  const summary = control.addWorksheet('Summary');
  summary.getCell('B2').value = { formula: 'Inputs!A1*2', result: 84 };
  summary.getCell('B2').font = { bold: true, color: { argb: 'FF336699' } };
  summary.mergeCells('A4:B4');
  summary.getCell('A4').value = 'merged';
  const plain = new browser.Workbook();
  await plain.xlsx.load(await control.xlsx.writeBuffer());
  expect(plain.worksheets.map((sheet) => sheet.name)).toEqual(['Inputs', 'Summary']);
  const input = plain.getWorksheet('Inputs')!.getCell('A1');
  expect(input.value).toBe(42);
  expect(input.numFmt).toBe('#,##0.00');
  const result = plain.getWorksheet('Summary')!.getCell('B2');
  expect(result.value).toEqual({ formula: 'Inputs!A1*2', result: 84 });
  expect(result.font).toMatchObject({ bold: true, color: { argb: 'FF336699' } });
  expect(plain.getWorksheet('Summary')!.getCell('B4').master.address).toBe('A4');
});

test('a rebound namespace stays foreign and the original prefix resumes in later rows', async () => {
  const zip = await JSZip.loadAsync(await fixture('created'));
  const path = 'xl/worksheets/sheet1.xml';
  const xml = (await zip.file(path)!.async('string'))
    .replaceAll('xmlns:x=', 'xmlns:sheet=')
    .replace(/<(\/?)(?:x:)/gu, '<$1sheet:')
    // Mark the extension namespace as ignorable, as Office producers do.
    .replace(
      '<sheet:worksheet ',
      '<sheet:worksheet xmlns:ext="urn:kite:test" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="ext" ',
    )
    .replace(
      '<sheet:sheetData>',
      '<ext:extra xmlns:sheet="urn:kite:test"><sheet:mergeCells count="1"><sheet:mergeCell ref="A1:B2"/></sheet:mergeCells></ext:extra><sheet:sheetData>',
    );
  expect(xml).toContain('<sheet:mergeCell ref="A1:B2"/>');
  zip.file(path, xml);
  const workbook = new browser.Workbook();
  await workbook.xlsx.load(await zip.generateAsync({ type: 'arraybuffer' }));
  const sheet = workbook.getWorksheet('Sheet1')!;
  expect(sheet.getCell('A1').value).toBe('月份');
  expect(sheet.getCell('B2').isMerged).toBe(false);
  expect(sheet.getCell('B2').value).toBe(42000);
  expect(sheet.rowCount).toBe(4);
  expect(sheet.getCell('B4').result).toBe(87000);
});
