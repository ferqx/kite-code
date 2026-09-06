# 待核实与后续改进

本页只记录当前有证据的后续工作。它不是产品承诺，也不要求在本次文档重构中修改运行行为。

| 问题 | 影响 | 证据与下一步 |
| --- | --- | --- |
| CLI help 仍列出旧命令/选项并写 LangGraph thread | 用户可能照帮助调用已拒绝入口 | cli/index.ts 的 printHelp 与 rejectUnsupportedOptions 不一致；单独修正帮助与相应测试 |
| TUI 帮助列出 Ctrl+E 和 ?，处理入口不完整 | 帮助与操作不一致 | HelpPanel、useGlobalKeys、CtrlSafeTextInput；确认产品意图后实现或删除提示 |

原 backlog 中已修复项不复制。仍未确认的具体需求保留在相关计划，实施前先 rebase 到当前架构，不根据旧日期直接宣布完成。

## 从旧计划提取的待核实问题

这些条目不是已批准可直接实施的方案，也不表示所有旧验收已完成。确认实际缺口后再写新方案。

| 问题 | 当前判断与下一步 | 历史背景 |
| --- | --- | --- |
| 产品缺口复核 | 任务混合旧入口、已实现信任与显示功能；保留尚需核实的搜索和初次体验需求，重新按手册验收。 | [历史方案](https://github.com/ferqx/kite-code/blob/8aa02d4ca07350f37d3805c17ac9f10bf828e6a9/docs/space/plans/2026-06-14-p0-gap-closure.md) |
| 后台子任务需求 | 当前已有 child driver、挂起与续跑，旧 SessionContext/BackgroundTaskManager 设计不再可直接落地；先确认还缺少哪种用户行为。 | [历史方案](https://github.com/ferqx/kite-code/blob/8aa02d4ca07350f37d3805c17ac9f10bf828e6a9/docs/space/plans/2026-06-17-background-subagent.md) |
| 搜索与抓取边界 | 当前存在 builtin:web_fetch；搜索服务能力与抓取不同，核对真实需求后另行设计，不重复创建抓取工具。 | [历史方案](https://github.com/ferqx/kite-code/blob/8aa02d4ca07350f37d3805c17ac9f10bf828e6a9/docs/space/plans/2026-07-01-web-search-tool.md) |
| 压缩剩余验证 | 已有 context projection/compaction；自动策略和质量验收未据旧计划宣布完成，按当前开关和模型测试重新核对。 | [历史方案](https://github.com/ferqx/kite-code/blob/8aa02d4ca07350f37d3805c17ac9f10bf828e6a9/docs/space/plans/2026-07-19-context-compaction-v2.md) |
| MCP 盘点验收 | 已有 list_mcp_tools；核对中文查询、分页和状态说明，不恢复已删除 src/core 路径。 | [历史方案](https://github.com/ferqx/kite-code/blob/8aa02d4ca07350f37d3805c17ac9f10bf828e6a9/docs/space/plans/2026-07-19-mcp-tool-inventory-implementation.md) |
| 压缩展示验收 | 当前已有 inline progress 与会话隔离；旧逐步实施脚本退出入口，剩余 PTY 场景按当前指南复核。 | [历史方案](https://github.com/ferqx/kite-code/blob/8aa02d4ca07350f37d3805c17ac9f10bf828e6a9/docs/space/plans/2026-08-13-inline-compaction-progress.md) |
| 本地化剩余覆盖 | 语言选择与 catalog 已存在；未完成表面的覆盖需按实际页面检查，不复制旧矩阵作为当前事实。 | [历史方案](https://github.com/ferqx/kite-code/blob/8aa02d4ca07350f37d3805c17ac9f10bf828e6a9/docs/space/plans/2026-08-15-tui-i18n-zh-en.md) |
| Native 跨平台发布验证 | 旧单 Service 方案已被 App Server/Session 边界替代；保留平台原生进程、权限、发布证据需求，不能用本机测试宣称远端通过。 | [历史方案](https://github.com/ferqx/kite-code/blob/8aa02d4ca07350f37d3805c17ac9f10bf828e6a9/docs/space/plans/2026-08-27-kite-local-runtime-service-v1.md) |
| 多客户端并发验证 | per-Workspace Worker/Store/Gateway 拓扑已被替代；只保留当前多客户端、隔离和平台验证问题。 | [历史方案](https://github.com/ferqx/kite-code/blob/8aa02d4ca07350f37d3805c17ac9f10bf828e6a9/docs/space/plans/2026-08-28-kite-coordinator-workspace-worker-web-v1.md) |
| Public API 后续能力 | 已实现 Browser 只读 API；mutation/SSE 等未交付能力不是当前承诺，重新确认目标后按当前 contract 设计。 | [历史方案](https://github.com/ferqx/kite-code/blob/8aa02d4ca07350f37d3805c17ac9f10bf828e6a9/docs/space/plans/2026-08-29-kite-agent-server-api-v1.md) |
| Run 持久化与发布证据 | 当前 Run Store 与 Session fencing 已改变旧落点；现存证据保留在 release/agent-api/evidence，后续资格按当前 head 核实。 | [历史方案](https://github.com/ferqx/kite-code/blob/8aa02d4ca07350f37d3805c17ac9f10bf828e6a9/docs/space/plans/2026-08-29-kite-runtime-run-store-v1.md) |
| Plan 子 Agent 角色 | 旧 openpx-new 方案不符合当前模块组织；需要先明确相对已有角色/规划的产品差异，不直接恢复旧实现。 | [历史方案](https://github.com/ferqx/kite-code/blob/8aa02d4ca07350f37d3805c17ac9f10bf828e6a9/docs/space/plans/plan-subagent-role-design.md) |

## 根路线图与旧 RFC 的剩余方向

旧路线图和 RFC 全文退出当前入口，实际现状由手册、技术专题和已保留的发布证据说明。以下方向尚需确认，不视为已批准功能：

- 自定义 Subagent、Hooks 与更多 Artifact 展示：先定义相对现有角色/扩展的用户收益，再确定范围。
- 可观测性、跨平台与真实 Provider 验证：核对已有机制和证据缺口，不能把旧“已完成基础”列表当作当前发布资格。
- 工具流水线和 MCP 盘点：已有生产机制，剩余需求沿上方条目核实，不恢复旧 src/core 方案。

历史根路线图：[ROADMAP](https://github.com/ferqx/kite-code/blob/854b3084479d78e79b37864bda99e0bb235db2d8/ROADMAP.md)。旧 API、模块化及发布 RFC 通过 Git 和所属证据定向追溯，不再维护一套“当前提案”索引。

## Web 更新验证

[页面更新的直接测试缺口](../../apps/kite-web/docs/testing.md)：补充可见性、轮询调度与增量合并场景；当前源码行为不等于测试已覆盖。本次文档验收只纠正覆盖说明，未修改实现或补充运行测试。

Web 已显示 idle 会话后，其他客户端开始执行：当前 [App 轮询](../../apps/kite-web/src/app/app.tsx) 由本页已读取的 running/waiting 状态启动，不主动探测 idle→running。手册的活动条件尚未明确是否承诺发现这种外部变化，需单独确认预期；不能以当前实现自动缩减承诺，也不能把这一差异视为本轮文档规则修改引入的缺陷。

## 高级配置参考完整性

手册[设置参考](../handbook/clients/tui/reference/settings.md)已覆盖顶层配置与常用模型字段，但 autoReview、compaction、sessionLogging、telemetry、sandbox 的嵌套参数尚未形成完整的取值、默认值、合并和生效时机参考。例如 compaction.cohortSalt/livePercentage/cooldownTurns/providerSafetyRatio 及 autoReview 的循环限制目前只有概述。后续应沿配置 schema 与实际消费者逐项核对，不能仅凭 schema 接受就承诺生效。当前不能据顶层覆盖宣称所有可配置项均有完整用户说明。

## 文档与实现一致性审查的后续修复

以下是已发现的实现/覆盖差异，不是本轮已经修复的功能；完整事实与代码入口保留在对应 owner 专题。

- TUI 排队提交的迟到失败须按原 Session 投影，见[输入失败归属](../../apps/kite-cli/docs/input-and-commands.md#当前差异排队失败的会话归属)。
- TUI 自有文案统一 catalog，以及语言写盘失败时的内存状态/提示，见[本地化差异](../../apps/kite-cli/docs/tui-localization.md#当前覆盖与失败行为差异)。
- 审批 Esc 与 Enter 的在途提交反馈应一致，见[交互差异](../../apps/kite-cli/docs/approvals-and-interactions.md#当前差异esc-提交态)。
- Web 保留取消与未知终态，见[状态投影差异](../../apps/kite-web/docs/session-presentation.md#当前差异取消与未知状态丢失)。
- Web 日志失败仍可读、API Docs 参数/schema详情，见[诊断专题](../../apps/kite-web/docs/diagnostics.md)。
- Web 深链接已取得的新 Session 快照不应被旧目录覆盖，见[快照优先级](../../apps/kite-web/docs/routing-and-lifecycle.md#当前差异深链接快照优先级)。
- CLI recovery_required 退出条件与 --ask 旧帮助文案，见[终态退出](../../apps/kite-cli/docs/service-mode.md#当前-cli-终态退出差异)和[命令参考](../handbook/cli/commands.md)。
- Web 开发启动脚本应在失败后停止后续调用，见[失败链](../development/local-development.md#web-启动失败链的已知差异)。

不兼容 daemon 的 stop 是当前明确限制，使用匹配客户端的恢复方法已归位[服务排障](../handbook/server/troubleshooting.md)；不默认新增绕过协议的 shutdown 接口。
