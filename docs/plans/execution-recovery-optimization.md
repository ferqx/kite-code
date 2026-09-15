# 执行保护与恢复机制整体优化

状态：本轮实现与验证完成；历史会话缺失清理证据及下述暂缓项仍保留。产品目标是安全空闲会话可继续、不同空间独立执行、历史故障按需恢复；保留多进程隔离、真实授权与未知副作用保护。

## 设计与交接

1. Host 在会话 mailbox 内协调命令准入和安全释放；runner、Provider、Shell、子代理及后台清理全部结束且无未决 effect 后释放 authority，停止空闲续租。下一次命令取得新的 generation 并刷新失效 Runtime。等待交互仅在执行资源已结束时释放。
2. Service 复用 recovery.inspect/reconcile 提供只读摘要和绑定 authority revision 的恢复操作。继续时只自动恢复可证明安全的情况；不凭终态、过期或 PID 消失证明清理。未知结果不重放、不伪造成功。历史读取不恢复，不启动全库扫描。
3. 共享协议区分 busy、cleanup、recovery、unknown outcome 和 storage failure；Desktop/TUI 提供相应操作，CLI 返回结构化错误，Web 只读。恢复和发送使用独立命令身份，丢回执查询已提交结果。
4. Desktop 使用同一 Electron Service/Host/Store，切换已授权空间只更换逻辑连接和订阅，不取消其他空间任务。模型、信任、草稿、迟到响应按身份隔离；真实 Git 工作目录冲突仍受保护。
5. 全仓审查调度、客户端校准、授权与沙箱、存储、工程门禁。只简化已证实重复或扩大阻断的机制；保留独立风险边界，证据不足项明确暂缓。

## 实施阶段

- 审查与基线：completed。
- 执行权与恢复：completed，无法证明清理的历史会话保持有原因的拒绝。
- 空间独立执行：实现与隔离 Electron 原生验收完成，Figma 同步已回读确认。
- 关联简化与整体复验：completed；暂缓项与原生视觉限制见下文。

## 审查清单

| 机制 | 当前证据与影响 | 判定与动作 |
| --- | --- | --- |
| 空闲执行租约 | App Server 每 10 秒续约、30 秒过期；完成后保留 owned；过期进入 recovery_required | 简化：实际执行清理后释放 |
| 恢复出口 | 存储 recovery.reconcile 只有测试消费者；Service 错误归并 session_unavailable | 简化：接入按需恢复与结构化诊断 |
| 空间切换 | Desktop activateForWork 调用 disconnect，native runtimeClose 关闭服务；多 workspace Service 测试可并发 | 简化：保留进程，更换逻辑 workspace admission |
| mailbox、generation、回执 | 各自提供进程内顺序、多进程隔离、持久幂等 | 保留：不能互相替代 |
| 历史 unknown 与调度 | scheduler 检查 capabilities.invocations unknown；需核对来源和清除条件 | 待证据：不直接放行 |
| 校准与授权 | 导航代次、workspace identity、interaction identity 分别保护不同目标 | 保留边界，继续检查重复预检 |
| 工程门禁 | required workflow 存在类型、文档、边界、平台及故障验证；名称相近不能证明重复 | 待按输入和断言核对；不取消 required checks |

## 验证与交付

确定性时间验证空闲过期可继续、完成早于清理、并发取得执行权、失权旧句柄拒绝、未知副作用不重放、恢复 CAS、历史只读、丢回执幂等；多空间验证任务不互相取消且配置/授权不串用。Electron 验证原生宿主、隐藏、重接与退出。真实 xp 数据只在隔离副本验证，不加入仓库。

每阶段执行 overengineering-check、iteration_complete；修改产品行为同步手册、边界同步 owner/active，重要取舍新增 ADR。UI 验证后由子 Agent 同步 Figma。Git 操作前执行 document-before-commit。最终交付实际简化、必要保护、验证证据和剩余项。

## 基线证据

2026-09-14 原始 HEAD 的 runtime-server-multi-workspace.test.ts：10 pass、0 fail，覆盖多工作区、只读历史、所有权竞争及执行租约丢失取消三个模型连接。该结果证明既有断言，不证明本计划已实现。

## 生产链审查结果

| 机制与产品要求 | 实际行为、触发条件 | 保护对象与范围 | 恢复出口 | 源码／验证证据 | 分类 |
| --- | --- | --- | --- | --- | --- |
| 空闲会话可继续 | 已完成仍 owned，休眠跨租期触发 recovery_required | 同一会话 writer；原错误扩大到正常下一轮 | 实际清理后释放，下一轮新 generation | [Service](../../apps/kite-service/src/bootstrap/kite-session-app-server-storage.ts)、[确定性回归](../../apps/kite-service/test/isolated/runtime-server-multi-workspace.test.ts) | 本轮简化 |
| 终态先于清理 | lifecycle completion 仍可能等待 Provider/Shell/子任务 | 相关 Session 后继执行 | 同 mailbox 等待 completion 后释放 | [Host](../../packages/runtime-host/src/host/runtime-host.ts)、[Host 回归](../../packages/runtime-host/test/persistent-command-host.test.ts) | 保留清理 barrier；本轮接通释放 |
| 失权本地 Runtime | 原 coordinator closing 仍可被权限提交命中 | 仅该会话设置；不应成为 generic internal error | closing 期间明确 cleanup_pending，释放后冷设置可用 | [Service](../../apps/kite-service/src/bootstrap.ts)、多子任务失权回归 | 本轮简化 |
| 历史恢复 | 存储能力没有客户端入口，错误合并 | 未确认旧执行与未决副作用 | 只读摘要、CAS 恢复、安全自动核验、具体原因 | [恢复帮助函数](../../packages/runtime-client/src/recovery.ts)、Store 原子恢复与丢回执测试 | 本轮简化 |
| 空间并发 | Desktop 切换关闭唯一 Service | 原错误影响其他空间所有任务 | 更换连接／订阅，Service 持续运行 | [native host](../../apps/kite-desktop/electron/host.ts)、[原生测试](../../apps/kite-desktop/scripts/native-smoke.ts) | 本轮简化 |
| 目录／模型校准 | 历史读取与执行资格已区分；同连接缓存不授予执行资格 | Session 订阅代次、interaction identity | 重新校准，保留历史和草稿 | [校准测试](../../apps/kite-desktop/test/session-calibration.test.ts) | 保留；没有新增全空间门禁 |
| unknown capability | scheduler 对 unknown invocation 阻断；目前缺少已结束且无后续依赖的清除证明 | 可能仍在执行或结果不明的外部操作 | 明确核对，不能自动当成功或重新执行 | [scheduler](../../packages/agent-kernel/src/scheduler.ts)、[restart recovery](../../packages/agent-kernel/src/restart-recovery.ts) | 暂缓放宽：缺安全归属证据 |
| context 与 quality guard | 自动压缩失败已按 requestedAtTurnId 限定；journal_invalid 保护持久状态有效性 | 当前任务上下文或损坏 journal | context reducer 的明确解除事件／新轮重试规则 | [context reducer](../../packages/agent-kernel/src/domains/context/reducer.ts)、[scheduler](../../packages/agent-kernel/src/scheduler.ts) | 保留；未证实历史失败误阻断新轮 |
| 审批与信任 | same_command grant 以规范命令 identity 复用；最终执行仍校验授权和参数 | 当前授权范围，不能扩大到变参或外部目录 | 原审批、撤销及重新授权入口 | [grant key](../../packages/agent-kernel/src/approval-queue.ts)、[授权 reducer](../../packages/agent-kernel/src/core/authorization/reducer.ts) | 保留；未发现可无条件合并的重复授权 |
| mailbox／回执／generation／effect／tombstone | 分别处理进程内顺序、幂等、多 writer、外部尝试与删除迟到写入 | 各自独立边界 | 各 owner 的原事务和恢复接口 | [Store owner](../../packages/runtime-storage-sqlite/README.md)、Host／Store 全套回归 | 保留；无第二 registry 或恢复状态 |
| 同一 CI job 的 lint | format:check=biome check 已启用 linter，紧接 biome lint 重复同输入同规则 | quality job 的静态质量断言 | 保留 format:check，删除独立重复 lint step | [workflow](../../.github/workflows/required.yml)、[Biome 配置](../../biome.json)；注入未使用 import 时 check 与 lint 均 exit 1 且报告 noUnusedImports | 本轮简化 |
| Git 分支与配置重载 | Service 的 Workspace 配置、MCP 与 sandbox owner 保持进程内缓存；只改 Git 不重载会继续使用旧配置 | 分支变化的依赖配置，当前重载需整个配套 Service 空闲 | 其他空间有任务时等待；全部空闲后沿原流程关闭、切分支、重接，不取消其他任务 | [配置 owner](../../apps/kite-service/src/app-control/composition.ts)、[分支回归](../../apps/kite-desktop/test/navigation.test.ts) | 保留现有重载边界；暂缓按空间重建依赖，未新增替代注册表 |
| hook、平台及 release qualification | hook staged 与 CI range 输入不同，原生系统与制品故障断言不同 | 提交边界与发布资格 | 原 required jobs 与对应故障验证 | [hook](../../lefthook.yml)、[required](../../.github/workflows/required.yml) | 保留；不绕过 hook，不建持久验证缓存 |
| 兼容与一次性恢复 | 当前 Store 格式、readonly inspect 与 supported migrations 分属 owner | 格式有效性与既有支持边界 | 明确拒绝不兼容格式 | [Store 格式](../../packages/runtime-storage-sqlite/docs/authority-and-recovery.md) | 暂缓：未证明无生产消费者，未预建替代机制 |

## 阶段审查与剩余证据

审查与基线 overengineering-check：required 为现有 writer fence、effect、mailbox、回执及清理 barrier；simplify_now 为已实现的空闲释放、空间停服务与恢复错误合并；defer 为缺安全归属的 historical unknown 与未知兼容消费者。审查阶段 pass，不表示实施全部完成。

xp 截图会话仅在隔离数据库副本通过同一 Service Runtime 入口检查：revision 1227，turn completed，authority revision 372／generation 4／recovery_required，cleanupConfirmed=false，pending 与 unknown effect 均为 0。只读摘要 action=inspect，显式恢复返回 session_cleanup_pending，前后事实相同；未修改原始数据、未向模型发请求。缺旧执行真实清理证据，不能凭已完成回答、PID 消失或租约过期解锁。该会话尚未恢复。

Electron 专用执行恢复场景已验证两个空间独立完成、模型请求仅 4 次、隐藏、刷新重接与退出；完整 UI 原生 smoke 另外发现复制按钮 hover 和文件面板布局断言失败，不作为通过证据。专用场景只跳过无关视觉断言，不跳过执行／安全断言。Figma 已由子 Agent 同步并通过节点树与截图回读确认：[恢复弹窗](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4721-4560)，包含“检查恢复”和“确定”。

最终验证批次：Host／Client／Protocol／SQLite／Desktop／Service／TUI 与保留的 Kernel 调度审批恢复测试共 636 pass、1 skip（Windows 路径，仅适用 Windows）、0 fail。清理竞态测试在拒绝 cleanup_pending 后等待真实清理，再确认冷权限设置成功且 recovery facts 不变；丢回执与查询都失败的 fixture 仍保持 unknown。当前会话恢复拒绝禁用发送、草稿保留及 Service 进程补验 59 pass；分支重载与原生文件/Git 保护补验 5 pass。核心边界、文档结构和 all docs-impact 已通过；格式检查原有图标 title 与两份 CSS 格式问题已最小修正，仍保留 6 条非阻断 info。18 个 workspace 完整类型检查通过；Figma 设计同步已确认。

执行权与恢复、关联简化阶段的 overengineering-check：required 为释放回调、原 generation/revision 事务、清理事实、恢复与只读回执接口（Desktop/TUI 真实消费者）、原生专用验收；simplify_now 已删除重复 lint step、全服务空间切换停止和失效 coordinator 使用，未留下新增持久状态或重复注册表；defer 为旧会话缺清理证据、未知结果归属和按空间重建 Git 配置依赖。结论 pass。iteration_complete 已核对共享手册、Desktop/TUI 差异、Host/Store/Service/Protocol/Client owner 与相关 active，复用有效测试并重跑类型、文档、all docs-impact、核心边界和格式检查；空间独立执行阶段与最终 overengineering-check 同样 pass：沿用唯一 Service，未新增空间进程或执行注册表；Figma 已完成。
