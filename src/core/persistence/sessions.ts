import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { type AgentConfig, loadAgentConfig } from '../config/index.js';
import { createChatModel } from '../model/factory.js';
import { BunSqliteSaver } from './checkpoint.js';

// ── Public types ──

export interface SessionInfo {
  threadId: string;
  name: string;
  updatedAt: string; // "YYYY-MM-DD HH:MM:SS" local time
  /** true if no cached smart name exists (name is raw first message or threadId) */
  needsSmartName: boolean;
}

/** 中立会话数据结构（无 UI 依赖），可被任意前端消费
 *  Neutral session data (no UI dependency), consumable by any frontend */
export interface SessionData {
  threadId: string;
  /** 原始 LangGraph 消息数组 / Raw LangGraph message array */
  messages: unknown[];
  interrupt: ReplayInterrupt | null;
  modelProvider: string;
  modelName: string;
  thinkingLevel: string | null;
  /** 已批准的方案（从 checkpoint state.plan 提取）/ Approved plan extracted from checkpoint state.plan */
  plan: AgentPlan | null;
  /** 方案审批通过时的授权模式（用于推断 auto/manual）/ Authorization mode at plan approval time */
  planAuthMode: string | null;
}

import type { AgentPlan } from '../../protocol/events.js';

/** 中立中断信息（无 blockId），TUI 端负责映射到具体 block
 *  Neutral interrupt info (no blockId), TUI layer maps to concrete block */
export interface ReplayInterrupt {
  kind: 'approval' | 'input' | 'plan_review';
  /** 触发中断的 tool_call_id（用于 TUI 端 block ID 映射） */
  callId?: string;
  /** plan_review 中断时携带的方案数据 / Plan data for plan_review interrupts */
  plan?: AgentPlan;
}

// ── List sessions ──

/** 列出最近的会话，最多 50 条，按更新时间降序 / List recent sessions, max 50, ordered by last updated descending */
export async function listSessions(checkpointPath: string): Promise<SessionInfo[]> {
  const saver = new BunSqliteSaver(checkpointPath);
  try {
    saver.setup(); // Ensure tables + created_at column exist
    const db = saver.getDb();
    // 使用 ROW_NUMBER() 窗口函数替代关联子查询 + GROUP BY，单次扫描即可获取每个 thread
    // 的最新 checkpoint 及其 session_name，避免 O(N * log M) 的关联子查询开销
    // Use ROW_NUMBER() window function instead of correlated subquery + GROUP BY,
    // fetching the latest checkpoint per thread in a single scan
    const rows = db
      .query<{ thread_id: string; updated_at: string | null; cached_name: string | null }, []>(
        `WITH latest AS (
           SELECT thread_id, created_at, metadata,
             ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY checkpoint_id DESC) as rn
           FROM checkpoints
           WHERE checkpoint_ns = '' AND created_at IS NOT NULL
         )
         SELECT thread_id, created_at AS updated_at,
           json_extract(metadata, '$.session_name') AS cached_name
         FROM latest
         WHERE rn = 1
         ORDER BY created_at DESC
         LIMIT 50`,
      )
      .all();

    const sessions: SessionInfo[] = [];
    for (const row of rows) {
      // 优先使用 cached_name（已持久化的智能名称），避免完整 checkpoint 反序列化
      // Prefer cached_name (persisted smart name) to avoid full checkpoint deserialization
      const name = row.cached_name ? row.cached_name : await readSessionName(saver, row.thread_id);
      sessions.push({
        threadId: row.thread_id,
        name,
        updatedAt: formatLocalTime(row.updated_at),
        needsSmartName: !row.cached_name,
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

    // Get all sessions (same ROW_NUMBER() pattern as listSessions, higher limit for search)
    const nameMatches = db
      .query<{ thread_id: string; updated_at: string | null; cached_name: string | null }, []>(
        `WITH latest AS (
           SELECT thread_id, created_at, metadata,
             ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY checkpoint_id DESC) as rn
           FROM checkpoints
           WHERE checkpoint_ns = '' AND created_at IS NOT NULL
         )
         SELECT thread_id, created_at AS updated_at,
           json_extract(metadata, '$.session_name') AS cached_name
         FROM latest
         WHERE rn = 1
         ORDER BY created_at DESC
         LIMIT 200`,
      )
      .all();

    const results: SessionInfo[] = [];
    const lowerQuery = query.toLowerCase();

    for (const row of nameMatches) {
      const name = row.cached_name ?? (await readSessionName(saver, row.thread_id));
      if (name.toLowerCase().includes(lowerQuery)) {
        results.push({
          threadId: row.thread_id,
          name,
          updatedAt: formatLocalTime(row.updated_at),
          needsSmartName: !row.cached_name,
        });
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
  // 复用单个连接避免每个会话打开/关闭 DB 两次 / Reuse a single connection to avoid opening/closing DB twice per session
  const saver = new BunSqliteSaver(checkpointPath);
  try {
    for (const s of sessions) {
      // Skip if already has a cached smart name
      if (!s.needsSmartName) continue;

      try {
        const result = await loadSessionWithSaver(saver, s.threadId);
        if (!result) continue;

        // Find first user message content from raw messages
        const firstHuman = result.messages.find(
          (m) =>
            m && typeof m === 'object' && HumanMessage.isInstance(m as Record<string, unknown>),
        ) as Record<string, unknown> | undefined;
        if (!firstHuman) continue;
        let content = extractText(firstHuman.content);
        // Strip "User: " prefix (mirrors messagesToOutputBlocks → replay-blocks.ts)
        content = content.replace(/^User:\s*/, '');
        if (!content) continue;

        const generated = await generateSessionName(content);
        if (generated) {
          await persistSessionNameWithSaver(saver, s.threadId, generated);
          onNamed(s.threadId, generated);
        }
      } catch {
        /* skip this session */
      }
    }
  } finally {
    saver.close();
  }
}

// ── Load session ──

/** 加载指定会话的最新 checkpoint 并返回中立会话数据 / Load latest checkpoint for a thread and return neutral session data */
export async function loadSession(
  checkpointPath: string,
  threadId: string,
): Promise<SessionData | null> {
  const saver = new BunSqliteSaver(checkpointPath);
  try {
    return await loadSessionWithSaver(saver, threadId);
  } finally {
    saver.close();
  }
}

/** 使用已有 saver 加载会话（供 enrichSessionNames 复用连接）/ Load session using an existing saver (for connection reuse in enrichSessionNames) */
async function loadSessionWithSaver(
  saver: BunSqliteSaver,
  threadId: string,
): Promise<SessionData | null> {
  const tuple = await saver.getTuple({
    configurable: { thread_id: threadId },
  });
  if (!tuple) return null;

  const cv = (tuple.checkpoint.channel_values ?? {}) as Record<string, unknown>;
  const messages = Array.isArray(cv.messages) ? (cv.messages as unknown[]) : [];

  // Check pending writes for interrupt, not channel_values — interrupt() throws
  // before state updates are returned, so channel_values.approvedToolRequest
  // /approvedToolGrant are always null at interrupt checkpoints.
  const pendingWrites = tuple.pendingWrites as [string, string, unknown][] | undefined;
  const interrupt = detectInterrupt(pendingWrites);

  // Extract approved plan from channel_values (set after plan_review approval)
  const plan = extractPlan(cv);
  const planAuthMode = extractPlanAuthMode(cv);

  return {
    threadId,
    messages,
    interrupt,
    modelProvider: typeof cv.modelProvider === 'string' ? cv.modelProvider : '',
    modelName: typeof cv.modelName === 'string' ? cv.modelName : '',
    thinkingLevel: typeof cv.thinkingLevel === 'string' ? cv.thinkingLevel : null,
    plan,
    planAuthMode,
  };
}

// ── Helpers ──

/** 提取消息文本内容 / Extract text content from various content formats */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: unknown) => {
        if (b && typeof b === 'object' && 'text' in (b as Record<string, unknown>)) {
          return String((b as Record<string, unknown>).text);
        }
        return '';
      })
      .join('');
  }
  return String(content ?? '');
}

/** 检测审批或用户输入中断状态（中立类型，无 UI 依赖）
 *  Detect approval or user input interrupt state (neutral, no UI dependency)
 *
 * LangGraph 的 `interrupt()` 在执行时抛出 GraphInterrupt，状态更新尚未返回，
 * 因此 `channel_values.approvedToolRequest`/`approvedToolGrant` 在中断检查点中始终为 null。
 * 实际的中断值存储在 pending writes 中 `__interrupt__` 通道内。
 *
 * 从 interrupt value 的 `request.id` 提取 tool_call_id，
 * TUI 端负责将其映射为具体的 block ID。
 */
function detectInterrupt(
  pendingWrites: [string, string, unknown][] | undefined,
): ReplayInterrupt | null {
  if (!pendingWrites || pendingWrites.length === 0) return null;

  for (const [, channel, value] of pendingWrites) {
    if (channel === '__interrupt__' && value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      const request = v.request as Record<string, unknown> | undefined;
      if (v.kind === 'tool_approval') {
        return {
          kind: 'approval',
          callId: typeof request?.id === 'string' ? request.id : undefined,
        };
      }
      if (v.kind === 'user_input') {
        return {
          kind: 'input',
          callId: typeof request?.id === 'string' ? request.id : undefined,
        };
      }
      if (v.kind === 'plan_review') {
        return {
          kind: 'plan_review',
          plan: parsePlanFromInterrupt(v),
        };
      }
    }
  }
  return null;
}

/** 从 interrupt value 解析 AgentPlan / Parse AgentPlan from interrupt value */
function parsePlanFromInterrupt(v: Record<string, unknown>): AgentPlan | undefined {
  const p = v.plan as Record<string, unknown> | undefined;
  if (!p || typeof p !== 'object') return undefined;
  return {
    name: (p.name as string) ?? '',
    description: (p.description as string) ?? '',
    status: (p.status as AgentPlan['status']) ?? 'pending',
    steps:
      (p.steps as Array<Record<string, unknown>> | undefined)?.map((s) => ({
        step: (s.step as string) ?? '',
        status: (s.status as AgentPlan['status']) ?? 'pending',
      })) ?? [],
  };
}

/** 从 channel_values 提取已批准的方案 / Extract approved plan from channel_values */
function extractPlan(cv: Record<string, unknown>): AgentPlan | null {
  const p = cv.plan as Record<string, unknown> | undefined;
  if (!p || typeof p !== 'object') return null;
  return {
    name: (p.name as string) ?? '',
    description: (p.description as string) ?? '',
    status: (p.status as AgentPlan['status']) ?? 'pending',
    steps:
      (p.steps as Array<Record<string, unknown>> | undefined)?.map((s) => ({
        step: (s.step as string) ?? '',
        status: (s.status as AgentPlan['status']) ?? 'pending',
      })) ?? [],
  };
}

/** 从 channel_values 提取方案审批时的授权模式 / Extract authorization mode at plan approval */
function extractPlanAuthMode(cv: Record<string, unknown>): string | null {
  const auth = cv.authorization as Record<string, unknown> | undefined;
  if (auth && typeof auth.mode === 'string') {
    return auth.mode;
  }
  return null;
}

/** 读取会话名称：优先 cached metadata，兜底截断首条消息 / Read session name: cached > truncation */
async function readSessionName(saver: BunSqliteSaver, threadId: string): Promise<string> {
  try {
    // 先用轻量 SQL 提取 metadata.session_name 和首条消息，避免反序列化完整 checkpoint
    // Lightweight SQL extraction first to avoid full checkpoint deserialization
    const db = saver.getDb();
    const row = db
      .query<
        {
          session_name: string | null;
          msg_type_lc: string | null;
          msg_type_id: string | null;
          content_kwargs: string | null;
          content_plain: string | null;
        },
        [string]
      >(
        `SELECT
           json_extract(metadata, '$.session_name') AS session_name,
           json_extract(checkpoint, '$.channel_values.messages[0].lc_id[2]') AS msg_type_lc,
           json_extract(checkpoint, '$.channel_values.messages[0].id[2]') AS msg_type_id,
           json_extract(checkpoint, '$.channel_values.messages[0].kwargs.content') AS content_kwargs,
           json_extract(checkpoint, '$.channel_values.messages[0].content') AS content_plain
         FROM checkpoints
         WHERE thread_id = ? AND checkpoint_ns = ''
         ORDER BY checkpoint_id DESC
         LIMIT 1`,
      )
      .get(threadId);
    if (!row) return threadId;

    // 1. Check cached session_name in metadata (set by smart naming)
    if (row.session_name && row.session_name.length > 0) {
      return row.session_name;
    }

    // 2. Extract first HumanMessage content from json_extract results
    const msgType = row.msg_type_lc ?? row.msg_type_id;
    if (msgType === 'HumanMessage') {
      const firstContent = row.content_kwargs ?? row.content_plain;
      if (firstContent) {
        const trimmed =
          typeof firstContent === 'string' ? firstContent.trim() : String(firstContent).trim();
        if (trimmed) {
          const clean = trimmed.replace(/^User:\s*/, '');
          if (clean) return clean;
        }
      }
    }

    // 3. Fall back to full deserialization for structured content (e.g., multi-modal blocks)
    const tuple = await saver.getTuple({ configurable: { thread_id: threadId } });
    if (!tuple) return threadId;

    const meta = tuple.metadata as Record<string, unknown> | undefined;
    if (
      meta?.session_name &&
      typeof meta.session_name === 'string' &&
      meta.session_name.length > 0
    ) {
      return meta.session_name;
    }

    const messages = tuple.checkpoint.channel_values?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return threadId;

    for (const msg of messages) {
      const m = msg as Record<string, unknown> | undefined;
      if (!m) continue;
      const msgType =
        typeof m._getType === 'function'
          ? m._getType()
          : typeof m.getType === 'function'
            ? m.getType()
            : undefined;
      if (msgType !== 'human') continue;
      let content = (typeof m.content === 'string' ? m.content : extractText(m.content)).trim();
      if (!content) continue;
      content = content.replace(/^User:\s*/, '');
      if (!content) continue;
      return content;
    }

    return threadId;
  } catch {
    return threadId;
  }
}

/** 使用轻量模型为会话生成简短有意义的名称（4-20 个字符）/ Generate a short meaningful session name (4-20 chars) using a lightweight model */
export async function generateSessionName(firstMessage: string): Promise<string> {
  // Strip "User: " prefix added by runTask conversation history
  const cleanMessage = firstMessage.replace(/^User:\s*/, '').trim();
  if (!cleanMessage) return '';

  // Fast-fail: skip if no API key configured (avoids network timeout)
  let config: AgentConfig;
  try {
    config = loadAgentConfig();
  } catch {
    return '';
  }
  if (!config.apiKey) return '';

  try {
    const model = createChatModel(config);

    const response = await model.invoke([
      new SystemMessage(
        'You are a session naming assistant. Generate a short, meaningful name (4-20 characters) ' +
          "for a conversation based on the user's first message. Reply with ONLY the name, no explanation, no quotes, no punctuation at the end. " +
          "Use the same language as the user's message. " +
          'CRITICAL: Use ONLY plain text characters (letters, digits, spaces, hyphens, underscores). ' +
          'NO emoji, NO symbols, NO special characters.',
      ),
      new HumanMessage(`First message: "${cleanMessage}"`),
    ]);

    const name = (typeof response.content === 'string' ? response.content : '').trim();

    // Clean up: remove quotes, trailing punctuation, emoji, extra whitespace
    const cleaned = name
      .replace(/^["']|["']$/g, '')
      .replace(/[.!。,，、；;]$/, '')
      .replace(
        /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{2B50}\u{2B55}\u{231A}\u{231B}\u{2328}\u{23CF}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{24C2}\u{25AA}\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2934}\u{2935}\u{3030}\u{303D}\u{3297}\u{3299}]/gu,
        '',
      )
      .trim();

    if (cleaned.length >= 2 && cleaned.length <= 30) return cleaned;
    return cleaned.slice(0, 30) || '';
  } catch {
    return cleanMessage.slice(0, 30) || '';
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
    await persistSessionNameWithSaver(saver, threadId, name);
  } finally {
    saver.close();
  }
}

/** 使用已有 saver 持久化会话名称（供 enrichSessionNames 复用连接）
 *  Persist session name using an existing saver (for connection reuse in enrichSessionNames) */
async function persistSessionNameWithSaver(
  saver: BunSqliteSaver,
  threadId: string,
  name: string,
): Promise<void> {
  const tuple = await saver.getTuple({ configurable: { thread_id: threadId } });
  if (!tuple) return;

  const db = saver.getDb();
  const checkpointId = tuple.config?.configurable?.checkpoint_id ?? '';
  if (!checkpointId) return;

  db.run(
    `UPDATE checkpoints SET metadata = json_set(COALESCE(metadata, '{}'), '$.session_name', ?)
     WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`,
    [name, threadId, checkpointId],
  );
}

/** 删除整个会话的 checkpoints 和 writes / Delete all checkpoints and writes for a session */
export async function deleteSession(checkpointPath: string, threadId: string): Promise<void> {
  const saver = new BunSqliteSaver(checkpointPath);
  try {
    await saver.deleteThread(threadId);
  } finally {
    saver.close();
  }
}

/** 将 UTC 时间字符串（SQLite datetime('now') 格式）转为本地时间字符串 / Convert UTC time string to local time, handles null/empty for legacy rows */
function formatLocalTime(utcStr: string | null): string {
  if (!utcStr) return '(unknown)';
  try {
    // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" in UTC
    const d = new Date(`${utcStr.replace(' ', 'T')}Z`);
    if (Number.isNaN(d.getTime())) return utcStr;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
  } catch {
    return utcStr;
  }
}
