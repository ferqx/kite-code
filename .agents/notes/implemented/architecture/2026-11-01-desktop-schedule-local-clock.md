# Agent Note: 定时任务统一采用本地服务宿主时钟

Status: implemented

## Problem

用户要求移除定时任务的时区选项，以本地服务时间为准。仅隐藏字段仍会让旧任务沿原自选时区执行；直接删除持久字段则会破坏既有 DB10、备份白名单与冻结运行快照。需要让现行任务遵循宿主时钟，同时保留已经发生的运行事实及恢复身份。

## Decision

renderer 保存频率、时分与可选星期，不提交时区；封闭 IPC 拒绝附带 timeZone。Main 使用系统 Intl 时区，保存时补充绑定，并在读取和调度前同步当前 Store 的任务定义。保留 DB10／manifest19 原 timeZone 字段作为宿主绑定元数据，不升级版本，不重写冻结运行快照或其他 Store 的任务。

旧绑定与宿主不同，或宿主系统时区改变时，按新时区重算下一次未来发生；不把转换前的时间解释成新时区的漏跑。同一绑定的睡眠／重开最新一次补跑、DST gap／overlap和未知运行阻止后继的规则保持。保存、容量校验及重算沿原私有库事务，失败保持原字节并拒绝继续按旧绑定派发。

此决定补充并限定[原本地调度决定](2026-10-15-desktop-local-scheduled-tasks.md)的时钟和补跑适用范围。原普通会话执行、权限、稳定身份、冷恢复零重放、Store隔离和容量边界继续适用。当前产品与实现分别归[Desktop手册](../../../../docs/handbook/clients/desktop/README.md)和[Native owner](../../../../apps/desktop/README.md#native-定时任务)。

## Alternatives considered

- 只隐藏 UI 时区：旧任务仍沿原绑定执行，不能满足统一宿主时间的要求，未采用。
- 删除 DB10 及快照中的时区：改变闭合格式与历史字节，需要额外格式升级；本次用户未授权升级，未采用。
- 绑定改变时立即追补：无法将旧时区发生映射为新本地日程，会在转换时意外执行任务，未采用。

## Consequences

用户只选择几点运行；主进程所在宿主决定本地时间，renderer 本身的时区不能改变安排。改变宿主时区会跳过转换前的待运行时间；后续按新本地时间继续。旧运行保留当次快照，备份恢复仍保留旧 Store，只有明确重绑才取得当前 Store 的执行资格。

[运行器](../../../../apps/desktop/test/scheduled-task-runner.test.ts)、[存储](../../../../apps/desktop/test/isolated/scheduled-tasks.test.ts)和[IPC](../../../../apps/desktop/test/native-scheduled-ipc.test.ts)覆盖宿主绑定改变、未来重算、旧快照及外来 Store 字节保持、禁用状态和调用者时区拒绝。真实 Native 在独立 Profile 验证 UTC 宿主接管 Asia/Shanghai 旧任务、新建和编辑；具体证据与未验平台归 Native owner。本次未让机器睡眠。
