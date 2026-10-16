# Agent Note: 长任务持续执行与相同工具五次失败停止

Status: implemented

## Problem

主任务可能持续数小时、数天或数周。固定模型重试次数、来源数量、项目指令字节额度和隐式 Shell 超时会在任务仍可推进时结束 Run；默认摘要器未启用自动触发、要求额外用户轮次，以及相同失败指纹长期阻止重试，也让单次长任务无法持续压缩。另一方面，模型反复用相同参数调用同一失败工具不会产生有效进展，需要用户明确要求的五次连续失败终止条件。

## Decision

2026-10-16：[持久 continuation 与父子恢复](2026-10-16-durable-continuations-and-group-recovery.md)扩展纯 Model、压缩和原 child 监督边界，并以实际 SQLite 写入观察复用未变化校验快照。本文的原身份、未知效果、初始化与权限理由继续适用；旧的全面拒绝范围和每阶段重复扫描由新决定收窄。

主 Run 不设总期限或累计资源额度，子 Run 保留激活后固定 30 分钟期限，包含等待后代的时间。普通 Task 的并发仅作调度：正整数并发配置默认 3，不再以 28 为配置上界；满额任务持久受理后等待空位，排队不消耗尚未开始的子 Run 期限，也没有固定队列数量上界。显式 fail_if_full 仍是底层调用者明确选择的准入语义。

原父 Run 的 required 结果义务及完整 waitingForResults 集合不设累计数量或 JSON 字节额度。Store 仍逐项核原可执行记录、不可变 ref、carrier、selection 与准确结果证明，缺一项不能完成；有限单次协议校验不作为长 Run 的累计预算。默认客户端 Run Schema 同步取消 64 项等待集合上界。

可安全重复的暂时性模型失败在同一 Run 内按原失败 Execution 血缘退避重试，不设置次数上限。公开 modelRetry.maxAttempts=null 表示无本地上限，保留实际 attempt 和原失败前驱；历史有限数字仍可读。SDK 每次仍只执行一次网络请求，原 SDK 的 retryable 分类涵盖 408、429 和可重试 5xx；非暂时错误、未知效果、取消和无法证明关闭的尝试不自动重放。来源／能力变更可重新准备多次，完成治理不再用重复诊断 key 代替真实必要条件。

完整接收到的纯文本 length 响应作为实际保存的响应段，在原 Run 中请求继续；任何截断工具批次零派发。压缩摘要的 length 仍失败，不能发布半份摘要。普通 Shell 仅在调用者明确提供 timeoutMs 时设置总期限，等待切片不取消进程。

安全接续的 SQL 全历史校验同时接纳成功 length 纯文本段，Runtime 重新读取完整正文并拒绝段中调用或空正文。历史 failed/incomplete Model 只有在没有派生 Tool/Job、后续已有安全 Model 边界时才跳过，不重放失败请求；末尾 failed Model 仍拒绝。保持原完整历史摘要、generation/selection CAS、权限和 unknown 边界，不用放宽恢复身份校验解决新旧结束原因不兼容。

Core、Service 和 Extension 不设来源数量额度；项目来源完整读取全部适用内容，不设目标／目录／深度／字节额度。准确 Session、namespace、摘要一致性、nofollow、范围、文件实体、UTF-8 以及物理内存与存储能力仍独立成立。每个检查点重新捕获来源，不缓存旧执行资格。

默认 Service 在安全 Model 边界对单个长任务自动压缩。已声明窗口时使用扣除已知输出预留后的约 80% 估算水位，未知窗口以 32768 个估算输入 token 触发维护；这些数值不拒绝执行、不代表准确 Provider 容量，也不限制摘要或任务累计用量。已结算的 Model／Tool 历史可以在一个用户任务内压缩。已知摘要失败保旧输入，相同失败指纹只让出一次普通决策边界，不能永久禁用后续压缩；SQL／unknown／取消继续按原恢复合同处理。

唯一新增主动停止条件由同一 Loop 执行：模型调用顺序中，同工具与语义相同 JSON 参数连续五次 failed，取消准确 Run 和 attached 后代，原因 repeated_tool_failure。换工具、换参数或非失败结果清零；对象键顺序／JSON 空白不改变语义。并行调用先全部结算再按原调用顺序统计，物理完成顺序不影响判断。计数跨完成检查保留；显式原 Run 接续从原 Model／Tool ledger 重建，压缩和 owner 更换不重新获得额度。

本决定部分替代[完整来源捕获](2026-10-10-complete-checkpoint-source-capture.md)的 128／256 数量和项目读取额度；检查点内批量复用与完整新鲜性理由保留。它细化[压缩来源](2026-10-02-recorded-context-compression.md)的默认触发和失败指纹生命周期；不可变历史、实际 Model／Artifact、事务与低信任摘要理由保留。[子 Run 期限](2026-09-29-independent-child-run-duration-only.md)与[主 Run 累计额度移除](2026-09-30-run-cumulative-limits-removed.md)的无限累计原则继续适用，新的工具五次失败规则不属于累计用量预算。

Windows 长模型输入的实际封存暴露了 Win32 relative FileRenameInfo error 87。固定 System ntdll 的 NtSetInformationFile(FileRenameInformation)保持原目录 HANDLE、相对 hash、不覆盖和独立 FR 政策，只在 STATUS_OBJECT_NAME_COLLISION 时完整核原内容后复用。该修复与剩余资格归[原媒体提案](../../proposed/architecture/2026-10-04-windows-artifact-handle-publication.md)，不以本片改变其余安全或发行门禁。

## Alternatives considered

- 调高模型重试次数、来源数和 Shell 隐式超时：仍会按任务持续时间或规模提前截断，不满足已确认需求。
- 按工具名合并来源输入、裁掉旧指令或历史：会丢失准确原路径、参数和后续新鲜性依据，未采用。
- 每次压缩失败都永久跳过相同上下文：暂时性中断会变成永久禁止压缩，改为仅让出一次普通决策边界。
- 每次失败都立刻在同一边界重复压缩：可能无限重复收费而不给原任务推进机会，未采用。
- 到 Provider length 后派发已见工具：无法证明完整批次和参数，保留零工具效果，仅完整纯文本可续接。
- 按工具完成时间统计失败：并发调度会改变停止结论，改按模型原始调用顺序。
- 只在内存维护失败次数：原 Run 接续会丢掉前四次失败，采用现有完整 ledger 重建，不新增第二份业务 authority。
- Windows 改成路径移动或把任意 rename 错误当内容已存在：不能保持原目录身份与幂等证明，保留原相对 HANDLE 语义和准确原生碰撞码。

## Consequences

长任务不因本地任意次数或内容额度结束，暂时性失败和无进展的完成诊断可能持续等待或重试，用户取消仍立即进入原有收束流程。实际内存、磁盘、Provider 能力和宿主存活仍是物理条件；这里不提供崩溃后自动重放、绕过权限或未知外部效果重试，也不声称任意单条超出 Provider 窗口的内容都能直接摘要。

默认估算只触发维护，摘要质量和真实模型窗口资格需独立验证。长任务增加数据量和持久来源核对成本，不宣称恒定 RSS 或固定时延。原始输入、结果和失败均保留，可按原身份读取。

## Verification

2026-10-16 修复审查发现的 SQL 恢复结束原因不兼容：先以真实 SIGKILL 复现 length 段、后继 planned Model、段后已完成工具以及重试后 planned Model 四项拒绝，再修复并运行恢复完整文件，20项197断言通过。已完成原工具和 length 段保持不变，历史失败不重放，最后失败尝试仍拒绝恢复。

2026-10-15 至 16 日 Windows x64／Bun 1.4.2 的[默认 Service 长任务](../../../../apps/service/test/isolated/long-running-compression.test.ts)3项30断言通过，覆盖已知／未知窗口、一次摘要 HTTP500、随后两次发布、同一原 Run，以及实际 HTTP／生成 Client 读取第六次重试和 null 上界。[长任务 Core](../../../../packages/agent/test/isolated/execution/long-running.test.ts)核主／子五次失败、重置、并行顺序、Provider长度续接与截断工具零效果。模型重试4项17断言、SDK21项130断言、Task11项75断言、child期限3项26断言、扩展完整来源5项321断言、并行原工具3项63断言、TUI17项92断言、用户配置8项45断言分别通过。真实强杀接续15项132断言保前四次失败，第五次停止而不重放；准确结果归[恢复完整文件](../../../../packages/agent/test/isolated/recovery/run-resume-runtime.test.ts)。Windows 原生 Artifact 完整文件4项通过、1项POSIX-only skip、64断言，含不覆盖、SQL orphan、双进程、准确强杀和恢复原 FR 后的实际硬链接拒绝。

最终 Core 长任务完整文件7项328断言，Shell前台5项42断言，原Service手动／自动压缩两个完整文件6项134断言分别通过。根及精确八个workspace类型检查、API生成一致性、源码边界、文档结构与实际影响核对通过；格式检查覆盖变更手写源码，生成validator由原生成器核验。

最终 required Task、持久义务、结果义务三个完整文件共22项251断言通过：真实65个子任务排队、父 Run 完整等待与结算；130项持久 ref 超过32KiB且缺失一项证明仍不能完成。用户配置完整文件最终为8项46断言通过。

既有完整Core压缩文件的 ≥17MiB 场景在本机原60秒预算两次超时，其余21项通过；没有放宽预算或降低断言。项目来源完整文件为8 pass、1 fail、38断言：越界、目录junction、实际Windows ACL拒读、UTF-8／NUL／非regular和完整大指令均通过；唯一失败是当前Windows用户创建文件symlink时EPERM，未跳过或替换该资格。完整内容、范围、namespace和原生媒体资格分别报告，不据定向绿色宣称完整默认、其他平台或连续数周实跑。
