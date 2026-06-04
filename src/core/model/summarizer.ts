import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";

/** 单步骤摘要 / Single step summary */
export interface StepSummary {
  /** 步骤描述（来自 HumanMessage 片段或工具推断）/ Step description */
  description: string;
  /** 使用的工具名称列表 / Tool names used */
  tools: string[];
  /** 创建的文件路径 / Created file paths */
  created: string[];
  /** 编辑的文件路径 / Edited file paths */
  edited: string[];
  /** 验证结论 / Verification conclusion */
  verified: string;
  /** 遇到的错误 / Errors encountered */
  errors: string[];
}

/** 压缩层级 / Compaction level */
export type CompactionLevel = "detailed" | "concise";

/** 按 HumanMessage 边界将消息分组为步骤，从每组提取结构化摘要 / Group messages by HumanMessage boundaries and extract structured summaries */
export function summarizeMessages(
  messages: BaseMessage[],
): StepSummary[] {
  // 按 HumanMessage 切分为多个分段 / Split into segments by HumanMessage boundaries
  const segments: BaseMessage[][] = [];
  let currentSegment: BaseMessage[] = [];

  for (const msg of messages) {
    if (msg instanceof HumanMessage && currentSegment.length > 0) {
      segments.push(currentSegment);
      currentSegment = [];
    }
    currentSegment.push(msg);
  }
  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  return segments.map((segment) => summarizeSegment(segment)).filter((s) => s.tools.length > 0);
}

/** 从单个分段提取步骤摘要 / Extract step summary from a single segment */
function summarizeSegment(segment: BaseMessage[]): StepSummary {
  const summary: StepSummary = {
    description: "",
    tools: [],
    created: [],
    edited: [],
    verified: "",
    errors: [],
  };

  for (const msg of segment) {
    if (msg instanceof HumanMessage) {
      // 用第一个 HumanMessage 的前几个词作为步骤描述 / Use first few words of first HumanMessage as step description
      if (!summary.description) {
        summary.description = textContent(msg.content).slice(0, 80);
      }
    } else if (msg instanceof AIMessage && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        if (!summary.tools.includes(tc.name)) {
          summary.tools.push(tc.name);
        }
      }
    } else if (msg instanceof ToolMessage) {
      const content = textContent(msg.content);
      try {
        const result = JSON.parse(content) as Record<string, unknown>;
        // 补充没有在 AIMessage tool_calls 中记录的工具名 / Add tool name if not tracked from AIMessage
        if (typeof result.tool === "string" && !summary.tools.includes(result.tool)) {
          summary.tools.push(result.tool);
        }
        // 提取文件路径 / Extract file path
        if (typeof result.path === "string") {
          if (
            result.tool === "write_file"
          ) {
            if (!summary.created.includes(result.path)) {
              summary.created.push(result.path);
            }
          } else if (result.tool === "edit_file") {
            if (!summary.edited.includes(result.path)) {
              summary.edited.push(result.path);
            }
          }
        }
        // 提取验证状态 / Extract verification status
        if (
          result.ok === true &&
          (result.tool === "read_file" || result.tool === "shell_execute")
        ) {
          summary.verified = "verified";
        }
        // 提取错误 / Extract errors
        if (result.failure && typeof result.failure === "object") {
          const f = result.failure as Record<string, unknown>;
          if (typeof f.reason === "string" && !summary.errors.includes(f.reason)) {
            summary.errors.push(f.reason);
          }
        }
      } catch {
        // 非 JSON 内容跳过 / Skip non-JSON content
      }
    }
  }

  return summary;
}

/** 将多个步骤摘要序列化为模型可读文本 / Serialize multiple step summaries into model-readable text */
export function formatCompactedSummary(
  summaries: StepSummary[],
  level: CompactionLevel,
): string {
  if (summaries.length === 0) return "";

  const lines = [`<compacted level="${level}">`];

  if (level === "concise") {
    // 聚合所有步骤 / Aggregate all steps
    const allTools = deduplicate(summaries.flatMap((s) => s.tools));
    const allCreated = deduplicate(summaries.flatMap((s) => s.created));
    const allEdited = deduplicate(summaries.flatMap((s) => s.edited));
    const allErrors = deduplicate(summaries.flatMap((s) => s.errors));

    if (allTools.length) lines.push(`Tools: ${allTools.join(", ")}`);
    if (allCreated.length) lines.push(`Created: ${allCreated.join(", ")}`);
    if (allEdited.length) lines.push(`Edited: ${allEdited.join(", ")}`);
    lines.push(`Verification: ${allErrors.length ? "had errors" : "completed"}`);
    if (allErrors.length) lines.push(`Errors: ${allErrors.join("; ")}`);
  } else {
    // 详细步骤 / Detailed per-step
    for (let i = 0; i < summaries.length; i++) {
      const s = summaries[i];
      const label = s.description || `Step ${i + 1}`;
      lines.push(`[step] ${label}`);
      if (s.tools.length) lines.push(`  tools: ${s.tools.join(", ")}`);
      if (s.created.length) lines.push(`  created: ${s.created.join(", ")}`);
      if (s.edited.length) lines.push(`  edited: ${s.edited.join(", ")}`);
      if (s.verified) lines.push(`  ${s.verified}`);
      if (s.errors.length) lines.push(`  errors: ${s.errors.join("; ")}`);
    }
  }

  lines.push("</compacted>");
  return lines.join("\n");
}

/** 估算消息列表的 token 数 / Estimate token count for a list of messages */
export function estimateMessagesTokens(messages: BaseMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    const text = textContent(msg.content);
    // CJK 字符通常 1 字符 ≈ 1-2 token，英文约 4 字符 ≈ 1 token
    // 分别计算以提高估算精度
    // CJK chars ≈ 1-2 tokens each, English ≈ 1 token per 4 chars
    const cjkChars = (text.match(/[一-鿿぀-ゟ゠-ヿ가-힯]/g) ?? []).length;
    const nonCjkChars = text.length - cjkChars;
    total += Math.ceil(nonCjkChars / 4 + cjkChars * 1.5);
  }
  return total;
}

function textContent(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

function deduplicate<T>(items: T[]): T[] {
  return [...new Set(items)];
}
