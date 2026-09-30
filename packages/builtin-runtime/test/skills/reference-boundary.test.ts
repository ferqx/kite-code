import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSkillReference } from '../../src/skills/lifecycle';
import { compileSkillWorkflow } from '../../src/skills/workflow';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(content: string | Buffer = 'declared content', rootAlias = false) {
  const root = mkdtempSync(join(tmpdir(), 'kite-skill-reference-boundary-'));
  roots.push(root);
  const skillDir = join(root, 'skill');
  const references = join(skillDir, 'references');
  const outside = join(root, 'outside');
  mkdirSync(references, { recursive: true });
  mkdirSync(outside);
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---
name: reference-boundary
version: 1.0.0
description: Read declared references.
invocation:
  allow_implicit: false
  allow_manual: true
context:
  mode: inline
  agent: code
input_schema:
  type: object
output_schema:
  type: object
capabilities:
  require: []
  deny: []
effects:
  filesystem: read
  network: none
  external_state: none
approval:
  minimum: none
execution:
  timeout_ms: 300000
  max_attempts: 1
verification:
  mode: best_effort
recovery:
  retry: never
---
Read the declared reference.
`,
  );
  writeFileSync(join(references, 'note.txt'), content);
  writeFileSync(join(outside, 'note.txt'), 'outside fixture');
  const sourcePath = rootAlias ? join(root, 'alias') : skillDir;
  if (rootAlias) symlinkSync(skillDir, sourcePath, 'dir');
  const entry = compileSkillWorkflow({
    skillDir: sourcePath,
    source: 'project',
    origin: '.kite-code',
  });
  expect(entry.diagnostics).toEqual([]);
  expect(entry.descriptor.availability).toBe('available');
  const runtime = {
    verificationEnabled: false,
    catalog: {
      revision: 'catalog',
      capabilities: { revision: 'catalog', descriptors: [entry.descriptor] },
      entries: [entry],
    },
    state: {
      activeTaskId: 'task',
      session: { workspace: root },
      skills: {
        catalogRevision: 'catalog',
        frames: {
          activation: {
            activationId: 'activation',
            skillId: entry.descriptor.capabilityId,
            skillRevision: entry.descriptor.revision,
            taskId: 'task',
            input: {},
            contextMode: 'inline' as const,
            agent: 'code',
            capabilityCeiling: [],
            verificationMode: 'not_required' as const,
            requestedBy: 'model' as const,
            activatedAt: '2026-09-30T00:00:00.000Z',
            status: 'active' as const,
          },
        },
      },
    },
  };
  return { runtime, entry, sourcePath, skillDir, references, outside };
}

const input = { activation_id: 'activation', path: 'references/note.txt' };

describe('Skill reference execution file boundary', () => {
  test('permits a compiled root alias that still resolves to its original directory', () => {
    const { runtime, entry } = fixture('root alias content', true);
    expect(entry.sourceBinding).toBeDefined();
    expect(JSON.parse(readSkillReference(runtime, input).stdout)).toMatchObject({
      content: 'root alias content',
    });
  });

  test('rejects a root alias repointed after compilation and changes its revision on recompilation', () => {
    const { runtime, entry, sourcePath, skillDir, outside } = fixture('same bytes', true);
    // Copy an identical workflow so only the root binding changes the revision.
    writeFileSync(join(outside, 'SKILL.md'), readFileSync(join(skillDir, 'SKILL.md')));
    mkdirSync(join(outside, 'references'));
    writeFileSync(join(outside, 'references', 'note.txt'), 'same bytes');
    rmSync(sourcePath);
    symlinkSync(outside, sourcePath, 'dir');
    const result = readSkillReference(runtime, input);
    expect(result.ok).toBe(false);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('source binding changed');
    const refreshed = compileSkillWorkflow({
      skillDir: sourcePath,
      source: 'project',
      origin: '.kite-code',
    });
    expect(refreshed.descriptor.availability).toBe('available');
    expect(refreshed.descriptor.revision).not.toBe(entry.descriptor.revision);
  });

  test('supports ordinary legacy fixtures but rejects root aliases without compilation evidence', () => {
    const ordinary = fixture();
    delete ordinary.entry.sourceBinding;
    expect(readSkillReference(ordinary.runtime, input).ok).toBe(true);
    const aliased = fixture('alias', true);
    delete aliased.entry.sourceBinding;
    const result = readSkillReference(aliased.runtime, input);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('requires a compiled source binding');
  });

  test('rejects a parent directory replaced by a symlink after the catalog snapshot', () => {
    const { runtime, references, outside } = fixture();
    rmSync(references, { recursive: true });
    symlinkSync(outside, references, 'dir');
    const result = readSkillReference(runtime, input);
    expect(result.ok).toBe(false);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('non-symlink directories');
  });

  test('rejects a leaf replaced by a symlink after the catalog snapshot', () => {
    const { runtime, references, outside } = fixture();
    rmSync(join(references, 'note.txt'));
    symlinkSync(join(outside, 'note.txt'), join(references, 'note.txt'));
    const result = readSkillReference(runtime, input);
    expect(result.ok).toBe(false);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('regular non-symlink file');
  });

  test('keeps complete UTF-8 and binary references in ordinary directories', () => {
    const text = '完整引用\n'.repeat(20_000);
    const utf8 = fixture(text);
    expect(JSON.parse(readSkillReference(utf8.runtime, input).stdout)).toMatchObject({
      encoding: 'utf8',
      content: text,
    });
    const bytes = Buffer.from([0xff, 0x00, 0x80]);
    const binary = fixture(bytes);
    expect(JSON.parse(readSkillReference(binary.runtime, input).stdout)).toMatchObject({
      encoding: 'base64',
      content: bytes.toString('base64'),
    });
  });
});
