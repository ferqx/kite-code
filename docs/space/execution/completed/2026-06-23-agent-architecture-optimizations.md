# Agent 架构三项优化 — edit_file 容错、checkpoint 源头治理、shell 输出截断

状态：completed
完成时间：2026-06-23
范围：`src/core/tools/file.ts`、`src/core/harness/tool-runner.ts`、`src/core/model/context.ts`、`src/core/harness/graph.ts`
前置条件：ROADMAP P1（edit_file 容错匹配）、PRODUCT.md 工程债务（sanitizeToolCallPairs 补丁）

## 改动概要

| 改动 | 文件 | 效果 |
|------|------|------|
| edit_file 三级自动回退 | `file.ts:236-310` | 模型不再需要显式 `matchMode: 'trimmed'`，工具自动处理常见空白不匹配 |
| shell_execute 输出 Head+Tail 截断 | `tool-runner.ts:353-363` | 大搜索结果不撑爆上下文，保留首尾各 2K 字符，行业标准做法 |
| sanitizeToolCallPairs 热路径移除 | `context.ts` + `graph.ts` | 每次 agent 调用省去 O(n) 冗余孤儿检测 pass，仅保留 reorder 排序 |

## 1. edit_file 三级自动回退

### 问题

模型生成的 `old_string` 与文件实际内容常有不可见差异：
- 行尾多余空格（AI 在块末尾多复制了一个空格）
- 缩进不一致（模型去掉或添加了前导空白）
- 空行差异

此前必须由模型**先读到错误 → 重新 read_file → 再 edit_file**，增加一轮模型往返。

### 方案

```
精确匹配 (indexOf)
  → 成功：直接替换
  → 失败：trimEnd 匹配（去除 old_string 行尾空白）
      → 成功：使用 trimEnd 后的位置替换
      → 失败：逐行 trim 匹配（old_string 和文件内容均逐行去空白）
          → 成功且唯一：使用匹配位置替换
          → 失败/模糊：返回错误
```

**设计原则**：
- 先试最快路径（精确匹配），只有失败时才降级
- 精确失败时，自动尝试 trimEnd（现有逻辑保持）
- trimEnd 失败时，自动尝试逐行 trim（新增，覆盖多行场景）
- `matchMode: 'trimmed'` 仍可用（跳过精确匹配直接走逐行 trim），但不再是必需的
- 所有匹配基于文件内容（非修改后），零副作用

### 行业调研
Claude Code、Codex CLI、Cline 等主流 coding agent 均未在工具层做自动回退——它们依赖模型在失败后 read_file 重试。Kite Code 在此向前一步，将常见空白容错下沉到工具层，减少无效模型往返。

### 测试

```bash
bun test tests/tools.test.ts  # 36 pass（含新增 2 个 auto-retry 测试）
```

## 2. shell_execute 输出 Head+Tail 截断

### 问题

`shell_execute` 的 stdout/stderr **完全不截断**。一次 `rg` 大范围搜索、`git log`、`npm install` 可产出 50KB+ 输出，全部塞进 ToolMessage 返回模型，直接挤占上下文窗口。

### 行业调研

| 工具 | 做法 |
|------|------|
| Claude Code | `BASH_MAX_OUTPUT_LENGTH` (30K chars)，head+tail 截断 |
| Codex CLI | 500 行/50KB 阈值，超限 head+tail |
| squeez (社区) | 4 级管道：去噪 → 去重 → 分组 → head+tail 截断 |
| context-compress | FTS5 索引，仅摘要进上下文 |

行业共识：**不做 LLM 语义摘要**（幻觉风险、丢失文件路径/行号），**仅做安全截断 + 占位标注**。

### 方案

```typescript
// tool-runner.ts:353
export function truncateToolOutput(output: string, maxLen = 4000): string {
  if (output.length <= maxLen) return output;
  const keep = Math.floor(maxLen / 2);
  const head = output.slice(0, keep);
  const tail = output.slice(-keep);
  const omittedLines = output.slice(keep, -keep).split('\n').filter(Boolean).length;
  return `${head}\n... [${omittedLines} lines omitted, ${output.length - 2 * keep} total chars truncated]\n${tail}`;
}
```

应用到 `shell_execute` 的 stdout 和 stderr。`edit_file`/`write_file` 已有独立 2000 字符截断（保持不变）。

**安全保证**：
- 仅截断，不修改内容（零幻觉）
- 保留首尾（头部通常包含最有价值的输出，尾部含最终结果/错误）
- 中间省略位置标注行数和字符数，模型可感知信息缺失

### 测试

现有测试全通过（shell output 样本均 < 4000 字符，截断为 no-op）。

## 3. sanitizeToolCallPairs 热路径移除

### 问题（PRODUCT.md 工程债务 #5）

`sanitizeToolCallPairs` 是"checkpoint 不一致的事后补丁"——每次 agent 调用时运行 O(n) 全消息遍历 + 孤儿检测 + 重建 + 排序。更糟的是它在两条路径上各调用一次（agent 节点的 graph.ts + prepareModelContext 的 context.ts），造成双重冗余。

### 根因分析

graph 的 `cleanup` 节点（`START → cleanup → ...`）在**所有路由之前**运行，已为每个孤儿 tool_call 插入 cancelled ToolMessage。到达 agent 节点和 `prepareModelContext` 时，消息列表**不再含孤儿**。`sanitizeToolCallPairs` 的孤儿检测 pass 永远是 no-op。

### 方案

```
Before:
  cleanup → agent(sanitizeToolCallPairs) → invokeModel → prepareModelContext(sanitizeToolCallPairs) → reorderInterleavedMessages

After:
  cleanup → agent(无 sanitize) → invokeModel → prepareModelContext(reorderInterleavedMessages 直接调用)
```

- `graph.ts:106-110`：agent 节点移除 `sanitizeToolCallPairs` 调用
- `context.ts:222-223`：`prepareModelContext` 改为直接调用 `reorderInterleavedMessages`
- `sanitizeToolCallPairs` 保留导出（测试引用），不在热路径调用

### 前缀缓存影响分析

验证：`sanitizeToolCallPairs(messages)` 对干净消息的输出 JSON === `reorderInterleavedMessages(messages)` 的输出 JSON。对脏消息（含孤儿）场景，cleanup 节点保证 agent 永远看不到脏消息。**改动不影响前缀缓存命中率**。

### 测试

```bash
bun test tests/context.test.ts    # 32 pass（sanitizeToolCallPairs + reorderInterleavedMessages 均覆盖）
bun test tests/graph.test.ts      # 44 pass
bun test tests/integration.test.ts # 14 pass
bun test tests/runner.test.ts     # 30 pass
bun test tests/checkpoint.test.ts # 13 pass
```

## 关联文档

- [[cancel-resume-cleanup]] — 更新为两层架构（2026-06-23），2026-06-27 恢复为三层架构
- [[tool-description-contracts]] — edit_file 契约更新
- [[../understanding/2026-06-08-prefix-cache-hit-rate-analysis]] — 前缀缓存影响因素

## 后续修正

**2026-06-27**：第 3 项（sanitizeToolCallPairs 热路径移除）被**部分回滚**。

根因：cleanup 节点只检查 `m.tool_calls`（顶层字段），不检查 `m.additional_kwargs.tool_calls`。当 LLM 的 tool call 参数 JSON 不合法导致 `parseToolCall()` 失败时，`tool_calls` 为空但 `additional_kwargs.tool_calls` 保留原始数据。cleanup 漏检此场景，残留数据通过 LangChain converter fallback 发送到 API，触发 400 错误。

修复：在 `prepareModelContext` 中恢复 `sanitizeToolCallPairs` 调用（`context.ts:224`），该函数同时检查两个来源并清理不一致字段。

详见 [[cancel-resume-cleanup]] 2026-06-27 更新。
