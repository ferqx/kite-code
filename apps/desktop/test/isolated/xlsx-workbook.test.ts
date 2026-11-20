import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { deflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { assertOfficeArchive, assertOfficeDeflate } from '../../electron/office-preview-source';
import { cellDisplay, makeRange } from '../../electron/xlsx-workbook';
import { xlsxPreviewRuntime } from '../../scripts/build-office-previews';

test('an XLSX preserves formatted values, formulas and original selection identity', async () => {
  const input = new ExcelJS.Workbook();
  const sheet = input.addWorksheet('预算');
  sheet.getCell('B2').value = 1200;
  sheet.getCell('B2').numFmt = '#,##0';
  sheet.getCell('C2').value = { formula: 'B2-1200', result: 0 };
  sheet.getCell('B3').value = { formula: 'B2+3' };
  sheet.getCell('C3').value = 7;
  sheet.getCell('F2').value = { formula: '1=2', result: false };
  sheet.getCell('F3').value = { formula: '1=1', result: true };
  sheet.mergeCells('D5:E5');
  const bytes = Uint8Array.from(new Uint8Array(await input.xlsx.writeBuffer())).buffer;
  await assertOfficeArchive(bytes);
  const read = new ExcelJS.Workbook();
  await read.xlsx.load(bytes);
  const original = read.getWorksheet('预算')!;
  const result = makeRange(original, { row: 2, col: 2 }, { row: 1, col: 1 }, false);
  if (!('selection' in result)) throw Error(result.error);
  expect(result.activeAddress).toBe('C3');
  expect(result.selection).toEqual({
    kind: 'excel',
    sheet: '预算',
    range: 'B2:C3',
    cells: [
      { path: '/预算/B2', address: 'B2', value: '1,200' },
      { path: '/预算/C2', address: 'C2', value: '0', formula: '=B2-1200' },
      { path: '/预算/B3', address: 'B3', value: '', formula: '=B2+3' },
      { path: '/预算/C3', address: 'C3', value: '7' },
    ],
  });
  expect(cellDisplay(original.getCell('B3'), false)).toEqual({
    value: '',
    formula: '=B2+3',
    resultUnavailable: true,
  });
  expect(cellDisplay(original.getCell('F2'), false)).toEqual({ value: 'FALSE', formula: '=1=2' });
  expect(cellDisplay(original.getCell('F3'), false)).toEqual({ value: 'TRUE', formula: '=1=1' });
  const booleans = makeRange(original, { row: 1, col: 5 }, { row: 2, col: 5 }, false);
  expect(booleans.selection?.cells.map(({ value }) => value)).toEqual(['FALSE', 'TRUE']);
  expect(makeRange(original, { row: 4, col: 3 }, { row: 4, col: 4 }, false)).toEqual({
    error: '此区域不可用，请重新选择',
  });
  expect(makeRange(original, { row: 0, col: 0 }, { row: 16, col: 16 }, false)).toEqual({
    error: '最多选择 256 个单元格',
  });
  await expect(assertOfficeArchive(new ArrayBuffer(32))).rejects.toThrow(
    'preview_office_archive_invalid',
  );
});

test('packaged XLSX reader distinguishes a missing formula cache from saved zero, false, blank and error', async () => {
  const fixture = new ExcelJS.Workbook();
  const sheet = fixture.addWorksheet('Results');
  sheet.getCell('A1').value = { formula: 'SUM(B1:C1)', result: 33 };
  sheet.getCell('A2').value = { formula: '1-1', result: 0 };
  sheet.getCell('A3').value = { formula: '1=2', result: false };
  sheet.getCell('A4').value = { formula: 'IF(1,"","x")', result: '' };
  sheet.getCell('A5').value = { formula: '1/0', result: { error: '#DIV/0!' } };
  sheet.getCell('A6').value = { formula: 'XLOOKUP(C1,B1:B2,D1:D2)' };
  sheet.getCell('A7').value = { formula: 'SUM(B1:C1)' };
  const archive = await JSZip.loadAsync(await fixture.xlsx.writeBuffer());
  const path = 'xl/worksheets/sheet1.xml';
  const xml = await archive.file(path)!.async('string');
  expect(xml).toMatch(/<c r="A4" t="str"><f>[^<]+<\/f><v><\/v>/);
  archive.file(path, xml.replace(/(<c r="A6"><f>[^<]+<\/f>)(<\/c>)/, '$1<v/>$2'));
  const bytes = await archive.generateAsync({ type: 'arraybuffer' });
  const { Workbook } = createRequire(import.meta.url)(xlsxPreviewRuntime) as typeof ExcelJS;
  const workbook = new Workbook();
  await workbook.xlsx.load(bytes);
  const saved = workbook.getWorksheet('Results')!;
  const show = (row: number) => cellDisplay(saved.getCell(row, 1), false);
  expect(show(1)).toEqual({ value: '33', formula: '=SUM(B1:C1)' });
  expect(show(2)).toEqual({ value: '0', formula: '=1-1' });
  expect(show(3)).toEqual({ value: 'FALSE', formula: '=1=2' });
  expect(show(4)).toEqual({ value: '', formula: '=IF(1,"","x")' });
  expect(show(5)).toEqual({ value: '#DIV/0!', formula: '=1/0' });
  expect(show(6)).toEqual({
    value: '',
    formula: '=XLOOKUP(C1,B1:B2,D1:D2)',
    resultUnavailable: true,
  });
  expect(show(7)).toEqual({ value: '', formula: '=SUM(B1:C1)', resultUnavailable: true });
  expect(makeRange(saved, { row: 5, col: 0 }, { row: 5, col: 0 }, false).selection?.cells).toEqual([
    {
      path: '/Results/A6',
      address: 'A6',
      value: '',
      formula: '=XLOOKUP(C1,B1:B2,D1:D2)',
    },
  ]);
});

test('OOXML deflate verification stops when streamed data exceeds its allowance', async () => {
  const content = new TextEncoder().encode('Quarterly workbook data.\n'.repeat(128));
  const compressed = Uint8Array.from(deflateRawSync(content));
  await assertOfficeDeflate(compressed, content.length);
  await expect(assertOfficeDeflate(compressed, 16)).rejects.toThrow(
    'preview_office_archive_invalid',
  );
});
