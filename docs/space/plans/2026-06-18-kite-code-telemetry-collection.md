# Kite Code 遥测收集方案

状态：superseded
创建：2026-06-18
替代者：
[`2026-07-29-agent-production-observability-operations.md`](2026-07-29-agent-production-observability-operations.md)

> 本计划仍允许 project basename、命令名和截断错误正文进入远程通道，不符合已批准的
> metadata-only、无路径、无命令、无自由错误文本边界，不再作为实施依据。

## 目标

在现有用户自配 OTLP 通道的基础上，增加一条可选的 Kite Code 遥测通道，收集脱敏后的工具调用统计数据，用于改进工具契约和提示词质量。**默认关闭，用户显式 opt-in 后才生效。**

## 不做什么

- **不收集对话内容**——不收集 user message、assistant text、reasoning_content
- **不收集文件路径**——`kite_code.tool.file` 只保留扩展名，丢弃目录和文件名
- **不收集命令内容**——`kite_code.tool.command` 只保留命令名（如 `npm`），丢弃参数
- **不收集 stderr**——`tool.error` event 中的 stderr 不发送
- **不收集 API key / token**——和你自己一样遵守密钥安全
- **不走用户自己的 endpoint**——两条通道完全独立

## 数据模型

### 双通道架构

```
Kite Code Agent
    │
    ├── 用户自配通道（现有）
    │   └── otlpEndpoint → Jaeger / Langfuse / Grafana
    │       └── 完整 Span 数据，包含所有 detail
    │
    └── Kite Code 遥测通道（新增，opt-in）
        └── kiteCodeEndpoint → telemetry.kite-code.dev
            └── 脱敏后 Span 数据，仅结构化统计维度
```

### 发送什么 vs 脱敏什么

原则：**保留对改进有用的诊断信息，去掉能追溯到具体用户/项目/文件的隐私数据。**

```
Span 全部属性                        遥测通道
──────────────────────────────────  ────────
设备 & 环境:
  kite_code.os: "win32"                  → ✓ 完整发送
  kite_code.os_version: "10.0.26220"     → ✓ 完整发送
  kite_code.arch: "x64"                  → ✓ 完整发送
  kite_code.bun_version: "1.3.14"        → ✓ 完整发送
  kite_code.kite-code_version: "0.0.1"     → ✓ 完整发送
  kite_code.terminal: "Windows Terminal" → ✓ 完整发送（TUI 渲染兼容性）

运行维度:
  kite_code.frontend: "tui"              → ✓ 完整发送
  kite_code.workspace: "/home/alice/project" → ✗ basename "project"
  kite_code.thread_id: "tui-lx1234"     → ✗ sha256 前 12 位

模型调用:
  gen_ai.system: "deepseek"           → ✓ 完整发送
  gen_ai.request.model: "..."         → ✓ 完整发送
  gen_ai.usage.input_tokens: 12000    → ✓ 完整发送
  gen_ai.usage.output_tokens: 500     → ✓ 完整发送
  kite_code.cache.hit_tokens: 10000      → ✓ 完整发送
  kite_code.cache.miss_tokens: 2000      → ✓ 完整发送
  model.retry (event):
    kite_code.retry.attempt: 2           → ✓ 完整发送
    model.retry.category: "timeout"   → ✓ 完整发送
    model.retry.error: "ETIMEDOUT..." → ✗ 只发 category，不发明文

工具调用:
  kite_code.tool.name: "shell_execute"   → ✓ 完整发送
  kite_code.tool.ok: false               → ✓ 完整发送
  kite_code.tool.exit_code: 1            → ✓ 完整发送
  kite_code.tool.failure_reason: "..."   → ✓ 完整发送 ← 核心数据
  kite_code.tool.duration_ms: 3200       → ✓ 完整发送
  kite_code.tool.command: "npx jest --ci"→ ✗ 只发 "npx"（命令名，不含参数）
  kite_code.tool.file: "src/runner.ts"   → ✗ 只发 ".ts"（扩展名，不含路径）

工具错误详情（关键改进数据）:
  tool.error (event):
    tool.error.summary (前 500 字符)   → ✓ 截断发送 ← "command not found" 还是 "exit code 1" 决定怎么改提示词
    tool.error.stderr（前 200 字符）   → ✓ 截断发送 ← shell 工具失败的核心原因
    old_string / new_string            → ✗ 不发送（可能含源代码）
    file content                       → ✗ 不发送

子 Agent:
  kite_code.subagent.role: "explore"      → ✓ 完整发送
  kite_code.subagent.id: "sub-lx1234"    → ✓ 完整发送（无隐私信息的内部 ID）
  kite_code.subagent.tool_call_count: 5   → ✓ 完整发送
  kite_code.subagent.duration_ms: 8000    → ✓ 完整发送
  subagent.error (event):
    error summary                      → ✓ 截断发送（子 agent 失败的根因）
    error stack trace                  → ✗ 不发送

会话 & 用户:
  kite_code.user.id: "..."               → ✗ 不发送 ← 不在 span 上记录 user 维度
  user message content                 → ✗ 不发送
  assistant text / reasoning           → ✗ 不发送
```

### 脱敏规则总表

| 字段 | 原值 | 脱敏后 | 理由 |
|------|------|--------|------|
| `kite_code.thread_id` | `tui-lx1234-0` | SHA-256 前 12 位 | 去个人化但保留跨 run 关联 |
| `kite_code.workspace` | `/home/alice/work/proj` | `proj` (basename) | 保留项目名语义 |
| `kite_code.tool.file` | `src/core/runner.ts` | `.ts` (ext only) | 保留语言/文件类型信号 |
| `kite_code.tool.command` | `npx jest --coverage --ci` | `npx` (cmd only) | 保留命令名，去掉参数（参数可能含路径/项目名） |
| `tool.error.summary` | 完整 summary | 前 500 字符截断 | 保留错误模式，限长防泄漏 |
| `tool.error.stderr` | 完整 stderr | 前 200 字符截断 | 保留错误模式 |
| `model.retry.error` | `ETIMEDOUT: connect 1.2.3.4:443` | `timeout` (category) | 保留错误类型，去掉 IP/端口 |
| `tool.error.old_string` | 完整 old_string | **不发送** | 可能包含源代码 |
| `tool.error.new_string` | 完整 new_string | **不发送** | 可能包含源代码 |
| `node.agent` events 内容 | reasoning_content | **不发送** | 模型思维链 |

## 配置

```jsonc
// ~/.kite-code/kite-code.jsonc
{
  "telemetry": {
    "enabled": true,
    "otlpEndpoint": "http://localhost:4318/v1/traces",  // 你自己的
    // Kite Code 遥测（opt-in）
    "allowKiteCodeTelemetry": false,          // 默认 false。true → 开启
    "kiteCodeEndpoint": "https://telemetry.kite-code.dev/v1/traces",
    "kiteCodeHeaders": "Authorization=Bearer kite-code-token-xxx"
  }
}
```

`allowKiteCodeTelemetry` 是 `false` 时，即使配置了 `kiteCodeEndpoint` 也不发送——保证不做默认遥测。

## 模块结构

```
src/core/telemetry/
├── scrubber.ts         ← 新增：Span 脱敏器（复用 OTel Span 的 toOtlpData，生成副本）
├── provider.ts         ← 修改：创建双 exporter pipeline
├── exporter.ts         ← 不变：通用 OTLPHttpExporter（两条通道共用同一个类）
├── run-tracer.ts       ← 不变
└── index.ts            ← 不变
```

### `scrubber.ts`

```typescript
import { basename } from 'node:path';

/** 对 OTLP Span 做脱敏，保留诊断信息，去掉隐私 */
export function scrubSpan(span: OtlpSpanData, workspace?: string): OtlpSpanData {
  const s = structuredClone(span);

  for (let i = 0; i < s.attributes.length; i++) {
    const a = s.attributes[i]!;
    const v = a.value.stringValue ?? '';

    switch (a.key) {
      case 'kite_code.thread_id':
        s.attributes[i] = { key: a.key, value: { stringValue: hash12(v) } };
        break;
      case 'kite_code.workspace':
        s.attributes[i] = { key: a.key, value: { stringValue: workspace ? basename(workspace) : v } };
        break;
      case 'kite_code.tool.file':
        if (v) {
          const ext = v.split('.').pop() ?? '';
          s.attributes[i] = { key: a.key, value: { stringValue: ext ? `.${ext}` : v } };
        }
        break;
      case 'kite_code.tool.command':
        if (v) {
          const cmd = v.split(/\s+/)[0] ?? v;
          s.attributes[i] = { key: a.key, value: { stringValue: cmd } };
        }
        break;
      case 'kite_code.tool.error_summary':
        // 已在 attribute 层截断
        break;
      case 'kite_code.tool.error_stderr':
        // 已在 attribute 层截断
        break;
      // 其他属性原样保留
    }
  }

  // event 层脱敏
  s.events = s.events
    .filter((e) =>
      e.name !== 'model.reasoning' &&       // 不发送 reasoning
      !e.name.startsWith('tool.error.')     // 不发送 tool.error.old_string 等
    )
    .map((e) => {
      if (e.name === 'tool.error') {
        // tool.error 保留 summary 和 stderr（截断后），去掉 old_string/new_string
        e.attributes = e.attributes.filter(
          (a) => !a.key.startsWith('tool.error.old_') && !a.key.startsWith('tool.error.new_'),
        );
      }
      return e;
    });

  return s;
}

function hash12(input: string): string {
  const h = new Bun.CryptoHasher('sha256');
  h.update(input);
  return h.digest('hex').slice(0, 12);
}
```

### `run-tracer.ts` — root span 增加设备属性

初始化 root span 时附着一次设备/环境信息：

```typescript
import { type, arch, platform, release } from 'node:os';
import { version as bunVersion } from 'bun';

// rootSpan.setAttributes
{
  // ... 现有 thread_id / frontend / workspace / model ...
  'kite_code.os': platform(),            // "win32" | "linux" | "darwin"
  'kite_code.os_version': release(),     // "10.0.26220"
  'kite_code.arch': arch(),             // "x64" | "arm64"
  'kite_code.bun_version': bunVersion,  // "1.3.14"
  'kite_code.kite-code_version': '0.0.1', // ← 从 package.json 读取
  // 终端环境（TUI 特有，渲染兼容性诊断用）
  ...(process.env.TERM_PROGRAM ? { 'kite_code.terminal': process.env.TERM_PROGRAM } : {}),
  ...(process.env.TERM ? { 'kite_code.term_type': process.env.TERM } : {}),
}
```

### `provider.ts` — 双 exporter pipeline

```typescript
export class KiteCodeTracerProvider implements TracerProvider {
  private _userExporter: OTLPHttpExporter;
  private _kiteCodeExporter: OTLPHttpExporter | null = null;
  private _workspace: string;

  constructor(config: TelemetryConfig, workspace?: string) {
    this._workspace = workspace ?? '';

    // 用户自配通道（始终启用，只要配置了 endpoint）
    this._userExporter = new OTLPHttpExporter(
      config.otlpEndpoint!,
      process.env.OTEL_SERVICE_NAME || 'kite-code',
      parseOtlpHeaders(config.otlpHeaders),
    );

    // Kite Code 遥测通道（opt-in）
    if (config.allowKiteCodeTelemetry && config.kite-codeEndpoint) {
      this._kiteCodeExporter = new OTLPHttpExporter(
        config.kite-codeEndpoint,
        process.env.OTEL_SERVICE_NAME || 'kite-code',
        parseOtlpHeaders(config.kite-codeHeaders),
      );
    }

    this._tracer = new KiteCodeTracer((span) => {
      this._pendingSpans.push(span);
      if (!span.parentSpanId) {
        void this._flush();
      }
    });
  }

  private async _flush(): Promise<void> {
    const spans = this._pendingSpans.splice(0);
    await this._userExporter.export(spans);

    if (this._kiteCodeExporter) {
      // 脱敏后再发送
      const scrubbed = spans.map((s) => {
        const scrubbedSpan = new KiteCodeSpan({
          name: s.name,
          kind: s.kind,
          traceId: s.traceId,
          parentSpanId: s.parentSpanId,
        });
        // 复制已脱敏的 attribute
        const data = scrubSpan(s.toOtlpData(), this._workspace);
        // ... 构建脱敏 span
        return s; // TODO: 实际构建脱敏 KiteCodeSpan
      });
      await this._kiteCodeExporter.export(scrubbed);
    }
  }
}
```

> **实际实现时**：为避免重复序列化，在 exporter 层增加 `scrubbed: boolean` 标记。Kite Code exporter 在构造 OTLP JSON 时调用 `scrubSpan` 对每个 span 做脱敏。

## 数据到开发者后怎么用

```
Grafana Dashboard（内部）：

1. 工具失败率 Top N（跨 10 万+ runs）
   kite_code.tool.failure_reason 分组 → shell_command_not_found 占 23%
   → 驱动 SHELL_EXECUTE_CONTRACT 增加 "先检查命令是否存在" 的提示

2. edit_file 失败原因分布
   edit_no_match: 45% → 强化 whitespace 相关提示
   edit_multiple_matches: 15% → 强化 replace_all 参数的文档

3. 模型性能（按 provider/model 分组）
   平均 token 消耗、重试率、缓存命中率
   → 评估不同模型的性价比

4. 版本对比（按 kite_code.kite-code_version 属性分组）
   新版本发布后 tool failure rate 上升还是下降？
```

## 实施步骤

| 步骤 | 内容 | 产出 |
|------|------|------|
| 1 | `scrubber.ts` — 脱敏器 | Span → 脱敏 Span |
| 2 | 扩展 `TelemetryConfig`（config/index.ts） | +`allowKiteCodeTelemetry`、`kiteCodeEndpoint`、`kiteCodeHeaders` |
| 3 | 扩展 `provider.ts` — 双 exporter pipeline | 用户通道 + Kite Code 通道 |
| 4 | `provider.ts` — exporter 层集成脱敏 | 发送给 Kite Code 前调 `scrubSpan` |
| 5 | 测试 `scrubber.test.ts` | 验证脱敏规则正确 |
| 6 | 更新 `tests/telemetry/exporter.test.ts` | 双通道 + 脱敏集成 |
| 7 | `docs/space/plans/` 更新 | 方案归档 |
