import { expect, test } from 'bun:test';
import {
  projectRuntimeClientCommand,
  projectRuntimeClientText,
} from '../src/runtime-client/safe-text';

test('redacts display text while retaining recognizable approval commands', () => {
  const value = 'printf authorization: Bearer secret-token\r\n';
  expect(projectRuntimeClientText(value)).toBe('printf [redacted]\r\n');
  expect(projectRuntimeClientCommand(value)).toBe(value);
});

test('both text boundaries filter controls and truncate without splitting UTF-16 pairs', () => {
  const value = 'a\u0000\t\u0085😀b';
  expect(projectRuntimeClientText(value, 4)).toBe('a\t…');
  expect(projectRuntimeClientCommand(value, 4)).toBe('a\t…');
  expect(projectRuntimeClientText(value, 5)).toBe('a\t😀b');
  expect(projectRuntimeClientCommand(value, 5)).toBe('a\t😀b');
});
