import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '@/core/config';
import { runApprovedTool } from '@/core/harness/tool-runner';
import { buildContextProjection } from '@/core/model/context-projection';
import {
  formatProjectInstructionSnapshot,
  MAX_PROJECT_INSTRUCTION_TOKENS,
  resolveProjectInstructionSnapshot,
} from '@/core/model/project-instructions';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { countTokens } from '@/core/token-counter';

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'kite-project-instructions-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project instruction snapshot', () => {
  test('orders parent CLAUDE before AGENTS and child scope last', () => {
    const root = workspace();
    mkdirSync(join(root, 'src', 'feature'), { recursive: true });
    writeFileSync(join(root, 'CLAUDE.md'), 'root claude');
    writeFileSync(join(root, 'AGENTS.md'), 'root agents');
    writeFileSync(join(root, 'src', 'AGENTS.md'), 'src agents');

    const snapshot = resolveProjectInstructionSnapshot({
      workspace: root,
      targetPaths: ['src/feature/index.ts'],
    });

    expect(snapshot.documents.map((document) => document.path)).toEqual([
      'CLAUDE.md',
      'AGENTS.md',
      'src/AGENTS.md',
    ]);
    const formatted = formatProjectInstructionSnapshot(snapshot);
    expect(formatted.indexOf('root claude')).toBeLessThan(formatted.indexOf('root agents'));
    expect(formatted.indexOf('root agents')).toBeLessThan(formatted.indexOf('src agents'));
    expect(formatted).toContain('cannot weaken system or runtime safety policy');
  });

  test('skips oversized and linked instruction files', () => {
    const root = workspace();
    writeFileSync(join(root, 'AGENTS.md'), 'x'.repeat(16 * 1024 + 1));
    const outside = workspace();
    writeFileSync(join(outside, 'CLAUDE.md'), 'outside');
    try {
      symlinkSync(join(outside, 'CLAUDE.md'), join(root, 'CLAUDE.md'));
    } catch {
      // Some Windows test environments do not grant symlink creation.
    }

    const snapshot = resolveProjectInstructionSnapshot({ workspace: root });
    expect(snapshot.documents).toHaveLength(0);
    expect(snapshot.warnings.some((warning) => warning.includes('exceeds 16 KiB'))).toBe(true);
    if (snapshot.warnings.some((warning) => warning.includes('CLAUDE.md'))) {
      expect(snapshot.warnings.some((warning) => warning.includes('not a regular'))).toBe(true);
    }
  });

  test('ignores target paths outside the workspace', () => {
    const root = workspace();
    writeFileSync(join(root, 'AGENTS.md'), 'root only');
    const snapshot = resolveProjectInstructionSnapshot({
      workspace: root,
      targetPaths: ['../outside/file.ts'],
    });
    expect(snapshot.documents.map((document) => document.path)).toEqual(['AGENTS.md']);
  });

  test('reports and skips content beyond the project instruction token budget', () => {
    const root = workspace();
    let scope = root;
    for (const name of ['a', 'b', 'c', 'd']) {
      writeFileSync(join(scope, 'AGENTS.md'), '规则'.repeat(2500));
      scope = join(scope, name);
      mkdirSync(scope);
    }
    const snapshot = resolveProjectInstructionSnapshot({
      workspace: root,
      targetPaths: ['a/b/c/d/file.ts'],
    });
    expect(snapshot.warnings.some((warning) => warning.includes('token budget'))).toBe(true);
    expect(
      countTokens(snapshot.documents.map((document) => document.content).join('\n')),
    ).toBeLessThanOrEqual(MAX_PROJECT_INSTRUCTION_TOKENS);
  });

  test('projects instructions as user context before the real transcript', () => {
    const root = workspace();
    writeFileSync(join(root, 'AGENTS.md'), 'project rule');
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: root });
    state.transcript.messages.push({
      kind: 'user',
      messageId: 'm1',
      turnId: state.turn.turnId,
      content: 'current user request',
    });
    const snapshot = resolveProjectInstructionSnapshot({ workspace: root });
    const projection = buildContextProjection({
      role: 'agent',
      state,
      promptContractVersion: 'v2',
      projectInstructions: snapshot,
      sandboxBackend: 'seatbelt',
    });
    const content = projection.providerMessages.map((message) => String(message.content));
    expect(content[0]).toContain('You are Kite');
    expect(content[1]).toContain('Cacheable runtime context:');
    expect(content[2]).toContain('project rule');
    expect(content[3]).toBe('current user request');
    expect(projection.providerMessages.slice(0, 4).map((message) => message.type)).toEqual([
      'system',
      'system',
      'human',
      'human',
    ]);
    expect(content.at(-1)).toContain('sandbox_backend: seatbelt');
  });

  test('loads nested instructions for a concrete file target in user transcript text', () => {
    const root = workspace();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'AGENTS.md'), 'root rule');
    writeFileSync(join(root, 'src', 'AGENTS.md'), 'nested rule');
    let state = createInitialRuntimeState({
      threadId: 'thread-target',
      userId: 'user',
      workspace: root,
    });
    state = reduceRuntimeState(state, {
      type: 'user.message_appended',
      messageId: 'message-target',
      content: 'Please update src/new.ts after inspecting the current implementation.',
    });
    const snapshot = resolveProjectInstructionSnapshot({ workspace: root, state });
    expect(snapshot.documents.map((document) => document.path)).toEqual([
      'AGENTS.md',
      'src/AGENTS.md',
    ]);
  });

  test('rejects a first write when a nested instruction was not visible to the model', async () => {
    const root = workspace();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), 'root rule');
    writeFileSync(join(root, 'src', 'AGENTS.md'), 'nested rule');
    const visible = resolveProjectInstructionSnapshot({ workspace: root });
    const result = await runApprovedTool({
      workspace: root,
      request: {
        source: 'builtin',
        name: 'write_file',
        args: { path: 'src/new.ts', content: 'export {};' },
        reason: 'test',
        protectedCommand: 'write_file src/new.ts',
      },
      phase: 'building',
      taskConfig: { features: { promptContractV2: true } } as AgentConfig,
      projectInstructionSnapshot: visible,
    });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('project_instructions_changed');
    expect(result.stderr).toContain('src/AGENTS.md');
    expect(existsSync(join(root, 'src', 'new.ts'))).toBe(false);
  });

  test('rejects a write when an already visible instruction digest changes', async () => {
    const root = workspace();
    writeFileSync(join(root, 'AGENTS.md'), 'old rule');
    const visible = resolveProjectInstructionSnapshot({ workspace: root });
    writeFileSync(join(root, 'AGENTS.md'), 'new rule');
    const result = await runApprovedTool({
      workspace: root,
      request: {
        source: 'builtin',
        name: 'write_file',
        args: { path: 'new.ts', content: 'export {};' },
        reason: 'test',
        protectedCommand: 'write_file new.ts',
      },
      phase: 'building',
      taskConfig: { features: { promptContractV2: true } } as AgentConfig,
      projectInstructionSnapshot: visible,
    });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('project_instructions_changed');
    expect(result.stderr).toContain('AGENTS.md');
    expect(existsSync(join(root, 'new.ts'))).toBe(false);
    const refreshed = resolveProjectInstructionSnapshot({ workspace: root });
    const retry = await runApprovedTool({
      workspace: root,
      request: {
        source: 'builtin',
        name: 'write_file',
        args: { path: 'new.ts', content: 'export {};' },
        reason: 'test',
        protectedCommand: 'write_file new.ts',
      },
      phase: 'building',
      taskConfig: { features: { promptContractV2: true } } as AgentConfig,
      projectInstructionSnapshot: refreshed,
    });
    expect(retry.ok).toBe(true);
    expect(existsSync(join(root, 'new.ts'))).toBe(true);
  });
});
