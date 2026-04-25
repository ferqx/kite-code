/**
 * 调试脚本：运行 agent 任务并打印结构化执行过程
 * 用法: bun run scripts/debug-agent.ts "你的任务描述"
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAgentConfig } from "../src/config";
import { streamCodeAgent, resumeCodeAgent } from "../src/runner";
import type { AgentEvent } from "../src/types";

const task = process.argv[2] || "Create hello.txt with exact content 'hello world'";

const root = join(tmpdir(), "openpx-debug");
const workspace = join(root, "workspace");
const dataDir = join(root, "data");
rmSync(root, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const config = loadAgentConfig();
const baseEnv = {
  userId: "debug-user",
  threadId: "debug-thread",
  workspace,
  checkpointPath: join(dataDir, "checkpoints.sqlite"),
  config,
};

let toolCallRound = 0;

// ============================================================================
// 格式化函数
// ============================================================================

function c(label: string, ...parts: string[]) {
  const head = `\n${"=".repeat(70)}\n  ${label}\n${"=".repeat(70)}`;
  console.log(head);
  for (const part of parts) {
    for (const line of part.split("\n")) {
      console.log(`  ${line}`);
    }
  }
}

function br() {
  console.log("  " + "-".repeat(60));
}

function dump(data: unknown): string {
  if (typeof data === "string") return data.slice(0, 500);
  try {
    return JSON.stringify(data, null, 2).slice(0, 500);
  } catch {
    return String(data).slice(0, 500);
  }
}

/** 获取消息类型名，兼容 LangChain 实例 / Get message type name, LangChain compatible */
function msgType(m: Record<string, unknown>): string {
  if (typeof m.getType === "function") return (m.getType as () => string)();
  if (typeof m._getType === "function") return (m._getType as () => string)();
  return String(m.type ?? "?");
}

/** 通用中断数据解析 / General interrupt data parser */
function parseInterrupt(data: unknown): string {
  if (!data || typeof data !== "object") return dump(data);

  // LangGraph 将中断数据包装为 [{ id, value }] / LangGraph wraps interrupt as [{ id, value }]
  const items = Array.isArray(data) ? data : [data];
  const parts: string[] = [];

  for (const item of items) {
    if (!item || typeof item !== "object") {
      parts.push(dump(item));
      continue;
    }
    const obj = item as Record<string, unknown>;

    // LangGraph 0.3+ 中断格式: { id, value: { kind, request, ... } }
    // LangGraph 0.3+ interrupt format: { id, value: { kind, request, ... } }
    if (obj.value && typeof obj.value === "object") {
      const inner = obj.value as Record<string, unknown>;
      parts.push(formatOneInterrupt(inner));
      continue;
    }

    // 旧格式: 直接是 { kind, request } / Legacy format: directly { kind, request }
    parts.push(formatOneInterrupt(obj));
  }

  return parts.filter(Boolean).join("\n  ") || dump(data);
}

function formatOneInterrupt(obj: Record<string, unknown>): string {
  const kind = obj.kind;
  if (kind === "tool_approval") {
    const req = obj.request as Record<string, unknown> | undefined;
    const name = req?.name ?? "?";
    const args = req ? dump(req.args ?? req).slice(0, 150) : "?";
    return `tool_approval: ${name}\n    参数: ${args}`;
  }
  if (kind === "mode_confirmation") {
    return `mode_confirmation: → ${obj.targetMode ?? "?"}\n    计划: ${String(obj.summary ?? "").slice(0, 200)}`;
  }
  // 如果顶层没有 kind，递归查找所有键值 / If no kind at top, search all keys
  return `中断数据: ${dump(obj).slice(0, 300)}`;
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
  c("任务 / Task", `指令: ${task}`, `模型: ${config.modelName}`, `工作区: ${workspace}`);

  const events: AgentEvent[] = [];

  // ---- 阶段 1: 启动 agent ----
  for await (const event of streamCodeAgent({ task, ...baseEnv })) {
    events.push(event);
    printEvent(event);

    if (event.type === "final") {
      printSummary(events);
      return;
    }
    if (event.type === "interrupt") {
      toolCallRound++;
      break;
    }
  }

  // ---- 阶段 2: 自动审批恢复 ----
  for (let i = 0; i < 20; i++) {
    let interrupted = false;
    for await (const event of resumeCodeAgent({ ...baseEnv, resume: { approved: true } })) {
      events.push(event);
      printEvent(event);

      if (event.type === "final") {
        printSummary(events);
        return;
      }
      if (event.type === "interrupt") {
        toolCallRound++;
        interrupted = true;
        break;
      }
    }
    if (!interrupted) {
      console.log("\n  ⚠️ 流意外结束（无 interrupt 也无 final）");
      break;
    }
  }

  console.log("\n  ⚠️ 已达最大恢复次数");
  printSummary(events);
}

// ---- 事件打印 ----
function printEvent(event: AgentEvent) {
  switch (event.type) {
    case "interrupt":
      c(`⏸️  中断 #${toolCallRound + 1} / Interrupt`, parseInterrupt(event.data));
      break;
    case "update":
      printUpdate(event.data);
      break;
    case "cache_metrics":
      printCacheMetrics(event.data);
      break;
    case "final":
      c("✅ 最终回答 / Final Answer", String(event.data));
      break;
  }
}

function printUpdate(data: unknown) {
  const record = data as Record<string, unknown>;
  for (const [nodeName, nodeOutput] of Object.entries(record)) {
    if (!nodeOutput || typeof nodeOutput !== "object") continue;
    const output = nodeOutput as Record<string, unknown>;

    // 模式切换
    if (output.mode) {
      console.log(`  [${nodeName}] 🔀 mode: ${output.mode}`);
    }

    // 计划更新
    if (output.plan && output.plan !== "null" && typeof output.plan === "object") {
      const plan = output.plan as Record<string, unknown>;
      const steps = (plan.steps as Array<{ step: string; status: string }>) ?? [];
      console.log(`  [${nodeName}] 📋 plan: ${plan.name} [${plan.status}]`);
      for (const s of steps) {
        console.log(`      ${s.status === "completed" ? "✅" : s.status === "in_progress" ? "▶️ " : "⏳"} ${s.status}: ${s.step}`);
      }
    }

    // 消息
    if (output.messages && Array.isArray(output.messages)) {
      for (const msg of output.messages as Record<string, unknown>[]) {
        const type = msgType(msg);

        if (type === "ai") {
          const toolCalls = msg.tool_calls as Array<{ name: string; args: unknown }> | undefined;
          if (toolCalls?.length) {
            for (const tc of toolCalls) {
              console.log(`  [${nodeName}] 🤖 调用工具: ${tc.name}(${dump(tc.args).slice(0, 200)})`);
            }
          } else {
            const content = String(msg.content ?? "").slice(0, 500);
            if (content) console.log(`  [${nodeName}] 💬 ${content}`);
          }
        } else if (type === "tool") {
          const content = String(msg.content ?? "").slice(0, 300);
          const status = String(msg.status ?? "?");
          const emoji = status === "success" ? "✅" : "❌";
          console.log(`  [${nodeName}] 🔧 结果(${status}): ${emoji} ${content}`);
        } else if (type === "human") {
          const content = String(msg.content ?? "").slice(0, 300);
          if (content) console.log(`  [${nodeName}] 👤 ${content}`);
        }
      }
    }

    // 证据更新
    if (output.evidence && typeof output.evidence === "object") {
      const ev = output.evidence as Record<string, unknown>;
      const cmds = ev.commands as string[] | undefined;
      const files = ev.files as string[] | undefined;
      const verif = ev.verification as string[] | undefined;
      if (cmds?.length) console.log(`  [${nodeName}] 📝 已执行命令: ${cmds.length} 条`);
      if (files?.length) console.log(`  [${nodeName}] 📁 已修改文件: ${files.join(", ")}`);
      if (verif?.length) {
        for (const v of verif) {
          console.log(`  [${nodeName}] 🔬 验证: ${v}`);
        }
      }
    }
  }
}

function printCacheMetrics(data: unknown) {
  const m = data as Record<string, unknown>;
  const hit = Number(m.cacheHitTokens ?? 0);
  const miss = Number(m.cacheMissTokens ?? 0);
  const input = Number(m.inputTokens ?? 0);
  const rate = input > 0 ? ((hit / input) * 100).toFixed(1) : "0";
  console.log(`  📊 缓存: hit=${hit} miss=${miss} total=${input} (命中率 ${rate}%) | mode=${m.mode ?? "?"}`);
  br();
}

// ---- 总结 ----
function printSummary(events: AgentEvent[]) {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;

  const lines = [
    `总事件: ${events.length}`,
    `node 更新: ${counts.update ?? 0}`,
    `中断次数: ${counts.interrupt ?? 0}`,
    `缓存指标: ${counts.cache_metrics ?? 0}`,
    `最终答案: ${counts.final ?? 0}`,
  ];
  c("📊 统计", ...lines);
}

main().catch((err) => {
  console.error("❌ 错误:", err);
  process.exit(1);
});
