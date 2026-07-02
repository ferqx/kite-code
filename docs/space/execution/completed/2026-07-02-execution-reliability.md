# 阶段五：执行可靠性与连续失败处理

状态：completed
创建：2026-07-02
关联方案：`docs/space/plans/2026-06-30-approval-execution-sandbox.md`（阶段五：执行可靠性与连续失败处理）

## 变更概要

让 kite-code 在长时间无人值守任务中具备自我感知失败、停止无效重试、安全收尾的能力。

## 核心改动

### 连续失败计数修复 + 进度检测（`src/core/execution/journal.ts`）

- 新增 `countConsecutiveFailures()` — 从 journal 尾部向前遍历，遇不同指纹/成功即停止，替代原有的全量 `filter()` 计数
- 进度检测：相邻失败条目的 `stderrDigest` 前 100 字符显著不同 → 视为有进展，断链停止
- 导出 `failureFingerprint`、`errorCodeFor`、`maxFailuresFor`（原为私有函数）
- 新增 `isFingerprintExhausted()` 辅助函数（prefix+suffix 模糊匹配，用于预检拦截）

**三层进度检测机制**：
1. 成功自动断链（成功条目 `fingerprint` 为 undefined → 停止）
2. 不同 errorCode → 不同指纹 → 不同链
3. stderrDigest 不同 → 视为有进展，断链

### ToolFailure 扩展（`src/core/harness/tool-result.ts`）

- `ToolFailure` 新增 `exhausted?: ExhaustionSignal` 可选字段，向后兼容

### classifyShellRisk 导出 + 命令分类补齐（`src/core/harness/tool-policy.ts`）

- 导出 `classifyShellRisk` 供 mutation 分类使用
- `isWriteLikeShellCommand` 新增 `pip/pip3/cargo/gem/go/brew/apt/apt-get/choco install` 匹配
- `isVcsMutationCommand` 新增 `git clone/push/reset/clean` 匹配

### 耗尽信号注入 + 预检拦截 + 写操作串行化（`src/core/harness/graph.ts`）

**tools 节点执行流程重构**：`Promise.all` 全并行 → read 并行 + mutation 串行

```
1. 分类：isMutationRequest() → reads vs mutations
2. read 组 → Promise.all 并行执行
3. 每个结果 → recordJournalForMessage 更新 journal
4. mutation 组 → for 循环逐个：
   a. 预检 isFingerprintExhausted → 命中则跳过执行
   b. 执行 executeOneTool
   c. recordJournalForMessage 更新 journal
   d. 新耗尽 → injectExhaustionSignal 重写 ToolMessage
   e. journal 状态流入下一迭代
```

**新增辅助函数**：
- `isMutationRequest()` — 工具分类（write_file/edit_file/task → 是；shell_execute → classifyShellRisk()；其余 → 否）
- `recordJournalForMessage()` — 解析 ToolMessage JSON + 调 recordExecutionResult + 合并子 Agent journal
- `injectExhaustionSignal()` — 显式构造 ExhaustionSignal 并嵌入 ToolMessage content + status:'exhausted'

### 子 Agent Journal 集成（`src/core/subagent/runner.ts` + `types.ts`）

- Loop 状态新增 `executionJournal` + `exhaustedFingerprints`
- 每次工具执行前预检 `isFingerprintExhausted`，命中则跳过
- 每次工具执行后 `recordExecutionResult` 更新 journal
- 返回 `SubAgentResult` 附加 journal 数据
- `SubAgentContinuation` 保存 journal 状态以跨 approval 往返

### 子 Agent Journal 合并（`src/core/harness/graph.ts`）

- `recordJournalForMessage` 解析 task 工具结果中的 `subagentResult.executionJournal` 合并入主 journal
- `pendingSubagentApproval` 路径 `resumeSubAgent` 后合并子 Agent journal

## 数据流（耗尽信号 → 模型）

```
工具执行 → recordExecutionResult()
  → classifyExecutionFailure() 连续失败 >= maxFailures
  → exhaustedFingerprints[fingerprint] = true
  → 本次 ToolMessage: status='exhausted' + content.failure.exhausted
下一次同 tool+path:
  → 预检 isFingerprintExhausted() → true
  → 跳过执行，直接返回 status:'exhausted' ToolMessage
模型看到 ToolMessage:
  → ok=false, failure.exhausted={suggestion:"skip_step",...}
```

## 设计决策

- **连续计数而非全量计数**：同指纹失败只计连续次数，中间插入成功则断链
- **耗尽指纹不清除**：模型必须换工具/路径，不能死磕同一操作
- **预检 + 信号双保险**：既在 Agent 层告诉模型不要重试（ToolMessage），又在系统层拦截（Gateway）
- **Mutation 串行化**：read 可并行，但 write/edit/shell_write/task 必须逐个执行，保证 journal 状态正确流动
- **子 Agent journal 向上合并**：子 Agent 的失败指纹合并到主 Agent，主 Agent 的预检也受子 Agent 耗尽结果保护
- **`injectExhaustionSignal` 显式构造 ExhaustionSignal**：从 journal state 指纹构造而非从 ToolMessage 解析（因为 ToolMessage 内容中从未被写入 ExhaustionSignal）

## 遗留项

- **耗尽通知用户不可见**：当工具指纹被耗尽时，系统向模型发送了 `status:'exhausted'` 的 ToolMessage，但 TUI 消息列表中没有对应的用户可见记录。类比 `/theme` 指令执行后消息列表中有一条 "主题切换为 xxx" 的系统消息——耗尽事件同样应该在消息列表中有留存，让用户感知到"Agent 在此处被系统拦截，换了一条路"。需要在 TUI 的 block 渲染系统中新增类似 `NotificationBlock` 或扩展现有 `tool_card` 来渲染耗尽通知。

## 测试覆盖

| 文件 | 测试数 | 覆盖 |
|------|--------|------|
| `tests/execution/reliability.test.ts` | 11 (+10) | 连续计数、成功断链、不同 errorCode 独立追踪、stderrDigest 进度检测、ENOENT/TIMEOUT/EXIT_NONZERO 阈值、预检匹配/不匹配/空集合、recordExecutionResult 写入 exhaustedFingerprints |
| `tests/execution/reliability-gateway.test.ts` | 6 (新建) | 预检拦截：tool+path 匹配、不同 tool/path 不匹配、不同 errorCode 均匹配、无路径匹配、多指纹并行检查 |

## Review 发现与修复

| 发现 | 严重度 | 修复 |
|------|--------|------|
| `injectExhaustionSignal` 死代码——耗尽信号从未写入 ToolMessage（从内容解析 `failure.exhausted` 永远为 undefined） | 中 | 重构：显式传递 fingerprint 参数，函数内部构造 ExhaustionSignal |
| `classifyShellRisk` 遗漏 pip/cargo/gem/go/brew/apt/choco install | 中低 | `isWriteLikeShellCommand` 新增匹配 |
| `git clone/push/reset/clean` 未被识别为 VCS mutation → 被并行化 | 高/中低 | `isVcsMutationCommand` 新增匹配 |
| continuation 中 `executionJournal` 捕获为活引用（与 `exhaustedFingerprints` 深拷贝不对称） | 低 | 改为 `[...executionJournal]` 浅拷贝 |

## 不变量

- 现有 interactive 模式行为不变
- `ToolExecutionResult` 形状向后兼容（新增可选字段）
- Checkpoint 兼容：缺失字段使用安全默认值（`executionJournal: []`，`exhaustedFingerprints: {}`）
- 原有测试全部通过
