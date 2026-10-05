# Agent Note: 声明补偿以原用户选择和受限普通 Job 执行

Status: implemented

## Problem

required 验证失败后需要修复、重新规划、准确豁免或执行原声明补偿。已交付 attempts 和用户决定没有安全补偿执行环境；普通 guardian 不证明文件与网络隔离。V1.3 §17 和当前验证治理要求补偿只来自用户选择、网络关闭、原脚本位于 Workspace 内，成功也不能把原验证失败变为通过。

## Decision

可信宿主登记独立 `skill.workflow.compensate@1` 普通 Job，仅在 allowCompensation、原声明与实际 macOS confined backend 都可用时提供问题选项。原 accepted question 绑定 Store/Session/Run/anchor/requirement/head/attempt/output/verifier；operation opening 在派发前保存原决定、父 Tool、闭合输入和摘要。每个 attempt 只登记一个补偿 operation，查回原结果不重新执行。Service trusted policy 默认允许该选择，但 Workflow flags 缺省关闭；原声明与后端资格仍是独立必要条件。

实际 start 重核 Workspace/profile/control 身份、编译来源和完整文件字节集合，将原脚本与全部资产复制到独立只读 runtime 根，再在原 Workspace 内用固定 Bun 和网络关闭/禁止 fork 的普通 guardian 执行。Job 独立核权限和必要审批，不借原 verifier 许可。Model 不提供命令、环境、路径或 sandbox policy。补偿、失败、取消和未知分别记录，原 failed proof 不改；仍需真实 replan/reverify 或准确 waiver 才能解除原 required。

必要条件使用通用有界 Run 执行闭包安全读：保原完整 revision 和 boolean，另公开实际 unconfirmed ID 集。Job condition 不申请只适用于 Tool 的 selfexclude；业务只能核实际当前 Job 与准确父 Tool，任何其他未结算或未知拒绝。Core 最终安全读集再次核整个闭包，不建立 Skill 状态枚举或数据库表。

## Alternatives considered

- 用普通 verifier Shell 执行补偿：拒绝，它只有监督，没有实际文件/网络 confinement。
- 在原 Skill 目录直接执行可变脚本：拒绝，审批后源变化及运行中改写会使声明与实际代码分离。
- 用户自报 compensated/passed：拒绝，真实 Job 和原 accepted question 才能证明采用与效果。
- 让插件选择安全读的排除集合：拒绝，排除权必须由原实际调用关系固定，原 closure ID 集仅为事实。
- 补偿成功直接结束任务：拒绝，原 failed 验证继续存在，补偿不证明原结果正确。

## Consequences

真实 Runtime/SQLite/问题与独立审批完成一次补偿，准确原 operation/resultRevision 可核，原失败与 required 保留；重复选择不重跑。通用 Store 10/45 与 Host 1/29 核 planned Job、准确父 Tool、第三 unknown 与最后 read-set CAS；completion/waiver 不接受未清闭包。业务新增 5/35 核独立审批、repair attempt 2 和准确 waiver，关联 6 文件 94/822 通过。真实默认 Service 2/39 使用超过 300 KiB 的完整原审批 Artifact，补偿效果一次、拒绝零效果；没有缩小输入以避开完整附件协议。

真实补偿 leaf 最终 6/49 核完整 UTF-8 与二进制原字节、固定环境、TCP 零 accept、Profile/sealed-copy 写拒绝、来源和闭合输入漂移、取消与超时真实停止。杀死原 guardian 而子进程仍存活时，生产 observe/cancel/dispose 保 unknown 和原副本；测试只在核验后清理自己的准确进程组，不把 teardown 当 Job 停止回执。源码外 21 个公开 entry 的真实发布包 1/55 另核合格补偿、原 Workspace 效果一次与完整清理；关联常规 confined Shell 的 fork/native-temp-exec/root identity 资格不能扩写成每个补偿漂移都已独立实跑。

资格限 macOS 禁止派生子进程模式，需要子进程的声明脚本会失败；Linux/Windows 与全部默认 Shell 隔离没有由本决定完成。Job stop 未确认时保留未知和 runtime 资产，不能删除仍可能使用的代码。完整正式客户端和 V1.3 §35 继续独立验证。

既有尝试与用户决定仍由[已实施记录](2026-10-03-workflow-verification-attempts-and-user-decisions.md)指导；受限后端的真实取舍见[Shell记录](2026-10-03-macos-confined-shell-refuses-fork-and-temp-exec.md)。当前事实仍归 [Workflow owner](../../../../packages/agent/src/business/skill-workflow/README.md)，完整日志与冻结适用范围归 [实施进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。
