import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuiltinSubagentModelContext } from '@kite/builtin-runtime';

describe('Builtin subagent model context', () => {
  test('owns the canonical Workspace/CWD and code-role Skill disclosure', () => {
    const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-subagent-context-')));
    try {
      const context = createBuiltinSubagentModelContext({
        workspace,
        task: 'Inspect the bounded implementation.',
        role: 'code',
        systemPrompt: 'Code role prompt.',
        promptContract: false,
        skills: [{ name: 'test-skill', description: 'A bounded test workflow.' }],
      });

      expect(context.workspace).toBe(workspace);
      expect(context.projectInstructions).toBeUndefined();
      expect(context.messages).toHaveLength(2);
      expect(context.messages[0]?.content).toContain('## Available Skills');
      expect(context.messages[0]?.content).toContain('test-skill: A bounded test workflow.');
      expect(context.messages[1]?.content).toContain(`CWD: ${workspace}`);
      expect(context.messages[1]?.content).toContain('Inspect the bounded implementation.');
      expect(Object.isFrozen(context.messages)).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('projects supplied Prompt Contract instructions without disclosing Skills to read-only roles', () => {
    const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-subagent-context-')));
    try {
      const projectInstructions = Object.freeze({
        revision: 'instructions-v1',
        workspaceRoot: workspace,
        documents: Object.freeze([
          Object.freeze({
            kind: 'agents' as const,
            path: join(workspace, 'AGENTS.md'),
            scopeRoot: workspace,
            digest: 'sha256:instructions',
            content: 'Keep the child read-only.',
          }),
        ]),
        warnings: Object.freeze([]),
      });
      const context = createBuiltinSubagentModelContext({
        workspace,
        task: 'Read only.',
        role: 'explore',
        systemPrompt: 'Explore role prompt.',
        promptContract: true,
        projectInstructions,
        skills: [{ name: 'hidden-skill', description: 'Must not be disclosed.' }],
      });

      expect(context.projectInstructions).toBe(projectInstructions);
      expect(context.messages).toHaveLength(3);
      expect(context.messages[0]?.content).not.toContain('hidden-skill');
      expect(context.messages[2]?.content).toContain('Keep the child read-only.');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
