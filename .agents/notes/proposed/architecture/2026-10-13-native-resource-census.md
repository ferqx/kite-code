# Agent Note: 原生资源与出生完整性的来源

Status: proposed

## Problem

正式客户端执行、取消、重连、后台工作至退出的稳定性门禁需要真实资源保留增长及全部所属出生身份。固定 Bun 的资源／handle／report 接口为空数组；应用 owner 登记和当前存活 PID 不足以证明全量，原 RSS 增长也尚未定位到可确认的业务持有链。当前产品能力与完整默认回归不能替代这些来源。

## Proposal

用户已授权新增可审计 runtime 观测实现及所需原生采集范围。资源从 Bun 实际 primitive 的创建、状态及最终释放取得，在短同步锁下形成进程级快照，避免跨 Worker 直接遍历和错时响应。计数语义须独立区分 live／refActive／pending／closing，任何未接入类别或来源失败保不完整，不能把多个调度计数求和充作 activeResources／handles。

当前[固定源码补丁](../../../../native/runtime-observer/README.md)已接 Job／POSIX FilePoll、EventLoopTimer 实际准入与私有 JS 出口；原生 SDK 选择修复后完整 native build 和实际局部释放通过，但全部类别、独立 ref 和正式指标接线未完成，因此状态保持 proposed。Timer 的内嵌 placeholder 不是已准入资源；实际入队后才登记，取消／触发后的 Dormant 保至最终 Drop，不凭 pending false 提前释放。正式运行时／安装资产保持。后续实际入口仍是原资格 runner 与全部固定负载，不将单次 syscall、collector 或 journal 作为独立长期目标。

出生身份可由连续内核事件提供，独占 coalition 的累计 Mach task 数作为独立缺项约束；必须逐项解释 fork／spawn／exec 和 task 的关系，不能用总数抵消未知身份。原 guardian 存活时才能取得最终 kernel 快照；共享 root、退出后数值 CID 或窗口外出生都不能授予全 Runtime 范围。只读[计数前缀入口](../../../../scripts/runtime/unified-soak-coalition.ts)未接完整出生 producer。用户曾重新要求闭合这两项门禁，随后再次明确以正常运行和内存稳定为本轮范围、停止过度采集。未执行的系统校准辅助脚本已删除，停止扩展来源；原完整资格要求与缺项拒绝保留。

## Alternatives considered

- 复用 Bun 三项 API 或 report：固定源码明确空数组 stub，数字零无来源。
- 应用 owner 数、FD／线程／Mach port 或 `getActiveTasks` 聚合：各有真实局部意义，但范围与计数交叠不能证明完整资源。
- 直接遍历现有 Job／FilePoll／timer／socket store：原取消 JobList 不含普通任务、Hive spill 无全链、timer 多队列及 socket 低优先列表会漏计或重复，选择实际生命周期钩子。
- 单靠 ES 的无 gap 和零 unknown：只证明订阅流，未证明失败 pre-exec 的全部出生事件域；保留独立 kernel 计数与来源边界，不能先声明完整。
- `tasks_started` 与进程数组长度相等：单位是 Mach task，exec-copy 也计数；未经逐项对账不能使用。
- 继续追加 Instruments／参数／采集矩阵：用户已明确收束性能诊断；当前没有可确认的新业务漏点，不扩大验证。

## Acceptance criteria

原正式断言、32MiB、八 outer／九点及出生／退出／EOF 要求保持。完整类别、去重与关闭未知均从准确版本 native 来源取得；候选／runner 绑定同一源码与二进制，来源失败、丢失、跨身份或对账未知继续拒绝。只有真实完整资格通过才能收束 RSS／观测与 §35，partial 原型和逻辑检查不代表阶段退出。

## Risks

定制 runtime 增加构建维护和工具链成本，当前部分源码完整编译已通过；计数钩子不得持有业务对象或制造自身无界增长。Darwin coalition ABI 为私有固定前缀，不冒称完整结构或跨版本公开保证。ES 的实际系统会话与来源验证未完成；当前不继续采集，不能据能力检查替代公开 ready／flush、全出生域或独立对账。该决定不承诺平台资格，不修改产品权限合同或发布门禁。
