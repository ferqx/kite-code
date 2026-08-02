# 第九章 CLI、模式与配置

## 9.1 CLI

入口为 `src/app/cli/index.ts`：

```bash
bun run agent run --task "检查并修复测试"
bun run agent resume --thread <thread-id>
bun run agent trace <events.jsonl> --turn 1
```

CLI 支持 workspace、thread、Runtime 数据库路径、interaction mode、授权恢复参数、Skill activation、feature override 和 trace 输出。`--execution-status` 在 Runtime/MCP/Skill 创建前输出有效 production boundary；普通开发入口会明确显示 `not admitted`。`--release-status` 输出脱敏的 artifact/profile/capability/Gate 投影；普通开发入口显示 `artifact_disabled`。CLI 不能把 release-controlled `executionBoundaryV1`、`networkBoundaryV1` 或 `releaseProfileV1` 打开，只能用显式 false 收紧。TUI 的对应入口是无参数 `/permissions` 与 `/release`。帮助文本中的历史参数名可能为兼容入口，架构语义以 Runtime mode/policy 为准。

## 9.2 Interaction mode

| 模式 | 目标 |
| --- | --- |
| `accept_edits` | 保持更强的人机确认边界 |
| `auto` | 结合 effect classification 与 auto review 自动推进 |
| `full` | 提高本地自治度，但不绕过未知/外部写入等强制边界 |

Mode 不等于 authorization grant，authorization 也不等于 sandbox。三者由 Runtime Policy 分别处理。

## 9.3 配置来源

用户配置与项目配置使用 JSONC，并由 Zod 校验后合并。主要配置域包括：

```jsonc
{
  "provider": {},
  "theme": "dark",
  "colorPreset": "default",
  "interactionMode": "auto",
  "sandbox": { "enabled": true },
  "autoReview": {},
  "compaction": {},
  "sessionLogging": {},
  "mcpServers": {},
  "features": {}
}
```

Provider 支持 `deepseek`、`openai`、`openai-compatible` 和 `ollama`，统一通过 AI SDK 模型边界调用。API key 和配置字符串支持环境变量展开。

模型可使用字符串简写，也可声明正式能力字段：

```jsonc
{
  "provider": {
    "local": {
      "type": "openai-compatible",
      "model": "coder",
      "models": [{
        "name": "coder",
        "contextWindow": 131072,
        "maxOutputTokens": 8192,
        "tokenizerFamily": "cl100k_base",
        "supportsUsageMetadata": true,
        "supportsPromptCache": false
      }]
    }
  }
}
```

模型 capability 的每个字段只按显式模型条目、adapter runtime metadata 和兼容 `modelKwargs` 依次解析。模型名称和默认模型列表不提供能力；未知窗口仍允许 Runtime 调用模型，但上下文 utilization 显示为 unknown，并对 Capability disclosure 使用保守预算。

自动会话总结需要默认关闭的 `features.contextCompactionAutoV1` 与 `compaction.autoMode` 共同开启。`autoMode` 只允许 `off | shadow | live`；未配置时为 `off`。`shadow` 只计算 trigger eligibility 术语（触发资格），不调用摘要模型、不写 checkpoint 术语（检查点）；`live` 默认在完整请求达到可用输入预算的 90% 时产生 `reason=auto`，也可由 `triggerRatio` 覆盖或使用显式 `compactAfterEstimatedTokens` 绝对策略。自动压缩失败或取消时当前用户请求不会继续调用普通模型；下一用户 turn 会重新预检并在仍超阈值时重试。Provider 拒绝 summary 时提示检查 `contextWindowTokens` 或执行 `/clear`，不自动清理、分块或重试。`compaction` 可配置 `warningRatio`、`compactRatio`、`hardRatio`、`minimumReductionRatio`、`cooldownTurns`、`maxSummaryTokens`、`maxSummaryInputTokens`、`maxNarrativeTokens` 和 `providerSafetyRatio`；`recentTurns`、`minimumIncrementalHeadroomTokens`、`softRatio`、`targetRatio` 与未消费的 breaker 配置已删除。模型 capability 只来自所选模型的显式字段、adapter runtime metadata 或 `modelKwargs` 兼容字段，并按字段记录 source；模型名称和默认列表不提供窗口、tokenizer、usage 或 cache 能力。未知窗口不显示百分比、不触发 ratio auto。当前 summary request 复用主模型（`tools: {}`，temperature 0，SDK retry 0），自定义指令作为数据字段传入。

Rollout 可额外配置 `cohortSalt` 与 `livePercentage`：相同 salt/session 始终进入相同 bucket，live 百分比外按 shadow 执行，master flag 关闭恒为 off。显式 `localDebug: { enabled: true, directory }` 只写脱敏压缩元数据；未启用时不创建文件。

TUI 启动时执行 workspace 信任门禁：首次打开未信任目录会显示授权确认（类似 VS Code 打开新项目），显式信任记录写入用户级 `~/.kite-code/workspace-trust.jsonc`，以 canonical realpath 的 sha256 作为 `workspaceKey`，之后同目录启动自动放行；目录移动或改名后信任失效。CLI `run` 执行同一门禁：未信任目录拒绝运行并向 stderr 报错，`--trust-workspace` 显式记录信任（`source: 'config'`）后继续，CI/自动化应使用该旗标或预写信任存储。门禁刻意不提供环境变量旁路：Bun 会自动注入 `<cwd>/.env*`，env 开关可被目录内文件伪造；web 前端当前不执行该门禁。当前行为以 `docs/active/workspace-trust.md` 为准。

### Session logging

`sessionLogging.mode` 只允许 `off | metadata | content`。`sessionLoggingPolicyV1` 关闭时 resolved
mode 恒为 `off`；开启时默认使用 release artifact 的 metadata policy。用户和项目配置只能收紧
retention/容量与 mode，项目配置不得开启 `content`。

`content` 需要 release artifact 允许并由用户/管理员在用户配置显式 opt-in，两者缺一不可；
即使开启仍不记录 reasoning、工具/文件正文、审批命令、Plan/Sub-agent 正文、secret 或
credential。TUI 每个 session 首次运行显示 resolved mode，CLI 把 mode 写到 stderr；content
另有显式披露。Logger 不可用时两端只显示一次固定脱敏诊断，Agent 继续运行且不使用 fallback。

日志存储使用 owner-only 权限：POSIX 目录 `0700`、文件 `0600`，Windows 使用禁继承的
owner-only ACL，并拒绝 symlink/reparse point。活动 session 通过绑定 PID/start identity、
owner、目录 identity 与 heartbeat 的 durable lease 防止并发回收；无法确认 lease、扫描超
预算或发现被隔离的不安全旧目录时，logger fail closed 而 Agent 继续运行。retention/总容量
按 bounded oldest-first maintenance 执行，单 session 达到 byte cap 后只保留一条无正文限额
记录与 bounded terminal marker。

## 9.4 MCP 配置

MCP server 可配置 stdio/HTTP transport、`enabled`、`required`、`cwd`、timeout、trust 和逐工具 policy override。`enabledTools` 是 allowlist，`disabledTools` 随后应用，最后由 `tools.<name>.enabled` 精确覆盖。逐工具配置还使用 `effects`、`minimumApproval`、`retry` 和 `idempotencyKeyArgument`，不使用旧的单一 `risk` 字段作为权威策略。开启默认关闭的 `mcpProviderActionV1` 后，非 ready/degraded 的 required Provider 会在首次模型调用前要求 Retry、当前 session waiver 或 Cancel Run；waiver 不会恢复该 Provider 的 capability 可见性。

stdio 与远程 HTTP 的内容边界不同。HTTP Tool 的任何非空最终参数最低按
`confidential` 加 `user_prompt/file_snippet/tool_result` 全量未知来源集合处理，项目配置不能声明
更低分类；read-only、Tool Approval、模型
Provider consent 和 host allowlist 都不授权正文上传。`remoteMcpEgressPolicyV1=false` 时这类
调用保持 no-egress；开启后每个 invocation 仍需由 App 注入精确、短期、单次 nonce permit。
credential 字段/形状、受保护 credential path 或无法在固定检查预算内确认安全的参数不会进入
permit resolver，也不能被 permit 覆盖。

默认 MCP 规范来源只有 project `<workspace>/.kite-code/mcp.json` 与 user `~/.kite-code/mcp.json`，优先级为 `project > user`。旧 hash workspace 文件、`.mcp.json` 和 `kite-code.jsonc#mcpServers` 只读并通过显式迁移进入规范位置。所有 project 来源必须匹配 `~/.kite-code/mcp-project-approvals.jsonc` 中绑定 workspace/source/name/config digest 的本地决定；未批准、已拒绝、配置变化或存储损坏时不创建 transport，且不回退同名低优先级 Server。项目批准只保留 allowlist、denylist、精确 disable、`minimumApproval: user` 和 `retry: never` 等收紧项，不采纳 annotation trust、精确 enable 或逐工具放宽策略。显式 `configPath` 是调用方授权的单文件来源，不与 workspace 来源合并。

`McpSupervisor` 投影全部来源和 shadow 状态，`McpConfigRepository` 使用 expected revision、JSONC edit 与原子 rename 提供 add/update/remove/set_enabled/migrate；文件 watcher 只触发 debounce 后全量 reload，外部冲突不覆盖。TUI `/mcp` 可通过 typed mutation 向 project/user 两个规范位置添加最小 Server、启停和移除，但不编辑高级字段或执行 legacy migrate。项目配置只可在脱敏 Review 页面按当前摘要决定，不能隐式自批。

## 9.5 Feature flags

Engine/Lifecycle 迁移由注册表中的 feature flags 控制。Flag 关闭时按各 active 规则 fail closed 或回到当前受治理路径，不允许恢复已删除的旧 MCP adapter、Prompt Skill 或旧状态机。

`toolSearchV1`（原 `capabilitySearchV1`）控制 MCP 工具渐进披露：≤20 工具时直接 binding，>20 工具时通过 `tool_search` 搜索发现。

ToolSpec Registry 的六个计算原语已按 ADR-0027 完成单路径切换；旧迁移 flag 未接入运行时并已删除，不再接受 `toolSpecRegistryV1` 配置。

生产治理的 `sessionLoggingPolicyV1`、`providerDataPolicyV1`、`remoteMcpEgressPolicyV1`、`resourceBudgetV1`、
`boundedCancellationV1`、`terminalOutcomeV1`、`executionBoundaryV1`、
`networkBoundaryV1` 和 `releaseProfileV1` 均默认关闭。Logger flag 开启时 Runtime 只写
显式 allowlist metadata，关闭时不创建日志目录。Provider flag 启用后从固定 release asset
加载并校验 revision/digest，所有普通模型、压缩、Sub-agent 和 reviewer dispatch 共用最终
gate；当前
route 集合为空，因此 limited profile 全部 fail closed。Resource flag 只为新 run 建立 Runtime
v19 limited preset ledger，并拒绝 legacy snapshot 热补余额。Bounded cancellation flag 提供
deadline、统一 AbortSignal 与进程树清理；Resource 开启但该 flag 关闭时不披露 writer/Shell/
child capability。Terminal flag 只控制 CLI 派生 presentation，原始结构化 outcome 始终保留，
不能把 unknown/blocked/budget/saturation 回退成普通完成。单独启用任一 flag 都不授予
production 资格。

`releaseProfileV1` 还要求独立的 artifact authority；user/project/CLI 的 true 不能创建该 authority。
当前 embedded profile 是 non-distributable foundation fixture，D-04 production 支持集为空，因此
所有 production profile 都拒绝。Release status 不显示完整 profile、credential、Workspace path、
route 名称或 cohort identity。

`networkBoundaryV1` 关闭时 production network 收紧为 off，不能恢复旧 `allow_all`。开启时只
使密封 boundary 内的 `web_fetch` 获得逐 invocation DNS/redirect/endpoint admission；Shell/Skill
descendant 仍为 network-off。Remote HTTP MCP 还要求 App 签发绑定 boundary/run/profile/endpoint/
invocation 的单次 transport receipt；当前 production TUI 没有该 controller，local stdio 也明确
排除，因此 Provider readiness 继续拒绝。该 flag 不定义 allowlist、不提供 URL path isolation，
也不改变当前空 production platform 支持集。

上下文压缩使用三个独立 flag 术语（功能开关）：`contextCompactionV2` 保护 checkpoint/summary 基础契约且默认开启；`contextCompactionAutoV1` 控制自动压缩灰度且默认关闭，不会把 Provider 术语（模型供应商）错误转换为自动压缩；`contextCompactionManualV1` 控制 `/compact` 命令且默认开启。压缩原因只允许 `manual | auto`。`/compact` 接受可选的自定义摘要指令（作为数据字段 `customPreferences` 传入而非 system prompt 术语（系统提示词））；`/context` 显示分项 token 占用和压缩状态。`/compact reset` 清除 active checkpoint 术语（活动检查点），不以本地容量比例阻止重置，也不清除 Runtime correctness hard block 术语（运行时正确性硬阻断）。
