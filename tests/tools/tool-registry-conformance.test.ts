import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { toolRequestFromCall } from '@/core/harness/tool-requests';
import { runApprovedTool } from '@/core/harness/tool-runner';
import { POLICY_CLASSIFIED_TOOL_NAMES } from '@/core/policies/tool-capabilities';
import { createAgentTools, toolAvailabilityContext } from '@/core/tools/definitions';
import { sessionReadTracker } from '@/core/tools/read-state';
import {
  builtinToolRegistry,
  type builtinToolSpecs,
  type PendingBuiltinToolRequest,
} from '@/core/tools/registry/builtins';
import { type askUserInputSchema, askUserSpec } from '@/core/tools/registry/builtins/ask-user';
import { type editFileInputSchema, editFileSpec } from '@/core/tools/registry/builtins/edit-file';
import { type readFileInputSchema, readFileSpec } from '@/core/tools/registry/builtins/read-file';
import {
  type searchContentInputSchema,
  searchContentSpec,
} from '@/core/tools/registry/builtins/search-content';
import {
  type searchFilesInputSchema,
  searchFilesSpec,
} from '@/core/tools/registry/builtins/search-files';
import {
  classifyShellActionIntent,
  projectedShellIntent,
  shellActionEnvelopeSchema,
  shellExecuteSpec,
} from '@/core/tools/registry/builtins/shell-execute';
import {
  type writeFileInputSchema,
  writeFileSpec,
} from '@/core/tools/registry/builtins/write-file';
import type { writePlanInputSchema } from '@/core/tools/registry/builtins/write-plan';
import { dispatchRegisteredTool } from '@/core/tools/registry/dispatch';
import { truncateProjectedOutput } from '@/core/tools/registry/projection';
import { createToolRegistry } from '@/core/tools/registry/registry';
import type { ToolContext } from '@/core/tools/registry/spec';
import { defineExecutableTool } from '@/core/tools/registry/spec';
import { TOOL_RESULT_BUDGET_POLICY_V1 } from '@/core/tools/result-budget';
import type { ShellExecutor } from '@/core/tools/shell';
import {
  buildDescription,
  KNOWN_TOOL_NAMES,
  normalizeToolContract,
} from '@/core/tools/tool-contracts';

/**
 * ToolSpec Registry 一致性测试（ADR-0043 §5 / RFC §5）。
 *
 * 不变量编号与 RFC §5 表格一致：i1 args 透传恒等、i2 schema-only、
 * i3 Policy 名集闭合、i4 KNOWN_TOOL_NAMES 棘轮、i5 写工具 mutation scope、
 * i6 描述纯函数、i9 revision 确定性。i10（shell 分类不读治理参数）
 * 随阶段 1.2 shell 迁移以参数面断言补齐。
 */

const CTX: ToolContext = { workspace: '/tmp/sample' };

// ── 测试本地样例 spec（名称带 registry_sample_ 前缀，永不进入生产 Registry） ──

const sampleReadSpec = defineExecutableTool({
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
  execute: async (input) => ({ lines: [input.path, String(input.limit ?? 'all')] as string[] }),
  projectResult: (output) => ({
    ok: true,
    modelContent: output.lines.join('\n'),
    resultMeta: {},
    display: { verb: 'Read' },
  }),
});

const sampleWriteSpec = defineExecutableTool({
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
});

function sampleRegistry() {
  return createToolRegistry().register(sampleReadSpec).register(sampleWriteSpec);
}

describe('ToolSpec Registry — registration behavior', () => {
  test('registers existing L1 limits without changing the 4000-character projection bytes', () => {
    expect(TOOL_RESULT_BUDGET_POLICY_V1).toEqual({
      version: 1,
      policyId: 'tool-result-budget:v1',
      shellSearchStreamMaxChars: 4_000,
      mcpModelResultMaxChars: 128 * 1_024,
    });
    expect(truncateProjectedOutput('a'.repeat(3_999))).toBe('a'.repeat(3_999));
    expect(truncateProjectedOutput('a'.repeat(4_000))).toBe('a'.repeat(4_000));
    const projected = truncateProjectedOutput('a'.repeat(4_001));
    expect(projected).toBe(
      `${'a'.repeat(2_000)}\n... [1 lines omitted, 1 total chars truncated]\n${'a'.repeat(2_000)}`,
    );
  });

  test('rejects duplicate registration', () => {
    expect(() => sampleRegistry().register(sampleReadSpec)).toThrow('already registered');
  });

  test('rejects names that are not stable snake_case', () => {
    for (const bad of ['Read', 'read-file', 'read_file ', '1read', '']) {
      const spec = { ...sampleReadSpec, name: bad };
      expect(() => createToolRegistry().register(spec)).toThrow('snake_case');
    }
  });

  test('returns ParseFailure for unknown tool names so the existing rejection path handles them', () => {
    const registry = sampleRegistry();
    const result = registry.parseToolCall({ name: 'never_registered', args: {} }, CTX);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unknown_tool');
  });

  test('rejects invalid arguments with a structured failure instead of dropping fields', () => {
    const registry = sampleRegistry();
    const missing = registry.parseToolCall(
      { id: 'c1', name: 'registry_sample_read', args: {} },
      CTX,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('invalid_arguments');

    const wrongType = registry.parseToolCall(
      { name: 'registry_sample_read', args: { path: 42 } },
      CTX,
    );
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.code).toBe('invalid_arguments');
  });

  test('availability gates toolset, parsing and listing', () => {
    const gated = defineExecutableTool({
      ...sampleReadSpec,
      name: 'registry_sample_gated',
      availability: (context: ToolContext) => context.workspace === '/allowed',
    });
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
      ).ok,
    ).toBe(false);
  });
});

describe('toolRequestFromCall — parseFailureCode propagation', () => {
  test('invalid_arguments is preserved on InvalidToolRequest from Registry schema failure', () => {
    // write_file has required 'path' and 'content' fields; empty args triggers schema
    // validation failure which flows: Registry.parseToolCall(invalid_arguments)
    // → toolRequestFromCall → InvalidToolRequest with parseFailureCode
    const result = toolRequestFromCall(
      { id: 'e1', name: 'write_file', args: {} },
      { workspace: '/tmp/sample' },
    );
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.request.parseFailureCode).toBe('invalid_arguments');
      expect(result.request.parseError).toBeTruthy();
    }
  });

  test('unknown tool returns null (handled by controller as tool_not_found)', () => {
    const result = toolRequestFromCall(
      { id: 'e2', name: 'nonexistent_tool', args: {} },
      { workspace: '/tmp/sample' },
    );
    expect(result).toBeNull();
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

describe('ToolSpec kind union', () => {
  test('interrupt specs cannot expose an execute or projectResult function', () => {
    expect(askUserSpec.kind).toBe('interrupt');
    expect('execute' in askUserSpec).toBe(false);
    expect('projectResult' in askUserSpec).toBe(false);
    expect(
      askUserSpec.createInterrupt(
        {
          questions: [
            {
              question: 'Continue?',
              options: [
                {
                  label: 'Yes',
                  description: 'Continue with the current approach.',
                  recommended: true,
                },
                {
                  label: 'No',
                  description: 'Stop and reconsider the approach.',
                  recommended: false,
                },
              ],
            },
          ],
        },
        CTX,
      ),
    ).toEqual({
      question: 'Continue?',
      options: [
        {
          id: 'q1-o1',
          label: 'Yes',
          description: 'Continue with the current approach.',
        },
        {
          id: 'q1-o2',
          label: 'No',
          description: 'Stop and reconsider the approach.',
        },
      ],
      recommended: 'q1-o1',
      allow_free_text: true,
      questions: [
        {
          id: 'q1',
          question: 'Continue?',
          options: [
            {
              id: 'q1-o1',
              label: 'Yes',
              description: 'Continue with the current approach.',
            },
            {
              id: 'q1-o2',
              label: 'No',
              description: 'Stop and reconsider the approach.',
            },
          ],
          recommended: 'q1-o1',
          allow_free_text: true,
        },
      ],
    });
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

  test('production model surface exactly equals Registry availability', () => {
    const input = {
      workspace: '/tmp/sample',
      toolSearch: true,
    };
    const context = toolAvailabilityContext(input);
    const toolset = createAgentTools(input);
    expect(Object.keys(toolset).sort()).toEqual(
      builtinToolRegistry
        .availableIn(context)
        .map((spec) => spec.name)
        .sort(),
    );
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
  test('migration is closed: known names exactly equal production Registry names', () => {
    expect(builtinToolRegistry.names()).toEqual([...KNOWN_TOOL_NAMES].sort());
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
      source: 'builtin',
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

describe('session read tracker (ADR-0042 §1)', () => {
  test('record/check lifecycle: not_read → fresh → stale', () => {
    const tracker = sessionReadTracker('conformance-test-thread');
    expect(tracker.check('/w/a.ts', 'h1')).toBe('not_read');
    tracker.record('/w/a.ts', 'h1');
    expect(tracker.check('/w/a.ts', 'h1')).toBe('fresh');
    expect(tracker.check('/w/a.ts', 'h2')).toBe('stale');
    expect(tracker.check('/w/a.ts', null)).toBe('stale');
  });
});

describe('edit_file read-before-write enforcement (ADR-0042 §1)', () => {
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
      writeTarget: { path: 'x.ts', readState: 'fresh' },
    });
    expect(outcome.dispatched).toBe(true);
    if (outcome.dispatched) {
      expect(outcome.output.ok).toBe(false); // File not found — but the gate passed
    }
  });

  test('missing writeTarget rejects before execute', async () => {
    const outcome = await dispatchRegisteredTool(editFileSpec, EDIT_INPUT, {
      workspace: '/tmp',
    });
    expect(outcome.dispatched).toBe(false);
    if (!outcome.dispatched) {
      expect(outcome.rejection.error).toContain('Missing verified read state');
    }
  });

  test('mismatched writeTarget.path rejects before execute', async () => {
    const outcome = await dispatchRegisteredTool(editFileSpec, EDIT_INPUT, {
      workspace: '/tmp',
      writeTarget: { path: 'other.ts', readState: 'fresh' },
    });
    expect(outcome.dispatched).toBe(false);
    if (!outcome.dispatched) {
      expect(outcome.rejection.error).toContain('does not match');
    }
  });

  test('writeTarget with undefined readState rejects before execute', async () => {
    const outcome = await dispatchRegisteredTool(editFileSpec, EDIT_INPUT, {
      workspace: '/tmp',
      writeTarget: { path: 'x.ts' },
    });
    expect(outcome.dispatched).toBe(false);
    if (!outcome.dispatched) {
      expect(outcome.rejection.error).toContain('read state');
    }
  });
});

describe('invariant i5 — write tools declare mutation scope', () => {
  test('write sample projects workspaceMutationScope; read sample does not', () => {
    const written = sampleWriteSpec.projectResult(
      { path: 'a.ts', bytes: 3 },
      { ...CTX, invocationInput: { path: 'a.ts', content: 'abc' } },
    );
    expect(written.resultMeta.workspaceMutationScope).toEqual(['a.ts']);

    const read = sampleReadSpec.projectResult(
      { lines: ['x'] },
      { ...CTX, invocationInput: { path: 'a.ts' } },
    );
    expect(read.resultMeta.workspaceMutationScope).toBeUndefined();
  });
});

describe('projectResult production closure', () => {
  test('write_file runner result is the spec projection used by the final tool result', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-projection-'));
    try {
      const request = {
        source: 'builtin' as const,
        id: 'write-projection',
        name: 'write_file' as const,
        args: { path: 'a.txt', content: 'hello\n' },
        reason: 'test',
        protectedCommand: 'write_file a.txt',
      };
      const actual = await runApprovedTool({
        workspace,
        request,
        phase: 'building',
        interactionMode: 'accept_edits',
      });
      const expected = writeFileSpec.projectResult(
        { ok: true, path: 'a.txt', lines: 1 },
        {
          workspace,
          invocationInput: request.args,
          writeTarget: { path: 'a.txt', existed: false },
        },
      );
      expect(actual.stdout).toBe(expected.modelContent);
      expect(actual.resultMeta).toEqual(expected.resultMeta);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('dual output streams survive projection (regression)', () => {
  const SHELL_REQUEST = {
    source: 'builtin' as const,
    id: 'shell-dual',
    name: 'shell_execute' as const,
    args: { command: 'make ci' },
    reason: 'test',
    protectedCommand: 'make ci',
  };

  test('shell_execute failure preserves stdout and stderr independently', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-dual-stream-'));
    try {
      const raw = {
        ok: false,
        command: 'make ci',
        exitCode: 1,
        stdout: 'partial output before failure',
        stderr: 'make: *** [ci] Error 1',
      };
      const shellExecutor: ShellExecutor = async () => raw;
      const actual = await runApprovedTool({
        workspace,
        request: SHELL_REQUEST,
        shellExecutor,
        phase: 'building',
        interactionMode: 'full',
        authorization: { mode: 'full_access', commandGrants: {} },
      });
      const expected = shellExecuteSpec.projectResult(raw, {
        workspace,
        invocationInput: { command: 'make ci' },
      });
      expect(actual.ok).toBe(false);
      // 回归断言：失败命令的 stdout（测试输出、部分匹配）不得被投影丢弃。
      expect(actual.stdout).toBe('partial output before failure');
      expect(actual.stderr).toBe('make: *** [ci] Error 1');
      expect(actual.resultMeta).toEqual(expected.resultMeta);
      expect(actual.action?.intent).toBe('other');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('shell_execute success preserves stderr warnings', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-dual-stream-'));
    try {
      const raw = {
        ok: true,
        command: 'make ci',
        exitCode: 0,
        stdout: 'all tests passed',
        stderr: 'npm warn deprecated',
      };
      const shellExecutor: ShellExecutor = async () => raw;
      const actual = await runApprovedTool({
        workspace,
        request: SHELL_REQUEST,
        shellExecutor,
        phase: 'building',
        interactionMode: 'full',
        authorization: { mode: 'full_access', commandGrants: {} },
      });
      expect(actual.ok).toBe(true);
      expect(actual.stdout).toBe('all tests passed');
      // 回归断言：成功命令的 stderr 警告不得被投影丢弃。
      expect(actual.stderr).toBe('npm warn deprecated');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('search projections keep both streams on failure and truncate per stream', () => {
    const longOut = 'match-line\n'.repeat(800);
    const raw = {
      ok: false,
      command: 'rg x',
      exitCode: 2,
      stdout: longOut,
      stderr: 'rg: regex parse error',
    };
    const content = searchContentSpec.projectResult(raw, {
      workspace: '/w',
      invocationInput: { pattern: 'x', path: 'src' },
    });
    expect(content.streams?.stderr).toBe('rg: regex parse error');
    expect(content.streams?.stdout).toContain('lines omitted');
    expect(content.resultMeta.truncated).toBe(true);
    expect(content.resultMeta.matchCount).toBe(800);

    const files = searchFilesSpec.projectResult(raw, {
      workspace: '/w',
      invocationInput: { pattern: 'x' },
    });
    expect(files.streams?.stderr).toBe('rg: regex parse error');
    expect(files.streams?.stdout).toContain('lines omitted');
  });

  test('projectedShellIntent validates resultMeta instead of blind casting', () => {
    expect(projectedShellIntent({ intent: 'git' })).toBe('git');
    expect(projectedShellIntent({ intent: 'not-an-intent' })).toBe('other');
    expect(projectedShellIntent({})).toBe('other');
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

    const normalized = normalizeToolContract(sampleReadSpec.contract);
    const mutated: typeof sampleReadSpec = {
      ...sampleReadSpec,
      contract: {
        ...normalized,
        summary: `${normalized.summary} (edited)`,
      },
    };
    expect(registry.descriptorOf(mutated).revision).not.toBe(first.revision);
  });

  test('schema changes alter descriptor revision', () => {
    const registry = createToolRegistry();
    const first = registry.descriptorOf(sampleReadSpec);
    const mutated: typeof sampleReadSpec = {
      ...sampleReadSpec,
      inputSchema: z.object({
        path: z.string(),
        limit: z.number().int().min(1).optional(),
      }),
    };
    expect(registry.descriptorOf(mutated).inputSchema).toBeDefined();
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
        source: 'builtin' as const,
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
    const guarded = defineExecutableTool({
      ...sampleWriteSpec,
      preExecute: (input: { path: string; content: string }) =>
        input.path.endsWith('protected.ts')
          ? {
              proceed: false,
              rejection: {
                ok: false,
                error: 'File has not been read yet.',
                guidance: 'Read the file first, then retry the edit.',
              } as const,
            }
          : { proceed: true },
    });
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

// ── 编译期 name → args 关联测试（ADR-0043 §5 不变量 i1） ──
// Compile-time name→args association tests (ADR-0043 §5 invariant i1).

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Expect<T extends true> = T;

// --- i1.1 name === 'read_file' ⇒ args 类型匹配 Schema ---
type ReadRequest = Extract<PendingBuiltinToolRequest, { name: 'read_file' }>;
type ReadArgsMatchSchema = Expect<Equal<ReadRequest['args'], z.infer<typeof readFileInputSchema>>>;

// --- i1.2 name === 'write_file' ⇒ args 类型匹配 Schema ---
type WriteRequest = Extract<PendingBuiltinToolRequest, { name: 'write_file' }>;
type WriteArgsMatchSchema = Expect<
  Equal<WriteRequest['args'], z.infer<typeof writeFileInputSchema>>
>;

// --- i1.3 name === 'edit_file' ⇒ args 类型匹配 Schema ---
type EditRequest = Extract<PendingBuiltinToolRequest, { name: 'edit_file' }>;
type EditArgsMatchSchema = Expect<Equal<EditRequest['args'], z.infer<typeof editFileInputSchema>>>;

// --- i1.4 name === 'search_content' ⇒ args 类型匹配 Schema ---
type SearchContentRequest = Extract<PendingBuiltinToolRequest, { name: 'search_content' }>;
type SearchContentArgsMatchSchema = Expect<
  Equal<SearchContentRequest['args'], z.infer<typeof searchContentInputSchema>>
>;

// --- i1.5 name === 'search_files' ⇒ args 类型匹配 Schema ---
type SearchFilesRequest = Extract<PendingBuiltinToolRequest, { name: 'search_files' }>;
type SearchFilesArgsMatchSchema = Expect<
  Equal<SearchFilesRequest['args'], z.infer<typeof searchFilesInputSchema>>
>;

// --- 编译期覆盖检查：每个 const tuple 元素必须在 PendingBuiltinToolRequest 中可找到 ---
// Compile-time coverage check: every spec in the const tuple must have
// a matching member in PendingBuiltinToolRequest.

type BuiltinSpec = (typeof builtinToolSpecs)[number];
type BuiltinName = BuiltinSpec['name'];

type NamesFromUnion = PendingBuiltinToolRequest['name'];
type AllBuiltinNamesCovered = Expect<Equal<BuiltinName, NamesFromUnion>>;

// --- i1.6 name === 'ask_user' ⇒ args 匹配规范模型输入 Schema ---
type AskUserRequest = Extract<PendingBuiltinToolRequest, { name: 'ask_user' }>;
type AskUserArgsMatchSchema = Expect<
  Equal<AskUserRequest['args'], z.infer<typeof askUserInputSchema>>
>;

// --- i1.7 name === 'write_plan' ⇒ action 可选（save 模式无需显式 action） ---
type WritePlanRequest = Extract<PendingBuiltinToolRequest, { name: 'write_plan' }>;
type WritePlanArgsMatchSchema = Expect<
  Equal<WritePlanRequest['args'], z.infer<typeof writePlanInputSchema>>
>;

// 运行时占位符，消耗编译期类型变量以通过 noUnusedLocals
describe('compile-time name → args invariants', () => {
  test('read_file args match schema', () => {
    const _assert: ReadArgsMatchSchema = true;
    expect(_assert).toBe(true);
  });

  test('write_file args match schema', () => {
    const _assert: WriteArgsMatchSchema = true;
    expect(_assert).toBe(true);
  });

  test('edit_file args match schema', () => {
    const _assert: EditArgsMatchSchema = true;
    expect(_assert).toBe(true);
  });

  test('search_content args match schema', () => {
    const _assert: SearchContentArgsMatchSchema = true;
    expect(_assert).toBe(true);
  });

  test('search_files args match schema', () => {
    const _assert: SearchFilesArgsMatchSchema = true;
    expect(_assert).toBe(true);
  });

  test('all builtin names covered in PendingBuiltinToolRequest', () => {
    const _assert: AllBuiltinNamesCovered = true;
    expect(_assert).toBe(true);
  });

  test('ask_user args match the canonical model input schema', () => {
    const _assert: AskUserArgsMatchSchema = true;
    expect(_assert).toBe(true);
  });

  test('write_plan args match schema (action optional)', () => {
    const _assert: WritePlanArgsMatchSchema = true;
    expect(_assert).toBe(true);
  });
});
