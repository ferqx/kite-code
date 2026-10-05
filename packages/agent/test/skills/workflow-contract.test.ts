import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '../../src/json';
import {
  compileSkillWorkflow,
  readWorkflowReference,
  revalidateSkillWorkflow,
  validateWorkflowArguments,
  type WorkflowCapability,
} from '../../src/skills/workflow-contract';
import type { Json } from '../../src/storage/types';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kite-workflow-contract-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const manifest = () => ({
  name: 'publish-docs',
  version: '1.2.3',
  description: 'Publish documentation.',
  invocation: { allow_implicit: false, allow_manual: true },
  context: { mode: 'fork', agent: 'code' },
  input_schema: {
    type: 'object',
    properties: { version: { type: 'string' } },
    required: ['version'],
  },
  output_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  capabilities: { require: ['builtin:read_file'], deny: [] as string[] },
  effects: { filesystem: 'read', network: 'write', external_state: 'write' },
  approval: { minimum: 'user' },
  execution: { timeout_ms: 300000, max_attempts: 1 },
  verification: { mode: 'best_effort' },
  recovery: { retry: 'never' },
});
function write(
  value: unknown = manifest(),
  body = 'Follow the governed workflow.',
  directory = join(root, 'skill'),
) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---\n${JSON.stringify(value, null, 2)}\n---\n${body}\n`,
  );
  return directory;
}
const dependency = (revision = 'revision-1'): WorkflowCapability => ({
  capabilityId: 'builtin:read_file',
  revision,
  availability: 'available',
  effectiveEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
  policy: { minimumApproval: 'none' },
});
const compile = (skillDir: string, resolveCapability?: () => WorkflowCapability | undefined) =>
  compileSkillWorkflow({
    skillDir,
    source: 'project',
    origin: '.kite-code',
    ...(resolveCapability ? { resolveCapability } : {}),
  });
test('unavailable Workflow descriptors remain valid persisted JSON beside an available contract', () => {
  const entries = [
    compile(write(manifest(), 'valid workflow', join(root, 'valid')), () => dependency()),
    compile(
      write(
        { name: 'knowledge', description: 'ordinary guidance' },
        'knowledge',
        join(root, 'knowledge'),
      ),
    ),
    compile(
      write(
        { ...manifest(), input_schema: { type: 'array' } },
        'invalid contract',
        join(root, 'invalid'),
      ),
    ),
    compile(join(root, 'missing')),
  ];
  expect(JSON.parse(canonicalJson(entries as unknown as Json))).toEqual(entries);
  const descriptors = entries.map((entry) => entry.descriptor);
  expect(JSON.parse(canonicalJson(descriptors as unknown as Json))).toEqual(descriptors);
  expect(descriptors[0]!.provider.version).toBe('1.2.3');
  for (const entry of entries.slice(1)) {
    expect(entry.contract).toBeUndefined();
    expect(entry.descriptor.availability).toBe('unavailable');
    expect(Object.hasOwn(entry.descriptor.provider, 'version')).toBe(false);
  }
});
test('object-root async schemas cannot turn a validation Promise into successful output', () => {
  const asyncSchema = { type: 'object', $async: true };
  expect(validateWorkflowArguments(asyncSchema, {})).not.toBeNull();
  expect(
    compile(write({ ...manifest(), output_schema: asyncSchema })).descriptor.availability,
  ).toBe('unavailable');
});
test('independent Workflow schemas may reuse an id but cannot resolve another Skill schema registry', () => {
  const schema = {
    $id: 'urn:kite:workflow:isolated-schema',
    type: 'object',
    properties: { ok: { const: true } },
    required: ['ok'],
  };
  expect(validateWorkflowArguments(structuredClone(schema), { ok: true })).toBeNull();
  expect(validateWorkflowArguments(structuredClone(schema), { ok: true })).toBeNull();
  expect(
    validateWorkflowArguments({ type: 'object', $ref: schema.$id }, { ok: true }),
  ).not.toBeNull();
});
test('neutral strict compiler preserves full contract, conservative dependencies and frozen source-bound output', () => {
  const dir = write();
  const read = () => dependency();
  const entry = compile(dir, read);
  expect(entry.diagnostics).toEqual([]);
  expect(entry.contract?.context).toEqual({ mode: 'fork', agent: 'code' });
  expect(entry.contract?.invocation).toEqual({ allowImplicit: false, allowManual: true });
  expect(entry.contract?.dependencyRevisions).toEqual({ 'builtin:read_file': 'revision-1' });
  expect(entry.descriptor).toMatchObject({
    capabilityId: 'skill:publish-docs',
    kind: 'skill',
    availability: 'available',
    policy: { workspaceTrustRequired: true, minimumApproval: 'user' },
  });
  expect(Object.isFrozen(entry)).toBe(true);
  expect(Object.isFrozen(entry.contract?.inputSchema)).toBe(true);
  expect(revalidateSkillWorkflow(entry, read).descriptor.revision).toBe(entry.descriptor.revision);
  const strong = compile(dir, () => ({
    ...dependency(),
    effectiveEffects: { filesystem: 'destructive', network: 'unknown', externalState: 'none' },
    policy: { minimumApproval: 'user' },
  }));
  expect(strong.contract?.effectiveEffects).toEqual({
    filesystem: 'destructive',
    network: 'unknown',
    externalState: 'write',
  });
  expect(strong.contract?.effectiveMinimumApproval).toBe('user');
  const user = compileSkillWorkflow({ skillDir: dir, source: 'user', origin: '.agents' });
  expect(user.descriptor.policy.workspaceTrustRequired).toBe(false);
});
test('manifest/schema gates remain explicit diagnostics, including invocation risk and ignored executable directories', () => {
  const cases: [unknown, string][] = [
    [{ ...manifest(), unsafe_extra: true }, 'unknown_field'],
    [{ ...manifest(), invocation: { allow_implicit: true, allow_manual: true } }, 'invalid_field'],
    [{ ...manifest(), input_schema: { type: 'array' } }, 'invalid_schema'],
    [
      { ...manifest(), output_schema: { type: 'object', invented_keyword: true } },
      'invalid_schema',
    ],
    [
      {
        ...manifest(),
        verification: { mode: 'required', strategy: 'script', entrypoint: '../outside.sh' },
      },
      'invalid_path',
    ],
    [
      {
        ...manifest(),
        verification: {
          mode: 'best_effort',
          strategy: 'script',
          entrypoint: 'node_modules/check.sh',
        },
      },
      'invalid_path',
    ],
    [{ ...manifest(), context: { mode: 'inline', agent: 'code', extra: 1 } }, 'unknown_field'],
    [
      {
        ...manifest(),
        capabilities: { require: ['builtin:read_file'], deny: ['builtin:write_file'] },
      },
      'invalid_field',
    ],
  ];
  for (const [value, code] of cases) {
    const entry = compile(write(value));
    expect(entry.descriptor.availability).toBe('unavailable');
    expect(entry.diagnostics.some((d) => d.code === code)).toBe(true);
  }
  writeFileSync(join(root, 'skill/SKILL.md'), '---\nname: a\nname: b\n---\nbody');
  expect(compile(join(root, 'skill')).diagnostics.some((d) => d.code === 'yaml_parse_error')).toBe(
    true,
  );
  writeFileSync(join(root, 'skill/SKILL.md'), '---\n[one, two]\n---\nbody');
  expect(
    compile(join(root, 'skill')).diagnostics.some((d) => d.code === 'manifest_not_object'),
  ).toBe(true);
  const absent = compile(join(root, 'missing'));
  expect(absent.descriptor.availability).toBe('unavailable');
  expect(absent.diagnostics.some((d) => d.code === 'missing_skill_file')).toBe(true);
});
test('missing and denied capabilities preserve exact ceiling and dependency/source revision drift refuses revalidation', () => {
  const dir = write();
  const missing = compile(dir, () => undefined);
  expect(missing.diagnostics.some((d) => d.code === 'missing_capability')).toBe(true);
  const deniedManifest = manifest();
  deniedManifest.capabilities.deny = ['builtin:read_file'];
  let resolverCalls = 0;
  const denied = compile(write(deniedManifest), () => {
    resolverCalls++;
    return undefined;
  });
  expect(denied.descriptor.availability).toBe('available');
  expect(denied.contract?.effectiveCapabilityCeiling).toEqual([]);
  expect(resolverCalls).toBe(0);
  write();
  const original = compile(dir, () => dependency());
  const changed = revalidateSkillWorkflow(original, () => dependency('revision-2'));
  expect(changed.descriptor.availability).toBe('unavailable');
  expect(changed.diagnostics.some((d) => d.code === 'dependency_changed')).toBe(true);
  write(manifest(), 'Changed instructions.');
  const sourceChanged = revalidateSkillWorkflow(original, () => dependency());
  expect(sourceChanged.descriptor.availability).toBe('unavailable');
  expect(sourceChanged.descriptor.revision).not.toBe(original.descriptor.revision);
});
test('full strict Ajv object schemas support refs, conditionals, dependencies, oneOf and pattern properties without mutating inputs', () => {
  const schema = {
    type: 'object',
    definitions: { tag: { type: 'string', pattern: '^[a-z]+$' } },
    properties: {
      kind: { type: 'string', enum: ['text', 'number'] },
      value: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      tag: { $ref: '#/definitions/tag' },
      count: { type: 'integer', minimum: 1, default: 5 },
      enabled: { type: 'boolean' },
    },
    patternProperties: { '^x-': { type: 'string' } },
    required: ['kind', 'value'],
    dependencies: { enabled: ['tag'] },
    additionalProperties: false,
    allOf: [
      {
        if: { properties: { kind: { const: 'text' } }, required: ['kind'] },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema Draft-07 conditional keyword.
        then: { properties: { value: { type: 'string', minLength: 2 } } },
        else: { properties: { value: { type: 'integer', minimum: 2 } } },
      },
    ],
  };
  const input = { kind: 'text', value: 'ok', 'x-label': 'raw' };
  expect(validateWorkflowArguments(schema, input)).toBeNull();
  expect(input).toEqual({ kind: 'text', value: 'ok', 'x-label': 'raw' });
  for (const invalid of [
    { kind: 'text', value: 3 },
    { kind: 'number', value: 1 },
    { kind: 'number', value: '3' },
    { kind: 'text', value: 'ok', tag: 'INVALID' },
    { kind: 'text', value: 'ok', enabled: true },
    { kind: 'text', value: 'ok', 'x-label': 4 },
    { kind: 'text', value: 'ok', unknown: true },
    [],
    null,
  ])
    expect(validateWorkflowArguments(schema, invalid)).not.toBeNull();
  expect(validateWorkflowArguments({ type: 'object', additionalProperties: false }, {})).toBeNull();
  expect(validateWorkflowArguments({ type: 'object', unsupported: 1 }, {})).toContain(
    'Unsupported',
  );
});
test('reference reads are source/revision-bound data, include large/binary files and reject undeclared paths or changed bytes', () => {
  const dir = write();
  mkdirSync(join(dir, 'references'));
  mkdirSync(join(dir, 'assets'));
  mkdirSync(join(dir, 'scripts'));
  const text = 'large reference\n'.repeat(10000);
  writeFileSync(join(dir, 'references/large.md'), text);
  writeFileSync(join(dir, 'assets/raw.bin'), Buffer.from([0, 255, 1]));
  writeFileSync(join(dir, 'scripts/action.sh'), 'echo MUST_NOT_EXECUTE');
  const entry = compile(dir);
  expect(readWorkflowReference(entry, 'references/large.md')).toMatchObject({
    encoding: 'utf8',
    content: text,
  });
  expect(readWorkflowReference(entry, 'assets/raw.bin')).toMatchObject({
    encoding: 'base64',
    content: Buffer.from([0, 255, 1]).toString('base64'),
  });
  expect(readWorkflowReference(entry, 'scripts/action.sh').content).toBe('echo MUST_NOT_EXECUTE');
  expect(() => readWorkflowReference(entry, '../outside')).toThrow('skill_reference_not_declared');
  expect(() => readWorkflowReference(entry, 'SKILL.md')).toThrow('skill_reference_not_declared');
  expect(() => readWorkflowReference(entry, 'references/missing')).toThrow(
    'skill_reference_not_declared',
  );
  writeFileSync(join(dir, 'references/large.md'), 'changed');
  expect(() => readWorkflowReference(entry, 'references/large.md')).toThrow(
    'skill_workflow_changed',
  );
});
test('root aliases bind their exact canonical identity and resource symlinks or root replacement cannot inherit authority', () => {
  const dir = write();
  mkdirSync(join(dir, 'references'));
  writeFileSync(join(dir, 'references/read.md'), 'original');
  const alias = join(root, 'alias');
  symlinkSync(dir, alias);
  const entry = compile(alias);
  expect(entry.descriptor.availability).toBe('available');
  expect(readWorkflowReference(entry, 'references/read.md').content).toBe('original');
  const elsewhere = write(manifest(), 'Other body.', join(root, 'other'));
  mkdirSync(join(elsewhere, 'references'));
  writeFileSync(join(elsewhere, 'references/read.md'), 'external');
  rmSync(alias);
  symlinkSync(elsewhere, alias);
  expect(() => readWorkflowReference(entry, 'references/read.md')).toThrow(
    'skill_workflow_changed',
  );
  const direct = compile(dir);
  renameSync(dir, `${dir}-retained`);
  write(manifest(), 'Follow the governed workflow.', dir);
  mkdirSync(join(dir, 'references'));
  writeFileSync(join(dir, 'references/read.md'), 'original');
  expect(() => readWorkflowReference(direct, 'references/read.md')).toThrow(
    'skill_workflow_changed',
  );
  const fresh = compile(dir);
  rmSync(join(dir, 'references/read.md'));
  symlinkSync(join(elsewhere, 'references/read.md'), join(dir, 'references/read.md'));
  expect(compile(dir).diagnostics.some((d) => d.code === 'invalid_path')).toBe(true);
  expect(() => readWorkflowReference(fresh, 'references/read.md')).toThrow(
    'skill_workflow_changed',
  );
});

test('migration preserves declared-risk implicit compiler gate while exposing effective write risk and approval to lifecycle', () => {
  const value = manifest();
  value.invocation.allow_implicit = true;
  value.effects = { filesystem: 'read', network: 'none', external_state: 'none' };
  value.approval.minimum = 'none';
  const dir = write(value);
  const entry = compile(dir, () => ({
    ...dependency(),
    effectiveEffects: { filesystem: 'write', network: 'none', externalState: 'none' },
    policy: { minimumApproval: 'user' },
  }));
  expect(entry.descriptor.availability).toBe('available');
  expect(entry.contract?.invocation.allowImplicit).toBe(true);
  expect(entry.contract?.effectiveEffects.filesystem).toBe('write');
  expect(entry.contract?.effectiveMinimumApproval).toBe('user');
  // The compiler declares intent; ordinary dispatch and risk-required verification belong to the lifecycle caller.
  expect(entry.contract?.verification.mode).toBe('best_effort');
});
test('source inventory includes more than 256 references and ignored build assets never change its revision', () => {
  const dir = write();
  mkdirSync(join(dir, 'references'));
  for (let index = 0; index < 301; index++)
    writeFileSync(join(dir, 'references', `${index}.md`), String(index));
  const entry = compile(dir);
  expect(entry.contract?.files).toHaveLength(302);
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', 'ignored.md'), 'not admitted');
  expect(compile(dir).descriptor.revision).toBe(entry.descriptor.revision);
  writeFileSync(join(dir, 'references', '300.md'), 'changed');
  expect(revalidateSkillWorkflow(entry).descriptor.availability).toBe('unavailable');
});
