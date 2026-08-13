import { z } from 'zod';
import { builtinToolRegistry } from './registry/builtins';
import { normalizeToolContract } from './tool-contracts';

/**
 * 返回工具期望的参数格式描述（人类可读）。
 * 用于在模型解析失败时提供结构化的错误反馈。
 *
 * Returns a human-readable description of the tool's expected argument format
 * for structured error feedback when the model's JSON fails to parse.
 */
export function getToolSchemaHint(toolName: string): string {
  const spec = builtinToolRegistry.get(toolName);
  if (spec) {
    const contract = normalizeToolContract(spec.contract);
    const jsonSchema = z.toJSONSchema(spec.inputSchema) as {
      required?: readonly string[];
      properties?: Record<string, unknown>;
    };
    const fields = Object.keys(jsonSchema.properties ?? {});
    const required = jsonSchema.required ?? [];
    return [
      `Arguments must match the disclosed JSON schema fields: ${fields.join(', ') || '(none)'}.`,
      required.length > 0 ? `Required fields: ${required.join(', ')}.` : '',
      contract.constraints,
    ]
      .filter(Boolean)
      .join(' ');
  }

  // MCP 工具：无固定契约，提示模型查看工具描述
  if (toolName.startsWith('mcp__')) {
    return (
      'MCP tool — check the Available MCP Tools section in the system prompt ' +
      "for this tool's JSON schema. Arguments must be a valid JSON object."
    );
  }

  // 未知工具：通用提示
  return 'Unknown tool. Arguments must be a valid JSON object with tool-specific fields.';
}

/**
 * 格式化工具解析错误，返回可反馈给模型的完整错误文本。
 * 包含：工具名 + 模型发送的原始参数 + 解析错误 + 期望格式。
 *
 * Formats a tool parse error into complete feedback text for the model.
 * Includes: tool name, raw arguments sent, parse error, expected format.
 */
export function formatToolParseError(
  toolName: string,
  rawArgs: string,
  parseError: string,
): string {
  const schemaHint = getToolSchemaHint(toolName);
  const truncatedArgs = rawArgs.length > 1200 ? `${rawArgs.slice(0, 1200)}...` : rawArgs;

  return [
    `**Tool**: \`${toolName}\``,
    ``,
    `**Your arguments** (raw, could not be parsed as JSON):`,
    '```json',
    truncatedArgs,
    '```',
    ``,
    `**Parse error**: ${parseError}`,
    ``,
    `**Expected format**:`,
    schemaHint,
  ].join('\n');
}
