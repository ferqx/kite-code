import { type BaseMessage, ToolMessage } from '@langchain/core/messages';
import { countTokens } from '@/core/token-counter';
import type { ContextBudget } from '@/core/types';

// ── 常量 / Constants ──

/** 默认软压缩触发阈值（maxTokens 的比例）/ Default soft compaction threshold (fraction of maxTokens) */
const DEFAULT_COMPACTION_THRESHOLD = 0.75;

/** 默认保留的最近消息数 / Default recent window size (kept uncompacted) */
const DEFAULT_RECENT_WINDOW = 6;

/** 计算输出预留 token 数（取 6% 窗口或 16K 的较小值）/ Compute reserved output tokens (min of 6% window or 16K) */
function reservedOutputTokens(maxTokens: number): number {
  return Math.min(16_384, Math.floor(maxTokens * 0.06));
}

// ── 工具输出微压缩 / Tool output micro-compaction ──

/**
 * 工具调用块：一个 AIMessage（含 tool_calls）+ 其对应的 ToolMessage(s)
 * Tool-call block: one AIMessage (with tool_calls) + its ToolMessage(s)
 */
interface ToolBlock {
  aiMsg: BaseMessage;
  toolMsgs: ToolMessage[];
  tool: string | null;
}

/** 从 AIMessage 提取主工具名 / Extract primary tool name from an AIMessage */
function primaryToolOfAI(msg: BaseMessage): string | null {
  const m = msg as unknown as Record<string, unknown>;
  if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
    return ((m.tool_calls[0] as Record<string, unknown>)?.name as string) ?? null;
  }
  return null;
}

/** 将消息列表分割为混合序列：独立消息 + 工具块
 *  Partition messages into a mixed sequence of standalone messages and tool blocks. */
function partitionIntoToolBlocks(messages: BaseMessage[]): Array<BaseMessage | ToolBlock> {
  const parts: Array<BaseMessage | ToolBlock> = [];
  let pending: ToolBlock | null = null;

  function flush() {
    if (pending) {
      parts.push(pending);
      pending = null;
    }
  }

  for (const msg of messages) {
    const tool = primaryToolOfAI(msg);
    if (tool) {
      flush();
      pending = { aiMsg: msg, toolMsgs: [], tool };
    } else if (pending && ToolMessage.isInstance(msg)) {
      pending.toolMsgs.push(msg);
    } else {
      flush();
      parts.push(msg);
    }
  }
  flush();

  return parts;
}

/** 对消息列表中的重复工具输出进行微压缩。
 *
 * 当同一工具在 ≥3 个连续 (AIMessage[tool=T] + ToolMessage[tool=T]) 配对中出现时，
 * 将中间重复结果的 ToolMessage 折叠为标记，同时保留 AIMessage（模型依赖其 tool_call 结构）。
 *
 * Micro-compact repetitive tool outputs.
 * When the same tool appears in ≥3 consecutive (AIMessage + ToolMessage) pairs,
 * collapse intermediate ToolMessages into a marker while preserving AIMessages.
 */
export function microCompactToolOutputs(messages: BaseMessage[]): BaseMessage[] {
  const parts = partitionIntoToolBlocks(messages);

  const blockIndices: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if ('tool' in part) blockIndices.push(i);
  }

  interface CompactRun {
    start: number;
    end: number;
    tool: string;
  }
  const runs: CompactRun[] = [];
  let runStart = 0;
  for (let i = 1; i <= blockIndices.length; i++) {
    const prev = blockIndices[i - 1]!;
    const curr = i < blockIndices.length ? blockIndices[i]! : -1;
    const prevBlock = parts[prev] as ToolBlock;
    const currBlock = curr >= 0 ? (parts[curr] as ToolBlock) : null;

    if (currBlock && currBlock.tool === prevBlock.tool && prevBlock.tool !== null) {
      continue;
    }
    if (i - runStart >= 3) {
      runs.push({ start: runStart, end: i, tool: prevBlock.tool! });
    }
    runStart = i;
  }

  if (runs.length === 0) return messages;

  const collapsedSet = new Set<number>();
  for (const run of runs) {
    for (let j = run.start + 1; j < run.end - 1; j++) {
      collapsedSet.add(blockIndices[j]!);
    }
  }

  const result: BaseMessage[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if ('tool' in part) {
      const block = part as ToolBlock;
      result.push(block.aiMsg);
      if (collapsedSet.has(i)) {
        result.push(
          new ToolMessage({
            content: JSON.stringify({
              _compacted: true,
              note: `[repeated ${block.tool} output collapsed — same as first result in run]`,
            }),
            tool_call_id: block.toolMsgs[0]?.tool_call_id ?? `compacted-${i}`,
            name: block.tool ?? 'unknown',
            status: 'success',
          }),
        );
      } else {
        for (const tm of block.toolMsgs) result.push(tm);
      }
    } else {
      result.push(part as BaseMessage);
    }
  }

  return result;
}

// ── Token 估算 & 压缩触发 / Token estimation & compaction trigger ──

/**
 * 估算消息列表的 token 数 / Estimate token count for a message list.
 */
export function estimateTokens(messages: BaseMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += countTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'string') {
          total += countTokens(block);
        } else if (
          block &&
          typeof block === 'object' &&
          'text' in (block as Record<string, unknown>)
        ) {
          total += countTokens(String((block as Record<string, unknown>).text));
        }
      }
    }
    total += 4;
    const toolCalls = (msg as unknown as Record<string, unknown>).tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (tc && typeof tc === 'object') {
          total += countTokens(JSON.stringify(tc));
        }
      }
    }
  }
  return total;
}

/**
 * 判断是否需要 M2 对话摘要压缩。
 *
 * 硬限制：估算 token >= maxTokens - reserved
 * 软限制：估算 token >= maxTokens * threshold
 */
export function shouldCompact(
  estimatedTokens: number,
  budget?: ContextBudget,
): { needed: boolean; reason: 'hard' | 'soft' | 'none' } {
  const maxTokens = budget?.maxTokens;
  if (!maxTokens || maxTokens <= 0) {
    return { needed: false, reason: 'none' };
  }

  const threshold = budget.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD;
  const reserved = reservedOutputTokens(maxTokens);

  if (estimatedTokens >= maxTokens - reserved) {
    return { needed: true, reason: 'hard' };
  }
  if (estimatedTokens >= maxTokens * threshold) {
    return { needed: true, reason: 'soft' };
  }
  return { needed: false, reason: 'none' };
}

// ── M1：工具结果折叠 / Tool output folding ──

/** 可折叠的只读工具集合 / Foldable read-only tool set */
const FOLDABLE_TOOLS = new Set([
  'read_file',
  'search_content',
  'search_files',
  'read_mcp_resource',
]);

/** 搜索类命令前缀：这些 shell 命令用于代码搜索，可折叠 */
const SEARCH_COMMAND_PREFIXES = ['rg ', 'grep ', 'ag ', 'ack ', 'git grep ', 'find .', 'find /'];

/** 是否为可折叠的 shell 搜索命令 / Whether a shell command is a foldable search */
function isShellSearch(msg: ToolMessage): boolean {
  const m = msg as unknown as Record<string, unknown>;
  if (m.name !== 'shell_execute') return false;
  try {
    const p = JSON.parse(typeof m.content === 'string' ? m.content : '{}');
    const action = p?.action as Record<string, unknown> | undefined;
    if (action?.intent !== 'inspect') return false;
    const cmd = (p?.command as string) ?? '';
    return SEARCH_COMMAND_PREFIXES.some((prefix) => cmd.startsWith(prefix));
  } catch {
    return false;
  }
}

/** 从 ToolMessage 内容中提取路径（如果存在）/ Extract path from ToolMessage content if present */
function extractPath(msg: ToolMessage): string | null {
  const m = msg as unknown as Record<string, unknown>;
  try {
    const p = JSON.parse(typeof m.content === 'string' ? m.content : '{}');
    return typeof p.path === 'string' ? p.path : null;
  } catch {
    return null;
  }
}

/** 从 ToolMessage 内容中提取行数 / Extract line count from ToolMessage content */
function extractTotalLines(msg: ToolMessage): number | null {
  const m = msg as unknown as Record<string, unknown>;
  try {
    const p = JSON.parse(typeof m.content === 'string' ? m.content : '{}');
    return typeof p.totalLines === 'number' ? p.totalLines : null;
  } catch {
    return null;
  }
}

/** 检查 ToolMessage 是否已被压缩（microCompact 或自身折叠）/ Check if ToolMessage is already compacted */
function isAlreadyCompacted(msg: ToolMessage): boolean {
  const content = typeof msg.content === 'string' ? msg.content : '';
  try {
    const p = JSON.parse(content);
    return p._compacted === true || p._folded === true;
  } catch {
    return false;
  }
}

/** 从 ToolMessage 内容中提取命令 / Extract command from ToolMessage content */
function extractCommand(msg: ToolMessage): string {
  const m = msg as unknown as Record<string, unknown>;
  try {
    const p = JSON.parse(typeof m.content === 'string' ? m.content : '{}');
    return typeof p.command === 'string' ? p.command : '';
  } catch {
    return '';
  }
}

/**
 * 折叠单个 ToolMessage。
 *
 * 对可折叠的只读工具（read_file、shell_execute intent=inspect、read_mcp_resource），
 * 将完整输出替换为一行结构化摘要。
 *
 * Fold a single ToolMessage into a one-line structured summary.
 */
export function foldOneToolResult(msg: ToolMessage): ToolMessage | null {
  const m = msg as unknown as Record<string, unknown>;
  const toolName = (m.name as string) ?? '';
  const ok = (m.status as string) !== 'error';

  // read_file → "Read <path> (<N> lines)"
  if (toolName === 'read_file') {
    const path = extractPath(msg);
    const lines = extractTotalLines(msg);
    const lineStr = lines != null ? `(${lines} lines)` : '';
    return new ToolMessage({
      content: JSON.stringify({
        _folded: true,
        ok,
        note: `Read ${path ?? 'unknown'} ${lineStr}`.trim(),
        path,
        totalLines: lines,
      }),
      tool_call_id: msg.tool_call_id,
      name: toolName,
      status: ok ? 'success' : 'error',
    });
  }

  // search_content → "Searched: <pattern>"
  if (toolName === 'search_content') {
    const pattern =
      typeof (m.args as Record<string, unknown> | undefined)?.pattern === 'string'
        ? ((m.args as Record<string, unknown>).pattern as string)
        : '';
    return new ToolMessage({
      content: JSON.stringify({
        _folded: true,
        ok,
        note: `Searched: ${pattern || 'unknown'}`,
      }),
      tool_call_id: msg.tool_call_id,
      name: toolName,
      status: ok ? 'success' : 'error',
    });
  }

  // search_files → "Found: <pattern>"
  if (toolName === 'search_files') {
    const pattern =
      typeof (m.args as Record<string, unknown> | undefined)?.pattern === 'string'
        ? ((m.args as Record<string, unknown>).pattern as string)
        : '';
    return new ToolMessage({
      content: JSON.stringify({
        _folded: true,
        ok,
        note: `Found: ${pattern || 'unknown'}`,
      }),
      tool_call_id: msg.tool_call_id,
      name: toolName,
      status: ok ? 'success' : 'error',
    });
  }

  // read_mcp_resource → "Read MCP <server>/<uri>"
  if (toolName === 'read_mcp_resource') {
    const path = extractPath(msg);
    return new ToolMessage({
      content: JSON.stringify({
        _folded: true,
        ok,
        note: `Read MCP ${path ?? 'unknown'}`,
      }),
      tool_call_id: msg.tool_call_id,
      name: toolName,
      status: ok ? 'success' : 'error',
    });
  }

  // shell_execute (intent=inspect) → "Searched: <command>"
  if (toolName === 'shell_execute' && isShellSearch(msg)) {
    const cmd = extractCommand(msg);
    return new ToolMessage({
      content: JSON.stringify({
        _folded: true,
        ok,
        note: `Searched: ${cmd || 'unknown'}`,
        command: cmd,
      }),
      tool_call_id: msg.tool_call_id,
      name: toolName,
      status: ok ? 'success' : 'error',
    });
  }

  return null; // not foldable
}

/**
 * 对消息列表中的可折叠只读工具结果进行折叠。
 *
 * 保护规则：
 * - 最近 recentWindowSize 条消息（默认 6）不折叠
 * - 每个文件路径首次出现时保留原文
 * - 折叠后的 ToolMessage 保留原始 tool_call_id、name、status
 *
 * Fold read-only tool outputs in the message list.
 *
 * Protection rules:
 * - Last recentWindowSize messages (default 6) are never folded
 * - First occurrence of each file path keeps full content
 * - Folded ToolMessages retain original tool_call_id, name, status
 */
export function foldToolOutputs(messages: BaseMessage[], budget?: ContextBudget): BaseMessage[] {
  const recentWindowSize = budget?.recentWindowSize ?? DEFAULT_RECENT_WINDOW;
  const preserveCount = Math.min(recentWindowSize, messages.length);

  // 计算保护范围：最后 N 条消息不被折叠
  const protectFrom = messages.length - preserveCount;

  // 跟踪首次出现的文件路径
  const seenPaths = new Set<string>();

  const result: BaseMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    // 非 ToolMessage → 直接通过
    if (!ToolMessage.isInstance(msg)) {
      result.push(msg);
      continue;
    }

    // 已被 microCompact 或自身折叠过的消息不再二次折叠
    if (isAlreadyCompacted(msg)) {
      result.push(msg);
      continue;
    }

    const toolName = (msg as unknown as Record<string, unknown>).name as string;

    // 不在可折叠工具列表中 → 直接通过
    if (!FOLDABLE_TOOLS.has(toolName) && !(toolName === 'shell_execute' && isShellSearch(msg))) {
      result.push(msg);
      continue;
    }

    // 保护规则 1：最近 N 条消息不折叠
    if (i >= protectFrom) {
      // 记录路径用于后续保护判断
      const path = extractPath(msg);
      if (path) seenPaths.add(path);
      result.push(msg);
      continue;
    }

    // 保护规则 2：首次出现的文件路径保留原文
    const path = extractPath(msg);
    if (path && !seenPaths.has(path)) {
      seenPaths.add(path);
      result.push(msg);
      continue;
    }

    // 折叠
    const folded = foldOneToolResult(msg);
    if (folded) {
      result.push(folded);
      if (path) seenPaths.add(path);
    } else {
      result.push(msg);
    }
  }

  return result;
}
