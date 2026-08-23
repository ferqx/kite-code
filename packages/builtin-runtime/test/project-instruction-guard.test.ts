import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkProjectInstructionSnapshotFreshness,
  projectProjectInstructionGuardTarget,
  resolveProjectInstructionSnapshot,
} from '../src/model/project-instructions';

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'kite-project-instruction-guard-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Builtin project instruction snapshot guard', () => {
  test('projects write, shell, and code-subagent targets from catalog facts', () => {
    expect(
      projectProjectInstructionGuardTarget({
        executionMechanism: 'filesystem',
        declaredFilesystemEffect: 'write',
        effectiveFilesystemEffect: 'write',
        canonicalArguments: { path: 'src/new.ts', content: 'export {};' },
      }),
    ).toEqual({ targetPath: 'src/new.ts', reason: 'filesystem_write' });
    expect(
      projectProjectInstructionGuardTarget({
        executionMechanism: 'shell',
        declaredFilesystemEffect: 'unknown',
        effectiveFilesystemEffect: 'unknown',
        canonicalArguments: { command: 'pwd' },
      }),
    ).toEqual({ targetPath: '.', reason: 'shell' });
    expect(
      projectProjectInstructionGuardTarget({
        executionMechanism: 'subagent',
        declaredFilesystemEffect: 'unknown',
        effectiveFilesystemEffect: 'unknown',
        canonicalArguments: { subagent_type: 'code', taskArtifact: { artifactId: 'fixture' } },
      }),
    ).toEqual({ targetPath: '.', reason: 'code_subagent' });
    expect(
      projectProjectInstructionGuardTarget({
        executionMechanism: 'subagent',
        declaredFilesystemEffect: 'unknown',
        effectiveFilesystemEffect: 'unknown',
        canonicalArguments: { subagent_type: 'review', taskArtifact: { artifactId: 'fixture' } },
      }),
    ).toBeNull();
  });

  test('rejects unseen nested instructions and accepts the refreshed snapshot', () => {
    const root = workspace();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'AGENTS.md'), 'root rule');
    const visible = resolveProjectInstructionSnapshot({ workspace: root });
    writeFileSync(join(root, 'src', 'AGENTS.md'), 'nested rule');
    const target = projectProjectInstructionGuardTarget({
      executionMechanism: 'filesystem',
      declaredFilesystemEffect: 'write',
      effectiveFilesystemEffect: 'write',
      canonicalArguments: { path: 'src/new.ts', content: 'export {};' },
    });
    if (!target) throw new Error('missing guard target');

    expect(
      checkProjectInstructionSnapshotFreshness({
        workspace: root,
        visibleSnapshot: visible,
        target,
      }),
    ).toMatchObject({
      status: 'changed',
      code: 'project_instructions_changed',
      path: 'src/AGENTS.md',
    });
    const refreshed = resolveProjectInstructionSnapshot({
      workspace: root,
      targetPaths: [target.targetPath],
    });
    expect(
      checkProjectInstructionSnapshotFreshness({
        workspace: root,
        visibleSnapshot: refreshed,
        target,
      }),
    ).toEqual({ status: 'accepted' });
  });

  test('rejects an already-visible instruction whose digest changed', () => {
    const root = workspace();
    writeFileSync(join(root, 'AGENTS.md'), 'old rule');
    const visible = resolveProjectInstructionSnapshot({ workspace: root });
    writeFileSync(join(root, 'AGENTS.md'), 'new rule');
    const target = projectProjectInstructionGuardTarget({
      executionMechanism: 'shell',
      declaredFilesystemEffect: 'unknown',
      effectiveFilesystemEffect: 'unknown',
      canonicalArguments: { command: 'pwd' },
    });
    if (!target) throw new Error('missing guard target');

    expect(
      checkProjectInstructionSnapshotFreshness({
        workspace: root,
        visibleSnapshot: visible,
        target,
      }),
    ).toMatchObject({
      status: 'changed',
      code: 'project_instructions_changed',
      path: 'AGENTS.md',
    });
  });
});
