# Token 统计持久化系统

状态：understanding
最后更新：2026-06-10
范围：`src/core/persistence/checkpoint.ts`、`src/app/tui/session-manager.ts`、`src/app/tui/index.tsx`、`src/app/tui/App.tsx`

相关：
- `understanding/2026-06-09-prompt-cache-optimization.md` — 缓存命中分析与优化
- `understanding/2026-06-08-prefix-cache-hit-rate-analysis.md` — DeepSeek KV cache 机制

## 背景

OpenPX 需要在 TUI Footer 展示 token 统计（缓存命中/未命中/总计），让用户感知每次交互的成本和缓存效果。此前依赖 provider 的 `prompt_cache_miss_tokens` 字段，但该字段语义不稳定且 DeepSeek 的实现存在边界情况。

## 设计方案

### 1. 手动 token 统计，不依赖 provider (8b5a542)

**问题**：DeepSeek API 返回的 `usage.prompt_cache_miss_tokens` 在部分场景下不准确（如纯缓存命中时省略字段）。

**方案**：在收到模型响应时自行计算：

```typescript
// 模型调用后
const usage = response.usage_metadata;
const hit = (usage.input_tokens ?? 0) - (usage.cache_read_input_tokens ?? 0);  // 缓存命中
const miss = usage.cache_creation_input_tokens ?? 0;                            // 缓存未命中
const output = usage.output_tokens ?? 0;
const total = miss + output;  // 仅算实际消耗（不含缓存命中）
```

**关键决策**：`totalTokens` = `miss + output`，**不**计入缓存命中。理由：
- 缓存命中的 token 不消耗 API 费用
- 反映的是"新处理量"而非"上下文窗口大小"
- 避免 `totalTokens` 随对话线性膨胀（缓存命中占比越来越高）

### 2. 持久化到 checkpoint DB (a7f0db3)

新建 `session_stats` 表，与 checkpoint 数据共享同一个 SQLite 文件：

```sql
CREATE TABLE IF NOT EXISTS session_stats (
  thread_id TEXT PRIMARY KEY NOT NULL,
  cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
  cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**写入时机**：`useEffect` 自动触发（每次 `status` 变化后延迟写入）：
- `SessionManager.saveTokenStats(threadId, status)` → 打开 DB → `INSERT OR REPLACE`

**读取时机**：`SessionManager.getSnapshots()` 时为每个 session 加载：
- 优先用内存中的实时数据
- 其次用 DB 持久化数据
- 最后 fallback 到零值

### 3. stateRef 滞后问题修复 (e2b666a, d263428)

React state 更新是异步的。之前的实现用 `stateRef` 在回调闭包中读取最新状态，但存在微任务时序竞争。

**修复历程**：
1. 初始方案：`queueMicrotask(() => saveTokenStats(stateRef.current))` — 仍有时序问题
2. 最终方案：`useEffect` 监听 `status` 变化自动保存 — 彻底消除闭包陈旧引用

```typescript
// src/app/tui/index.tsx
useEffect(() => {
  if (status.totalTokens > 0 || status.cacheMissTokens > 0) {  // 跳过初始全零
    sessionManager.saveTokenStats(threadId, status);
  }
}, [status.cacheHitTokens, status.cacheMissTokens, status.totalTokens]);
```

### 4. getSnapshot 内存缓存 (bb50d86)

**问题**：`SessionManager.getSnapshots()` 在每次 TUI 渲染时被调用（包括 Enter 键输入），每次都查询 DB → 输入卡顿。

**方案**：SessionRuntime 维护内存缓存：

```typescript
class SessionRuntime {
  private cachedStatus: Partial<StatusState> | null = null;
  
  getOrLoadStats(dbPath: string): Partial<StatusState> {
    if (this.cachedStatus) return this.cachedStatus;
    this.cachedStatus = loadFromDB(dbPath);
    return this.cachedStatus;
  }
}
```

### 5. 会话切换时统计保留 (a12d467)

**问题**：切换到另一个 session 再切回来时，token 统计显示全零。

**修复**：`getSnapshots()` 在加载每个 session 时优先从 DB 恢复：

```typescript
const dbStats = this.loadTokenStats(threadId);
status: {
  ...initialStatusSnapshot(),
  ...(dbStats ?? {}),       // DB 持久化数据
  ...(prevStatus ?? {}),    // 内存数据（优先级最高）
}
```

### 6. 切换会话后统计丢失 (a12d467)

**根因**：`statusReducer` 在会话切换后未从 DB 恢复数据。修复在状态快照构建层而非 reducer 层。

## 数据流总结

```
模型响应 (usage_metadata)
    ↓ dispatch({ type: "TOKEN_USAGE" })
statusReducer 累加 cacheHit/cacheMiss/total
    ↓ useEffect
SessionManager.saveTokenStats(threadId, status)
    ↓
SQLite session_stats 表
    ↓ 下次加载会话时
SessionManager.loadTokenStats(threadId)
    ↓ merge
App state.status
    ↓ Footer 渲染
⚡ 12.3k hit / 3.4k miss · 78%
```

## 验证

```bash
bun test tests/session-manager.test.ts
bun test tests/checkpoint.test.ts
```
