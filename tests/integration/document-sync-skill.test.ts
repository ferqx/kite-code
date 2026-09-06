import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { parse } from 'yaml';

const source = readFileSync(
  join(import.meta.dir, '../../.agents/skills/document-before-commit/SKILL.md'),
  'utf8',
);
const metadata = parse(source.split('---')[1]!);
const ajv = new Ajv();
const validateInput = ajv.compile(metadata.input_schema);
const validateOutput = ajv.compile(metadata.output_schema);

describe('document synchronization Skill contract', () => {
  test('accepts design and iteration completion without requiring a Git action', () => {
    expect(validateInput({ action: 'design_complete' })).toBe(true);
    expect(validateInput({ action: 'iteration_complete' })).toBe(true);
    expect(validateInput({})).toBe(false);
    expect(validateInput({ action: 'silently_skip' })).toBe(false);
  });
  test('preserves existing Git actions and ready/blocked evidence output', () => {
    for (const action of ['stage', 'commit', 'push', 'pull_request'])
      expect(validateInput({ action })).toBe(true);
    expect(
      validateOutput({
        status: 'ready',
        documents_checked: ['docs/handbook/concepts.md'],
        documents_updated: [],
      }),
    ).toBe(true);
    expect(
      validateOutput({ status: 'blocked', documents_checked: [], documents_updated: [] }),
    ).toBe(true);
    expect(validateOutput({ status: 'complete' })).toBe(false);
    expect(validateOutput({ status: 'ready', documents_checked: [] })).toBe(false);
  });
});
