/**
 * 工具预整合逻辑 — 将连续出现的只读探索工具合并为一个 tool_summary 块。
 *
 * Pre-consolidation logic — merge consecutive read-only exploration tools
 * into a single tool_summary block, matching Claude Code's
 * "Thinking Xs · read N files, searched for M patterns" pattern.
 * 注：工具统计（summaryLine）用于两类标题——思考块的
 * "Thinking Xs · <统计>" 后缀（规则 22）与非思考聚合块的
 * 纯统计标签（规则 20）。
 * Note: the tool-stats summaryLine feeds both header forms — the thinking
 * block suffix "Thinking Xs · <stats>" (rule 22) and the pure-stats
 * label of non-thinking aggregates (rule 20).
 */
import type { ConsolidatedToolEntry, OutputBlock } from '../types';

/** 可合并的探索工具名 / Exploration tool names eligible for consolidation */
const EXPLORATION_TOOLS = new Set([
  'read_file',
  'search_content',
  'search_files',
  'read_mcp_resource',
  'shell_execute', // 条件性纳入：需 intent=inspect + 搜索命令前缀，由 isShellExploreCommand 守卫
]);

/** shell_execute 搜索/查找类命令前缀，匹配后纳入 Thought 预整合 */
const SHELL_SEARCH_PREFIXES = ['rg ', 'grep ', 'ag ', 'ack ', 'git grep ', 'find ./', 'find /'];

/**
 * `ls` is read-only only while it remains one simple command. Keep compound
 * shell syntax out of Thought: it may execute another command or write output.
 */
function isPureLsCommand(command: string): boolean {
  const normalized = command.trim();
  if (!/^ls(?:\s|$)/.test(normalized)) return false;
  return !/[|&;<>\n\r`]|\$\(/.test(normalized);
}

/** 判断 shell_execute 是否为搜索/查找类探索命令 */
function isShellExploreCommand(args: Record<string, unknown>): boolean {
  const intent = args.intent;
  if (intent !== 'inspect') return false;
  const command = args.command;
  if (typeof command !== 'string') return false;
  const normalized = command.trim();
  return (
    isPureLsCommand(normalized) ||
    SHELL_SEARCH_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

/** 从事件数据判断是否为可合并的探索工具（用于 tool_call 事件，此时还没有 block） */
export function isExplorationToolEvent(data: {
  name: string;
  args: Record<string, unknown>;
}): boolean {
  if (EXPLORATION_TOOLS.has(data.name)) {
    if (data.name === 'shell_execute') return isShellExploreCommand(data.args);
    return true;
  }
  return false;
}

/** 从工具名判断是否为探索工具（用于 tool_done 事件）。 */
export function isExplorationToolByName(name: string): boolean {
  return EXPLORATION_TOOLS.has(name);
}

/** 判断一个 tool_card 是否为可合并的探索工具。
 * shell_execute 需要额外检查 intent + 命令前缀。 */
export function isExplorationTool(block: OutputBlock): boolean {
  if (block.kind !== 'tool_card') return false;
  if (!EXPLORATION_TOOLS.has(block.name)) return false;
  if (block.name === 'shell_execute') return isShellExploreCommand(block.args);
  return true;
}

/**
 * 生成合并摘要行 / Build the consolidated summary line.
 *
 * 统计各类工具的数量，生成类似 "read 2 files, searched for 1 pattern" 的行
 * （用作非思考聚合块标签，以及思考块 "Thinking Xs · <统计>" 的后缀，
 * 见规则 20/22）。
 */
export function buildToolSummaryLine(tools: ConsolidatedToolEntry[]): string {
  let readFiles = 0;
  let searched = 0;
  let filePatterns = 0;
  let readMcp = 0;
  let listedDirectories = 0;
  let ranCommands = 0;

  for (const t of tools) {
    if (t.name === 'read_file') readFiles++;
    else if (t.name === 'search_content') searched++;
    else if (t.name === 'search_files') filePatterns++;
    else if (t.name === 'read_mcp_resource') readMcp++;
    else if (
      t.name === 'shell_execute' &&
      typeof t.args.command === 'string' &&
      isPureLsCommand(t.args.command)
    )
      listedDirectories++;
    else if (t.name === 'shell_execute' || t.name === 'bash') ranCommands++;
    else if (EXPLORATION_TOOLS.has(t.name)) readFiles++; // fallback
  }

  const parts: string[] = [];
  if (readFiles > 0) parts.push(`read ${readFiles} file${readFiles > 1 ? 's' : ''}`);
  if (searched > 0) parts.push(`searched for ${searched} pattern${searched > 1 ? 's' : ''}`);
  if (filePatterns > 0)
    parts.push(`searched ${filePatterns} file pattern${filePatterns > 1 ? 's' : ''}`);
  if (readMcp > 0) parts.push(`read ${readMcp} MCP resource${readMcp > 1 ? 's' : ''}`);
  if (listedDirectories > 0)
    parts.push(`listed ${listedDirectories} director${listedDirectories > 1 ? 'ies' : 'y'}`);
  if (ranCommands > 0) parts.push(`ran ${ranCommands} command${ranCommands > 1 ? 's' : ''}`);

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
    if (
      b.kind === 'tool_card' &&
      isExplorationTool(b) &&
      b.status !== 'queued' &&
      b.status !== 'running'
    ) {
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
    (blocks[scanIdx] as Extract<OutputBlock, { kind: 'tool_card' }>).status !== 'queued' &&
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
    active: false,
    hasThought: false,
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
      active: false,
      hasThought: false,
    });

    pending = [];
  }

  for (const block of blocks) {
    if (
      block.kind === 'tool_card' &&
      isExplorationTool(block) &&
      block.status !== 'queued' &&
      block.status !== 'running'
    ) {
      pending.push(block);
    } else if (block.kind === 'reason') {
      result.push(block);
    } else {
      flushPending();
      result.push(block);
    }
  }
  flushPending();

  return result;
}
