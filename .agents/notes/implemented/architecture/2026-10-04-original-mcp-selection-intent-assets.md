# Agent Note: 原 MCP 配置选择意图独立持久与离线采集

Status: implemented

## Problem

MCP 配置文件可以已发布而 Command/Execution/HostMutation 回应未知。只在面板内存保存原选择时，进程退出会丢失准确原请求，重开后重复启停可能覆盖后来的配置；目录或物理 Workspace 已消失也不能成为重新提交历史操作的理由。普通五类 caller、人类答案与 Files 的闭合格式各有现行语义，不能为了 MCP 复用它们的 POST 权利或扩大旧备份白名单。

## Decision

CLI host 独立持有 `ui/mcp-selection-intents.json@1`，记录完整原 subject、Store/Session/Workspace/identity、Command/request、body/request SHA 与 phase。首次 POST 仅属于当前进程成功 durable prepare 的 hot intent；同一短 data lock 内重新核完整 identity、用户/项目冲突与容量，私有 temp/fsync、原 etag CAS、rename/目录同步与重读成功后才返回许可。同 ID 已有记录和所有冷记录只读原结果，128条/整文件16MiB，不淘汰 unknown、不裁正文。

冷记录只恢复未知意图，不恢复 readproof、批准、owner 或 POST 权利。列表与详情均提供全部同 Session 原 ID，目录空/失败仍可用上下/Enter选择；选择不查询，明确原查询才 GET。历史读取首先核原完整 journal identity、subject 与实际 Store，随后核准确原 Command、Execution 与 HostMutation。历史 GET 不要求当前 catalogue 或物理 Workspace 存在；新申请仍核实际当前 Workspace identity 与完整 read-set。

Agent maintenance 使用自有 codec 验相同固定元数据，不依赖 CLI/UI/Client。实际存在新文件时创建 closed manifest v8，带准确 MCP 资产和原 v7 全部字段；缺文件沿原创建规则。v2–v7 的闭合字段、Desktop SQL 与物理白名单不扩大。采集与恢复保完整原字节及 phase；新 Store 不重绑原身份、不自动 GET/POST。稳定维护锁、vault 排除与跨介质非瞬时原子的理由沿[原备份决定](2026-10-02-offline-profile-backup.md)保留。

## Alternatives considered

- 继续仅内存保存：较早面板已有此范围，但冷进程无法核准确原申请，因此增加独立私人资产。
- 扩展普通五类 caller 或借答案/Files 格式：它们各有闭合请求及原效果合同，选择单独 MCP document，不把不同业务恢复许可混合。
- 原历史 GET 前重新核当前 catalogue 和物理 Workspace：曾作为保守条件讨论；它会使 Server 已移除或 Workspace 改名后的只读事实不可达，实际原 Store/subject/request 和 receipt 链已有准确约束。仅 fresh 修改继续核当前物理 scope。
- 把新文件放入 v7 原白名单：会让已发布的闭合格式含义改变，使用 v8 并保留旧格式精确读取与物理树拒绝。
- 直接删除 unknown 为新写腾位：真实预 POST 强杀夹具已验证 unknown 必须保留；fixture 改用另一准确 Workspace 完成合法主链，生产冲突门禁不放宽。

## Consequences

本机 macOS 的真实源码外 cold Host 覆盖 durable prepare 前后、物理 socket 丢失、准确 SIGKILL、原 Server 移除/Workspace 改名后的 GET 与 fresh drift 零 POST。共享 UI 的15项501断言包含真实上下键选择第二原 ID；当前源码 PTY 的1项21断言保原 active Run、审批、history/draft。备份新资产4项99断言及完整维护8文件59项850断言保原字节和新 Store 冷 reader 零 HTTP。

当前源码外冷重开真实80×24 TUI另有1项44断言：首轮键盘生成两原申请，正常Ctrl+Q后同Profile/Store/subject/Session/Workspace空目录上下/Enter选第二ID，选择零GET、明确Check才GET-only；冷轮所有POST/Model/Run/凭据/RPC/取消均零。它独立于cold Host的SIGKILL/物理丢响应资格。

冷 Node reader只调用纯 codec，证明原资产/subject 字段保留及 foreign Store 拒绝，不等于完整 TuiMcpPort receipt lookup。journal 私有读取有 POSIX owner/mode/no-follow 边界；当前cold TUI只资格macOS paired正常退出后的重开；异常9s清理未完整验证，未确认时保留根并失败，不能向历史数字PGID fallback发信号。安装、三平台、认证/OAuth、重连、增删与 Tools 中心仍未闭合。完整 scoped 来源提案继续 [proposed](../../proposed/architecture/2026-10-03-scoped-default-mcp-sources.md)，本决定不宣称完整 V1.3 或 MCP 管理完成。当前行为与证据归 [CLI owner](../../../../apps/cli/README.md#tui-mcp-目录与配置选择)、[维护 owner](../../../../packages/agent/src/maintenance/README.md#mcp-选择意图的独立离线资产)和[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。
