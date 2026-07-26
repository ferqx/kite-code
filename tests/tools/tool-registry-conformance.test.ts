import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { runApprovedTool } from '@/core/harness/tool-runner';
import { POLICY_CLASSIFIED_TOOL_NAMES } from '@/core/policies/tool-capabilities';
import { sessionReadTracker } from '@/core/tools/read-state';
import { builtinToolRegistry } from '@/core/tools/registry/builtins';
import { editFileSpec } from '@/core/tools/registry/builtins/edit-file';
import { readFileSpec } from '@/core/tools/registry/builtins/read-file';
import {
  classifyShellActionIntent,
  shellActionEnvelopeSchema,
  shellExecuteSpec,
} from '@/core/tools/registry/builtins/shell-execute';
import { dispatchRegisteredTool } from '@/core/tools/registry/dispatch';
import { createToolRegistry } from '@/core/tools/registry/registry';
import type { ToolContext, ToolSpec } from '@/core/tools/registry/spec';
import { buildDescription, KNOWN_TOOL_NAMES } from '@/core/tools/tool-contracts';

/**
 * ToolSpec Registry 一致性测试（ADR-0026 §5 / RFC §5）。
 *
 * 不变量编号与 RFC §5 表格一致：i1 args 透传恒等、i2 schema-only、
 * i3 Policy 名集闭合、i4 KNOWN_TOOL_NAMES 棘轮、i5 写工具 mutation scope、
 * i6 描述纯函数、i9 revision 确定性。i10（shell 分类不读治理参数）
 * 随阶段 1.2 shell 迁移以参数面断言补齐。
 */

const CTX: ToolContext = { workspace: '/tmp/sample' };

// ── 测试本地样例 spec（名称带 registry_sample_ 前缀，永不进入生产 Registry） ──

interface SampleReadOutput {
  lines: string[];
}

const sampleReadSpec: ToolSpec<{ path: string; limit?: number }, SampleReadOutput> = {
  name: 'registry_sample_read',
  kind: 'computer',
  contract: {
    whenToUse:
      'Sample read tool for conformance tests. Use registry_sample_write when you need to write.',
    commonMistakes: 'Using registry_sample_write for reads.',
    outputFormat: 'JSON: ok (boolean), lines (string array).',
    failureHandling: 'If path missing: provide a workspace-relative path and retry.',
  },
  inputSchema: z.object({
    path: z.string(),
    limit: z.number().optional(),
  }),
  declaredEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
  minimumApproval: 'none',
  effects: () => ({
    effectClass: 'read_only',
    sideEffect: false,
    classificationReason: 'Sample read-only spec.',
  }),
  execute: async (input) => ({ lines: [input.path, String(input.limit ?? 'all')] }),
  projectResult: (output) => ({
    ok: true,
    modelContent: output.lines.join('\n'),
    resultMeta: {},
    display: { verb: 'Read' },
  }),
};

interface SampleWriteOutput {
  path: string;
  bytes: number;
}

const sampleWriteSpec: ToolSpec<{ path: string; content: string }, SampleWriteOutput> = {
  name: 'registry_sample_write',
  kind: 'computer',
  contract: {
    whenToUse: 'Sample write tool for conformance tests. Use registry_sample_read to read first.',
    commonMistakes: 'Overwriting without reading.',
    outputFormat: 'JSON: ok (boolean), bytes (written byte count).',
    failureHandling: 'If write fails: verify the path is workspace-relative and retry.',
  },
  inputSchema: z.object({
    path: z.string(),
    content: z.string(),
  }),
  declaredEffects: { filesystem: 'write', network: 'none', externalState: 'none' },
  minimumApproval: 'user',
  effects: () => ({
    effectClass: 'workspace_write',
    sideEffect: true,
    classificationReason: 'Sample workspace write spec.',
  }),
  approvalSummary: (input) => `registry_sample_write ${input.path}`,
  execute: async (input) => ({ path: input.path, bytes: input.content.length }),
  projectResult: (output) => ({
    ok: true,
    modelContent: `Wrote ${output.bytes} bytes to ${output.path}`,
    resultMeta: { workspaceMutationScope: [output.path] },
    display: { verb: 'Write' },
  }),
};

function sampleRegistry() {
  return createToolRegistry().register(sampleReadSpec).register(sampleWriteSpec);
}

describe('ToolSpec Registry — registration behavior', () => {
  test('rejects duplicate registration', () => {
    expect(() => sampleRegistry().register(sampleReadSpec)).toThrow('already registered');
  });

  test('rejects names that are not stable snake_case', () => {
    for (const bad of ['Read', 'read-file', 'read_file ', '1read', '']) {
      const spec: typeof sampleReadSpec = {
        ...sampleReadSpec,
        name: bad,
      };
      expect(() => createToolRegistry().register(spec)).toThrow('snake_case');
    }
  });

  test('returns null for unknown tool names so the existing rejection path handles them', () => {
    const registry = sampleRegistry();
    expect(registry.parseToolCall({ name: 'never_registered', args: {} }, CTX)).toBeNull();
  });

  test('rejects invalid arguments with a structured failure instead of dropping fields', () => {
    const registry = sampleRegistry();
    const missing = registry.parseToolCall(
      { id: 'c1', name: 'registry_sample_read', args: {} },
      CTX,
    );
    expect(missing).not.toBeNull();
    expect(missing?.ok).toBe(false);

    const wrongType = registry.parseToolCall(
      { name: 'registry_sample_read', args: { path: 42 } },
      CTX,
    );
    expect(wrongType?.ok).toBe(false);
  });

  test('availability gates toolset, parsing and listing', () => {
    const gated: ToolSpec<{ path: string }, SampleReadOutput> = {
      ...sampleReadSpec,
      name: 'registry_sample_gated',
      availability: (context) => context.workspace === '/allowed',
    };
    const registry = createToolRegistry().register(gated);

    expect(registry.availableIn({ workspace: '/allowed' })).toHaveLength(1);
    expect(registry.availableIn({ workspace: '/other' })).toHaveLength(0);
    expect(Object.keys(registry.toSchemaOnlyToolSet({ workspace: '/other' }))).toHaveLength(0);
    expect(
      registry.parseToolCall(
        { name: 'registry_sample_gated', args: { path: 'a' } },
        {
          workspace: '/other',
        },
      ),
    ).toBeNull();
  });
});

describe('ToolSpec Registry — Runtime Action ownership', () => {
  test('controller does not construct Plan or Skill domain lifecycle events', () => {
    const source = readFileSync(
      new URL('../../src/core/controllers/tool-controller.ts', import.meta.url),
      'utf8',
    );
    for (const eventType of [
      'plan.drafted',
      'plan.review_requested',
      'plan.progress_updated',
      'plan.completed',
      'skill.activation_started',
      'skill.frame_closed',
    ]) {
      expect(source).not.toContain(`type: '${eventType}'`);
    }
  });
});

describe('invariant i1 — parsed args are identical to the schema parse (no field remapping)', () => {
  test('full input with optionals passes through unchanged', () => {
    const registry = sampleRegistry();
    const raw = { path: 'src/index.ts', limit: 20 };
    const parsed = registry.parseToolCall({ name: 'registry_sample_read', args: raw }, CTX);
    expect(parsed?.ok).toBe(true);
    if (parsed?.ok) {
      expect(parsed.args).toEqual(sampleReadSpec.inputSchema.parse(raw));
      expect(parsed.args).toEqual(raw);
    }
  });

  test('unknown extra keys are stripped by the schema, not by hand-written branches', () => {
    const registry = sampleRegistry();
    const raw = { path: 'a.ts', limit: 5, match_mode: 'trimmed', force: true };
    const parsed = registry.parseToolCall({ name: 'registry_sample_read', args: raw }, CTX);
    expect(parsed?.ok).toBe(true);
    if (parsed?.ok) {
      // 关键断言：args 恒等于 schema 解析结果——match_mode/force 这类
      // 未声明字段被 schema 层统一处理，不存在"声明了却被丢弃"的中间层。
      expect(parsed.args).toEqual(sampleReadSpec.inputSchema.parse(raw));
      expect(parsed.args).toEqual({ path: 'a.ts', limit: 5 });
    }
  });

  test('approvalSummary derives protectedCommand; default is the tool name', () => {
    const registry = sampleRegistry();
    const write = registry.parseToolCall(
      { name: 'registry_sample_write', args: { path: 'x.ts', content: 'hi' } },
      CTX,
    );
    expect(write?.ok).toBe(true);
    if (write?.ok) expect(write.protectedCommand).toBe('registry_sample_write x.ts');

    const read = registry.parseToolCall(
      { name: 'registry_sample_read', args: { path: 'y.ts' } },
      CTX,
    );
    expect(read?.ok).toBe(true);
    if (read?.ok) expect(read.protectedCommand).toBe('registry_sample_read');
  });
});

describe('invariant i2 — model ToolSet is schema-only', () => {
  test('no generated tool carries an execute function', () => {
    const toolset = sampleRegistry().toSchemaOnlyToolSet(CTX);
    expect(Object.keys(toolset).sort()).toEqual(['registry_sample_read', 'registry_sample_write']);
    for (const entry of Object.values(toolset)) {
      expect(entry.execute).toBeUndefined();
    }
  });
});

describe('invariant i3 — policy-classified names form a closed set (anti-ghost-name)', () => {
  test('every name referenced by policy classification is a known tool name', () => {
    // 捕获 list_files 式幽灵名：Policy 引用的工具名必须真实存在。
    const known = new Set<string>(KNOWN_TOOL_NAMES);
    const ghosts = [...POLICY_CLASSIFIED_TOOL_NAMES].filter((name) => !known.has(name));
    expect(ghosts).toEqual([]);
  });
});

describe('invariant i4 — KNOWN_TOOL_NAMES migration ratchet', () => {
  /**
   * 尚未迁入 Registry 的静态工具名 = 已知名单 − 生产 Registry 已注册名。
   * 阶段 1.2 每迁移一个工具，它自动从待迁移集合移入 Registry；
   * 阶段 1.3 清理完成后本集合应为空（届时改为全量断言）。
   */
  const PENDING_MIGRATION = new Set<string>(
    [...KNOWN_TOOL_NAMES].filter((name) => !builtinToolRegistry.get(name)),
  );

  test('migrated names never remain pending (single source of truth)', () => {
    for (const name of builtinToolRegistry.names()) {
      expect(PENDING_MIGRATION.has(name)).toBe(false);
    }
  });

  test('pending migration set never hides unknown names', () => {
    const known = new Set<string>(KNOWN_TOOL_NAMES);
    for (const name of PENDING_MIGRATION) {
      expect(known.has(name)).toBe(true);
    }
  });

  test('known names are covered by production registry or pending migration', () => {
    const covered = new Set<string>([...builtinToolRegistry.names(), ...PENDING_MIGRATION]);
    for (const name of KNOWN_TOOL_NAMES) {
      expect(covered.has(name)).toBe(true);
    }
  });

  test('production registry names must be known tool names', () => {
    const known = new Set<string>(KNOWN_TOOL_NAMES);
    for (const name of builtinToolRegistry.names()) {
      expect(known.has(name)).toBe(true);
    }
  });
});

describe('read_file migration (S1.2)', () => {
  test('registry parses read_file identically to the legacy request shape', () => {
    const parsed = builtinToolRegistry.parseToolCall(
      { id: 'tc1', name: 'read_file', args: { path: 'src/index.ts', offset: 10, limit: 50 } },
      CTX,
    );
    expect(parsed).toEqual({
      ok: true,
      id: 'tc1',
      name: 'read_file',
      args: { path: 'src/index.ts', offset: 10, limit: 50 },
      reason: 'Model requested read_file',
      protectedCommand: 'read_file src/index.ts',
    });
  });

  test('read_file spec declares read-only effects and user-visible contract', () => {
    const spec = builtinToolRegistry.get('read_file');
    expect(spec).toBeDefined();
    expect(spec?.kind).toBe('computer');
    expect(spec?.declaredEffects).toEqual({
      filesystem: 'read',
      network: 'none',
      externalState: 'none',
    });
    expect(spec?.effects({ path: 'a' }, CTX).effectClass).toBe('read_only');
  });
});

describe('read_file output passthrough', () => {
  test('execute output carries rawContent (fingerprint input) alongside line-numbered model content', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-conformance-raw-'));
    try {
      writeFileSync(join(workspace, 'a.txt'), 'hello\n');
      const outcome = await dispatchRegisteredTool(readFileSpec, { path: 'a.txt' }, { workspace });
      expect(outcome.dispatched).toBe(true);
      if (outcome.dispatched) {
        // rawContent 是原始文本（读取状态指纹输入），content 仍是带行号的模型表面格式。
        expect(outcome.output.rawContent).toBe('hello\n');
        expect(outcome.output.content).toContain('1|hello');
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('session read tracker (ADR-0025 §1)', () => {
  test('record/check lifecycle: not_read → fresh → stale', () => {
    const tracker = sessionReadTracker('conformance-test-thread');
    expect(tracker.check('/w/a.ts', 'h1')).toBe('not_read');
    tracker.record('/w/a.ts', 'h1');
    expect(tracker.check('/w/a.ts', 'h1')).toBe('fresh');
    expect(tracker.check('/w/a.ts', 'h2')).toBe('stale');
    expect(tracker.check('/w/a.ts', null)).toBe('stale');
  });
});

describe('edit_file read-before-write enforcement (ADR-0025 §1)', () => {
  const EDIT_INPUT = { path: 'x.ts', old_string: 'a', new_string: 'b' };

  test('not_read rejects before execute', async () => {
    const outcome = await dispatchRegisteredTool(editFileSpec, EDIT_INPUT, {
      workspace: '/tmp',
      writeTarget: { path: 'x.ts', readState: 'not_read' },
    });
    expect(outcome.dispatched).toBe(false);
    if (!outcome.dispatched) {
      expect(outcome.rejection.error).toContain('has not been read yet');
    }
  });

  test('stale rejects before execute', async () => {
    const outcome = await dispatchRegisteredTool(editFileSpec, EDIT_INPUT, {
      workspace: '/tmp',
      writeTarget: { path: 'x.ts', readState: 'stale' },
    });
    expect(outcome.dispatched).toBe(false);
    if (!outcome.dispatched) {
      expect(outcome.rejection.error).toContain('has been modified since');
    }
  });

  test('fresh passes the preExecute gate (filesystem errors surface as output, not rejection)', async () => {
    const outcome = await dispatchRegisteredTool(editFileSpec, EDIT_INPUT, {
      workspace: '/tmp',
      writeTarget: { path: 'definitely-missing.ts', readState: 'fresh' },
    });
    expect(outcome.dispatched).toBe(true);
    if (outcome.dispatched) {
      expect(outcome.output.ok).toBe(false); // File not found — but the gate passed
    }
  });
});

describe('invariant i5 — write tools declare mutation scope', () => {
  test('write sample projects workspaceMutationScope; read sample does not', () => {
    const written = sampleWriteSpec.projectResult({ path: 'a.ts', bytes: 3 }, CTX);
    expect(written.resultMeta.workspaceMutationScope).toEqual(['a.ts']);

    const read = sampleReadSpec.projectResult({ lines: ['x'] }, CTX);
    expect(read.resultMeta.workspaceMutationScope).toBeUndefined();
  });
});

describe('invariant i6 — description is a pure function of contract sections', () => {
  test('toolset and descriptor descriptions equal buildDescription(contract)', () => {
    const registry = sampleRegistry();
    const toolset = registry.toSchemaOnlyToolSet(CTX);
    for (const spec of registry.availableIn(CTX)) {
      expect(toolset[spec.name]?.description).toBe(buildDescription(spec.contract));
      expect(registry.descriptorOf(spec).description).toBe(buildDescription(spec.contract));
    }
  });
});

describe('invariant i9 — descriptor projection is deterministic', () => {
  test('same spec yields same revision; contract change changes revision', () => {
    const registry = createToolRegistry();
    const first = registry.descriptorOf(sampleReadSpec);
    const second = registry.descriptorOf(sampleReadSpec);
    expect(first.capabilityId).toBe('builtin:registry_sample_read');
    expect(first.kind).toBe('builtin_tool');
    expect(first.provider).toEqual({ type: 'builtin', id: 'kite-code', provenance: 'builtin' });
    expect(first.revision).toBe(second.revision);

    const mutated: typeof sampleReadSpec = {
      ...sampleReadSpec,
      contract: {
        ...sampleReadSpec.contract,
        whenToUse: `${sampleReadSpec.contract.whenToUse} (edited)`,
      },
    };
    expect(registry.descriptorOf(mutated).revision).not.toBe(first.revision);
  });
});

describe('invariant i10 — shell governance is derived from command shape', () => {
  test('model-visible schema exposes exactly the three approved fields', () => {
    expect(shellActionEnvelopeSchema.keyof().options.sort()).toEqual([
      'command',
      'description',
      'timeout_ms',
    ]);
  });

  test('schema strips all former model-declared governance fields', () => {
    const parsed = shellExecuteSpec.inputSchema.parse({
      command: 'git status',
      description: 'Inspect repository',
      timeout_ms: 1000,
      intent: 'other',
      objective: 'mutate',
      justification: 'trust me',
      expected_observation: 'changed',
      failure_strategy: 'retry',
      prefix_rule: ['git'],
      grant_request: 'full_access',
    });
    expect(parsed).toEqual({
      command: 'git status',
      description: 'Inspect repository',
      timeout_ms: 1000,
    });
    expect(shellExecuteSpec.effects(parsed, CTX).effectClass).toBe('read_only');
    expect(classifyShellActionIntent(parsed.command)).toBe('git');
  });

  test('read-only fast-path corpus remains command-driven', () => {
    for (const command of ['ls -la', 'pwd', 'git status', 'git diff --stat', 'rg TODO src']) {
      const effects = shellExecuteSpec.effects({ command }, CTX);
      expect(effects.effectClass, command).toBe('read_only');
      expect(effects.sideEffect, command).toBe(false);
    }
  });

  test('dispatch preserves execution context and runner derives action metadata', async () => {
    const progress: string[] = [];
    const result = await runApprovedTool({
      workspace: '/tmp/sample',
      request: {
        id: 'shell-read',
        name: 'shell_execute',
        args: { command: 'git status', description: 'Inspect repository', timeout_ms: 3210 },
        reason: 'inspect',
        protectedCommand: 'git status',
      },
      onShellProgress: (chunk) => progress.push(chunk),
      shellExecutor: async (input) => {
        expect(input.timeoutMs).toBe(3210);
        input.onProgress?.('status', 'stdout');
        return {
          ok: true,
          command: input.command,
          exitCode: 0,
          stdout: 'clean',
          stderr: '',
        };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.action).toEqual({ intent: 'git', grantUsed: 'none' });
    expect(progress).toEqual(['status']);
  });
});

describe('dispatch — spec execution sequence', () => {
  test('runs execute then projectResult on the success path', async () => {
    const outcome = await dispatchRegisteredTool(
      sampleWriteSpec,
      { path: 'a.ts', content: 'hello' },
      CTX,
    );
    expect(outcome.dispatched).toBe(true);
    if (outcome.dispatched) {
      expect(outcome.output).toEqual({ path: 'a.ts', bytes: 5 });
      expect(outcome.projected.modelContent).toBe('Wrote 5 bytes to a.ts');
      expect(outcome.projected.resultMeta.workspaceMutationScope).toEqual(['a.ts']);
    }
  });

  test('preExecute rejection fails fast without executing', async () => {
    const guarded: ToolSpec<{ path: string; content: string }, SampleWriteOutput> = {
      ...sampleWriteSpec,
      preExecute: (input) =>
        input.path.endsWith('protected.ts')
          ? {
              proceed: false,
              rejection: {
                ok: false,
                error: 'File has not been read yet.',
                guidance: 'Read the file first, then retry the edit.',
              },
            }
          : { proceed: true },
    };
    const rejected = await dispatchRegisteredTool(
      guarded,
      { path: 'x/protected.ts', content: '' },
      CTX,
    );
    expect(rejected.dispatched).toBe(false);
    if (!rejected.dispatched) {
      expect(rejected.rejection.error).toBe('File has not been read yet.');
    }

    const allowed = await dispatchRegisteredTool(guarded, { path: 'x/open.ts', content: 'y' }, CTX);
    expect(allowed.dispatched).toBe(true);
  });
});
