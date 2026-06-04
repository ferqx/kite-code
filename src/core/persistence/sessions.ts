import type { Database } from "bun:sqlite";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { BunSqliteSaver } from "./checkpoint.js";
import { createChatModel } from "../model/factory.js";
import { loadAgentConfig, type AgentConfig } from "../config/index.js";
import type { OutputBlock, InterruptState } from "../../app/tui/types.js";
import type { SubAgentRole } from "../../protocol/events.js";

/** Pending task tool call info collected from AIMessage tool_calls */
interface PendingTaskCall {
  subagentType: SubAgentRole;
  task: string;
}

// ── Public types ──

export interface SessionInfo {
  threadId: string;
  name: string;
  updatedAt: string; // "YYYY-MM-DD HH:MM:SS" local time
}

export interface SessionLoadResult {
  threadId: string;
  blocks: OutputBlock[];
  interrupt: InterruptState | null;
  modelProvider: string;
  modelName: string;
  thinkingLevel: string | null;
}

// ── List sessions ──

/** 列出最近的会话，最多 50 条，按更新时间降序 / List recent sessions, max 50, ordered by last updated descending */
export async function listSessions(checkpointPath: string): Promise<SessionInfo[]> {
  const saver = new BunSqliteSaver(checkpointPath);
  try {
    saver.setup(); // Ensure tables + created_at column exist
    const db = saver.getDb();
    const rows = db
      .query<
        { thread_id: string; updated_at: string | null; cached_name: string | null },
        []
      >(
        `SELECT
           c.thread_id,
           MAX(c.created_at) AS updated_at,
           (SELECT json_extract(c2.metadata, '$.session_name')
            FROM checkpoints c2
            WHERE c2.thread_id = c.thread_id
              AND c2.checkpoint_ns = ''
              AND c2.metadata IS NOT NULL
              AND json_extract(c2.metadata, '$.session_name') IS NOT NULL
            ORDER BY c2.checkpoint_id DESC
            LIMIT 1) AS cached_name
         FROM checkpoints c
         WHERE c.checkpoint_ns = '' AND c.created_at IS NOT NULL
         GROUP BY c.thread_id
         ORDER BY updated_at DESC
         LIMIT 50`,
      )
      .all();

    const sessions: SessionInfo[] = [];
    for (const row of rows) {
      // 优先使用 cached_name（已持久化的智能名称），避免完整 checkpoint 反序列化
      // Prefer cached_name (persisted smart name) to avoid full checkpoint deserialization
      const name = row.cached_name
        ? row.cached_name
        : await readSessionName(saver, row.thread_id);
      sessions.push({
        threadId: row.thread_id,
        name,
        updatedAt: formatLocalTime(row.updated_at),
      });
    }
    return sessions;
  } finally {
    saver.close();
  }
}

/** 按关键词搜索会话（匹配会话名或消息内容）/ Search sessions by keyword (matches name or message content) */
export async function searchSessions(
  checkpointPath: string,
  query: string,
): Promise<SessionInfo[]> {
  if (!query.trim()) return listSessions(checkpointPath);

  const saver = new BunSqliteSaver(checkpointPath);
  try {
    saver.setup();
    const db = saver.getDb();

    // Get all sessions (same query as listSessions but with higher limit for search)
    const nameMatches = db
      .query<{ thread_id: string; updated_at: string | null; cached_name: string | null }, []>(
        `SELECT
           c.thread_id,
           MAX(c.created_at) AS updated_at,
           (SELECT json_extract(c2.metadata, '$.session_name')
            FROM checkpoints c2
            WHERE c2.thread_id = c.thread_id
              AND c2.checkpoint_ns = ''
              AND c2.metadata IS NOT NULL
              AND json_extract(c2.metadata, '$.session_name') IS NOT NULL
            ORDER BY c2.checkpoint_id DESC
            LIMIT 1) AS cached_name
         FROM checkpoints c
         WHERE c.checkpoint_ns = '' AND c.created_at IS NOT NULL
         GROUP BY c.thread_id
         ORDER BY updated_at DESC
         LIMIT 200`,
      )
      .all();

    const results: SessionInfo[] = [];
    const lowerQuery = query.toLowerCase();

    for (const row of nameMatches) {
      const name = row.cached_name ?? await readSessionName(saver, row.thread_id);
      // Check name match first (fast)
      if (name.toLowerCase().includes(lowerQuery)) {
        results.push({
          threadId: row.thread_id,
          name,
          updatedAt: formatLocalTime(row.updated_at),
        });
        continue;
      }

      // Check message content match (slower — need to load checkpoint)
      try {
        const tuple = await saver.getTuple({ configurable: { thread_id: row.thread_id } });
        if (!tuple) continue;
        const cv = (tuple.checkpoint.channel_values ?? {}) as Record<string, unknown>;
        const messages = Array.isArray(cv.messages) ? (cv.messages as unknown[]) : [];
        const hasMatch = messages.some((msg) => {
          if (!msg || typeof msg !== "object") return false;
          const m = msg as Record<string, unknown>;
          const content = typeof m.content === "string" ? m.content : "";
          return content.toLowerCase().includes(lowerQuery);
        });
        if (hasMatch) {
          results.push({
            threadId: row.thread_id,
            name,
            updatedAt: formatLocalTime(row.updated_at),
          });
        }
      } catch {
        /* skip */
      }
    }

    return results;
  } finally {
    saver.close();
  }
}

/** 为会话列表中的每个会话惰性生成智能名称（已有 cached 名称的跳过）/ Lazily generate smart names for sessions without cached names */
export async function enrichSessionNames(
  checkpointPath: string,
  sessions: SessionInfo[],
  onNamed: (threadId: string, name: string) => void,
): Promise<void> {
  for (const s of sessions) {
    // Skip if already has a good name (not just truncated threadId)
    if (s.name !== s.threadId && !s.name.endsWith("...")) continue;

    try {
      const result = await loadSession(checkpointPath, s.threadId);
      if (!result) continue;

      // Find first user message content
      const userBlock = result.blocks.find((b) => b.kind === "user");
      if (!userBlock || userBlock.kind !== "user") continue;

      const generated = await generateSessionName(userBlock.content);
      if (generated) {
        await persistSessionName(checkpointPath, s.threadId, generated);
        onNamed(s.threadId, generated);
      }
    } catch { /* skip this session */ }
  }
}

// ── Load session ──

/** 加载指定会话的最新 checkpoint 并返回结构化的会话数据 / Load latest checkpoint for a thread and return structured session data */
export async function loadSession(
  checkpointPath: string,
  threadId: string,
): Promise<SessionLoadResult | null> {
  const saver = new BunSqliteSaver(checkpointPath);
  try {
    const tuple = await saver.getTuple({
      configurable: { thread_id: threadId },
    });
    if (!tuple) return null;

    const cv = (tuple.checkpoint.channel_values ?? {}) as Record<string, unknown>;
    const messages = Array.isArray(cv.messages) ? (cv.messages as unknown[]) : [];
    const blocks = messagesToOutputBlocks(messages);

    // Check pending writes for interrupt, not channel_values — interrupt() throws
    // before state updates are returned, so channel_values.approvedToolRequest
    // /approvedToolGrant are always null at interrupt checkpoints.
    const pendingWrites = tuple.pendingWrites as [string, string, unknown][] | undefined;
    const interrupt = detectInterrupt(pendingWrites, blocks);

    return {
      threadId,
      blocks,
      interrupt,
      modelProvider: typeof cv.modelProvider === "string" ? cv.modelProvider : "",
      modelName: typeof cv.modelName === "string" ? cv.modelName : "",
      thinkingLevel: typeof cv.thinkingLevel === "string" ? cv.thinkingLevel : null,
    };
  } finally {
    saver.close();
  }
}

// ── Message mapping ──

/** 将 LangChain 消息数组映射为 OutputBlock 数组 / Map LangChain messages to OutputBlock array */
function messagesToOutputBlocks(messages: unknown[]): OutputBlock[] {
  const blocks: OutputBlock[] = [];
  let nextId = 1;
  // Track pending task tool calls: callId → { subagent_type, task }
  const pendingTasks = new Map<string, PendingTaskCall>();

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;

    // HumanMessage → user block
    if (HumanMessage.isInstance(msg)) {
      let content = extractText(msg.content as unknown);
      // Strip "User: " prefix added by runTask for conversation history
      content = content.replace(/^User:\s*/, "");
      if (content.length > 0) {
        blocks.push({ id: nextId++, kind: "user", content });
      }
      continue;
    }

    // AIMessage
    if (AIMessage.isInstance(msg)) {
      const rawMsg = msg as unknown as Record<string, unknown>;
      const additionalKwargs = (rawMsg.additional_kwargs as Record<string, unknown> | undefined) ?? {};

      // reasoning_content → reason block
      const reasoningContent =
        (rawMsg.reasoning_content as string | undefined) ??
        (additionalKwargs.reasoning_content as string | undefined);
      if (typeof reasoningContent === "string" && reasoningContent.length > 0) {
        blocks.push({
          id: nextId++,
          kind: "reason",
          content: reasoningContent,
          folded: false,
        });
      }

      // tool_calls → tool_card blocks (result summary added later from ToolMessage if present)
      const toolCalls = msg.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          if (tc && typeof tc === "object") {
            const call = tc as Record<string, unknown>;
            const callId = typeof call.id === "string" ? call.id : "";
            const name = typeof call.name === "string" ? call.name : "";
            const args = (call.args as Record<string, unknown>) ?? {};

            // task tool → defer to build subagent block from ToolMessage result
            if (name === "task") {
              const subagentType = (args.subagent_type as SubAgentRole) || "explore";
              const task = typeof args.task === "string" ? args.task : "";
              pendingTasks.set(callId, { subagentType, task });
              continue;
            }
            blocks.push({
              id: nextId++,
              kind: "tool_card",
              callId,
              name,
              args,
              status: "done",
              summary: "",
              preview: computePreview(name, args),
            });
          }
        }
      }

      // text content → text block
      const content = extractText(msg.content as unknown);
      if (content.length > 0) {
        blocks.push({ id: nextId++, kind: "text", content });
      }
      continue;
    }

    // ToolMessage → update matching AIMessage tool_card with result, or create standalone
    const tm = msg as Record<string, unknown>;
    if (isToolMessageLike(tm)) {
      const callId = (tm.tool_call_id as string) ?? "";
      const tmName = (tm.name as string) ?? "";

      // task tool result → build subagent block from pending task call + result
      if (tmName === "task") {
        const pending = pendingTasks.get(callId) ?? { subagentType: "explore" as const, task: "" };
        const subId = callId || `sa-${nextId}`;
        const { ok, summary, toolCallCount, durationMs, error } = parseTaskResult(
          typeof tm.content === "string" ? tm.content : JSON.stringify(tm.content),
        );
        blocks.push({
          id: nextId++,
          kind: "subagent",
          subagentId: subId,
          role: pending.subagentType,
          task: pending.task,
          status: ok ? "done" : "error",
          summary,
          toolCallCount,
          durationMs,
          steps: [],
          ...(error ? { error } : {}),
        });
        pendingTasks.delete(callId);
        continue;
      }

      const content = typeof tm.content === "string" ? tm.content : JSON.stringify(tm.content);
      let ok = true;
      let summary = content.slice(0, 200);
      try {
        const p = JSON.parse(content);
        if (p && typeof p === "object") {
          ok = p.ok !== false;
          if (p.ok !== false) {
            summary =
              (p.stdout as string) ??
              (p.message as string) ??
              (p.summary as string) ??
              summary;
          } else {
            summary =
              (p.reason as string) ??
              (p.stderr as string) ??
              (p.message as string) ??
              (p.summary as string) ??
              summary;
          }
        }
      } catch {
        /* use raw content */
      }

      // Find existing tool_card from AIMessage tool_calls and enrich with result
      const existingIdx = blocks.findIndex(
        (b) => b.kind === "tool_card" && b.callId === callId,
      );
      if (existingIdx >= 0 && blocks[existingIdx].kind === "tool_card") {
        blocks[existingIdx] = {
          ...blocks[existingIdx],
          status: ok ? "done" : "error",
          summary,
        } as typeof blocks[number];
      } else {
        // Standalone ToolMessage (no preceding AIMessage tool_calls)
        const name = (tm.name as string) ?? "";
        blocks.push({
          id: nextId++,
          kind: "tool_card",
          callId,
          name,
          args: {},
          status: ok ? "done" : "error",
          summary,
        });
      }
    }
  }

  // Any pending task calls without ToolMessage result → create error subagent blocks
  for (const [callId, pending] of pendingTasks) {
    blocks.push({
      id: nextId++,
      kind: "subagent",
      subagentId: callId || `sa-${nextId}`,
      role: pending.subagentType,
      task: pending.task,
      status: "error",
      summary: "",
      toolCallCount: 0,
      durationMs: 0,
      steps: [],
      error: "Sub-agent result not found in checkpoint",
    });
  }

  return blocks;
}

/** Parse task tool ToolMessage content into subagent block fields */
function parseTaskResult(content: string): {
  ok: boolean;
  summary: string;
  toolCallCount: number;
  durationMs: number;
  error?: string;
} {
  try {
    const p = JSON.parse(content);
    if (p && typeof p === "object") {
      return {
        ok: p.ok !== false,
        summary: (p.summary as string) ?? "",
        toolCallCount: typeof p.toolCallCount === "number" ? p.toolCallCount : 0,
        durationMs: typeof p.durationMs === "number" ? p.durationMs : 0,
        ...(p.error ? { error: p.error as string } : {}),
      };
    }
  } catch { /* fall through */ }
  return { ok: false, summary: content.slice(0, 200), toolCallCount: 0, durationMs: 0 };
}

/** 计算回放工具卡片的 preview 文本 / Compute preview text for replayed tool cards */
function computePreview(name: string, args: Record<string, unknown>): string | undefined {
  switch (name) {
    case "read_file":
    case "write_file":
    case "edit_file":
      return String(args.path ?? "") || undefined;
    case "shell_execute": {
      const cmd = String(args.command ?? "");
      if (!cmd) return undefined;
      return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
    }
    case "update_plan":
      return String(args.name ?? "") || undefined;
    case "ask_user": {
      const q = String(args.question ?? "");
      if (!q) return undefined;
      return q.length > 40 ? q.slice(0, 37) + "..." : q;
    }
    default:
      return undefined;
  }
}

// ── Helpers ──

/** 提取消息文本内容 / Extract text content from various content formats */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: unknown) => {
        if (b && typeof b === "object" && "text" in (b as Record<string, unknown>)) {
          return String((b as Record<string, unknown>).text);
        }
        return "";
      })
      .join("");
  }
  return String(content ?? "");
}

/** 检测审批或用户输入中断状态 / Detect approval or user input interrupt state

LangGraph 的 `interrupt()` 在执行时抛出 GraphInterrupt，状态更新尚未返回，
因此 `channel_values.approvedToolRequest`/`approvedToolGrant` 在中断检查点中始终为 null。
实际的中断值存储在 pending writes 中 `__interrupt__` 通道内。

blockId 从 blocks 中推断：tool_approval 匹配最近的 tool_card block 的 id，
user_input 使用 0（InputBlock 不需要 blockId 做显示匹配）。
*/
function detectInterrupt(
  pendingWrites: [string, string, unknown][] | undefined,
  blocks: OutputBlock[],
): InterruptState | null {
  if (!pendingWrites || pendingWrites.length === 0) return null;

  for (const [, channel, value] of pendingWrites) {
    if (channel === "__interrupt__" && value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      if (v.kind === "tool_approval") {
        // Find the most recent tool_card block (the one that triggered approval)
        for (let i = blocks.length - 1; i >= 0; i--) {
          if (blocks[i].kind === "tool_card") {
            return { kind: "approval", blockId: blocks[i].id };
          }
        }
        return { kind: "approval", blockId: 0 };
      }
      if (v.kind === "user_input") {
        return { kind: "input", blockId: 0 };
      }
    }
  }
  return null;
}

/** 判断是否为 ToolMessage 类消息 / Check if message is ToolMessage-like */
function isToolMessageLike(msg: Record<string, unknown>): boolean {
  try {
    if (typeof msg._getType === "function") {
      return (msg._getType as () => string).call(msg) === "tool";
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** 读取会话名称：优先 cached metadata，兜底截断首条消息 / Read session name: cached > truncation */
async function readSessionName(saver: BunSqliteSaver, threadId: string): Promise<string> {
  try {
    const tuple = await saver.getTuple({ configurable: { thread_id: threadId } });
    if (!tuple) return threadId;

    // 1. Check cached session_name in metadata (set by smart naming)
    const meta = tuple.metadata as Record<string, unknown> | undefined;
    if (meta?.session_name && typeof meta.session_name === "string" && meta.session_name.length > 0) {
      return meta.session_name;
    }

    // 2. Find first HumanMessage and extract content
    const messages = tuple.checkpoint.channel_values?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return threadId;

    for (const msg of messages) {
      const m = msg as Record<string, unknown> | undefined;
      if (!m) continue;
      const msgType = typeof m._getType === "function" ? m._getType() : typeof m.getType === "function" ? m.getType() : undefined;
      if (msgType !== "human") continue;
      let content = (typeof m.content === "string" ? m.content : extractText(m.content)).trim();
      if (!content) continue;
      // Strip conversation history prefix added by runTask
      content = content.replace(/^User:\s*/, "");
      if (!content) continue;
      return content.length > 40 ? content.slice(0, 40) + "..." : content;
    }

    return threadId;
  } catch {
    return threadId;
  }
}

/** 使用轻量模型为会话生成简短有意义的名称（4-20 个字符）/ Generate a short meaningful session name (4-20 chars) using a lightweight model */
export async function generateSessionName(firstMessage: string): Promise<string> {
  // Strip "User: " prefix added by runTask conversation history
  const cleanMessage = firstMessage.replace(/^User:\s*/, "").trim();
  if (!cleanMessage) return "";

  // Fast-fail: skip if no API key configured (avoids network timeout)
  let config: AgentConfig;
  try {
    config = loadAgentConfig();
  } catch {
    return "";
  }
  if (!config.apiKey) return "";

  try {
    const model = createChatModel(config);

    const response = await model.invoke([
      new SystemMessage(
        "You are a session naming assistant. Generate a short, meaningful name (4-20 characters) " +
        "for a conversation based on the user's first message. Reply with ONLY the name, no explanation, no quotes, no punctuation at the end. " +
        "Use the same language as the user's message. " +
        "CRITICAL: Use ONLY plain text characters (letters, digits, spaces, hyphens, underscores). " +
        "NO emoji, NO symbols, NO special characters.",
      ),
      new HumanMessage(`First message: "${cleanMessage}"`),
    ]);

    const name = (typeof response.content === "string" ? response.content : "").trim();

    // Clean up: remove quotes, trailing punctuation, emoji, extra whitespace
    const cleaned = name
      .replace(/^["']|["']$/g, "")
      .replace(/[.!。,，、；;]$/, "")
      .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{2B50}\u{2B55}\u{231A}\u{231B}\u{2328}\u{23CF}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{24C2}\u{25AA}\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2934}\u{2935}\u{3030}\u{303D}\u{3297}\u{3299}]/gu, "")
      .trim();

    if (cleaned.length >= 2 && cleaned.length <= 30) return cleaned;
    return cleaned.slice(0, 30) || "";
  } catch {
    return cleanMessage.slice(0, 30) || "";
    // 原: return ""; // caller handles fallback to truncation
  }
}

/** 持久化会话名称到 checkpoint metadata / Persist session name to checkpoint metadata */
export async function persistSessionName(
  checkpointPath: string,
  threadId: string,
  name: string,
): Promise<void> {
  const saver = new BunSqliteSaver(checkpointPath);
  try {
    const tuple = await saver.getTuple({ configurable: { thread_id: threadId } });
    if (!tuple) return;

    const db = saver.getDb();
    const checkpointId =
      tuple.config?.configurable?.checkpoint_id ?? "";
    if (!checkpointId) return;

    db.run(
      `UPDATE checkpoints SET metadata = json_set(COALESCE(metadata, '{}'), '$.session_name', ?)
       WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`,
      [name, threadId, checkpointId],
    );
  } catch {
    // Non-critical: name will be regenerated on next listing
  } finally {
    saver.close();
  }
}

/** 删除整个会话的 checkpoints 和 writes / Delete all checkpoints and writes for a session */
export async function deleteSession(
  checkpointPath: string,
  threadId: string,
): Promise<void> {
  const saver = new BunSqliteSaver(checkpointPath);
  try {
    await saver.deleteThread(threadId);
  } finally {
    saver.close();
  }
}

/** 将 UTC 时间字符串（SQLite datetime('now') 格式）转为本地时间字符串 / Convert UTC time string to local time, handles null/empty for legacy rows */
function formatLocalTime(utcStr: string | null): string {
  if (!utcStr) return "(unknown)";
  try {
    // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" in UTC
    const d = new Date(utcStr.replace(" ", "T") + "Z");
    if (isNaN(d.getTime())) return utcStr;
    const pad = (n: number) => n.toString().padStart(2, "0");
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
  } catch {
    return utcStr;
  }
}
