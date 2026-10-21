# Agent Note: 持久权限控制与最终派发读集

Status: implemented

## Problem

会话模式、以后会话的默认模式和 Workspace trust 是用户可以改变的独立事实。仅把它们放在内存或配置快照中，会在重启、跨 Service 或最终授权之后撤销时继续使用旧许可。若管理读取必须加载整段历史，大正文和损坏的无关执行还会阻塞用户撤销权限；客户端丢失写响应后重发则可能把未知结果改造成新意图。

本决定只描述新统一 Agent 的持久控制机制与薄调用者，范围由 [V1.3](../../../../docs/plans/unified-agent-refactor-v1.md)及[当前边界](../../../../docs/active/unified-agent-boundary.md)定义。旧执行线仍有正式消费者，未迁移旧权限数据；same_command/clear 已验证当前切片，全部正式客户端和平台迁移尚未完成。

## Decision

模式/default 和 trust 复用唯一 Store 中的 HostMutation journal，保存准确原 Store、宿主主体、root Session 或 Workspace、稳定命令 ID 与观察 revision。控制记录和不可变回执在同一短事务提交；用户默认与当前 Session 模式分别保存，不写项目 JSONC。管理入口只读取有限 Session/control 元数据。child 继承根模式但不能独立修改根控制。显式宿主 policy 保留能力／信任、硬拒绝与明确人工要求上限；根审批模式仍由用户在运行中修改，不因注入策略成为只读。默认管理器以独立 allowModeChanges 开放 mode，保留注入宿主原 trust／grants 管理边界。

Trust 将 canonical Workspace 文件身份与当前可信额外读取范围摘要分开封存。目录替换、Skill 根或实际额外范围漂移使旧决定不再有效；Git 元数据和普通文件修改不构成整个工作区身份变更。摘要只证明用户观察过准确范围，不接受客户端路径、scope 或 hash 作为新的读取许可。

默认授权读取准确 mode/default/trust revision，并以中立 controlReads 交给 Core。人工决定仍保留这些读取；同 Loop child 的父子策略取交集，冲突 revision 不裁剪为允许。最终 markDispatching 在同一 SQL 事务按原 Command 主体复核全部相关控制 revision。撤销先提交时旧 proof 零派发；已发生效果继续按真实证据与取消能力结算。

Native HTTP、CLI 与便携 Desktop/UI 固定原 Store、目标、观察和命令 ID。保存、已接纳、已应用、失败和未知分别展示；未知只查询原 journal，局部视图取消不提交 Run 取消。Browser gateway 保持只读，不取得这些写入口。实际实现由 [Service 权限管理](../../../../apps/service/src/permission-management.ts)、[Store 控制](../../../../packages/agent/src/storage/sqlite/host-mutation-operations.ts)、[CLI](../../../../apps/cli/README.md)和[Desktop](../../../../apps/desktop/README.md)维护。

正式 TUI 的当前进程原意图不能与单个显示槽合并：用户从 A 切到 B 后，A 的保存和 GET 仍可能返回；仅给晚回加 guard 会保住 B，却可能丢掉 A 的可查结果或漏掉同 Workspace 的 trust 未决阻塞。因此沿现有 map 保完整原意图，分别按 Session/Workspace 匹配，以准确读取身份撤销展示；不新建持久格式。查询由显示槽选择 ID，但基线必须是 map 中已核原事实，最新同 ID 请求独占更新标记；否则旧 unknown 显示加一次网络失败会覆盖已经核实的终态。产品范围由 [TUI 指南](../../../../docs/handbook/clients/tui/guides/approvals-and-questions.md)与 [TUI owner](../../../../packages/ui/src/tui/README.md)维护，[原 controller 用例](../../../../packages/ui/test/tui/permissions.test.tsx)保旧 CAS 并覆盖这条完整行为；不从这项修复推导客户端强杀后的原 ID 发现。

界面只按准确 applied 控制事件重读真实权限，不用 event payload 或显示缓存签发授权。根事件需要使已观察 child 及首次 metadata 尚在读取的 child 重新校准，切 scope 与迟到结果仍服从原读取代次。背景刷新不能替换在途原保存的展示 ownership，否则一次合法控制事件会把已保存结果留成 unknown；相同事实重读也不应撤下未提交确认。TUI 以 Ctrl+P 在问卷中访问权限，保留原步骤及字面 slash 回答，避免把用户数据解释成控制命令。对应当前行为与回归归 [TUI owner](../../../../packages/ui/src/tui/README.md)和 [Desktop owner](../../../../apps/desktop/README.md)。

## same_command 与准确 Session 清除

同命令批准不是跨 Session 的通行证，也不能从 Tool 名称或任意 JSON 推测作用范围。Core 保留真实 Store/subject/Workspace/Session、kind/definition/version、原 accepted Interaction/decision revision/Execution 与完整 input digest；可信 policy 可以另给严格 command digest。只有当前 policy 仍明确提供 same_command 时才复用，最后派发事务核 grant epoch 与原控制/必要义务读集。child 与 root 不能互借；creator 只能按实际 scope 管理准确 child。

默认 Shell 的 command digest 在 Service 可信 factory 中构造，固定实际 command、Tool attached/detached、host configuration、canonical cwd、克隆 env、真实 guardian/Bun/Shell bytes hash 和实际 grace/output queue，排除 operation key。默认值和 Job 保持 200ms/256KiB；新 key 是新的明确效果，原 key 查询和重试仍沿原回执。非 Shell 默认用完整 input digest，Model/JSONC 不能登记 digest。

授权目录只读有限出处，每页 200 项、固定 upper 与 epoch，新增授权也推进 epoch。clear 的原 journal/CAS 只撤准确 Session，不扩到 descendants，也不改写已发生效果。Native/CLI 发生物理响应丢失后仅查询原 command，视图切换、读取失败或 CAS 冲突不制造新的 POST。UI 缺省 approve_once，只有原卡实际提供该范围时才呈现 same_command；deny/question/plan 不产生 grant。

原先只对全 input 求 hash 会把 Shell ensure key 当作命令权限的一部分。我们保留这个通用安全缺省，在可信 Shell factory 登记准确环境摘要，避免在 Core 中剥 key、按业务 Tool 名称分支或把不完整命令字符串当作 authority。代价是可信摘要必须随实际执行语义/默认值同步，所有变化继续经独立 Tool/Job 权限核对。

## Alternatives considered

- 用 JSONC 或单份配置快照兼作可变许可：未采用。配置选择与权限 authority 不同，当前会话/default/trust 的并发修改也需要独立原回执和 CAS。
- 在授权函数中只核一次当前记录：未采用。授权到持久派发之间存在真实撤销窗口，最后事务必须复核准确读集。
- 从 getView/完整历史推导当前权限：核对中改为有限 Session/control 读取。权限操作不应依赖大正文或无关执行 JSON。
- 丢失响应后重新 POST 或换命令 ID：未采用。无法证明原提交未生效，只能查询原意图，必要时由明确新观察产生新用户选择。

## Consequences

控制权威仍由唯一 Store 与当前宿主策略组成，没有第二个权限 manager、旧格式迁移或 renderer authority。客户端可以独立撤销或查看权限；Full 继续受硬能力和 trust 限制，用户控制不把已知拒绝变成一次性批准。Generic Core 只理解读集、身份与最终 CAS，不内置业务模式名称或信任路径。

[管理/实际装配](../../../../apps/service/test/isolated/permission-management.test.ts)、[最后派发竞争](../../../../packages/agent/test/isolated/storage/host-control-dispatch.test.ts)及[真实 CLI](../../../../apps/cli/test/permissions.test.ts)建立本机 SQLite、真实 Loop/子调用、取消和 socket 丢失证据。CLI/HTTP/Client 组合 12 tests/113 assertions、控制 read-set 相关组合 34/300、便携 Desktop/UI 相关组合 39/300 通过。真实 Shell/CLI/Client 同命令与清除组合 19/180 通过；Native 恢复原基线后完整当前组合 30/224 与实际 Electron 13 条 Node 断言通过，丢 clear 回应仍 POST1、准确另一 Session 保留且真实 CAS 冲突不重试。实际 child 清除窗口、正式 TUI、其余 Native 管理、完整 backup/restore 与三平台资格仍按实施进度验证。

旧 [Workspace trust scope 决定](../bug-fix/2026-08-27-workspace-trust-binds-external-read-scope.md)关于观察范围和不扩大 mutation/network 权限的理由仍适用，但其旧 transport/格式迁移不描述新链路。[模式授权决定](../simplification/2026-08-24-mode-aware-workspace-authorization-boundary.md)的 Workspace 与外部 effects 分流继续由当前实际 Tool 元数据/宿主 policy 承担；本决定没有把所有 Shell 都自报为 Workspace write。
