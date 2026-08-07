import { getToolContract } from './tool-contracts';

/**
 * 返回工具期望的参数格式描述（人类可读）。
 * 用于在模型解析失败时提供结构化的错误反馈。
 *
 * Returns a human-readable description of the tool's expected argument format
 * for structured error feedback when the model's JSON fails to parse.
 */
export function getToolSchemaHint(toolName: string): string {
  // 先从工具契约中获取 outputFormat（已有的结构化描述）
  const contract = getToolContract(toolName);
  if (contract) {
    const fmt = contract.sections.outputFormat;
    // outputFormat 通常以 "JSON: ..." 开头，直接返回
    if (fmt) return fmt;
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
