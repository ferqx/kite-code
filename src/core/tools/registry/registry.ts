/**
 * ToolSpec Registry — 注册、查找与派生产物（ADR-0043 §1）。
 * ToolSpec Registry — registration, lookup and derived artifacts (ADR-0043 §1).
 *
 * 从 Registry 派生：schema-only 模型 ToolSet、泛型调用解析、
 * CapabilityDescriptor 投影。模型 ToolSet 不含 execute；真实执行
 * 只允许经过 dispatchRegisteredTool（见 ./dispatch.ts）。
 */
import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { descriptorRevision } from '@/core/capabilities/catalog';
import type { ToolCapability } from '@/core/policies/tool-capabilities';
import { buildDescription } from '@/core/tools/tool-contracts';
import type { CapabilityDescriptor } from '@/protocol/capabilities';
import type { ToolContext, ToolSpec } from './spec';

// biome-ignore lint/suspicious/noExplicitAny: 异构 spec 存储需要双变参数位置
type AnyToolSpec = ToolSpec<any, any>;

/** schema-only 模型工具条目。execute 必须不存在（一致性不变量 i2）。 */
export interface SchemaOnlyModelTool {
  description: string;
  execute?: undefined;
}

export interface ParsedToolCallSuccess {
  ok: true;
  id?: string;
  name: string;
  /** 恒等于 inputSchema 解析结果（一致性不变量 i1）；禁止逐字段重映射。 */
  args: unknown;
  reason: string;
  protectedCommand: string;
}

export interface ParsedToolCallFailure {
  ok: false;
  id?: string;
  name: string;
  error: string;
}

export type ParsedToolCall = ParsedToolCallSuccess | ParsedToolCallFailure;

/** 模型可见名保持 snake_case（ADR-0043 §4）。 */
const MODEL_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export class ToolRegistry {
  readonly #specs = new Map<string, AnyToolSpec>();

  /** 注册 spec。重名与非法名 fail-fast，防止静默覆盖。 */
  register(spec: AnyToolSpec): this {
    if (!MODEL_TOOL_NAME_PATTERN.test(spec.name)) {
      throw new Error(`Tool spec name '${spec.name}' must be stable snake_case.`);
    }
    if (this.#specs.has(spec.name)) {
      throw new Error(`Tool spec '${spec.name}' is already registered.`);
    }
    this.#specs.set(spec.name, spec);
    return this;
  }

  get(name: string): AnyToolSpec | undefined {
    return this.#specs.get(name);
  }

  names(): string[] {
    return [...this.#specs.keys()].sort();
  }

  /** 当前上下文中可用的 spec（availability 省略视为始终可用）。 */
  availableIn(context: ToolContext): AnyToolSpec[] {
    return [...this.#specs.values()].filter((spec) => spec.availability?.(context) !== false);
  }

  /**
   * 生成 schema-only 模型 ToolSet（AI SDK tool() 的无 execute 重载）。
   * MCP 动态工具继续使用 dynamicTool() + binding 流程，不经过本方法。
   */
  toSchemaOnlyToolSet(context: ToolContext): Record<string, SchemaOnlyModelTool> {
    const toolset: Record<string, SchemaOnlyModelTool> = {};
    for (const spec of this.availableIn(context)) {
      toolset[spec.name] = tool({
        description: buildDescription(spec.contract),
        inputSchema: zodSchema(spec.inputSchema),
      }) as unknown as SchemaOnlyModelTool;
    }
    return toolset;
  }

  /**
   * 泛型调用解析：lookup → availability → inputSchema 校验 → 构造请求。
   * 未注册或不可用名称返回 null，交由现有统一未知工具拒绝路径处理。
   */
  parseToolCall(
    call: { id?: string; name: string; args: unknown },
    context: ToolContext,
  ): ParsedToolCall | null {
    const spec = this.#specs.get(call.name);
    if (!spec || spec.availability?.(context) === false) {
      return null;
    }
    const parsed = spec.inputSchema.safeParse(call.args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      const message = issue ? `${path}${issue.message}` : 'invalid arguments';
      return { ok: false, id: call.id, name: call.name, error: message };
    }
    // args 透传：恒等于 schema 解析结果（i1），不做任何逐字段重映射。
    return {
      ok: true,
      id: call.id,
      name: call.name,
      args: parsed.data,
      reason: `Model requested ${call.name}`,
      protectedCommand: spec.approvalSummary?.(parsed.data, context) ?? call.name,
    };
  }

  /** 从 Registry spec 计算审批唯一输入；未知、不可用或参数无效时返回 undefined。 */
  effectsOf(name: string, args: unknown, context: ToolContext): ToolCapability | undefined {
    const spec = this.#specs.get(name);
    if (!spec || spec.availability?.(context) === false) return undefined;
    const parsed = spec.inputSchema.safeParse(args);
    return parsed.success ? spec.effects(parsed.data, context) : undefined;
  }

  /**
   * CapabilityDescriptor 投影（builtin_tool kind）。revision 复用内容哈希
   * 算法（descriptorRevision），契约/效果语义变化即 revision 变化。
   * Schema 也属于 capability identity；参数类型、必填性或枚举变化必须改变 revision。
   */
  descriptorOf(spec: AnyToolSpec): CapabilityDescriptor {
    const base = {
      capabilityId: `builtin:${spec.name}`,
      kind: 'builtin_tool' as const,
      displayName: spec.name,
      description: buildDescription(spec.contract),
      inputSchema: z.toJSONSchema(spec.inputSchema) as Record<string, unknown>,
      provider: { type: 'builtin' as const, id: 'kite-code', provenance: 'builtin' as const },
      declaredEffects: spec.declaredEffects,
      effectiveEffects: spec.declaredEffects,
      policy: {
        workspaceTrustRequired: false,
        minimumApproval: spec.minimumApproval,
      },
      availability: 'available' as const,
      diagnostics: [] as string[],
    };
    return { ...base, revision: descriptorRevision(base) };
  }
}

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry();
}
