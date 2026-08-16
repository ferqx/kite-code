import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { toolFinishedEvent } from '@/core/controllers/tool-controller';
import { toolRequestFromCall } from '@/core/harness/tool-requests';
import { invokeGovernedTool, recoveryGuidanceForTool } from '@/core/harness/tool-runner';
import { isToolMessage } from '@/core/messages';
import { buildContextProjection } from '@/core/model/context-projection';
import { POLICY_CLASSIFIED_TOOL_NAMES } from '@/core/policies/tool-capabilities';
import { AgentKernel } from '@/core/runtime/kernel';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';
import { normalizeCurrentToolOutcomeEventV1 } from '@/core/runtime/tool-outcome-events';
import type { SkillCatalogSnapshot } from '@/core/skills';
import { createAgentTools, toolAvailabilityContext } from '@/core/tools/definitions';
import { DEFAULT_READ_FILE_LINE_LIMIT } from '@/core/tools/file';
import { sessionReadTracker } from '@/core/tools/read-state';
import {
  builtinToolRegistry,
  builtinToolSpecs,
  type PendingBuiltinToolRequest,
} from '@/core/tools/registry/builtins';
import { type askUserInputSchema, askUserSpec } from '@/core/tools/registry/builtins/ask-user';
import { type editFileInputSchema, editFileSpec } from '@/core/tools/registry/builtins/edit-file';
import {
  MAX_MODEL_READ_FILE_CHARS,
  type readFileInputSchema,
  readFileSpec,
} from '@/core/tools/registry/builtins/read-file';
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
import { taskSpec } from '@/core/tools/registry/builtins/task';
import {
  type writeFileInputSchema,
  writeFileSpec,
} from '@/core/tools/registry/builtins/write-file';
import type { writePlanInputSchema } from '@/core/tools/registry/builtins/write-plan';
import { dispatchRegisteredTool } from '@/core/tools/registry/dispatch';
import { createToolRegistry } from '@/core/tools/registry/registry';
import type { ExecutableToolSpec, ToolContext } from '@/core/tools/registry/spec';
import { defineExecutableTool } from '@/core/tools/registry/spec';
import type { ShellExecutor } from '@/core/tools/shell';
import {
  buildDescription,
  KNOWN_TOOL_NAMES,
  normalizeToolContract,
} from '@/core/tools/tool-contracts';
import { executeTestRuntimeToolsV1 as executeRuntimeTools } from '../helpers/runtime-model';

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
  }),
});

function sampleRegistry() {
  return createToolRegistry().register(sampleReadSpec).register(sampleWriteSpec);
}

describe('ToolSpec Registry — registration behavior', () => {
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

  test('unknown_tool remains structured so Controller can select tool_not_found recovery', () => {
    const result = toolRequestFromCall(
      { id: 'e2', name: 'nonexistent_tool', args: {} },
      { workspace: '/tmp/sample' },
    );
    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.request.parseFailureCode).toBe('unknown_tool');
    }
  });

  test('tool_unavailable remains structured instead of becoming invalid arguments', () => {
    const result = toolRequestFromCall(
      { id: 'e3', name: 'tool_search', args: { query: 'database capability' } },
      { workspace: '/tmp/sample', toolSearchEnabled: false },
    );
    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.request.parseFailureCode).toBe('tool_unavailable');
    }
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

  test('bounds the complete model result and reports an accurate line continuation', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-conformance-read-budget-'));
    try {
      const lines = Array.from({ length: 2_500 }, (_, index) => {
        return `${index + 1}:${'x'.repeat(80)}`;
      });
      writeFileSync(join(workspace, 'large.txt'), `${lines.join('\n')}\n`);
      const outcome = await dispatchRegisteredTool(
        readFileSpec,
        { path: 'large.txt', limit: 2_500 },
        { workspace },
      );
      expect(outcome.dispatched).toBe(true);
      if (!outcome.dispatched) return;

      expect(outcome.projected.modelContent.length).toBeLessThanOrEqual(MAX_MODEL_READ_FILE_CHARS);
      const expectedRawDigest = createHash('sha256')
        .update(JSON.stringify({ stdout: outcome.output.content, stderr: '', exitCode: 0 }))
        .digest('hex');
      expect(outcome.projected.resultMeta).toMatchObject({
        path: 'large.txt',
        totalLines: 2_500,
        truncated: true,
        rawResultDigest: expectedRawDigest,
      });
      const match = outcome.projected.modelContent.match(/continue with offset=(\d+)/u);
      expect(match).not.toBeNull();
      const nextOffset = Number(match?.[1]);
      const lastVisibleLine = outcome.projected.modelContent
        .split('\n')
        .at(-2)
        ?.match(/^\s*(\d+)\|/u);
      expect(nextOffset).toBe(Number(lastVisibleLine?.[1]) + 1);

      const continuation = await dispatchRegisteredTool(
        readFileSpec,
        { path: 'large.txt', offset: nextOffset, limit: 1 },
        { workspace },
      );
      expect(continuation.dispatched).toBe(true);
      if (continuation.dispatched) {
        expect(continuation.projected.modelContent).toContain(
          `${nextOffset}|${nextOffset}:${'x'.repeat(80)}`,
        );
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('clips one oversized source line without claiming line-offset continuation', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-conformance-read-long-line-'));
    try {
      const raw = 'x'.repeat(MAX_MODEL_READ_FILE_CHARS * 2);
      writeFileSync(join(workspace, 'minified.js'), raw);
      const outcome = await dispatchRegisteredTool(
        readFileSpec,
        { path: 'minified.js' },
        { workspace },
      );
      expect(outcome.dispatched).toBe(true);
      if (!outcome.dispatched) return;

      expect(outcome.output.rawContent).toBe(raw);
      expect(outcome.output.toLine).toBe(1);
      expect(outcome.projected.modelContent.length).toBeLessThanOrEqual(MAX_MODEL_READ_FILE_CHARS);
      expect(outcome.projected.modelContent).toContain('line 1 clipped');
      expect(outcome.projected.modelContent).toContain(
        'line offset cannot continue within this line',
      );
      expect(outcome.projected.modelContent).not.toContain('continue with offset=');
      expect(outcome.projected.resultMeta.truncated).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('omitted limit advertises the next default page without losing read-state raw content', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-conformance-read-default-marker-'));
    try {
      const lines = Array.from({ length: DEFAULT_READ_FILE_LINE_LIMIT + 1 }, (_, index) => {
        return `line-${index + 1}`;
      });
      const raw = `${lines.join('\n')}\n`;
      writeFileSync(join(workspace, 'paged.txt'), raw);
      const outcome = await dispatchRegisteredTool(
        readFileSpec,
        { path: 'paged.txt' },
        { workspace },
      );
      expect(outcome.dispatched).toBe(true);
      if (!outcome.dispatched) return;

      expect(outcome.output.rawContent).toBe(raw);
      expect(outcome.output.toLine).toBe(DEFAULT_READ_FILE_LINE_LIMIT);
      expect(outcome.projected.modelContent).toContain(
        `continue with offset=${DEFAULT_READ_FILE_LINE_LIMIT + 1}`,
      );
      expect(outcome.projected.resultMeta.truncated).toBe(true);
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
  test('task model projection exposes only the explicit public result allowlist', () => {
    const projected = taskSpec.projectResult(
      {
        available: true,
        result: {
          ok: false,
          summary: 'Public child summary.',
          error: 'Public child error.',
          toolCallCount: 3,
          durationMs: 42,
          executionJournal: [{ fingerprint: 'private-execution-journal' }],
          exhaustedFingerprints: { 'private-exhausted': true },
          toolRecovery: {
            identityKey: 'private-recovery-key',
            failures: { private_failure: { invocationFingerprint: 'private-fingerprint' } },
          },
          blocked: {
            continuation: { id: 'private-continuation', task: 'private-child-task' },
          },
          steps: [{ toolName: 'read_file', toolArgs: { path: '/private/path' } }],
        } as never,
      },
      { workspace: '/workspace', invocationInput: { subagent_type: 'explore', task: 'inspect' } },
    );

    expect(JSON.parse(projected.modelContent)).toEqual({
      ok: false,
      summary: 'Public child summary.',
      error: 'Public child error.',
      toolCallCount: 3,
      durationMs: 42,
    });
    expect(projected.modelContent).not.toContain('private-');
  });

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
      const actual = await invokeGovernedTool({
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
      const actual = await invokeGovernedTool({
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
      const actual = await invokeGovernedTool({
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

  test('shell failure dual streams flow through Runner, Controller terminal, reducer, and provider context', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-shell-public-projection-'));
    const raw = {
      ok: false,
      command: 'pwd',
      exitCode: 1,
      stdout: 'partial stdout',
      stderr: 'authoritative stderr failure',
    };
    const shellExecutor: ShellExecutor = async () => raw;
    const expected = shellExecuteSpec.projectResult(raw, {
      workspace,
      invocationInput: { command: 'pwd' },
    });
    const initialState = createInitialRuntimeState({
      threadId: 'shell-public-projection',
      userId: 'fixture',
      workspace,
    });
    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState,
      interactionMode: 'accept_edits',
    });
    try {
      kernel.processEvent({
        type: 'model.responded',
        messageId: 'shell-model',
        text: 'Inspect the workspace.',
        toolCalls: [{ id: 'shell', name: 'shell_execute', args: { command: 'pwd' } }],
      });
      kernel.processEvent({
        type: 'tool.queued',
        toolCallId: 'shell',
        modelMessageId: 'shell-model',
        name: 'shell_execute',
        args: { command: 'pwd' },
        ordinal: 0,
        effectClass: 'read_only',
        sideEffect: false,
      });
      const state = kernel.getState();
      const runnerResult = await invokeGovernedTool({
        workspace,
        request: {
          source: 'builtin',
          id: 'shell',
          name: 'shell_execute',
          args: { command: 'pwd' },
          reason: 'fixture',
          protectedCommand: 'pwd',
        },
        shellExecutor,
      });
      expect(runnerResult.stdout).toBe(raw.stdout);
      expect(runnerResult.stderr).toBe(raw.stderr);
      expect(expected.modelContent).toBe(raw.stderr);
      expect(normalizeToolContract(shellExecuteSpec.contract).returns).toMatchObject({
        format: 'text',
      });

      const controllerEvents = await executeRuntimeTools({
        state,
        toolCallIds: ['shell'],
        shellExecutor,
      });
      const terminal = controllerEvents.find((event) => event.type === 'tool.finished');
      if (terminal?.type !== 'tool.finished') {
        throw new Error('expected shell controller to emit tool.finished');
      }
      expect(terminal).toMatchObject({
        type: 'tool.finished',
        result: { ok: false, stdout: raw.stdout, stderr: raw.stderr },
      });
      const expectedModelContentDigest = createHash('sha256')
        .update(expected.modelContent)
        .digest('hex');
      expect(terminal.result.resultMeta?.modelContentDigest).toBe(expectedModelContentDigest);
      expect(terminal.result.resultMeta?.contentDigest).toBe(expectedModelContentDigest);
      kernel.processEventBatch(controllerEvents);
      const reduced = kernel.getState();
      const transcriptResult = reduced.transcript.messages.find(
        (message) => message.kind === 'tool' && message.toolCallId === 'shell',
      );
      expect(transcriptResult?.content).toBe(expected.modelContent);
      const providerContext = buildContextProjection({
        role: 'agent',
        state: reduced,
        skills: [],
        workflowSkills: [],
      });
      expect(
        providerContext.transcriptMessages.find((message) => isToolMessage(message))?.content,
      ).toBe(expected.modelContent);
    } finally {
      kernel.close();
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

describe('ACORE-CONTRACT-01 — structured builtin contract closure', () => {
  test('all 20 builtin specs own structured selection, parameter, result, and recovery facts', () => {
    expect(builtinToolRegistry.names()).toHaveLength(20);
    for (const spec of builtinToolSpecs) {
      expect('summary' in spec.contract, spec.name).toBe(true);
      const contract = normalizeToolContract(spec.contract);
      expect(contract.summary.length, `${spec.name}: selection summary`).toBeGreaterThan(0);
      expect(contract.useWhen.length, `${spec.name}: selection boundary`).toBeGreaterThan(0);
      expect(contract.constraints?.length, `${spec.name}: parameter constraints`).toBeGreaterThan(
        0,
      );
      expect(contract.returns.description.length, `${spec.name}: result semantics`).toBeGreaterThan(
        0,
      );
      expect(contract.recovery?.length, `${spec.name}: recovery semantics`).toBeGreaterThan(0);
      expect(recoveryGuidanceForTool(spec.name)).toBe(contract.recovery);
      for (const version of ['legacy', 'v2'] as const) {
        const description = buildDescription(spec.contract, version);
        expect(description, `${spec.name}/${version}: summary`).toContain(contract.summary);
        expect(description, `${spec.name}/${version}: selection`).toContain(contract.useWhen);
        expect(description, `${spec.name}/${version}: constraints`).toContain(contract.constraints);
        expect(description, `${spec.name}/${version}: result`).toContain(
          contract.returns.description,
        );
        expect(description, `${spec.name}/${version}: recovery`).toContain(contract.recovery);
      }
    }
  });

  test('projects and independently parses the same resolved schema across real role contexts', async () => {
    const covered = new Set<string>();
    const skillCatalog: SkillCatalogSnapshot = {
      revision: 'skill-catalog-test',
      capabilities: {
        revision: 'skill-capabilities-test',
        descriptors: [
          {
            capabilityId: 'skill:test-workflow',
            revision: 'skill-revision-test',
            kind: 'skill',
            displayName: 'test-workflow',
            description: 'Test workflow.',
            provider: { type: 'skill', id: 'test-workflow', provenance: 'project' },
            declaredEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
            effectiveEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
            policy: { workspaceTrustRequired: false, minimumApproval: 'none' },
            availability: 'available',
            diagnostics: [],
          },
        ],
      },
      entries: [],
    };
    const validArguments: Record<string, Record<string, unknown>> = {
      ask_user: {
        questions: [
          {
            question: 'Choose one?',
            options: [
              { label: 'One', description: 'First choice.', recommended: true },
              { label: 'Two', description: 'Second choice.', recommended: false },
            ],
          },
        ],
      },
      read_file: { path: 'src/index.ts' },
      read_plan: { plan_id: 'plan-1' },
      search_content: { pattern: 'needle' },
      search_files: { pattern: '*.ts' },
      shell_execute: { command: 'pwd' },
      git_inspect: { operation: 'status', paths: ['src/index.ts'] },
      write_file: { path: 'notes.txt', content: 'content' },
      edit_file: { path: 'notes.txt', old_string: 'old', new_string: 'new' },
      web_fetch: { url: 'https://example.com' },
      list_mcp_resources: {},
      list_mcp_tools: {},
      read_mcp_resource: { server: 'fixture', uri: 'file:///fixture' },
      task: { subagent_type: 'plan', task: 'Produce a read-only architecture plan.' },
      tool_search: { query: 'fixture capability' },
      read_skill_reference: { activation_id: 'activation-1', path: 'references/fixture.md' },
      complete_skill: { activation_id: 'activation-1', output: {} },
      activate_skill: { skill_id: 'skill:test-workflow', input: {} },
      update_plan: {
        plan_id: 'plan-1',
        version: 1,
        structural_digest: 'digest',
        updates: [{ step_id: 'step-1', status: 'completed' }],
      },
      write_plan: {
        title: 'Fixture plan',
        body_markdown: 'A sufficiently detailed fixture plan body.',
        steps: [{ id: 'step-1', title: 'First step' }],
      },
    };
    for (const promptContractV2 of [false, true]) {
      for (const phase of ['planning', 'building'] as const) {
        const config = {
          apiKey: '',
          baseURL: 'http://localhost',
          modelName: 'test',
          providerName: 'test',
          providerType: 'openai-compatible' as const,
          sandbox: { enabled: false },
          features: {
            promptContractV2,
            skillWorkflowV1: true,
            skillActivationV2: true,
            brokeredGitV1: true,
          },
        };
        const input = {
          workspace: '/workspace',
          phase,
          config,
          toolSearch: true,
          skillCatalog,
          activeSkillFrames: [{ activationId: 'activation-1' }],
          subagentEventSink: () => {},
          gitBroker: {
            featureRevision: 'brokered-git-r1' as const,
            inspect: async () => ({ ok: true, output: '' }),
            stage: async () => ({ ok: true, output: '' }),
            commit: async () => ({ ok: true, output: '' }),
          },
        };
        const context = {
          ...toolAvailabilityContext(input),
          brokeredGitFeatureRevision: 'brokered-git-r1' as const,
        };
        const projected = createAgentTools(input, context);
        const available = builtinToolRegistry.availableIn(context);
        expect(Object.keys(projected).sort()).toEqual(available.map((spec) => spec.name).sort());
        for (const spec of available) {
          covered.add(spec.name);
          expect(projected[spec.name]?.description).toBe(
            buildDescription(spec.contract, promptContractV2 ? 'v2' : 'legacy'),
          );
          const valid = validArguments[spec.name]!;
          const modelSchema = (
            projected[spec.name] as unknown as {
              inputSchema: {
                jsonSchema: Record<string, unknown>;
                validate(value: unknown): Promise<{ success: boolean; value?: unknown }>;
              };
            }
          ).inputSchema;
          const modelValidation = await modelSchema.validate(valid);
          expect(modelValidation.success, `${spec.name}: provider schema valid`).toBe(true);
          const parsed = builtinToolRegistry.parseToolCall(
            { name: spec.name, args: valid },
            context,
          );
          expect(parsed.ok, `${spec.name}: registry valid`).toBe(true);
          if (parsed.ok) expect(parsed.args as unknown).toEqual(modelValidation.value);

          const resolvedSchema = spec.modelInputSchema?.(context) ?? spec.inputSchema;
          const resolvedJsonSchema = z.toJSONSchema(resolvedSchema) as {
            type?: unknown;
            properties?: Record<string, unknown>;
            required?: string[];
            additionalProperties?: unknown;
          };
          expect(
            {
              type: modelSchema.jsonSchema.type,
              properties: Object.keys(
                (modelSchema.jsonSchema.properties as Record<string, unknown> | undefined) ?? {},
              ).sort(),
              required: modelSchema.jsonSchema.required,
              additionalProperties: modelSchema.jsonSchema.additionalProperties,
            },
            `${spec.name}: independently projected JSON schema`,
          ).toEqual({
            type: resolvedJsonSchema.type,
            properties: Object.keys(resolvedJsonSchema.properties ?? {}).sort(),
            required: resolvedJsonSchema.required,
            additionalProperties: resolvedJsonSchema.additionalProperties,
          });
          const invalid = null;
          const invalidProvider = await modelSchema.validate(invalid);
          const invalidRegistry = builtinToolRegistry.parseToolCall(
            { name: spec.name, args: invalid },
            context,
          );
          expect(invalidProvider.success, `${spec.name}: provider rejects null`).toBe(false);
          expect(invalidRegistry.ok, `${spec.name}: registry rejects null`).toBe(
            invalidProvider.success,
          );

          const privateUnknownName = 'provider_private_prompt_field';
          const privateUnknownValue = '/private/workspace/stdout-secret';
          const unknown = { ...valid, [privateUnknownName]: privateUnknownValue };
          const unknownProvider = await modelSchema.validate(unknown);
          const unknownRegistry = builtinToolRegistry.parseToolCall(
            { name: spec.name, args: unknown },
            context,
          );
          expect(unknownRegistry.ok, `${spec.name}: unknown policy parity`).toBe(
            unknownProvider.success,
          );
          if (unknownRegistry.ok && unknownProvider.success) {
            expect(
              unknownRegistry.args as unknown,
              `${spec.name}: normalized unknown value`,
            ).toEqual(unknownProvider.value);
          }
          const observation = builtinToolRegistry.unknownFieldsOf(spec.name, unknown, context);
          expect(observation, `${spec.name}: unknown fields observed independently`).toMatchObject({
            count: 1,
            hasUnknown: true,
          });
          expect(JSON.stringify(observation)).not.toContain(privateUnknownName);
          expect(JSON.stringify(observation)).not.toContain(privateUnknownValue);
        }
      }
    }
    expect([...covered].sort()).toEqual([...builtinToolRegistry.names()].sort());
  });

  test('declares actual modelContent formats for text and structured projections', () => {
    expect(
      normalizeToolContract(builtinToolRegistry.get('shell_execute')!.contract).returns.format,
    ).toBe('text');
    expect(
      normalizeToolContract(builtinToolRegistry.get('search_content')!.contract).returns.format,
    ).toBe('text');
    expect(
      normalizeToolContract(builtinToolRegistry.get('read_skill_reference')!.contract).returns
        .format,
    ).toBe('json');
  });

  test('projects all 20 builtin results through the canonical reducer and provider context', () => {
    const json = (value: Record<string, unknown>) => JSON.stringify(value);
    const fixtures: Record<string, { input: Record<string, unknown>; output: unknown }> = {
      read_file: {
        input: { path: 'fixture.ts' },
        output: {
          ok: true,
          content: '1: const fixture = true;',
          totalLines: 1,
          path: 'fixture.ts',
        },
      },
      read_plan: {
        input: { plan_id: 'plan-1' },
        output: {
          ok: true,
          stdout: json({
            ok: true,
            status: 'plan_loaded',
            task_id: 'task-1',
            plan_id: 'plan-1',
            version: 1,
            plan_schema_version: 2,
            structural_digest: 'digest',
            title: 'Fixture',
            body_markdown: 'Fixture body',
            steps: [],
            completion_evidence: [],
            artifact: {},
          }),
          stderr: '',
        },
      },
      edit_file: {
        input: { path: 'fixture.ts', old_string: 'old', new_string: 'new' },
        output: { ok: true, path: 'fixture.ts', replacements: 1, lines: 1 },
      },
      write_file: {
        input: { path: 'fixture.ts', content: 'new' },
        output: { ok: true, path: 'fixture.ts', lines: 1 },
      },
      shell_execute: {
        input: { command: 'pwd' },
        output: { ok: true, command: 'pwd', exitCode: 0, stdout: '/workspace', stderr: '' },
      },
      search_content: {
        input: { pattern: 'fixture' },
        output: {
          ok: true,
          command: 'rg fixture',
          exitCode: 0,
          stdout: 'fixture.ts:1',
          stderr: '',
        },
      },
      search_files: {
        input: { pattern: '*.ts' },
        output: { ok: true, command: 'rg --files', exitCode: 0, stdout: 'fixture.ts', stderr: '' },
      },
      tool_search: {
        input: { query: 'fixture' },
        output: {
          ok: true,
          stdout: json({
            ok: true,
            search_id: 'search-1',
            candidate_count: 0,
            candidates: [],
            executable_candidate_count: 0,
            provider_count: 0,
            providers: [],
            next_step: 'none',
          }),
          stderr: '',
          runtimeEvents: [],
        },
      },
      activate_skill: {
        input: { skill_id: 'skill:fixture', input: {} },
        output: {
          ok: true,
          stdout: json({
            ok: true,
            activation_id: 'activation-1',
            skill_id: 'skill:fixture',
            context_mode: 'inline',
          }),
          stderr: '',
          runtimeEvents: [],
        },
      },
      complete_skill: {
        input: { activation_id: 'activation-1', output: {} },
        output: {
          ok: true,
          stdout: json({ ok: true, activation_id: 'activation-1', output: {} }),
          stderr: '',
          runtimeEvents: [],
        },
      },
      read_skill_reference: {
        input: { activation_id: 'activation-1', path: 'references/fixture.md' },
        output: {
          ok: true,
          stdout: json({
            ok: true,
            activation_id: 'activation-1',
            path: 'references/fixture.md',
            encoding: 'utf8',
            content: 'fixture',
          }),
          stderr: '',
        },
      },
      list_mcp_resources: {
        input: {},
        output: {
          ok: true,
          stdout: json({
            ok: true,
            resource_count: 0,
            resources: [],
            truncated: false,
            next_step: 'none',
          }),
          stderr: '',
        },
      },
      list_mcp_tools: {
        input: {},
        output: {
          ok: true,
          stdout: json({
            ok: true,
            configured_provider_count: 0,
            callable_provider_count: 0,
            available_tool_count: 0,
            providers: [],
            tools: [],
            truncated: false,
          }),
          stderr: '',
        },
      },
      read_mcp_resource: {
        input: { server: 'fixture', uri: 'file:///fixture' },
        output: { ok: true, stdout: 'resource body', stderr: '', rawContent: 'resource body' },
      },
      write_plan: {
        input: {
          title: 'Fixture plan',
          body_markdown: 'A sufficiently detailed fixture plan body.',
          steps: [{ id: 'step-1', title: 'First' }],
        },
        output: {
          ok: true,
          stdout: json({
            ok: true,
            status: 'draft_saved',
            task_id: 'task-1',
            plan_id: 'plan-1',
            version: 1,
            plan_schema_version: 2,
            structural_digest: 'digest',
            artifact: {},
            next_action: 'submit',
          }),
          stderr: '',
          runtimeEvents: [],
        },
      },
      update_plan: {
        input: {
          plan_id: 'plan-1',
          version: 1,
          structural_digest: 'digest',
          updates: [{ step_id: 'step-1', status: 'completed' }],
        },
        output: {
          ok: true,
          stdout: json({
            ok: true,
            plan_id: 'plan-1',
            updated_steps: ['step-1'],
            plan_completed: false,
          }),
          stderr: '',
          runtimeEvents: [],
        },
      },
      task: {
        input: { subagent_type: 'plan', task: 'Plan the fixture.' },
        output: {
          available: true,
          result: { ok: true, summary: 'done', toolCallCount: 0, durationMs: 2 },
        },
      },
      git_inspect: {
        input: { operation: 'status', paths: ['fixture.ts'] },
        output: { ok: true, output: ' M fixture.ts' },
      },
      web_fetch: {
        input: { url: 'https://example.com' },
        output: {
          ok: true,
          url: 'https://example.com',
          finalUrl: 'https://example.com',
          title: 'Fixture',
          content: 'body',
          contentType: 'text/plain',
          truncated: false,
        },
      },
    };

    const projectedNames = new Set<string>();
    for (const rawSpec of builtinToolSpecs) {
      const contract = normalizeToolContract(rawSpec.contract);
      if (rawSpec.kind === 'interrupt') {
        const args = {
          questions: [
            {
              question: 'Choose one?',
              options: [
                { label: 'One', description: 'One.', recommended: true },
                { label: 'Two', description: 'Two.', recommended: false },
              ],
            },
          ],
        };
        const parsed = rawSpec.inputSchema.parse(args);
        const interrupt = rawSpec.createInterrupt(parsed, { workspace: '/workspace' });
        expect(contract.returns.format).toBe('interrupt');
        expect(interrupt.questions).toHaveLength(1);
        projectedNames.add(rawSpec.name);
        continue;
      }
      const fixture = fixtures[rawSpec.name]!;
      const spec = rawSpec as ExecutableToolSpec<string, unknown, unknown>;
      const input = spec.inputSchema.parse(fixture.input);
      const projected = spec.projectResult(fixture.output, {
        workspace: '/workspace',
        invocationInput: input,
      });
      let state = createInitialRuntimeState({
        threadId: `projection-${rawSpec.name}`,
        userId: 'fixture',
        workspace: '/workspace',
      });
      state = reduceRuntimeState(state, {
        type: 'model.responded',
        messageId: `model-${rawSpec.name}`,
        toolCalls: [{ id: `call-${rawSpec.name}`, name: rawSpec.name, args: input }],
      });
      state = reduceRuntimeState(state, {
        type: 'tool.queued',
        toolCallId: `call-${rawSpec.name}`,
        name: rawSpec.name,
        args: input,
        modelMessageId: `model-${rawSpec.name}`,
        ordinal: 0,
        effectClass: 'read_only',
        sideEffect: false,
      });
      state = reduceRuntimeState(state, {
        type: 'tool.started',
        toolCallId: `call-${rawSpec.name}`,
      });
      state = reduceRuntimeState(
        state,
        normalizeCurrentToolOutcomeEventV1(
          toolFinishedEvent({
            toolCallId: `call-${rawSpec.name}`,
            name: rawSpec.name,
            result: {
              ok: projected.ok,
              command: rawSpec.name,
              exitCode: projected.ok ? 0 : -1,
              stdout: projected.ok ? projected.modelContent : '',
              stderr: projected.ok ? '' : projected.modelContent,
              resultMeta: projected.resultMeta,
              ...(projected.outcomeAdviceV1
                ? { classifierAdviceV1: projected.outcomeAdviceV1 }
                : {}),
              ...(projected.classifierDiagnostic
                ? { classifierDiagnostic: projected.classifierDiagnostic }
                : {}),
            },
            command: rawSpec.name,
          }),
          state,
          '2026-08-11T00:00:00.000Z',
        ),
      );
      expect(state.transcript.messages.at(-1)).toMatchObject({
        kind: 'tool',
        content: projected.modelContent,
      });
      const context = buildContextProjection({
        role: 'agent',
        state,
        skills: [],
        workflowSkills: [],
      });
      const toolMessage = context.transcriptMessages.find((message) => isToolMessage(message));
      expect(toolMessage?.content, `${rawSpec.name}: provider modelContent`).toBe(
        projected.modelContent,
      );
      if (contract.returns.format === 'json') {
        const visible = JSON.parse(projected.modelContent) as Record<string, unknown>;
        expect(
          Object.keys(visible).every((key) => contract.returns.fields?.includes(key) === true),
          `${rawSpec.name}: contract fields cover the real projection`,
        ).toBe(true);
      } else {
        expect(
          contract.returns.fields,
          `${rawSpec.name}: text has no invented fields`,
        ).toBeUndefined();
      }
      projectedNames.add(rawSpec.name);
    }
    expect([...projectedNames].sort()).toEqual([...builtinToolRegistry.names()].sort());
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
    expect(shellExecuteSpec.effects(parsed, CTX).effectClass).toBe('unknown');
    expect(classifyShellActionIntent(parsed.command)).toBe('git');
  });

  test('read-only fast-path corpus remains command-driven', () => {
    for (const command of ['ls -la', 'pwd', 'rg TODO src']) {
      const effects = shellExecuteSpec.effects({ command }, CTX);
      expect(effects.effectClass, command).toBe('read_only');
      expect(effects.sideEffect, command).toBe(false);
    }
  });

  test('projects policy-proven inspection with inspect intent', () => {
    expect(classifyShellActionIntent('ls -la src')).toBe('inspect');
    expect(classifyShellActionIntent('rg TODO src')).toBe('inspect');
    expect(classifyShellActionIntent('uniq input.txt output.txt')).toBe('other');
  });

  test('dispatch preserves execution context and runner derives action metadata', async () => {
    const progress: string[] = [];
    const result = await invokeGovernedTool({
      workspace: '/tmp/sample',
      request: {
        source: 'builtin' as const,
        id: 'shell-read',
        name: 'shell_execute',
        args: { command: 'ls -la', description: 'Inspect workspace', timeout_ms: 3210 },
        reason: 'inspect',
        protectedCommand: 'ls -la',
      },
      onShellProgress: (chunk) => progress.push(chunk),
      shellExecutor: async (input) => {
        expect(input.timeoutMs).toBe(3210);
        expect(input.executionTrust).toBe('policy_proven_read_only');
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
    expect(result.action).toEqual({ intent: 'inspect', grantUsed: 'none' });
    expect(progress).toEqual(['status']);
  });

  test('does not attach read-only execution trust to a side-effectful command', async () => {
    const outcome = await dispatchRegisteredTool(
      shellExecuteSpec,
      { command: 'touch created.txt' },
      {
        ...CTX,
        shellExecutor: async (input) => {
          expect(input.executionTrust).toBeUndefined();
          return { ok: true, command: input.command, exitCode: 0, stdout: '', stderr: '' };
        },
      },
    );
    expect(outcome.dispatched).toBe(true);
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
