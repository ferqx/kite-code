// src/core/mcp/tool-adapter.ts
import { tool } from '@langchain/core/tools';
import type { Tool as SdkTool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { McpManager } from './manager';

const MAX_MCP_OUTPUT_TOKENS = Number(process.env.KITE_CODE_MCP_MAX_OUTPUT_TOKENS ?? '25000');

/** JSON Schema definition shape (simplified subset) */
export interface JsonSchemaDef {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchemaDef>;
  required?: string[];
  items?: JsonSchemaDef;
  enum?: Array<string | number>;
}

/**
 * Convert a JSON Schema definition to a Zod type.
 * Handles: string, number, integer, boolean, array, object (with properties/required), enum.
 * Falls back to ZodAny for unsupported or empty schemas.
 */
export function jsonSchemaToZod(schema: JsonSchemaDef): z.ZodType {
  if (!schema || Object.keys(schema).length === 0) {
    return z.any();
  }

  // Enum takes priority if present
  if (schema.enum && schema.enum.length > 0) {
    // Zod enum requires at least one string element
    const values = schema.enum.map(String) as [string, ...string[]];
    const zodEnum = z.enum(values);
    return schema.description ? zodEnum.describe(schema.description) : zodEnum;
  }

  switch (schema.type) {
    case 'string': {
      const s = z.string();
      return schema.description ? s.describe(schema.description) : s;
    }
    case 'number': {
      const n = z.number();
      return schema.description ? n.describe(schema.description) : n;
    }
    case 'integer': {
      const n = z.number().int();
      return schema.description ? n.describe(schema.description) : n;
    }
    case 'boolean': {
      const b = z.boolean();
      return schema.description ? b.describe(schema.description) : b;
    }
    case 'array': {
      const itemSchema = schema.items ? jsonSchemaToZod(schema.items) : z.any();
      const arr = z.array(itemSchema);
      return schema.description ? arr.describe(schema.description) : arr;
    }
    case 'object': {
      if (!schema.properties) {
        const obj = z.object({}).passthrough();
        return schema.description ? obj.describe(schema.description) : obj;
      }
      const required = new Set(schema.required ?? []);
      const shape: Record<string, z.ZodType> = {};
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        const zodProp = jsonSchemaToZod(propSchema);
        shape[key] = required.has(key) ? zodProp : zodProp.optional();
      }
      const obj = z.object(shape);
      return schema.description ? obj.describe(schema.description) : obj;
    }
    default: {
      // Unsupported or absent type -> any
      const a = z.any();
      return schema.description ? a.describe(schema.description) : a;
    }
  }
}

/**
 * Parse MCP tool name into server name and tool name.
 * Format: mcp__<serverName>__<toolName>
 * Splits on the first two "__" after the "mcp" prefix, so tool names containing "__" are preserved.
 */
export function parseMcpToolName(name: string): { serverName: string; toolName: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice(5); // remove "mcp__"
  const sepIndex = rest.indexOf('__');
  if (sepIndex < 0) return null;
  return {
    serverName: rest.slice(0, sepIndex),
    toolName: rest.slice(sepIndex + 2),
  };
}

/**
 * Adapt an MCP SDK Tool to a LangChain StructuredTool.
 * Tool name format: mcp__<serverName>__<toolName>
 */
export function adaptMcpTool(serverName: string, mcpTool: SdkTool, manager: McpManager) {
  const toolName = `mcp__${serverName}__${mcpTool.name}`;
  const inputSchema = mcpTool.inputSchema as unknown as JsonSchemaDef;
  const zodSchema = jsonSchemaToZod(inputSchema);

  return tool(
    async (input: Record<string, unknown>) => {
      const raw = await manager.callTool(serverName, mcpTool.name, input);
      return truncateOutput(raw);
    },
    {
      name: toolName,
      description: mcpTool.description ?? `MCP tool: ${mcpTool.name}`,
      schema: zodSchema,
    },
  );
}

/** Truncate output text to MAX_MCP_OUTPUT_TOKENS approximate tokens */
function truncateOutput(text: string): string {
  if (text.length <= MAX_MCP_OUTPUT_TOKENS * 4) {
    return text;
  }
  const truncated = text.slice(0, MAX_MCP_OUTPUT_TOKENS * 4);
  return `${truncated}\n\n[Output truncated to ~${MAX_MCP_OUTPUT_TOKENS} tokens. Use MCP pagination or query parameters to narrow the result.]`;
}
