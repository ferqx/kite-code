import { expect, test } from 'bun:test';
import {
  isManagedWorkingFilePath,
  isSessionOutputName,
  isSessionOutputPath,
} from '../../../src/tools/session-output-path';

const root = `files/${'a'.repeat(64)}/${'b'.repeat(64)}/outputs/`;

test('portable deliverable names retain Unicode and interior spaces within both budgets', () => {
  for (const name of [
    'report.md',
    '优化方案.md',
    '优化 方案.md',
    'é'.repeat(120),
    'a💡.md',
    'e\u0301.md',
  ]) {
    expect(isSessionOutputName(name)).toBe(true);
    expect(isSessionOutputPath(`${root}${name}`)).toBe(true);
    expect(isManagedWorkingFilePath(`${root}${name}`)).toBe(true);
  }
  expect(isSessionOutputPath(`${root}é.md`)).toBe(true);
  expect(isSessionOutputPath(`${root}e\u0301.md`)).toBe(true);
  expect(`${root}é.md`).not.toBe(`${root}e\u0301.md`);
  expect(isSessionOutputName('é'.repeat(121))).toBe(false);
  expect(isSessionOutputName('中'.repeat(81))).toBe(false);
  expect(isSessionOutputName('a'.repeat(121))).toBe(false);
});

test('deliverable path classification never admits another component or platform-unsafe name', () => {
  for (const name of [
    '',
    '.',
    '..',
    '../优化.md',
    'a/b.md',
    'a\\b.md',
    '.hidden',
    ' leading.md',
    'a.',
    'a ',
    'a\0.md',
    'a\n.md',
    'a\t.md',
    'a\u007f.md',
    'a\u202e.md',
    'a\ud800.md',
    'a:b.md',
    'a?.md',
    'a*.md',
    'a".md',
    'a<.md',
    'a>.md',
    'a|.md',
    'CON',
    'con.md',
    'PRN.txt',
    'AUX',
    'NUL.md',
    'COM1.md',
    'LPT9.md',
    'COM¹.md',
    'LPT².md',
  ]) {
    expect(isSessionOutputName(name)).toBe(false);
    expect(isSessionOutputPath(`${root}${name}`)).toBe(false);
  }
  expect(isSessionOutputPath(`/${root}优化.md`)).toBe(false);
  expect(isSessionOutputPath(`${root.replace('a'.repeat(64), 'g'.repeat(64))}优化.md`)).toBe(false);
  expect(
    isManagedWorkingFilePath(
      `files/${'a'.repeat(64)}/${'b'.repeat(64)}/plans/${'c'.repeat(64)}/plan.md`,
    ),
  ).toBe(true);
  expect(
    isManagedWorkingFilePath(
      `files/${'a'.repeat(64)}/${'b'.repeat(64)}/plans/${'c'.repeat(64)}/优化.md`,
    ),
  ).toBe(false);
});
