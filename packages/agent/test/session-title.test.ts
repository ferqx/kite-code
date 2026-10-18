import { expect, test } from 'bun:test';
import {
  fallbackSessionTitle,
  readableSessionTitle,
  sessionTitleInput,
  sessionTitleInstructions,
} from '../src/business/session-title/title';

test('model titles retain readable multilingual topics and remove simple presentation wrappers', () => {
  expect(readableSessionTitle(' 标题：“修复会话命名 🪁” ')).toBe('修复会话命名 🪁');
  expect(readableSessionTitle('**Title: Fix names**')).toBe('Fix names');
  expect(readableSessionTitle('# 会话历史')).toBe('会话历史');
  expect(readableSessionTitle('Title: “🪁 Fix bugs”')).toBe('🪁 Fix bugs');
  expect(readableSessionTitle(' Fix\t na\u0000mes ')).toBe('Fix names');
});

test('titles are limited by Unicode code points without splitting supplementary characters', () => {
  const title = readableSessionTitle(`会${'🪁'.repeat(80)}`)!;
  expect(Array.from(title)).toHaveLength(10);
  expect(title).toBe(`会${'🪁'.repeat(9)}`);
  expect(readableSessionTitle('Improve session naming')).toBe('Improve');
  expect(readableSessionTitle('Fix titles and history')).toBe('Fix titles');
  expect(readableSessionTitle('Refactoring')).toBeNull();
});

test('the final truncated model title must still contain a readable topic', () => {
  expect(readableSessionTitle(`${'😀'.repeat(10)}主题`)).toBeNull();
  expect(readableSessionTitle('0123456789主题')).toBeNull();
  expect(readableSessionTitle(`${'！'.repeat(10)}主题`)).toBeNull();
});

test('model titles reject explanations, structured output, code, symbols and opaque identifiers', () => {
  for (const input of [
    '',
    '---',
    '***',
    '123456',
    '123e4567-e89b-12d3-a456-426614174000',
    'deadbeefdeadbeefdeadbeef',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    '{"title":"Readable topic"}',
    '["Readable topic"]',
    '```text\nReadable topic\n```',
    'Readable topic\nHere is why I chose it.',
    'const title = "Readable topic";',
    'console.log("hello");',
    'https://example.com/sessions/abc',
    '`const x = 2`',
    'bun run test',
  ])
    expect(readableSessionTitle(input)).toBeNull();
});

test('fallback preserves non-whitespace source text and truncates at 10 Unicode code points', () => {
  const input = '🪁完整原文'.repeat(50);
  expect(fallbackSessionTitle(input)).toBe(Array.from(input).slice(0, 10).join(''));
  expect(Array.from(fallbackSessionTitle(input))).toHaveLength(10);
  expect(fallbackSessionTitle('## **会话命名**')).toBe('## **会话命名*');
  expect(fallbackSessionTitle('```ts\nconst title = "x";\n```')).toBe('```ts cons');
});

test('title input trims and collapses whitespace before applying the title limit', () => {
  expect(fallbackSessionTitle(' \r\n 修复\t\t会话\n\n命名   ')).toBe('修复 会话 命名');
  expect(fallbackSessionTitle('\u3000\u00a0修复\u2028\u2029会话\u3000\u00a0')).toBe('修复 会话');
  expect(fallbackSessionTitle('123456789  主题')).toBe('123456789');
  expect(fallbackSessionTitle(' \t\r\n\u3000\u00a0\u2028\u2029'.repeat(2000))).toBe('新会话');
  const input = `${' \r\n'.repeat(5000)}修复${'\t '.repeat(5000)}会话命名`;
  expect(sessionTitleInput(input)).toBe('修复 会话命名');
  expect(fallbackSessionTitle(input)).toBe('修复 会话命名');
});

test('the bounded naming input preserves Unicode without letting leading blank lines consume it', () => {
  const input = `${'\r\n '.repeat(5000)}${'🪁'.repeat(9000)}`;
  expect(sessionTitleInput(input)).toBe('🪁'.repeat(8192));
  expect(fallbackSessionTitle(input)).toBe('🪁'.repeat(10));
});

test('unavailable AI leaves original JSON, code and identifiers rather than inventing a topic', () => {
  for (const input of [
    '```ts\nconst title = "x";\n```',
    '{"title":"Topic"}',
    '123e4567-e89b-12d3-a456-426614174000',
    'deadbeefdeadbeefdeadbeef',
    'const x = 2;',
    'console.log("hello");',
    '---\n***',
    '123456',
    '$ ls -la',
  ])
    expect(fallbackSessionTitle(input)).toBe(
      Array.from(input.replace(/\s+/gu, ' ').trim()).slice(0, 10).join('').trimEnd(),
    );
  expect(fallbackSessionTitle('')).toBe('新会话');
});

test('generation instructions constrain the output and treat source input as untrusted', () => {
  expect(sessionTitleInstructions).toContain('same language');
  expect(sessionTitleInstructions).toContain('single line');
  expect(sessionTitleInstructions).toContain('untrusted task data');
});
