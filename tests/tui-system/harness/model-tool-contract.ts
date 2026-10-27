import { isDeepStrictEqual } from 'node:util';
import type { JobDefinition, ToolDefinition } from '@kite-ai/agent/extensions';
import { createFileTools, createPathFileTools, type WorkspaceFiles } from '@kite-ai/agent/files';
import { createMcpLifecycle } from '@kite-ai/agent/mcp';
import { createPlanningValidation } from '@kite-ai/agent/planning';
import { createShellExtension } from '@kite-ai/agent/shell';
import type { ModelRequest } from '@kite-ai/ai';
import { createMcpToolsSearchTool } from '../../../packages/agent/src/mcp/tools-search';
import { createModelToolSurface, modelToolCall } from '../../../packages/agent/src/model-tools';
import type { MockChatRequest } from './fixtures';
import type { OriginalToolCall } from './original-tool-contract';

const unavailable = () => {
  throw Error('fixture_tool_metadata_must_not_execute');
};
// These are the real factories' declarations only. No file, Job, connection or
// Runtime is opened here, and the fixture never executes these capabilities.
const files = new Proxy({} as WorkspaceFiles, { get: unavailable });
const job: JobDefinition = {
  id: 'shell.command',
  version: '1',
  description: 'Metadata only',
  inputSchema: {},
  start: unavailable,
  observe: unavailable,
  cancel: unavailable,
  dispose: unavailable,
};
const definitions = new Map<string, ToolDefinition>(
  [
    ...createFileTools(files),
    ...createPathFileTools({ qualifiedPlatforms: [], protectedRoots: [] }).tools,
    ...createShellExtension({ job }).tools!,
    ...createPlanningValidation().extension.tools!,
    ...createMcpLifecycle({ servers: [] }).extension.tools!,
    createMcpToolsSearchTool('fixture', 'fixture', []),
  ].map((tool) => [tool.id, tool]),
);

function catalogueDefinition(id: string, request: MockChatRequest): ToolDefinition | undefined {
  const matches: ToolDefinition[] = [];
  for (const message of request.messages) {
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(message.content);
    } catch {
      continue;
    }
    if (value?.source !== 'frozen_selected_mcp_catalogue' || !Array.isArray(value.items)) continue;
    for (const row of value.items) {
      if (
        row?.definitionId !== id ||
        typeof row.modelName !== 'string' ||
        typeof row.definitionVersion !== 'string' ||
        !row.inputSchema
      )
        continue;
      const declared = Array.isArray(request.body.tools) ? request.body.tools : [];
      if (declared.filter((tool) => tool?.function?.name === row.modelName).length !== 1) continue;
      matches.push({
        id,
        version: row.definitionVersion,
        model: { name: row.modelName },
        description: String(row.description ?? ''),
        inputSchema: row.inputSchema,
        execute: unavailable,
      });
    }
  }
  const unique = [...new Map(matches.map((tool) => [JSON.stringify(tool), tool])).values()];
  if (unique.length > 1) throw Error('original_mcp_tool_source_ambiguous');
  return unique[0];
}

function definition(id: string, request: MockChatRequest): ToolDefinition | undefined {
  if (id === 'task.execute') throw Error('original_task_requires_public_collaboration_migration');
  return definitions.get(id) ?? catalogueDefinition(id, request);
}
function assertUniqueDeclaredName(name: string, request: MockChatRequest): void {
  const declared = Array.isArray(request.body.tools) ? request.body.tools : [];
  if (declared.filter((tool) => tool?.function?.name === name).length > 1)
    throw Error('original_tool_model_declaration_ambiguous');
  // An attempted unavailable Tool must still reach the real Runtime rejection;
  // a missing declaration is never synthesized or used to grant capability.
}
const snake = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();

/** Project the fixture's finite Core input through the production replay codec.
 * Only the migrated top-level fields participate; baseline, plan steps and
 * remote/opaque JSON remain byte-for-byte data. The real production decoder
 * must restore every original field, or this fixture refuses to emit the call.
 */
export function projectOriginalModelToolCall(
  call: OriginalToolCall,
  request: MockChatRequest,
): OriginalToolCall {
  const tool = definition(call.name, request);
  if (!tool) {
    if (call.name.startsWith('mcp.')) throw Error('original_mcp_tool_source_unavailable');
    assertUniqueDeclaredName(call.name, request);
    return call;
  }
  const model = tool.model;
  if (!model || model.hidden) throw Error('original_tool_model_surface_unavailable');
  assertUniqueDeclaredName(model.name, request);
  const parameters = Object.keys(call.args).flatMap((key) => {
    // Do not infer names inside user JSON or undeclared keys.
    const properties = tool.inputSchema.properties;
    if (
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties) ||
      !Object.hasOwn(properties, key)
    )
      return [];
    const name = model.parameterNames?.[key] ?? (model.snakeCase ? snake(key) : key);
    return name === key ? [] : [{ path: [key], name }];
  });
  const projected = modelToolCall({
    id: call.id,
    name: call.name,
    arguments: JSON.stringify(call.args),
    model: { name: model.name, parameters },
  } as Parameters<typeof modelToolCall>[0]);
  const input: ModelRequest = {
    modelId: 'fixture',
    requestId: call.id,
    messages: [],
    tools: [
      {
        id: tool.id,
        definitionVersion: tool.version,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
    ],
  };
  const decoded = createModelToolSurface(input, new Map([[tool.id, tool]])).decode(projected);
  if (
    decoded.model?.error ||
    decoded.name !== call.name ||
    !isDeepStrictEqual(JSON.parse(decoded.arguments), call.args)
  )
    throw Error(`original_tool_model_projection_changed_input:${call.name}`);
  return { id: projected.id, name: projected.name, args: JSON.parse(projected.arguments) };
}

/** Invalid JSON is an intentional Model response; preserve its exact bytes. */
export function originalModelToolName(id: string, request: MockChatRequest): string {
  const name = definition(id, request)?.model?.name ?? id;
  assertUniqueDeclaredName(name, request);
  return name;
}
