# MCP Agent Provider Recovery Phase 5

状态：archived
优先级：P2
创建日期：2026-07-17
依赖：Phase 1、Phase 3、Phase 4、ADR-0010、ADR-0012、ADR-0014
替代范围：仅替代 superseded `2026-07-15-mcp-tui-management-center-implementation.md` 的 Phase 5 实施依据

## 目标与边界

让 Agent 区分 MCP capability 不存在、Provider 等待批准、需要登录、暂时失败和 capability 漂移；用户完成恢复后只在新 model turn 获取新 binding，不重放旧 Tool Call。

`/mcp` 继续是只读 effective Server 列表。Provider Action 和 required admission 使用 App shell/Runtime interaction 边界，不新增 `/mcp` detail、retry、login、approval 或配置 route。

## 实施切片

### 5A Provider directory、typed failure 与 unavailable search

状态：completed（2026-07-17）

- Supervisor 作为 Runtime provider façade，Manager 保持唯一 SDK client；
- 增加 redacted provider directory 与 last-known Tool 名称；
- 增加四类 typed provider failure；
- `capability_search` 返回 bounded unavailable-provider diagnostic；
- unavailable 结果不产生 descriptor、binding、approval 或重放。

验证：MCP Manager/Supervisor/config reconcile、Runtime failure/tool controller/capability search、typecheck、core boundary、docs gates。

结果：仓库非 PTY 全量测试 1483 pass / 1 native keyring smoke skip，MCP 串行 PTY 4 pass；typecheck、Biome、core boundary、docs 与 docs-impact 全部通过。

### 5B Provider Action Runtime lifecycle

状态：completed（2026-07-17）

- 新增默认关闭的 `mcpProviderActionV1`；
- 新增 interaction、events、effect、action、scheduler/reducer/invariant；
- 旧 Tool Call 先终结，再进入 provider action；
- success/deferred/failed 都清除旧 interaction，success 只能开始新 turn；
- 增加 Runtime schema migration、replay/golden 和 flag 双路径测试；
- 新 ADR 决定 lifecycle 与 App handler 边界。

结果：`mcpProviderActionV1` 默认关闭；Provider Action 已进入 schema v11 的 interaction/event/effect/action/scheduler/reducer/invariant，成功恢复只通过新 turn 继续，旧 Tool Call 保持 terminal。Core migration、restart、flag 双路径与 golden 已覆盖。App/TUI 的实际 login/approve/retry handler 保留到 5D；未接入的客户端只会安全 defer。

### 5C Required Provider admission

状态：completed（2026-07-17）

- run 前检查 effective required Provider；
- ready/degraded 准入，其余进入独立 required gate；
- Retry、Session Waive、Cancel Run；
- waiver 作为 Runtime 初始事实持久化，不使 capability 可见；
- 不恢复 `/mcp` 管理 route。

结果：schema v12 增加稳定排序的 required admission 队列与 session waiver；新 run 在首次模型调用前只接受 ready/degraded，其余逐个进入 retry/waive/cancel interaction。waiver 不改变 provider/capability snapshot，cancel 产生 task/turn 终止事实。Core integration、migration 与 golden 已覆盖；实际 TUI Gate 和 Supervisor retry handler 留到 5D。

### 5D App/TUI 恢复与系统验证

状态：completed（2026-07-17）

- foreground/background interaction routing；
- 认证、审批和 retry 使用现有独立 App shell 能力；
- auth success 后新 turn/new binding，Later 形成明确失败事实；
- PTY 覆盖 provider action 与 required gate；
- 更新 active/book/完成记录并执行完整文档门禁。

结果：TUI 通过既有 foreground/background interrupt surface 接入 Provider Action 和 Required Gate，并由 `TuiMcpController` 复用 Supervisor login/project approval/retry；Session Waive 与 Cancel Run 不修改 control plane。Provider required 事件与动作适配共用同一输入投影，避免展示与执行选项漂移。真实 HTTP MCP PTY 已覆盖 failed Tool Call → login action → Later，确认旧调用只执行一次；required login Provider PTY 已确认 waiver 前模型请求为零、waiver 后才继续。

完成记录：[`../execution/completed/2026-07-17-mcp-agent-provider-recovery-phase5.md`](../execution/completed/2026-07-17-mcp-agent-provider-recovery-phase5.md)

## 不变量

1. unavailable Provider 不能产生 executable handle；
2. interaction、事件与日志不保存 token、URL、authorization code 或旧 Tool raw args；
3. 任何恢复都不复用旧 binding、approval 或 invocation；
4. Provider Action flag 关闭时仍保留 typed failure，且不恢复 legacy MCP adapter；
5. required waiver 只允许任务继续，不使缺失 capability 可见；
6. Manager 保持唯一 MCP SDK client 路径。

## 完成标准

Agent 能准确解释 Provider 不可用原因；恢复成功后从新 catalog revision 开始新 model turn；defer/cancel 有持久明确事实；required gate 可 retry/waive/cancel；旧 snapshot migration、flag 双路径、golden、unit、integration 与 PTY 全部通过。
