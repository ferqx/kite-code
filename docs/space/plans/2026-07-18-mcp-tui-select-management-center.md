# MCP TUI Select 管理中心实施计划

状态：archived
优先级：P1
创建日期：2026-07-18
来源：ADR-0018 与 MCP TUI MVP 交互方案修订版
替代：`2026-07-16-mcp-tui-readonly-list.md` 的后续产品方向
依赖：ADR-0009、ADR-0010、ADR-0011、ADR-0013、ADR-0018

## 一、目标与验收

将当前只读 `/mcp` Overlay 改为由 Select 驱动的管理中心。用户只需理解：

```text
↑↓ Select
Enter Confirm
Esc Back
```

完成后必须满足：

1. Server List 只导航，Enter 打开只读详情或 Add flow；
2. 所有 MCP 业务操作通过可见 Select 选项完成，不存在 `A/L/R/D/Space/C/Y/N` 功能键；
3. ready、auth required、failed、disabled、pending approval、rejected、connecting 等状态都有确定的详情与操作菜单；
4. Add 支持 HTTP/STDIO、name、URL/command、local/user scope；
5. Authenticate、project review、disable 和 remove 使用独立页面或确认 route；
6. Core 的审批门禁、secret 边界、revision conflict、generation 和 Runtime binding 不变量保持；
7. component、controller、Core integration 与真实 PTY 测试覆盖完整导航和副作用。

非目标：Edit Config、高级 args/env/header/auth/policy 表单、Tool/Resource/Prompt 浏览器、Marketplace、手动 reload、连接取消、logout/revoke、多账号和鼠标支持。

## 二、交互与状态契约

### 2.1 App 状态

在 `src/app/tui/mcp/` 内建立 App-owned 状态：

```ts
type McpOverlayView =
  | { kind: 'server_list' }
  | { kind: 'server_detail'; serverKey: McpServerKey; selectedActionId?: string }
  | { kind: 'add_server'; step: McpAddStep; draft: McpServerDraft }
  | { kind: 'authenticate'; serverKey: McpServerKey; phase: McpAuthPhase }
  | { kind: 'project_approval'; serverKey: McpServerKey; selectedOptionId?: string }
  | { kind: 'confirm'; action: 'disable' | 'remove'; serverKey: McpServerKey };
```

使用稳定 option id 和 Server key 恢复 selection，不把数组 index 当作持久身份。每次 snapshot 更新重新生成可用项，并按原 id 保持选择；原项消失时选择最近的可用项。disabled option 可显示但不能成为当前 selection。

输入 action 固定为 open/close、list move/confirm、detail move/confirm、generic select move/confirm、input changed/confirm 和 back。`resolveMcpSelection()` 是 route + selected option 到业务 command 的唯一解释入口。

### 2.2 主状态派生

新增纯 App mapper，将 `McpServerControlState` 派生为展示状态：

| 条件 | 主状态 | 操作 |
|---|---|---|
| pending approval | Approval required | Review server, Back |
| rejected | Rejected | Review decision, Remove, Back |
| disabled | Disabled | Enable, Remove, Back |
| invalid/store unavailable/quarantined | Configuration unavailable | Remove（仅可写 source）, Back |
| authorizing | Authenticating | Back |
| login/reauth required | Login required | Authenticate, Disable, Remove, Back |
| auth error | Authentication failed | Authenticate, Disable, Remove, Back |
| connecting/discovering | Connecting | Back |
| ready | Connected | Reconnect, Disable, Remove, Back |
| degraded/half-open/circuit-open | Connection failed/degraded | Retry（仅 retryable）, Disable, Remove, Back |
| disconnected + diagnostic | Connection failed | Retry（仅 retryable）, Disable, Remove, Back |
| 其他 disconnected | Disconnected | Connect, Disable, Remove, Back |

详情只展示 control snapshot 已有的安全投影：name、status、transport、source label、HTTP endpoint origin 或审批 review command、auth status、tool count 和 typed diagnostic message。不得展示 secret、headers、env values、完整 OAuth URL/query、raw config 或 raw error。

### 2.3 导航与确认

- Server List 最后一项固定为 Add MCP server；空目录仍显示该项；
- Detail Esc 与 Back 返回列表并保留原 Server；
- Add 的 Esc 返回上一步，首步 Esc 取消并返回列表；
- Add final review 提供 Add and connect、Back、Cancel；
- auth prompt 提供 Open browser、Cancel；waiting 提供 Cancel authentication；
- remove、disable 和 project review 默认选择安全项；
- connecting/discovering 返回列表后继续后台运行；
- snapshot 删除当前 Server 时自动返回列表并显示 notice。

## 三、实现任务

### Task 1：TUI reducer、ViewModel 与通用 Select

状态：completed（2026-07-18）

- 新增 route/reducer、稳定 selection helper、主状态与动态 action builder；
- 抽取无业务副作用的 Select renderer，统一 `>`、说明、disabled/destructive 文案和 footer；
- 改造 `McpOverlay` 为唯一 MCP 页面宿主；Server List 从滚动窗口改为 selection + 可视窗口；
- 保持 `layeredEscRef` 与其他 overlay/interrupt 的输入隔离，避免按键穿透到主输入框。

验证：reducer/table tests 覆盖全部 route、动态 option 变化、禁用项跳过、Server 删除和 selection 恢复；component tests 断言无功能快捷键提示。

### Task 2：只读详情与连接动作

状态：completed（2026-07-18）
依赖：Task 1

- 实现 Server Detail 与安全字段格式化；
- 扩展 App controller 的 connect/retry/reconnect command，统一调用 `McpSupervisor.retry()`；
- 实现 ready、failed、disabled、rejected、approval required、connecting 的操作菜单；
- retry/enable 后立即依赖 snapshot 显示 connecting，不在组件维护第二套连接事实；
- disable 使用确认 route，并通过 expected revision 的 `set_enabled` mutation 执行。

验证：controller tests 覆盖 command 目标、stale revision、retryable/non-retryable 菜单和后台 snapshot 刷新；Core Supervisor/Repository 回归通过。

### Task 3：Add flow 与配置 mutation

状态：completed（2026-07-18）
依赖：Task 2

- Transport → Name → URL/Command → Availability → Review 五步；
- `Current project` 映射 `local`，`All projects` 映射 `user`；
- HTTP 只写 `{type:'http', url}`，STDIO 只写 `{type:'stdio', command}`；
- 使用 snapshot 的 `sourceRevisions` 构造 expected revision；冲突保留 draft 并提示重新 review；
- 成功 mutation 后以稳定 key 打开 Detail；连接状态完全来自 Supervisor snapshot；
- 复用 Core name/schema 校验，不在 UI 建立不一致的验证规则。

验证：local/user 文件目标、JSONC 保留、权限、冲突、不合法 name/URL/command、Add 后连接与失败详情；不得写 project `.mcp.json`。

### Task 4：认证流程迁移

状态：completed（2026-07-18）
依赖：Task 2

- 将独立 `McpAuthPrompt` 合并为 authenticate route，删除 `l` 输入；
- 显式 Open browser 才调用 login；authorizing 状态由 snapshot/flow id 驱动；
- Cancel authentication 调用 `cancelAuth()`；success 返回详情并等待 reconnect；
- opener failure、timeout、state mismatch 和 Store unavailable 显示 Try again/Back；
- 删除启动时自动弹出的 auth prompt；Runtime Provider Action 仍可通过 controller 发起固定 login 动作。

验证：component + PTY 覆盖浏览器打开前零副作用、cancel、成功、失败、Esc 恢复主输入；原生 keyring smoke 保持。

### Task 5：项目审批迁移

状态：completed（2026-07-18）
依赖：Task 2

- 将独立 `McpProjectTrustPrompt` 合并为 project approval route，删除 `a/r` 与同键二次确认；
- Review 只使用现有脱敏 approval projection；
- Decide later、Approve and connect、Reject server 均为 Select option，默认 Decide later；
- approve/reject 继续传递 expected config digest 并复用 TOCTOU 校验；
- 删除启动时自动弹出的 project prompt；pending/rejected Server 保持可从列表进入；
- Runtime Provider Action 的 approve 路径继续调用 controller，不依赖 Overlay 当前是否打开。

验证：pending stdio/HTTP 在批准前零进程/零请求；approve 后连接；reject 后状态和 Review decision；Esc 不记录决定。

### Task 6：Remove、凭据清理与故障语义

状态：completed（2026-07-18）
依赖：Task 2、Task 4

- Confirm 页面默认 Cancel，并列出配置、凭据和 capability 影响；
- 只允许删除可写 local/project/user source；legacy/explicit/shadowed 的不可写原因明确显示；
- 删除前检查 expected revision 和 Credential Store 可用性；
- 删除配置后清理同 Server/source 的本地 credential profiles，不默认 remote revoke；
- cleanup 部分失败保留 notice/diagnostic 和可恢复指引，不能报告完整成功；
- 删除成功返回列表；同名低优先级 fallback 生效时在确认页预告。

验证：cancel 零副作用、revision conflict、fallback、vault unavailable、credential cleanup、capability 先失效、删除后 selection 收敛。

### Task 7：App shell 清理、PTY 与文档收敛

状态：completed（2026-07-18）
依赖：Task 1–6

- 移除自动 `mcpPendingApproval`/`mcpPendingAuth` overlay 及 defer session state；
- 保留 Provider Action 与 required-provider admission 的独立 Runtime interaction；
- 更新 HelpPanel、slash suggestion、README、`docs/active/mcp-*`、book 07/08/09/11；
- 新增 ADR-0018 实施完成记录，并把本计划归档；
- 按 `docs/documentation-map.json` 修正遗漏映射，不绕过 docs-impact 检查。

验证：

```bash
bun test tests/mcp-panel.test.tsx tests/mcp-config-repository.test.ts tests/mcp-config-reconcile.test.ts tests/mcp-project-approval.test.ts tests/mcp-supervisor.test.ts tests/mcp-auth-coordinator.test.ts tests/mcp-oauth-integration.test.ts
bun test --parallel=1 --max-concurrency=1 tests/tui-system/scenarios/mcp-management.test.ts tests/tui-system/scenarios/mcp-project-approval.test.ts tests/tui-system/scenarios/mcp-authentication.test.ts tests/tui-system/scenarios/slash-commands.test.ts
bun run typecheck
bun run check:core-boundary
bun run check:docs-impact
bun run check:docs
git diff --check
```

提交前必须执行项目 `document-before-commit` Skill；任一实现、测试或文档门禁失败时不得提交。

## 四、发布顺序与回滚

按 Task 1→7 单链实施，不能先删除独立认证/审批入口。Task 4/5 的新 route 和旧入口可在开发分支短暂并存，但合并态只能保留新入口。无需新增 Runtime feature flag；在一个版本内完成 Overlay cutover，避免两套管理语义长期并存。

回滚必须恢复独立认证与项目审批入口后，才能恢复只读 Overlay。任何回滚都不得删除 Core Repository、Credential Store、审批摘要、Supervisor generation 或 Runtime provider recovery 能力。
