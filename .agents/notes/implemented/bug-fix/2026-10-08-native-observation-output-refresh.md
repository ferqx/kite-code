# Agent Note: Native observation refresh preserves complete output

Status: implemented

## Problem

真实 macOS PC 窗口的一次兼容 Model 产生超过17MiB正文时，原10秒等待内 Core Run仍为running，稍后的只读选读才看到completed。原诊断记录两个目录各605次GET、所选View139次GET。输出按不可变片段持续持久化，每个变化驱动Main立即再次读目录；所选View的后继调度还会额外读取目录。合并这些重复读取后，原完整窗口进一步暴露重命名刷新会卸载原消息组件，从而丢失已经验证并展开的全文。

## Decision

[NativeCaller](../../../../apps/desktop/electron/native-caller.ts)继续使用现有独立目录与所选View读取，每条路径保留一个在途读取和一个后继通知位。读取完成后100ms内的通知合并，最后通知仍触发新的事实读取；View的后继不再重新调度目录。旧读取失去当前owner后不设置后继计时器；目录epoch失效和网络释放清理所属计时器。显式选择、准确原命令操作和慢目录之间的既有独立性保持。

reset仍先重新读取原事实和完整历史；ready高水位等于重新读取的baseline时无需再读同一观察，不确认snapshot为已应用事件游标。[Native renderer](../../../../apps/desktop/src/native.tsx)在同一选择范围刷新时保留消息组件，只在没有可展示消息或正在切换范围时使用整页历史loading。全文组件按attach generation／viewSelection／history epoch／原消息ID封存生命周期，真实范围变化仍清正文；历史loading期间仍撤除写资格。

## Alternatives considered

- 保持每次变化立即读取：原失败已经显示大量重复GET，且所选View后继还放大目录读取；持续输出会争用正常执行与观察所需的资源。
- 只合并当前在途读取中的通知：快读取结束后紧接到达的输出变化仍可立即重开，不能覆盖实际连续片段场景。
- 放宽原窗口期限、减少正文或根据Model succeeded推断Run completed：均未采用；它们不能证明原Core轮次完成和完整用户行为。
- 每次普通历史refresh都卸载全文组件：真实重命名断言已失败；改为同范围保组件，范围变化仍清理，不建立全局全文缓存。

## Consequences

自动观察在快读取完成后最多增加100ms合并等待，不作为所有设备的延迟保证。Core片段大小、完整持久化、终态判定、Service/Client API、默认宿主Shell及原UI结构未变。原窗口的10秒UI、45秒driver与60秒整例预算及全部18条Node断言保持；完整原窗口actual0／25.70秒，读取>17MiB原正文、rename CAS、重命名后全文保留、unknown delete原GET、Provider一次与普通退出所属Service停止全部通过。直接八文件27项／199断言通过，范围和失败记录归[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08native-大输出刷新与全文保留)。本决定不关闭macOS RSS／八轮稳定性、完整迁移或其他平台资格。
