import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SKILL_CATALOG_REQUEST_SCHEMA_,
  type SkillCatalogRequest,
} from '@kite-ai/kite-app-contract';
import { resolveProjectIdentity } from '@kite-ai/runtime-host';
import { skillDirs } from '#kite-cli/config/paths';
import { createSkillCatalogOwner } from '../../../src/app-control/owners/skill-catalog-owner';

const MANIFEST = `version: 1.0.0
description: A safe skill summary.
invocation:
  allow_implicit: false
  allow_manual: true
context:
  mode: inline
  agent: code
input_schema:
  type: object
  properties:
    target:
      type: string
  required: [target]
output_schema:
  type: object
  properties:
    ok:
      type: boolean
  required: [ok]
capabilities:
  require: [builtin:read_file]
  deny: []
effects:
  filesystem: read
  network: none
  external_state: none
approval:
  minimum: none
execution:
  timeout_ms: 1000
  max_attempts: 1
verification:
  mode: not_required
recovery:
  retry: never`;

let root: string;
let previousKiteCodeHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kite-skill-owner-'));
  previousKiteCodeHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = join(root, 'kite-home');
  mkdirSync(process.env.KITE_CODE_HOME, { recursive: true });
});

afterEach(() => {
  if (previousKiteCodeHome === undefined) delete process.env.KITE_CODE_HOME;
  else process.env.KITE_CODE_HOME = previousKiteCodeHome;
  rmSync(root, { recursive: true, force: true });
});

function identity(workspace: string) {
  const project = resolveProjectIdentity(workspace);
  return {
    canonicalPath: workspace,
    projectId: project.projectId,
    workspaceDigest: project.workspaceDigest,
  } as const;
}

function writeSkill(workspace: string, name: string, body = 'Private instruction body.') {
  const directory = join(skillDirs(workspace).projectKiteCodeSkillsDir, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${name}\n${MANIFEST}\n---\n\n${body}\n`);
  return directory;
}

function request(workspace: ReturnType<typeof identity>): SkillCatalogRequest {
  return { schema: SKILL_CATALOG_REQUEST_SCHEMA_, workspace };
}

describe('Skill Catalog App Control owner', () => {
  test('retains actual manifests while projecting a stable safe snapshot', async () => {
    const workspacePath = join(root, 'workspace');
    mkdirSync(workspacePath, { recursive: true });
    const workspace = identity(workspacePath);
    const skillName = `owner-skill-${crypto.randomUUID().slice(0, 8)}`;
    const skillDirectory = writeSkill(
      workspacePath,
      skillName,
      'DO NOT DISCLOSE THIS INSTRUCTION BODY or /private/skill/path.',
    );
    const owner = createSkillCatalogOwner({ workspace });

    const first = await owner.snapshot(request(workspace));
    const second = await owner.snapshot(request(workspace));
    const projected = first.skills.find((skill) => skill.name === skillName);
    const actual = owner.getActualManifests().find((manifest) => manifest.name === skillName);

    expect(second.revision).toBe(first.revision);
    expect(projected).toEqual({
      name: skillName,
      description: 'A safe skill summary.',
      source: 'project',
      origin: '.kite-code',
      status: 'available',
    });
    expect(actual).toEqual({
      name: skillName,
      description: 'A safe skill summary.',
      source: 'project',
      origin: '.kite-code',
    });
    expect(Object.isFrozen(owner.getActualManifests())).toBeTrue();
    expect(Object.isFrozen(actual)).toBeTrue();
    expect(JSON.stringify(first)).not.toContain('DO NOT DISCLOSE THIS INSTRUCTION BODY');
    expect(JSON.stringify(first)).not.toContain('private/skill/path');
    expect(JSON.stringify(first)).not.toContain(skillDirectory);
    expect(JSON.stringify(actual)).not.toContain('SKILL.md');

    writeSkill(workspacePath, skillName, 'Changed private body.');
    const changed = await owner.snapshot(request(workspace));
    expect(changed.revision).toBe(first.revision);
  });

  test('isolates project Skill roots and rejects a request for another Workspace', async () => {
    const firstPath = join(root, 'first');
    const secondPath = join(root, 'second');
    mkdirSync(firstPath, { recursive: true });
    mkdirSync(secondPath, { recursive: true });
    const firstWorkspace = identity(firstPath);
    const secondWorkspace = identity(secondPath);
    const firstName = `first-skill-${crypto.randomUUID().slice(0, 8)}`;
    const secondName = `second-skill-${crypto.randomUUID().slice(0, 8)}`;
    writeSkill(firstPath, firstName);
    writeSkill(secondPath, secondName);

    const firstOwner = createSkillCatalogOwner({ workspace: firstWorkspace });
    const secondOwner = createSkillCatalogOwner({ workspace: secondWorkspace });
    const first = await firstOwner.snapshot(request(firstWorkspace));
    const second = await secondOwner.snapshot(request(secondWorkspace));

    expect(first.skills.some((skill) => skill.name === firstName)).toBeTrue();
    expect(first.skills.some((skill) => skill.name === secondName)).toBeFalse();
    expect(second.skills.some((skill) => skill.name === secondName)).toBeTrue();
    expect(second.skills.some((skill) => skill.name === firstName)).toBeFalse();
    expect(
      firstOwner.getActualManifests().some((manifest) => manifest.name === secondName),
    ).toBeFalse();
    expect(
      secondOwner.getActualManifests().some((manifest) => manifest.name === firstName),
    ).toBeFalse();
    await expect(firstOwner.snapshot(request(secondWorkspace))).rejects.toMatchObject({
      code: 'invalid_app_control_request',
    });
  });
});
