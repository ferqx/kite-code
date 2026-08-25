import type { CapabilityBinding, CapabilityDescriptor } from '@kite-ai/runtime-contract';
import type { CapabilityTurnContext } from '@kite-ai/runtime-spi';
import { dynamicTool, jsonSchema, type ToolSet } from 'ai';
import { digestCapabilityBindingValue } from '../capability-binding';
import type { ExecutionCapabilitySurface } from '../sandbox';
import { isDescriptorAdmittedByExecutionCapabilitySurface } from '../sandbox';
import type { BuiltinModelToolCatalogEntry, BuiltinToolCatalogProjection } from '../tool-catalog';

export interface BuiltinSubagentDynamicMcpBinding {
  readonly binding: CapabilityBinding;
  readonly descriptor: CapabilityDescriptor;
}

export interface BuiltinSubagentToolSurfaceInput {
  readonly catalog: BuiltinToolCatalogProjection;
  readonly turnContext: CapabilityTurnContext;
  readonly executionCapabilitySurface?: ExecutionCapabilitySurface;
  readonly allowedTools?: ReadonlySet<string>;
  readonly canSpawnSubagents: boolean;
  readonly dynamicMcpBindings?: readonly BuiltinSubagentDynamicMcpBinding[];
}

export interface BuiltinSubagentToolSurface {
  /** Turn projection derived from the App-owned frozen registry snapshot. */
  readonly projection: BuiltinToolCatalogProjection;
  /** Schema-only Builtin surface plus the independent dynamic MCP overlay. */
  readonly tools: ToolSet;
  readonly builtinEntries: readonly BuiltinModelToolCatalogEntry[];
}

export interface BuiltinModelToolSurfaceFromProjectionInput {
  readonly projection: BuiltinToolCatalogProjection;
  readonly turnContext: CapabilityTurnContext;
  readonly executionCapabilitySurface?: ExecutionCapabilitySurface;
  readonly allowedTools?: ReadonlySet<string>;
  readonly canSpawnSubagents?: boolean;
  readonly exposeInterrupts?: boolean;
  readonly dynamicMcpBindings?: readonly BuiltinSubagentDynamicMcpBinding[];
}

/** Compose one schema-only model surface from an already frozen turn projection. */
export function createBuiltinModelToolSurfaceFromProjection(
  input: BuiltinModelToolSurfaceFromProjectionInput,
): BuiltinSubagentToolSurface {
  const builtinEntries = input.projection.entries.filter(
    (entry): entry is BuiltinModelToolCatalogEntry =>
      entry.visibility === 'model' &&
      entry.availability === 'available' &&
      (input.exposeInterrupts !== false ||
        (entry.kind !== 'interrupt' && entry.executionMechanism !== 'user_input')) &&
      (input.canSpawnSubagents !== false || entry.executionMechanism !== 'subagent') &&
      (!input.allowedTools || input.allowedTools.has(entry.name)) &&
      (!input.executionCapabilitySurface ||
        isDescriptorAdmittedByExecutionCapabilitySurface({
          surface: input.executionCapabilitySurface,
          descriptor: entry.descriptor,
        })),
  );
  const builtinNames = new Set(builtinEntries.map((entry) => entry.name));
  const builtinTools = Object.fromEntries(
    Object.entries(input.projection.toolSet).filter(([name]) => builtinNames.has(name)),
  );
  const dynamicMcpTools: ToolSet = {};
  for (const { binding, descriptor } of input.dynamicMcpBindings ?? []) {
    if (
      !binding.exposedToolName.startsWith('mcp__') ||
      descriptor.kind !== 'mcp_tool' ||
      descriptor.availability !== 'available' ||
      !descriptor.inputSchema ||
      binding.capabilityId !== descriptor.capabilityId ||
      binding.capabilityRevision !== descriptor.revision ||
      binding.schemaDigest !== digestCapabilityBindingValue(descriptor.inputSchema) ||
      (input.executionCapabilitySurface &&
        !isDescriptorAdmittedByExecutionCapabilitySurface({
          surface: input.executionCapabilitySurface,
          descriptor,
        }))
    ) {
      continue;
    }
    dynamicMcpTools[binding.exposedToolName] = dynamicTool({
      description: descriptor.modelDescription ?? `MCP capability ${descriptor.displayName}.`,
      inputSchema: jsonSchema(
        modelVisibleDynamicMcpSchema(descriptor.inputSchema) as Parameters<typeof jsonSchema>[0],
      ),
    });
  }
  return Object.freeze({
    projection: input.projection,
    tools: Object.freeze({ ...builtinTools, ...dynamicMcpTools }),
    builtinEntries: Object.freeze([...builtinEntries]),
  });
}

/**
 * Project the child model surface from one Builtin snapshot. Dynamic MCP stays
 * an independent overlay and never changes the Builtin catalog revision.
 */
export function createBuiltinSubagentToolSurface(
  input: BuiltinSubagentToolSurfaceInput,
): BuiltinSubagentToolSurface {
  const projection = input.catalog.forTurn(input.turnContext);
  return createBuiltinModelToolSurfaceFromProjection({
    projection,
    turnContext: input.turnContext,
    executionCapabilitySurface: input.executionCapabilitySurface,
    allowedTools: input.allowedTools,
    canSpawnSubagents: input.canSpawnSubagents,
    exposeInterrupts: false,
    dynamicMcpBindings: input.dynamicMcpBindings,
  });
}

const MODEL_HIDDEN_SCHEMA_ANNOTATIONS_ = new Set([
  'description',
  'title',
  '$comment',
  'examples',
  'default',
]);

/** Remove untrusted MCP prose without changing the admitted schema structure. */
function modelVisibleDynamicMcpSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(modelVisibleDynamicMcpSchema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !MODEL_HIDDEN_SCHEMA_ANNOTATIONS_.has(key))
      .map(([key, item]) => [key, modelVisibleDynamicMcpSchema(item)]),
  );
}
