import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { POLICY_CLASSIFIED_TOOL_NAMES } from '@/core/policies/tool-capabilities';
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
   * 尚未迁入 Registry 的静态工具名。阶段 1.2 每迁移一个工具就从这里移除；
   * 阶段 1.3 清理完成后本集合应为空（届时删除本常量并改为全量断言）。
   */
  const PENDING_MIGRATION = new Set<string>(KNOWN_TOOL_NAMES);

  test('pending migration set never hides unknown names', () => {
    const known = new Set<string>(KNOWN_TOOL_NAMES);
    for (const name of PENDING_MIGRATION) {
      expect(known.has(name)).toBe(true);
    }
  });

  test('known names are covered by registry or pending migration', () => {
    const registry = sampleRegistry();
    const covered = new Set<string>([...registry.names(), ...PENDING_MIGRATION]);
    for (const name of KNOWN_TOOL_NAMES) {
      expect(covered.has(name)).toBe(true);
    }
  });

  test('production registry names must be known tool names (arms in S1.2)', () => {
    // 生产 Registry 实例在阶段 1.2 引入；届时把其 names() 并入此断言，
    // 防止注册的规格脱离 KNOWN_TOOL_NAMES 契约集合。
    const productionRegistryNames: string[] = [];
    const known = new Set<string>(KNOWN_TOOL_NAMES);
    for (const name of productionRegistryNames) {
      expect(known.has(name)).toBe(true);
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
