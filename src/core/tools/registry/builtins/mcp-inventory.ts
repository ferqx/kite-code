import { z } from 'zod';
import { buildMcpInventory, isMcpProviderError } from '@/core/mcp';
import {
  LIST_MCP_RESOURCES_CONTRACT,
  LIST_MCP_TOOLS_CONTRACT,
  READ_MCP_RESOURCE_CONTRACT,
} from '@/core/tools/tool-contracts';
import { projectionDigest } from '../projection';
import type { ToolSpec } from '../spec';

const MAX_MODEL_MCP_RESULT_CHARS = 128 * 1024;

export const listMcpResourcesInputSchema = z.object({
  server: z.string().min(1).optional().describe('Optional exact MCP server name'),
});
export const listMcpToolsInputSchema = z.object({
  provider: z.string().trim().min(1).max(128).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(2048).optional(),
});
export const readMcpResourceInputSchema = z.object({
  server: z.string().describe('MCP server name'),
  uri: z.string().describe('Resource URI to read (e.g. file:///docs/api.md)'),
});

type McpSpecOutput = {
  ok: boolean;
  stdout: string;
  stderr: string;
  rawContent?: string;
  truncated?: boolean;
};

const readOnlyEffects = () => ({
  effectClass: 'read_only' as const,
  sideEffect: false,
  classificationReason: 'Reads governed MCP inventory or static resource content.',
});

export const listMcpResourcesSpec: ToolSpec<
  z.infer<typeof listMcpResourcesInputSchema>,
  McpSpecOutput
> = {
  name: 'list_mcp_resources',
  kind: 'coordination',
  contract: LIST_MCP_RESOURCES_CONTRACT.sections,
  inputSchema: listMcpResourcesInputSchema,
  declaredEffects: { filesystem: 'none', network: 'read', externalState: 'none' },
  minimumApproval: 'none',
  effects: readOnlyEffects,
  approvalSummary: (input) => `list_mcp_resources ${input.server ?? ''}`.trim(),
  execute: async (input, context) => {
    const manager = context.mcpManager;
    if (!manager) {
      return {
        ok: false,
        stdout: '',
        stderr:
          'MCP Runtime is not available in this execution context. Use list_mcp_tools or /mcp to inspect configured providers.',
      };
    }
    const snapshot = manager.getResourceDirectorySnapshot();
    const matching = snapshot.resources
      .filter((resource) => input.server == null || resource.providerId === input.server)
      .slice()
      .sort(
        (left, right) =>
          left.providerId.localeCompare(right.providerId) ||
          left.uri.localeCompare(right.uri) ||
          left.name.localeCompare(right.name),
      );
    if (input.server && matching.length === 0) {
      const provider = manager
        .getProviderDirectorySnapshot()
        .entries.find((entry) => entry.providerId === input.server);
      return {
        ok: false,
        stdout: '',
        stderr: provider
          ? `No available static MCP resources were discovered for server: ${input.server}`
          : `Unknown MCP server: ${input.server}`,
      };
    }
    const resources = matching.slice(0, 100).map((resource) => ({
      server: resource.providerId,
      uri: resource.uri,
      name: resource.name,
      ...(resource.mimeType ? { mime_type: resource.mimeType } : {}),
    }));
    return {
      ok: true,
      stdout: JSON.stringify({
        ok: true,
        resource_count: resources.length,
        resources,
        truncated: matching.length > resources.length,
        next_step:
          matching.length > resources.length
            ? 'Call list_mcp_resources with an exact server to narrow the result.'
            : resources.length > 0
              ? 'Call read_mcp_resource with an exact server and URI.'
              : 'No static MCP resources are currently available.',
      }),
      stderr: '',
    };
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok ? output.stdout : output.stderr,
    // execute 产出的已是模型就绪文本：逐流透传，Runner 不得按 ok 重新分流。
    streams: { stdout: output.stdout, stderr: output.stderr },
    resultMeta: {},
    display: { verb: 'List', preview: 'MCP resources' },
  }),
};

export const listMcpToolsSpec: ToolSpec<z.infer<typeof listMcpToolsInputSchema>, McpSpecOutput> = {
  name: 'list_mcp_tools',
  kind: 'coordination',
  contract: LIST_MCP_TOOLS_CONTRACT.sections,
  inputSchema: listMcpToolsInputSchema,
  declaredEffects: { filesystem: 'none', network: 'read', externalState: 'none' },
  minimumApproval: 'none',
  effects: readOnlyEffects,
  execute: async (input, context) => {
    if (!context.mcpManager) {
      return {
        ok: true,
        stdout: JSON.stringify({
          ok: true,
          configured_provider_count: 0,
          callable_provider_count: 0,
          available_tool_count: 0,
          providers: [],
          tools: [],
          truncated: false,
        }),
        stderr: '',
      };
    }
    const result = buildMcpInventory({
      capabilities: context.mcpManager.getCapabilitySnapshot(),
      providers: context.mcpManager.getProviderDirectorySnapshot(),
      query: input,
    });
    return { ok: result.ok, stdout: JSON.stringify(result), stderr: '' };
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.stdout,
    // 契约要求结构化拒绝（如 stale_cursor）与成功页同为 stdout JSON：
    // 逐流透传，失败时模型仍从 stdout 读到机器可读载荷。
    streams: { stdout: output.stdout, stderr: output.stderr },
    resultMeta: {},
    display: { verb: 'List', preview: 'MCP tools' },
  }),
};

export const readMcpResourceSpec: ToolSpec<
  z.infer<typeof readMcpResourceInputSchema>,
  McpSpecOutput
> = {
  name: 'read_mcp_resource',
  kind: 'coordination',
  contract: READ_MCP_RESOURCE_CONTRACT.sections,
  inputSchema: readMcpResourceInputSchema,
  declaredEffects: { filesystem: 'none', network: 'read', externalState: 'none' },
  minimumApproval: 'none',
  effects: readOnlyEffects,
  approvalSummary: (input) => `read_mcp_resource ${input.server}`,
  execute: async (input, context) => {
    if (!input.server || !input.uri) {
      return { ok: false, stdout: '', stderr: 'server and uri are required' };
    }
    if (!context.mcpManager) {
      return {
        ok: false,
        stdout: '',
        stderr:
          'MCP Runtime is not available in this execution context. Use list_mcp_tools or /mcp to inspect configured providers.',
      };
    }
    try {
      const content = await context.mcpManager.readResource(
        input.server,
        input.uri,
        context.signal,
      );
      if (content.length <= MAX_MODEL_MCP_RESULT_CHARS) {
        return { ok: true, stdout: content, stderr: '', rawContent: content, truncated: false };
      }
      return {
        ok: true,
        stdout: JSON.stringify({
          status: 'partial',
          content: content.slice(0, MAX_MODEL_MCP_RESULT_CHARS),
          truncated: true,
          original_characters: content.length,
          message: 'The MCP resource exceeded the model-facing output limit.',
        }),
        stderr: '',
        rawContent: content,
        truncated: true,
      };
    } catch (error) {
      if (isMcpProviderError(error)) throw error;
      return {
        ok: false,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok ? output.stdout : output.stderr,
    // execute 产出的已是模型就绪文本：逐流透传，Runner 不得按 ok 重新分流。
    streams: { stdout: output.stdout, stderr: output.stderr },
    resultMeta: {
      ...(output.rawContent ? { rawResultDigest: projectionDigest(output.rawContent, '', 0) } : {}),
      truncated: output.truncated,
    },
    display: { verb: 'Read', preview: 'MCP resource' },
  }),
};
