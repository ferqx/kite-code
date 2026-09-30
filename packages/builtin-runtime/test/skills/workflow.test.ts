import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compileSkillWorkflow,
  createSkillCapabilityResolver,
  evaluateSkillActivation,
  refreshSkillCatalog,
} from '@kite-ai/builtin-runtime/skills';
import { readSkillReference } from '../../src/skills/lifecycle';

let root: string;

function writeWorkflow(name: string, manifest: string, body = 'Follow the governed workflow.') {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), `---\n${manifest}\n---\n\n${body}\n`);
  return directory;
}

function compile(directory: string) {
  return compileSkillWorkflow({
    skillDir: directory,
    source: 'project',
    origin: '.kite-code',
  });
}

const VALID_MANIFEST = `name: publish-docs
version: 1.2.3
description: Publish the documentation.
invocation:
  allow_implicit: false
  allow_manual: true
context:
  mode: fork
  agent: code
input_schema:
  type: object
  properties:
    version:
      type: string
  required: [version]
output_schema:
  type: object
  properties:
    url:
      type: string
  required: [url]
capabilities:
  require: [builtin:read_file]
  deny: []
effects:
  filesystem: read
  network: write
  external_state: write
approval:
  minimum: user
execution:
  timeout_ms: 300000
  max_attempts: 1
verification:
  mode: best_effort
recovery:
  retry: never`;

describe('compileSkillWorkflow', () => {
  beforeEach(() => {
    root = join(
      tmpdir(),
      `kite-skill-workflow-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('compiles a strict workflow contract into an available capability', () => {
    const result = compile(writeWorkflow('publish-docs', VALID_MANIFEST));
    expect(result.diagnostics).toEqual([]);
    expect(result.contract?.context.mode).toBe('fork');
    expect(result.contract?.capabilityCeiling).toEqual(['builtin:read_file']);
    expect(result.descriptor).toMatchObject({
      capabilityId: 'skill:publish-docs',
      kind: 'skill',
      availability: 'available',
      policy: { minimumApproval: 'user' },
    });
  });

  it('records unknown fields as diagnostics instead of silently accepting them', () => {
    const result = compile(writeWorkflow('publish-docs', `${VALID_MANIFEST}\nunsafe_extra: true`));
    expect(result.contract).toBeDefined();
    expect(result.descriptor.availability).toBe('unavailable');
    expect(result.diagnostics.some((item) => item.code === 'unknown_field')).toBe(true);
  });

  it('rejects high-risk implicit activation', () => {
    const result = compile(
      writeWorkflow(
        'publish-docs',
        VALID_MANIFEST.replace('allow_implicit: false', 'allow_implicit: true'),
      ),
    );
    expect(result.descriptor.availability).toBe('unavailable');
    expect(result.diagnostics.some((item) => item.message.includes('allow_implicit'))).toBe(true);
  });

  it('covers referenced files in the immutable revision', () => {
    const directory = writeWorkflow('publish-docs', VALID_MANIFEST);
    mkdirSync(join(directory, 'references'));
    const reference = join(directory, 'references', 'release.md');
    writeFileSync(reference, 'first revision');
    const first = compile(directory);
    writeFileSync(reference, 'first revisioN');
    const second = compile(directory);
    expect(second.descriptor.revision).not.toBe(first.descriptor.revision);
  });

  it('reads a declared reference larger than the former direct-read limit', () => {
    const directory = writeWorkflow('publish-docs', VALID_MANIFEST);
    mkdirSync(join(directory, 'references'));
    const content = 'reference content\n'.repeat(10_000);
    writeFileSync(join(directory, 'references', 'large.md'), content);
    const entry = compile(directory);
    expect(entry.contract?.files).toContain('references/large.md');
    const runtime = {
      state: {
        activeTaskId: 'task-1',
        session: { workspace: root },
        skills: {
          catalogRevision: 'catalog-1',
          frames: {
            activation: {
              activationId: 'activation',
              skillId: entry.descriptor.capabilityId,
              skillRevision: entry.descriptor.revision,
              taskId: 'task-1',
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
      catalog: {
        revision: 'catalog-1',
        capabilities: { revision: 'catalog-1', descriptors: [entry.descriptor] },
        entries: [entry],
      },
      verificationEnabled: false,
    };
    const result = readSkillReference(runtime, {
      activation_id: 'activation',
      path: 'references/large.md',
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({ encoding: 'utf8', content });
    expect(
      readSkillReference(runtime, {
        activation_id: 'activation',
        path: 'references/undeclared.md',
      }).ok,
    ).toBe(false);
  });

  it('resolves capability revisions and rejects missing dependencies', () => {
    const directory = writeWorkflow('publish-docs', VALID_MANIFEST);
    const missing = compileSkillWorkflow({
      skillDir: directory,
      source: 'project',
      origin: '.kite-code',
      resolveCapability: () => undefined,
    });
    expect(missing.descriptor.availability).toBe('unavailable');
    expect(missing.diagnostics.some((item) => item.code === 'missing_capability')).toBe(true);

    const resolved = compileSkillWorkflow({
      skillDir: directory,
      source: 'project',
      origin: '.kite-code',
      resolveCapability: (capabilityId) => ({
        capabilityId,
        revision: 'current-revision',
        kind: 'builtin_tool',
        displayName: capabilityId,
        description: 'fixture',
        provider: { type: 'builtin', id: capabilityId, provenance: 'builtin' },
        declaredEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
        effectiveEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
        policy: { workspaceTrustRequired: false, minimumApproval: 'none' },
        availability: 'available',
        diagnostics: [],
      }),
    });
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.contract?.dependencyRevisions).toEqual({
      'builtin:read_file': 'current-revision',
    });
  });

  it('subtracts denied requirements and rejects ineffective deny declarations', () => {
    const overlap = compile(
      writeWorkflow('overlap', VALID_MANIFEST.replace('deny: []', 'deny: [builtin:read_file]')),
    );
    expect(overlap.descriptor.availability).toBe('available');
    expect(overlap.contract?.effectiveCapabilityCeiling).toEqual([]);
    expect(overlap.contract?.dependencyRevisions).toEqual({});

    const outside = compile(
      writeWorkflow('outside', VALID_MANIFEST.replace('deny: []', 'deny: [builtin:write_file]')),
    );
    expect(outside.descriptor.availability).toBe('unavailable');
    expect(outside.diagnostics.some((item) => item.message.includes('not present'))).toBe(true);
  });

  it('conservatively joins dependency effects and approval', () => {
    const result = compileSkillWorkflow({
      skillDir: writeWorkflow('publish-docs', VALID_MANIFEST),
      source: 'project',
      origin: '.kite-code',
      resolveCapability: (capabilityId) => ({
        capabilityId,
        revision: 'write-revision',
        kind: 'builtin_tool',
        displayName: capabilityId,
        description: 'write fixture',
        provider: { type: 'builtin', id: capabilityId, provenance: 'builtin' },
        declaredEffects: { filesystem: 'write', network: 'none', externalState: 'none' },
        effectiveEffects: { filesystem: 'write', network: 'unknown', externalState: 'none' },
        policy: { workspaceTrustRequired: false, minimumApproval: 'user' },
        availability: 'available',
        diagnostics: [],
      }),
    });
    expect(result.contract?.effectiveEffects).toEqual({
      filesystem: 'write',
      network: 'unknown',
      externalState: 'write',
    });
    expect(result.contract?.effectiveMinimumApproval).toBe('user');
    expect(result.descriptor.effectiveEffects.network).toBe('unknown');
  });

  it('resolves production builtin and MCP dependencies conservatively', () => {
    const resolver = createSkillCapabilityResolver({
      findCapability: (capabilityId: string) =>
        capabilityId === 'mcp:docs/search'
          ? ({
              capabilityId,
              revision: 'mcp-revision',
              kind: 'mcp_tool',
              displayName: 'search',
              description: 'fixture',
              provider: { type: 'mcp', id: 'docs', provenance: 'remote' },
              declaredEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
              effectiveEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
              policy: { workspaceTrustRequired: false, minimumApproval: 'none' },
              availability: 'available',
              diagnostics: [],
            } as const)
          : undefined,
    } as never);
    expect(resolver('builtin:read_file')?.effectiveEffects.filesystem).toBe('read');
    expect(resolver('builtin:write_file')?.policy.minimumApproval).toBe('user');
    expect(resolver('builtin:typo')).toBeUndefined();
    expect(resolver('mcp:docs/search')?.revision).toBe('mcp-revision');
  });

  it('includes large, deep, and numerous files in the revision while ignoring build directories', () => {
    const directory = writeWorkflow('publish-docs', VALID_MANIFEST);
    writeFileSync(join(directory, 'oversized.bin'), Buffer.alloc(8 * 1024 * 1024 + 1));
    let deep = directory;
    for (let index = 0; index < 9; index += 1) deep = join(deep, `level-${index}`);
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'deep.md'), 'deep reference');
    const many = join(directory, 'references');
    mkdirSync(many);
    for (let index = 0; index < 257; index += 1)
      writeFileSync(join(many, `reference-${index}.md`), String(index));
    const expanded = compile(directory);
    expect(expanded.descriptor.availability).toBe('available');
    expect(expanded.contract?.files).toHaveLength(260);
    expect(expanded.contract?.files).toContain('oversized.bin');
    expect(expanded.contract?.files).toContain(
      join(...Array.from({ length: 9 }, (_, index) => `level-${index}`), 'deep.md'),
    );

    mkdirSync(join(directory, 'node_modules'), { recursive: true });
    writeFileSync(join(directory, 'node_modules', 'ignored.bin'), Buffer.alloc(1024 * 1024 + 1));
    const ignored = compile(directory);
    expect(ignored.descriptor.availability).toBe('available');
    expect(ignored.descriptor.revision).toBe(expanded.descriptor.revision);
  });

  it('rejects executable paths inside ignored directories', () => {
    const manifest = VALID_MANIFEST.replace(
      'verification:\n  mode: best_effort',
      'verification:\n  mode: best_effort\n  strategy: script\n  entrypoint: node_modules/check.ts',
    );
    const result = compile(writeWorkflow('ignored-entrypoint', manifest));
    expect(result.descriptor.availability).toBe('unavailable');
    expect(
      result.diagnostics.some((item) => item.message.includes('ignored Skill directory')),
    ).toBe(true);
  });

  it('keeps shadowed skills diagnosable instead of silently skipping them', () => {
    const projectRoot = join(root, 'project');
    const userRoot = join(root, 'user');
    const projectSkill = join(projectRoot, 'publish-docs');
    const userSkill = join(userRoot, 'publish-docs');
    mkdirSync(projectSkill, { recursive: true });
    mkdirSync(userSkill, { recursive: true });
    writeFileSync(join(projectSkill, 'SKILL.md'), `---\n${VALID_MANIFEST}\n---\nProject body.`);
    writeFileSync(join(userSkill, 'SKILL.md'), `---\n${VALID_MANIFEST}\n---\nUser body.`);
    const catalog = refreshSkillCatalog({
      projectKiteCodeSkillsDir: projectRoot,
      projectAgentsSkillsDir: join(root, 'missing-project-agents'),
      userKiteCodeSkillsDir: userRoot,
      userAgentsSkillsDir: join(root, 'missing-user-agents'),
    });
    expect(catalog.capabilities.descriptors).toHaveLength(1);
    expect(catalog.entries).toHaveLength(2);
    expect(catalog.entries.find((entry) => entry.shadowedBy)?.descriptor.availability).toBe(
      'unavailable',
    );
  });

  it('allows a valid user skill to win over an invalid project skill', () => {
    const projectRoot = join(root, 'invalid-project');
    const userRoot = join(root, 'valid-user');
    mkdirSync(join(projectRoot, 'publish-docs'), { recursive: true });
    mkdirSync(join(userRoot, 'publish-docs'), { recursive: true });
    writeFileSync(join(projectRoot, 'publish-docs', 'SKILL.md'), 'invalid');
    writeFileSync(
      join(userRoot, 'publish-docs', 'SKILL.md'),
      `---\n${VALID_MANIFEST}\n---\nUser body.`,
    );
    const catalog = refreshSkillCatalog({
      projectKiteCodeSkillsDir: projectRoot,
      projectAgentsSkillsDir: join(root, 'missing-project-agents'),
      userKiteCodeSkillsDir: userRoot,
      userAgentsSkillsDir: join(root, 'missing-user-agents'),
    });
    expect(catalog.capabilities.descriptors).toHaveLength(1);
    expect(catalog.capabilities.descriptors[0]?.provider.provenance).toBe('user');
    expect(catalog.entries[0]?.descriptor.availability).toBe('unavailable');
  });
});

describe('evaluateSkillActivation', () => {
  beforeEach(() => {
    root = join(
      tmpdir(),
      `kite-skill-activation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('uses an injected content-free activation identifier without allocating a UUID', () => {
    const directory = writeWorkflow('publish-docs', VALID_MANIFEST);
    const catalog = { revision: 'catalog-fixture', entries: [compile(directory)] } as never;
    expect(directory).toBeDefined();
    const evaluated = evaluateSkillActivation({
      state: {
        activeTaskId: 'task_fixture',
        session: { workspace: root },
        skills: { catalogRevision: '', frames: {} },
      },
      catalog,
      flags: { skillWorkflow: true, skillActivation: true },
      now: new Date('2026-08-26T00:00:00.000Z'),
      activationId: 'skill_activation_deterministic_1',
      request: {
        skillId: 'skill:publish-docs',
        input: { version: '1.2.3' },
        requestedBy: 'user',
        implicit: false,
      },
    });
    expect(evaluated).toMatchObject({
      ok: true,
      activation: {
        activationId: 'skill_activation_deterministic_1',
        activatedAt: '2026-08-26T00:00:00.000Z',
      },
    });
  });
});
