# Kite Code

Kite Code 是一个基于 Bun、TypeScript 和事件化 Runtime Kernel 的多模型代码 Agent。模型、工具、审批、恢复与验收统一由 Kernel 调度；TUI 和 CLI 共享相同的 Core 行为。TUI 支持文件 diff 染色和代码语法高亮（`ink-syntax-highlight` / highlight.js）。

正式发行目标为 Windows、Linux 与 macOS。跨平台可安装/运行与 Shell、writer 等 effectful
capability 的原生隔离资格分开验证；某平台缺少强隔离时对应能力保持关闭，不把整个 TUI 伪装成
不支持或把未验证能力伪装成可用。

## 当前能力

- React Ink 主屏缓冲区 TUI（保留终端 scrollback）与 Headless CLI；
- AI SDK 模型边界，支持 DeepSeek、OpenAI、OpenAI-compatible 与 Ollama 配置；
- Runtime Event/State/Effect、SQLite Event Store、Snapshot、Restore/Fork；
- Builtin、MCP、Skill Workflow 与 Subagent 统一 Capability Catalog；
- interaction mode、authorization、approval、auto review 与 sandbox；
- Execution Receipt、Artifact、分级 Verification 与 repair/replan；
- Plan Artifact、上下文压缩、多会话和 PTY 系统测试。

总体架构见 [六概念 Runtime 架构](docs/active/six-concept-runtime-architecture.md)，当前行为规则见 [docs/active](docs/active)。

## 安装

从源码运行：

```bash
bun install
```

构建并验证当前平台的 unsigned 开源候选包：

```bash
bun run release:build
bun run release:verify
bun run release:smoke
```

`release:smoke` 会在临时目录完成真实候选包的安装、CLI/TUI 启动、第二候选安装、回滚和卸载。手动安装
到显式 managed prefix 的示例：

```bash
bun run release:install -- install \
  --archive dist/oss-candidate/kite-code-macos-arm64.tar.gz \
  --prefix "$HOME/.local/share/kite-code"

bun run release:install -- rollback --prefix "$HOME/.local/share/kite-code"
bun run release:install -- uninstall --prefix "$HOME/.local/share/kite-code"
```

Windows、Linux、macOS 的 archive 名称分别使用 `windows-x64`、`linux-x64` 与 `macos-arm64`（实际
architecture 以 manifest 为准）。安装器拒绝 filesystem root、用户 home、仓库 root、symlink/reparse
point 和没有 Kite Code marker 的非空目录。候选包只有 SHA-256 完整性校验，没有平台签名或
notarization；完整限制见
[`KNOWN_LIMITATIONS.md`](release/oss-first-release/KNOWN_LIMITATIONS.md)。

用户配置位于 `~/.kite-code/kite-code.jsonc`，项目可用 `<workspace>/.kite-code/kite-code.jsonc` 覆盖。最小示例：

```jsonc
{
  "provider": {
    "default": {
      "type": "openai-compatible",
      "apiKey": "${OPENAI_API_KEY}",
      "baseURL": "https://example.com/v1",
      "model": "model-name",
      "models": [{
        "name": "model-name",
        "contextWindow": 131072,
        "maxOutputTokens": 8192
      }]
    }
  },
  "interactionMode": "auto",
  "sandbox": { "enabled": true }
}
```

模型调用统一通过 AI SDK/OpenAI-compatible 边界。Provider 专有 reasoning 和缓存行为隔离在 `src/core/model/`，不会进入 Runtime 策略。模型建议显式配置 `contextWindow` 和 `maxOutputTokens`；未配置且 adapter 无可信元数据时，Runtime 会将窗口视为 unknown，而不会根据模型名称假定一个大窗口。

自动 M2 上下文压缩默认关闭，需要同时开启 `features.contextCompactionAutoV1` 并把 `compaction.autoMode` 配置为 `live`；`shadow` 只观察触发资格，不调用摘要模型。自动阈值可使用已知可信窗口下的 `triggerRatio`，或显式的 `compactAfterEstimatedTokens` 绝对策略；压缩原因只有 `manual | auto`。本地 token ratio 术语（文本计量比例）、Provider 术语（模型供应商）错误或压缩失败都不会阻断会话；自动压缩保留原始 transcript 术语（消息记录）。

启用 `features.contextCompactionManualV1`（默认开启）后可使用 `/compact` 命令，支持可选的自定义摘要指令（例如 `/compact focus on auth changes`）。运行中请求会排队到安全边界；消息不足时提示 `Not enough messages to compact.`，active checkpoint 后没有新增消息时，无参数连续压缩提示 `No new messages to compact.` 且不会再次调用摘要模型。进入历史会话时，TUI 会基于恢复的 checkpoint 和当前投影环境在本地重算 Footer context token，不产生模型请求。

会话日志治理默认开启并只记录 allowlist metadata；显式设置 `features.sessionLoggingPolicyV1=false` 时 mode 为 `off` 且不创建日志目录。`content` 需要 release artifact 允许和用户配置显式 opt-in，项目配置不能开启；即使 opt-in 也不记录 reasoning、工具/文件正文、审批命令、Plan/Sub-agent 正文或 credential。日志目录/文件使用 owner-only 权限或 ACL、拒绝 link/reparse point，并通过 durable active-session lease、bounded retention/容量与 fail-closed quarantine 保护；TUI 不显示普通 mode 状态，CLI 仍显示 resolved mode，logger 不可用时 Agent 继续运行且不使用不安全 fallback。

生产模型数据门禁与远程 HTTP MCP 正文外发是两个独立授权域。`providerDataPolicyV1` 开启后，
模型、压缩、Sub-agent 和 reviewer 都必须匹配仓库固定的 route/data policy；当前只批准
DeepSeek 官方 API 的精确 `deepseek-v4-flash` Route。`remoteMcpEgressPolicyV1` 开启后，非空 MCP 参数仍需
逐 invocation、短时、route/tool/参数 digest/nonce 精确绑定的独立许可；关闭时保持 no-egress，
Tool Approval、read-only annotation、模型 Provider consent 或 network allowlist 都不能替代该许可。

该 Route 固定为 `type=deepseek`、`model=deepseek-v4-flash` 与
`https://api.deepseek.com[/v1]`，并按 ADR-0066 显式接受官方政策披露的中国处理/存储、可能训练、
未承诺固定 API 正文保留期以及无 DPA；这些事实不再是准入阻塞项。产品仍必须向用户透明披露，
secret/protected credential 在网络调用前一律拒绝，换模型、换 endpoint、URL 携带凭据/查询参数或
policy 过期都 fail closed。该批准不允许 remote MCP 正文外发，也不允许 secondary reviewer 使用
production content；真实评估仍需要凭据、authenticated live run 和 retained evidence。

MCP 默认配置只有两个规范位置：项目级 `<project>/.kite-code/mcp.json` 与用户级 `~/.kite-code/mcp.json`，同名 Server 按 `project > user` 选择。`/mcp` 的 Current project 与 All projects 分别写入这两个文件；项目声明必须在 Server Detail 的 Review 页面显式批准。旧 hash workspace 文件、`.mcp.json` 和 `kite-code.jsonc#mcpServers` 仅只读兼容与显式迁移，不再作为写入目标。

Tool 可见性可在 JSONC 中用 `enabledTools` allowlist、`disabledTools` denylist 和 `tools.<name>.enabled` 精确 override 控制；逐 Tool policy 还支持 `effects`、`minimumApproval`、`retry` 与 `idempotencyKeyArgument`。项目配置只能用这些字段收紧可见性或策略，不能信任远端 annotation、降低风险或扩大重试。任何 filter/policy 变化都会使旧 turn binding 失效。

`/mcp` 不接受参数，打开使用 `↑/↓/Enter/Esc` 的 MCP 管理 Overlay。Server List 只负责选择；Enter 进入只读详情，再通过可见菜单执行 Connect/Retry、Authenticate、Enable/Disable、Remove 或项目审批。配置文件变化仍由 watcher 自动重载；watcher 不可用时可重启 TUI 进行完整加载。动态 MCP Prompt 命令保持独立行为。

HTTP Server 返回 OAuth 认证要求时，Server Detail 提供 Authenticate；只有在认证页选择 Open browser 后才创建 callback 并打开系统浏览器，Esc 可返回或取消进行中的 callback。OAuth token、dynamic client、PKCE verifier 和 discovery state 只保存在系统原生凭据保险库，成功后重新 discovery，不重放旧 Tool Call。已有 token 会在启动时静默恢复；恢复失败只进入 `reauth-required`，不会循环打开浏览器。

开启默认关闭的 `features.mcpProviderActionV1` 后，MCP Tool 因登录、项目批准或 Provider 暂时不可用而失败时，Runtime 会通过 App shell 提供固定的 Login、Approve 或 Retry 恢复动作。恢复成功从新 turn 继续，延后或失败不会重放旧调用。配置为 `required: true` 的不可用 Provider 还会在首次模型调用前要求 Retry、当前 session waiver 或 Cancel Run；waiver 不会让不可用能力重新进入 catalog。

静态 HTTP 认证继续支持环境变量引用，也支持由嵌入调用方预先写入系统保险库的 credential profile。普通配置只保存引用，例如：

```jsonc
{
  "mcpServers": {
    "remote": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "auth": {
        "type": "environment",
        "header": "Authorization",
        "env": "MCP_TOKEN",
        "scheme": "Bearer"
      }
    }
  }
}
```

`auth` 只适用于 HTTP transport。`auth.type: "credential"` 只接受 `credentialRef`；`auth.type: "oauth"` 可保存 scopes、client id、`clientSecretRef` 和 credential profile。inline client secret 会被拒绝。TUI 不录入 secret，也不修改 auth 配置；原生保险库 locked/unavailable 时认证 fail closed，绝不退回明文文件。

## 运行

交互式 TUI：

```bash
bun run tui
```

CLI：

```bash
bun run agent run --thread demo --workspace . --task "检查并修复测试"
bun run agent resume --thread demo --approve
bun run agent trace events.jsonl --turn 1
bun run agent run --release-status
bun run agent run --telemetry-status
```

常用参数以 `bun run agent --help` 输出和 `src/app/cli/index.ts` 为准。`--checkpoints` 是保留的 CLI 参数名，当前数据由 Runtime Store 管理。

ADR-0068/ADR-0069 采用单维护者开源首发终态模型。发布只保留两个 Gate：G0 验证本地正确性、安全边界、P0/P1
和安装/回滚；G1 验证 GitHub-hosted `macos-15`、`ubuntu-24.04`、`windows-2025` 的构建/安装/启动、
TUI/CLI smoke、DeepSeek `deepseek-v4-flash` 与阿里千问 OpenAI-compatible route 的真实最小调用，以及
准确的 release notes/known limitations。

候选 workflow 只有 `contents: read`，会上传 unsigned CI artifact，但不会创建 GitHub Release、发布
npm 包、申请 OIDC/attestation 或执行其他公开发布。Sigstore、SLSA/provenance、macOS Developer ID/
notarization、Windows Authenticode、企业 SBOM attestation、第三方评审、external cohort、长期
服务等级/error-budget 和 canary/maturity promotion 已明确移出路线图，也不会被表述为已经取得。
唯一维护者检查清单位于
[`MAINTAINER_CHECKLIST.md`](release/oss-first-release/MAINTAINER_CHECKLIST.md)。

D-04 effectful execution 支持集仍为空，但它只关闭缺少本机强隔离资格的 Shell、writer、MCP write 或
effectful Skill，不阻止普通三平台 TUI/CLI 候选包。`releaseProfileV1`、`executionBoundaryV1` 和
`networkBoundaryV1` 仍不能由 CLI 放宽；capability profile 不能扩大 embedded ceiling。

原 108 个生产 Task 已收敛为 83 `completed`、25 `superseded`、0 optional，权威状态见
[`task-status-v2.json`](release/oss-first-release/task-status-v2.json)。Web、多租户 SaaS、托管 runner、
服务端 credential custody、无人值守共享 writer 和 enterprise promotion/authority service 明确不在首版
支持范围。

Remote observability 不属于当前产品路线。`--telemetry-status` 与 TUI `/telemetry` 只显示脱敏的本地
状态；普通入口为 `artifact_disabled`。project 配置不能开启网络发送，Reporter 无磁盘 spool。所有
结构化状态都禁止 prompt/response/file/path/command/error 正文与 secret；本地 incident rehearsal
只证明合成 contract，不冒充真实事故或外部运营证据。

## 安全边界

- Capability discovery 不等于授权；动态能力必须具有当前轮 binding。
- `accept_edits`、`auto`、`full` 不会绕过 schema、revision、强制审批或 sandbox。
- 远端 MCP annotation 和 Skill manifest 不能自行授予权限。
- 未获本机用户按配置摘要批准的项目 MCP 不会创建 stdio/HTTP transport。
- MCP token、client secret 与 PKCE material 不进入普通配置、Runtime Event、session log 或 control snapshot。
- 外部写入先记录 invocation intent；未知结果禁止盲重放。
- Tool success 不等于任务完成；required Verification 未通过时不能完成。

## 源码结构

```text
src/protocol/       跨层事件、动作、Capability 与 Verification 契约
src/core/runtime/   Kernel、State、Event、Effect、Scheduler、Store
src/core/model/     AI SDK provider 与上下文边界
src/core/tools/     Builtin Capability provider
src/core/mcp/       MCP supervisor、control snapshot 与 Runtime provider
src/core/skills/    Skill Workflow provider
src/core/subagent/  Subagent provider
src/core/policies/  Mode、审批和副作用策略
src/core/verification/ 验收与恢复
src/app/tui/        React Ink TUI
src/app/cli/        CLI
```

## 验证

```bash
bun test
bun run test:mock
bun run test:e2e
bun run test:runtime:fault
bun run test:runtime:soak
bun run test:sandbox:smoke:native
bun run test:tui:harness
bun run test:tui:system
bun run test:tui:smoke:native
bun run test:all
bun run test:mcp:live
bun run test:model:live
bun run test:provider:smoke -- --provider deepseek
bun run test:provider:smoke -- --provider qwen
bun test tests/release
bun test tests/evals/agent-tasks
bun test tests/observability
bun test tests/release/ga-selection.test.ts tests/release/ga-compatibility.test.ts
bun run release:build
bun run release:verify
bun run release:gate:foundation
bun run release:smoke:execution
bun run typecheck
bun run check:core-boundary
bun run check:compaction-legacy
bun run check:docs
bun run check:docs-impact
```

`test:provider:smoke` 是显式真实网络调用：DeepSeek 固定使用 `deepseek-v4-flash`并关闭 thinking；千问使用
OpenAI-compatible adapter，默认读取 `DASHSCOPE_API_KEY`，调用阿里云 Token Plan 北京
`token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` endpoint 的 `qwen3.6-flash`；环境变量和
本机配置都必须使用该 endpoint，`KITE_QWEN_MODEL` 只允许切换 Qwen 模型。runner 只输出 provider/model/usage/耗时和布尔结果，不输出
prompt、response、credential 或完整 endpoint；缺 key 或调用失败时非零退出，mock 不得替代 G1。

默认测试不访问真实模型或公网 MCP，也不运行依赖宿主机 Seatbelt/bubblewrap 的正向用例。`test:mock` 运行确定性的 context compaction Runtime contract；`test:e2e` 只运行 `tests/e2e/local/`。`test:runtime:fault` 运行确定性的 SIGKILL/SQLite/report contract，`test:runtime:soak` 运行固定 7-case CI profile；资源指标不完整时仍保持 `inconclusive`，不能包装成成功。`test:sandbox:smoke:native` 显式运行当前宿主机的原生 sandbox executor smoke。快速 TUI harness 单元测试进入默认 `unit` 门禁，也可用 `test:tui:harness` 单独运行；真实 TUI PTY scenarios 只由 `test:tui:system` 按文件独立串行执行，并带单文件硬超时，不重复运行 harness。first-run provider 探测使用本地 mock `/v1/models`。`test:tui:smoke:native` 是依赖宿主机真实 sandbox backend 的显式 opt-in PTY smoke，不属于默认门禁；`test:all` 依次运行默认测试和完整 PTY suite。裸 `bun test` 会误收集高成本 PTY 与原生平台文件，不是仓库规范的全量入口。旧 production-shaped authority contract 只作为 fail-closed 负向测试保留；registry 为空时不得生成外部认证或 promotion 结论，且不再绑定任何路线图 Task。`test:mcp:live` 是显式 opt-in 的 LangChain Docs 公网 MCP smoke；`test:model:live` 是显式 opt-in 的真实模型 context compaction direct/incremental summary 套件。未实际运行对应 live runner 时，不得把 mock 或本地 E2E 表述为真实 Provider 验证。
