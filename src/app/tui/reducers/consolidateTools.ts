/**
 * 工具预整合逻辑 — 将连续出现的只读探索工具合并为一个 tool_summary 块。
 *
 * Pre-consolidation logic — merge consecutive read-only exploration tools
 * into a single tool_summary block, matching Claude Code's
 * "Thought for Xs, read N files, searched for M patterns" pattern.
 */
import type { ConsolidatedToolEntry, OutputBlock } from '../types';

/** 可合并的探索工具名 / Exploration tool names eligible for consolidation */
const EXPLORATION_TOOLS = new Set([
  'read_file',
  'search_content',
  'search_files',
  'read_mcp_resource',
]);

/** 从事件数据判断是否为可合并的探索工具（用于 tool_call 事件，此时还没有 block） */
export function isExplorationToolEvent(data: {
  name: string;
  args: Record<string, unknown>;
}): boolean {
  if (EXPLORATION_TOOLS.has(data.name)) return true;
  // shell_execute with intent=inspect + search commands (rg/grep/ag/find) — fallback
  // when the model uses shell_execute directly for search (should be rare with dedicated tools)
  if (data.name === 'shell_execute') {
    const intent = data.args?.intent as string | undefined;
    if (intent !== 'inspect') return false;
    const cmd = (data.args?.command as string) ?? '';
    const searchPrefixes = ['rg ', 'grep ', 'ag ', 'ack ', 'git grep ', 'find .', 'find /'];
    return searchPrefixes.some((prefix) => cmd.startsWith(prefix));
  }
  return false;
}

/** 从工具名判断是否为探索工具（用于 tool_done 事件） */
export function isExplorationToolByName(name: string): boolean {
  if (EXPLORATION_TOOLS.has(name)) return true;
  return name === 'shell_execute'; // intent already checked at tool_call time, match by name
}

/**
 * 判断一个 tool_card 是否为可合并的探索工具。
 * shell_execute 仅当 intent=inspect 时视为探索工具。
 */
export function isExplorationTool(block: OutputBlock): boolean {
  if (block.kind !== 'tool_card') return false;
  if (EXPLORATION_TOOLS.has(block.name)) return true;
  // Fallback: shell_execute with inspect intent + search commands
  if (block.name === 'shell_execute') {
    const intent = block.args?.intent as string | undefined;
    if (intent !== 'inspect') return false;
    const cmd = (block.args?.command as string) ?? '';
    const searchPrefixes = ['rg ', 'grep ', 'ag ', 'ack ', 'git grep ', 'find .', 'find /'];
    return searchPrefixes.some((prefix) => cmd.startsWith(prefix));
  }
  return false;
}

/**
 * 生成合并摘要行 / Build the consolidated summary line.
 *
 * 统计各类工具的数量，生成类似 "Thought for 3s, read 2 files, searched for 1 pattern" 的行。
 */
export function buildToolSummaryLine(tools: ConsolidatedToolEntry[]): string {
  let readFiles = 0;
  let searched = 0;
  let foundFiles = 0;
  let readMcp = 0;

  for (const t of tools) {
    if (t.name === 'read_file') readFiles++;
    else if (t.name === 'search_content' || t.name === 'shell_execute') searched++;
    else if (t.name === 'search_files') foundFiles++;
    else if (t.name === 'read_mcp_resource') readMcp++;
    else if (EXPLORATION_TOOLS.has(t.name)) readFiles++; // fallback
  }

  const parts: string[] = [];
  if (readFiles > 0) parts.push(`read ${readFiles} file${readFiles > 1 ? 's' : ''}`);
  if (searched > 0) parts.push(`searched for ${searched} pattern${searched > 1 ? 's' : ''}`);
  if (foundFiles > 0) parts.push(`found ${foundFiles} pattern${foundFiles > 1 ? 's' : ''}`);
  if (readMcp > 0) parts.push(`read ${readMcp} MCP resource${readMcp > 1 ? 's' : ''}`);

  if (parts.length === 0) {
    return `${tools.length} tool call${tools.length > 1 ? 's' : ''}`;
  }

  return parts.join(', ');
}

/**
 * 在末尾轮次中实时合并探索工具。
 *
 * 从最后一个 block 开始向前扫描，收集连续出现的探索工具 tool_card，
 * 将它们合并为一个 tool_summary 块。
 *
 * Merge exploration tools in the last turn in real-time.
 * Scans backward from the last block collecting consecutive exploration tool_cards
 * and merging them into a single tool_summary block.
 */
export function maybeConsolidateLastTurnBlocks(
  blocks: OutputBlock[],
  nextBlockId: number,
): { blocks: OutputBlock[]; nextBlockId: number } {
  if (blocks.length === 0) return { blocks, nextBlockId };

  // 跳过末尾已存在的 tool_summary（它们已是合并结果）
  let endIdx = blocks.length - 1;
  while (endIdx >= 0 && blocks[endIdx]!.kind === 'tool_summary') {
    endIdx--;
  }
  if (endIdx < 0) return { blocks, nextBlockId };

  // 从末尾向前找最右边的已完成的探索 tool_card
  let rightmost = -1;
  for (let i = endIdx; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === 'tool_card' && isExplorationTool(b) && b.status !== 'running') {
      rightmost = i;
      break;
    }
  }
  if (rightmost < 0) return { blocks, nextBlockId };

  // 从 rightmost 向前收集连续的已完成的探索 tool_card
  const explorationBlocks: OutputBlock[] = [];
  let scanIdx = rightmost;
  while (
    scanIdx >= 0 &&
    blocks[scanIdx]!.kind === 'tool_card' &&
    isExplorationTool(blocks[scanIdx]!) &&
    (blocks[scanIdx] as Extract<OutputBlock, { kind: 'tool_card' }>).status !== 'running'
  ) {
    explorationBlocks.unshift(blocks[scanIdx]!);
    scanIdx--;
  }

  if (explorationBlocks.length < 1) return { blocks, nextBlockId };

  // 构建 ConsolidatedToolEntry 列表
  const tools: ConsolidatedToolEntry[] = explorationBlocks.map((b) => {
    const card = b as Extract<OutputBlock, { kind: 'tool_card' }>;
    return {
      callId: card.callId,
      name: card.name,
      args: card.args,
      ok: card.status === 'done' || card.status === 'running',
      summary: card.summary,
      elapsedMs: card.elapsedMs,
      status: card.status,
    };
  });

  const createdAt =
    explorationBlocks[0]!.kind === 'tool_card'
      ? (explorationBlocks[0]!.startedAt ?? Date.now())
      : Date.now();

  // Wall-clock total time
  const totalElapsedMs = Date.now() - createdAt;
  const summaryLine = buildToolSummaryLine(tools);

  const summary: OutputBlock = {
    id: nextBlockId,
    kind: 'tool_summary',
    tools,
    totalElapsedMs,
    createdAt,
    summaryLine,
  };

  // 替换：前缀 + summary + 后缀（非探索 tools / 其他 blocks 在探索块之后的部分）
  const prefix = blocks.slice(0, scanIdx + 1);
  const suffix = blocks.slice(rightmost + 1, endIdx + 1);
  const result = [...prefix, summary, ...suffix];

  return { blocks: result, nextBlockId: nextBlockId + 1 };
}

/**
 * 全量扫描合并 — 用于回放和 text 打断后的重新评估。
 *
 * 扫描所有 block，将连续出现的探索工具合并。
 *
 * Full scan consolidation — for replay and re-evaluation after text interrupts.
 * Scans all blocks and merges consecutive exploration tools.
 */
export function consolidateAllRuns(blocks: OutputBlock[]): OutputBlock[] {
  if (blocks.length === 0) return blocks;

  const result: OutputBlock[] = [];
  let pending: Extract<OutputBlock, { kind: 'tool_card' }>[] = [];

  function flushPending() {
    if (pending.length === 0) return;
    const tools: ConsolidatedToolEntry[] = pending.map((b) => ({
      callId: b.callId,
      name: b.name,
      args: b.args,
      ok: b.status === 'done' || b.status === 'running',
      summary: b.summary,
      elapsedMs: b.elapsedMs,
      status: b.status,
    }));

    const createdAt = pending[0]!.startedAt ?? Date.now();
    const totalElapsedMs = Date.now() - createdAt;

    const summaryLine = buildToolSummaryLine(tools);
    const maxId = Math.max(...pending.map((p) => p.id));

    result.push({
      id: maxId,
      kind: 'tool_summary',
      tools,
      totalElapsedMs,
      createdAt,
      summaryLine,
    });

    pending = [];
  }

  for (const block of blocks) {
    if (block.kind === 'tool_card' && isExplorationTool(block)) {
      pending.push(block);
    } else {
      flushPending();
      result.push(block);
    }
  }
  flushPending();

  return result;
}
