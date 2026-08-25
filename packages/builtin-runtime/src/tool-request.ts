import type { CapabilityDescriptor } from '@kite-ai/runtime-contract';
import type {
  CapabilityExecutionMechanism,
  CapabilityTurnContext,
  ValidatedInvocation as RuntimeValidatedInvocation,
} from '@kite-ai/runtime-spi';
import type { BuiltinModelToolCatalogEntry, BuiltinToolCatalogProjection } from './tool-catalog';
import type { KnownToolName } from './tool-contracts';

export type BuiltinToolAvailabilityContext = CapabilityTurnContext & {
  readonly workspace: string;
  readonly interactionMode?: import('@kite-ai/runtime-contract').InteractionMode;
};

export interface BuiltinValidatedInvocationProjection {
  readonly resolved: Readonly<{
    readonly call: Readonly<{ readonly toolCallId: string }>;
    readonly target: Readonly<{
      readonly operationId: string;
      readonly capabilityRevision: string;
      readonly executorRevision: string | null;
      readonly descriptor: Readonly<CapabilityDescriptor>;
      readonly executionMechanism: CapabilityExecutionMechanism;
    }>;
    /** RM neutral SPI name. */
    readonly builtinProjectionRevision?: string | null;
    /** Temporary Core dispatch-shape name; removed with the Core Pipeline. */
    readonly builtinCatalogRevision?: string;
  }>;
  readonly request: Readonly<{
    readonly source: 'builtin' | 'mcp';
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly schemaDigest: string;
    readonly approvalSummary: string;
  }>;
}

interface PendingBuiltinToolRequestBase {
  readonly source: 'builtin';
  readonly id?: string;
  readonly reason: string;
  readonly protectedCommand: string;
  /** Immutable identity projected from the frozen Builtin catalog. */
  readonly operationId?: string;
  readonly capabilityId?: string;
  readonly capabilityRevision?: string;
  readonly executorRevision?: string;
  readonly schemaDigest?: string;
  readonly catalogRevision?: string;
  readonly executionMechanism?: CapabilityExecutionMechanism;
}

// Names are defined by the Builtin Runtime package. Harness does not keep a
// second model-surface name authority here.
type BuiltinModelToolName = KnownToolName;

type PendingShellRequest = PendingBuiltinToolRequestBase & {
  readonly name: 'shell_execute';
  readonly args: { command: string; description?: string; timeout_ms?: number };
};

type PendingTaskRequest = PendingBuiltinToolRequestBase & {
  readonly name: 'task';
  readonly args:
    | {
        name: string;
        subagent_type: 'explore' | 'plan' | 'code' | 'review';
        task: string;
      }
    | {
        name: string;
        subagent_type: 'explore' | 'plan' | 'code' | 'review';
        taskArtifact: import('@kite-ai/runtime-spi').SubagentTaskRequestArtifact;
      };
};

type PendingEditRequest = PendingBuiltinToolRequestBase & {
  readonly name: 'edit_file';
  readonly args: Record<string, unknown> & { path: string; old_string: string };
};

type PendingOtherBuiltinRequest = PendingBuiltinToolRequestBase & {
  readonly name: Exclude<BuiltinModelToolName, 'edit_file' | 'shell_execute' | 'task'>;
  readonly args: Record<string, unknown>;
};

export type PendingBuiltinToolRequest =
  | PendingShellRequest
  | PendingTaskRequest
  | PendingEditRequest
  | PendingOtherBuiltinRequest;

/** 解析/校验失败的工具调用 — 不进入 PendingToolRequest 联合，非合法请求。 */
export interface InvalidToolRequest {
  source: 'invalid';
  id?: string;
  name: string;
  rawArgs: unknown;
  parseError: string;
  /** Structured failure code from the Builtin catalog parser; distinguishes
   *  unavailable vs. invalid-arguments at the request-adapter layer. */
  parseFailureCode?: ToolRequestParseFailureCode;
}

export type ToolRequestParseFailureCode =
  | 'invalid_json'
  | 'unknown_tool'
  | 'tool_unavailable'
  | 'invalid_arguments';

/** 动态 MCP 工具请求 — args 无法编译期验证，Record<string,unknown> 是合理上限。 */
export interface PendingMcpToolRequest {
  source: 'mcp';
  id?: string;
  name: `mcp__${string}`;
  args: Record<string, unknown>;
  reason: string;
  protectedCommand: string;
}

/**
 * 待处理的工具请求 / Pending tool request.
 *
 * Builtin 部分从 Runtime catalog projection 的 parser 产出可辨识联合，MCP
 * 部分保持 Record<string,unknown>。
 * 无效调用（parse 失败）由 InvalidToolRequest 单独建模，不混入本联合。
 */
export type PendingToolRequest = PendingBuiltinToolRequest | PendingMcpToolRequest;

/** 工具请求解析结果：合法请求 或 无效调用。 */
export type ToolRequestParseResult =
  | { ok: true; request: PendingToolRequest }
  | { ok: false; request: InvalidToolRequest };

/**
 * Adapt one Builtin-owned or dynamic-MCP validated Pipeline request into the
 * legacy harness DTO. No schema lookup or argument re-parse is permitted here.
 */
export function pendingToolRequestFromValidatedInvocation(
  validated: Readonly<BuiltinValidatedInvocationProjection> | Readonly<RuntimeValidatedInvocation>,
  builtinToolCatalog: BuiltinToolCatalogProjection,
): PendingToolRequest {
  const request = validated.request;
  if (
    request.arguments === null ||
    typeof request.arguments !== 'object' ||
    Array.isArray(request.arguments)
  ) {
    throw new Error('Validated Tool invocation arguments are not a canonical JSON object.');
  }
  const requestArguments = request.arguments as Readonly<Record<string, unknown>>;
  if (request.source === 'mcp') {
    return {
      source: 'mcp',
      id: validated.resolved.call.toolCallId,
      name: request.name as `mcp__${string}`,
      args: requestArguments as Record<string, unknown>,
      reason: `Model requested MCP tool ${request.name}`,
      protectedCommand: request.approvalSummary,
    };
  }
  if (request.source !== 'builtin') {
    throw new Error('Validated Tool invocation is not a Builtin or dynamic MCP request.');
  }
  const privateTaskProjection = request.name === 'task' && 'taskArtifact' in requestArguments;
  const target = validated.resolved.target;
  const builtinProjectionRevision =
    ('builtinProjectionRevision' in validated.resolved
      ? validated.resolved.builtinProjectionRevision
      : undefined) ??
    ('builtinCatalogRevision' in validated.resolved
      ? validated.resolved.builtinCatalogRevision
      : undefined);
  const entry = builtinToolCatalog.entries.find(
    (candidate): candidate is BuiltinModelToolCatalogEntry =>
      candidate.visibility === 'model' && candidate.operationId === target.operationId,
  );
  if (
    builtinProjectionRevision !== builtinToolCatalog.revision ||
    !entry ||
    entry.name !== request.name ||
    entry.operationId !== target.operationId ||
    entry.capabilityId !== target.descriptor.capabilityId ||
    entry.revision !== target.capabilityRevision ||
    entry.executorRevision !== target.executorRevision ||
    entry.descriptor.revision !== target.descriptor.revision ||
    entry.executionMechanism !== target.executionMechanism
  ) {
    throw new Error('Validated Builtin invocation no longer matches its frozen catalog identity.');
  }
  return {
    source: 'builtin',
    id: validated.resolved.call.toolCallId,
    name: request.name,
    args: requestArguments,
    reason: `${privateTaskProjection ? 'Runtime' : 'Model'} requested ${request.name}`,
    protectedCommand: request.approvalSummary,
    operationId: target.operationId,
    capabilityId: target.descriptor.capabilityId,
    capabilityRevision: target.capabilityRevision,
    executorRevision: entry.executorRevision,
    schemaDigest: request.schemaDigest,
    catalogRevision: builtinProjectionRevision,
    executionMechanism: target.executionMechanism,
  } as PendingBuiltinToolRequest;
}

/** 从单个 tool_call 解析工具请求 / Parse tool request from a single tool_call */
export function toolRequestFromCall(
  call: { id?: string; name: string; args: unknown },
  availabilityContext: string | BuiltinToolAvailabilityContext,
  builtinToolCatalog?: BuiltinToolCatalogProjection,
): ToolRequestParseResult | null {
  const context: BuiltinToolAvailabilityContext =
    typeof availabilityContext === 'string'
      ? { workspace: availabilityContext }
      : availabilityContext;

  // 合成调用：invokeModel 在 parseToolCall 失败后注入 _raw_invalid_args 标记。
  // 返回 InvalidToolRequest 而非强转进 PendingToolRequest 联合。
  if (
    call.args !== null &&
    typeof call.args === 'object' &&
    !Array.isArray(call.args) &&
    typeof (call.args as Record<string, unknown>)._raw_invalid_args === 'string'
  ) {
    const argsObj = call.args as Record<string, unknown>;
    return {
      ok: false,
      request: {
        source: 'invalid',
        id: call.id,
        name: call.name,
        rawArgs: argsObj._raw_invalid_args,
        parseError:
          typeof argsObj._parse_error === 'string'
            ? argsObj._parse_error
            : 'invalid JSON arguments',
        parseFailureCode: 'invalid_json',
      },
    };
  }

  if (call.name.startsWith('mcp__')) {
    // MCP 工具：显式验证 args 为非 null 对象，防止数组/字符串等原始值传播。
    if (call.args === null || typeof call.args !== 'object' || Array.isArray(call.args)) {
      return {
        ok: false,
        request: {
          source: 'invalid',
          id: call.id,
          name: call.name,
          rawArgs: call.args,
          parseError: `MCP tool '${call.name}' arguments must be a JSON object`,
        },
      };
    }
    return {
      ok: true,
      request: {
        source: 'mcp',
        id: call.id,
        name: call.name as `mcp__${string}`,
        args: call.args as Record<string, unknown>,
        reason: `Model requested MCP tool ${call.name}`,
        protectedCommand: call.name,
      },
    };
  }

  // Builtin parsing is owned by the frozen Runtime catalog projection. A
  // caller that has not captured that projection cannot use the legacy
  // adapter: fail closed instead of consulting Core's retired registry.
  if (!builtinToolCatalog) {
    return {
      ok: false,
      request: {
        source: 'invalid',
        id: call.id,
        name: call.name,
        rawArgs: call.args,
        parseError: 'Builtin Runtime catalog projection is unavailable.',
        parseFailureCode: 'tool_unavailable',
      },
    };
  }

  const entry = builtinModelEntryByName(builtinToolCatalog, call.name);
  if (!entry) {
    return {
      ok: false,
      request: {
        source: 'invalid',
        id: call.id,
        name: call.name,
        rawArgs: call.args,
        parseError: `Unknown Builtin tool '${call.name}'.`,
        parseFailureCode: 'unknown_tool',
      },
    };
  }
  if (entry.availability !== 'available') {
    return {
      ok: false,
      request: {
        source: 'invalid',
        id: call.id,
        name: call.name,
        rawArgs: call.args,
        parseError:
          entry.availabilityReason ?? `Builtin tool '${call.name}' is unavailable in this context.`,
        parseFailureCode: 'tool_unavailable',
      },
    };
  }

  const isPrivateTaskProjection =
    call.name === 'task' &&
    call.args !== null &&
    typeof call.args === 'object' &&
    !Array.isArray(call.args) &&
    'taskArtifact' in call.args;
  const turnContext = toCapabilityTurnContext(context);
  const parsed = isPrivateTaskProjection
    ? entry.parse(call.args, turnContext)
    : entry.parseModelInput(call.args, turnContext);
  if (!parsed.success) {
    const issueText = parsed.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
        return `${path}: ${issue.message}`;
      })
      .join('; ');
    return {
      ok: false,
      request: {
        source: 'invalid',
        id: call.id,
        name: call.name,
        rawArgs: call.args,
        parseError: issueText || `Builtin tool '${call.name}' arguments are invalid.`,
        parseFailureCode: 'invalid_arguments',
      },
    };
  }

  const args = parsed.data;
  return {
    ok: true,
    request: {
      source: 'builtin',
      id: call.id,
      name: entry.name,
      args,
      reason: `Model requested ${entry.name}`,
      protectedCommand: entry.projectApprovalSummary(args, turnContext),
      operationId: entry.operationId,
      capabilityId: entry.capabilityId,
      capabilityRevision: entry.revision,
      executorRevision: entry.executorRevision,
      schemaDigest: entry.inputSchemaDigest ?? entry.parser.schemaDigest,
      catalogRevision: builtinToolCatalog.revision,
      executionMechanism: entry.executionMechanism,
    } as PendingBuiltinToolRequest,
  };
}

function builtinModelEntryByName(
  catalog: BuiltinToolCatalogProjection,
  name: string,
): BuiltinModelToolCatalogEntry | undefined {
  return catalog.entries.find(
    (entry): entry is BuiltinModelToolCatalogEntry =>
      entry.visibility === 'model' && entry.name === name,
  );
}

function toCapabilityTurnContext(context: BuiltinToolAvailabilityContext): CapabilityTurnContext {
  return {
    workspace: context.workspace,
    ...(context.threadId !== undefined ? { threadId: context.threadId } : {}),
    ...(context.phase !== undefined ? { phase: context.phase } : {}),
    ...(context.featureFlags !== undefined ? { featureFlags: context.featureFlags } : {}),
    ...(context.brokeredGitFeatureRevision !== undefined
      ? { brokeredGitFeatureRevision: context.brokeredGitFeatureRevision }
      : {}),
    ...(context.hasTaskAdapter !== undefined ? { hasTaskAdapter: context.hasTaskAdapter } : {}),
    ...(context.hasGitBroker !== undefined ? { hasGitBroker: context.hasGitBroker } : {}),
    ...(context.toolSearchEnabled !== undefined
      ? { toolSearchEnabled: context.toolSearchEnabled }
      : {}),
    ...(context.activeSkillFrameIds !== undefined
      ? { activeSkillFrameIds: context.activeSkillFrameIds }
      : {}),
    ...(context.availableSkillIds !== undefined
      ? { availableSkillIds: context.availableSkillIds }
      : {}),
  };
}

/** 类型守卫：判断请求是否为动态 MCP 工具调用（基于 source 判别字段）。 */
export function isMcpRequest(req: PendingToolRequest): req is PendingMcpToolRequest {
  return req.source === 'mcp';
}
