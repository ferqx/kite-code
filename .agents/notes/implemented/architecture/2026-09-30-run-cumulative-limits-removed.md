# Agent Note: Run 累计额度移除，保留执行期限与并发约束

Status: implemented

## Problem

旧主 Run 的累计 Artifact 预算为 256 MiB。缺少文件变更证据的已派发 Shell 会按整笔预留上界结算；即使命令只执行 `sleep` 和 `echo`，后续 `shell_stop`、写工具也可能因剩余额度为零被拒绝。模型、工具、token 和 turn 的固定总额同样会在 Run 仍有时间且工作可继续时提前截断执行。

移除累计额度后，项目指令、文件观察、Skill／schema、计划、审查上下文和验证修复仍存在固定大小或次数门禁；它们会跳过有效约束、丢掉诊断或在同一任务仍可继续时要求用户介入。Shell 的内存环形缓冲还会丢失中间输出，直接改成无限内存捕获则会引入内存与文件描述符耗尽。

## Decision

新主 Run 使用通用 `unboundedCumulativeUsage` 标记和零值累计占位字段。独立子 Run 继续使用有准确父子血缘的 `durationOnlyChildRun`。两种模式只用执行期限、并发、取消、权限、审批和准确外部结果来控制继续派发；累计计数仍记录用于观察，不作额度拒绝。模型与工具 reservation 分别使用 `unboundedModelTokens`、`unboundedArtifactBytes`；Provider 的单次能力和明确工具超时仍生效。

活动旧主 Run 恢复时先提交可回放、幂等的 `resource_budget.cumulative_limits_removed` 事件，再规划新的外部派发。事件保留原 Run、已用量、截止时间和并发数字，只放宽当前 Run 尚未结算的直接模型／工具上界；旧 `artifact_capacity` 等待者在重算准入时取消。已完成历史 Run、保留的旧资金账本和旧 v1 子 grant 不改写。Runner 的 `maxEffects` 转为定期让出执行权，不能再作为整个 Run 的次数上限。

有效内容按完整身份读取和检查，不再受本地固定字节、字符、层数、文件数、属性数或计划步骤额度裁剪。Provider 已知真实窗口与实际单次输出参数仍约束请求；未知容量不产生本地替代额度。自动压缩失败保留原上下文并继续运行；只抑制同一失败来源的立即重复请求，不能以次数、冷却或低收益阈值永久禁用。当前无限累计模式的 required 验证可持续修复，必须通过或由用户按结构化流程 waiver 才能完成；无效规范继续阻塞。重复调用和历史拒绝计数不能替代当前操作的真实安全审查。

正常 Shell 均由 Managed Shell owner 保存完整私有磁盘 spool，模型通过 cursor 分页续读，内存只保留当前读写缓冲及临时终态预览。只提供终态正文的 executor 按未收到流式输出的路补写；流式捕获的正文不重复追加终态预览。分页核对实际 JSON 编码长度，控制字符膨胀不会把合法正文变成传输拒绝。单页通信与不可信 RPC 校验继续保护解析和客户端；它们不裁掉历史数据或限制累计命令次数。临时 spool 随 Runtime 生命周期释放，句柄不跨宿主重启授予执行或读取权。

完整后台执行目录按稳定 execution ID 和实际编码字节分页，不再把无限历史放入单条 RPC 帧。客户端缺省查询只在 aggregate generation、watermark、Session revision 与 Session identity 一致时发布完整目录；变化则在原请求期限内异步重试，不能以部分成功替代完整结果。精确 Shell 查询不经过全量目录跨协议传输。

MCP 资源与动态结果、声明的 Skill reference 不再受旧的 128 KiB 单次内容额度；MCP 清单默认完整返回，显式 limit 仍可分页。网页默认正文裁剪和跳转次数门禁移除，显式内容选择仍受尊重。外网单次 5 MB 响应体解析保护、每跳网络权限／SSRF 检查、真实跳转循环拒绝和取消继续生效；响应大小在读取过程中按实际字节验证，不能先无界读入内存再检查。RPC 单帧和单条记录的格式／解析保护继续约束不可信数据，不作为 Run 累计执行额度。

客户端完整 History 不再按 50,000 条／40 MiB 或等待队列项数拒绝；生产读取端也不再按 50,000 条／32 MiB 源／32 MiB 投影拒绝。并发组装保留为 4，其余 FIFO 排队；真实容量暂满时仅安全的只读 History 页等待重试，并保持原水位、scope 和 digest。协议分页、取消、单页请求时限与有界缓存淘汰继续生效。当前接口最终返回整份记录／事件数组，并发限制和避免重复序列化减少峰值，不承诺单份任意规模快照占用固定内存。

本决定部分替代[累计资源治理决定](2026-07-30-cumulative-runtime-resource-governance.md)对新主 Run 的累计数值限制；其持久预留、并发、取消、unknown 和恢复身份规则继续适用。[独立子 Run 时限决定](2026-09-29-independent-child-run-duration-only.md)的子血缘与独立期限规则继续适用。

移除额度后，已完成 reservation 不继续常驻活动 State；[活动预约与持久回执决定](2026-09-30-active-resource-reservations-and-durable-receipts.md)将准确终态与 State 在同一 Store 事务中归档。子级资金查证、恢复、取消与重复结算使用准确回执，未知事实仍保留原 ledger，不能把 State 缩小解释为丢弃审计或放宽执行权。

## Alternatives considered

- 只提高 256 MiB 和其他固定总额：拒绝。未知 Shell 预留仍可能一次占满新总额，长任务仍按任意数字提前停止。
- 完全取消用量 ledger：拒绝。并发许可、准确结算和恢复需要同一持久身份，用量也需要留作观察。
- 直接改写旧事件或所有保留资金：拒绝。事件历史与旧 grant 的授权证据必须按原身份回放；活动旧 Run 用显式升级事件转换。
- 将 Shell 环形缓冲改为无限内存列表：拒绝。累计输出会耗尽内存；磁盘保存与分页读取可以保留完整内容和有界内存。

## Consequences

新主 Run 不再因累计额度耗尽而进入 `artifact_capacity` 等待或拒绝后续模型／工具调用。无文件变更证据的 Shell 不再把旧 256 MiB 预留记为已知实际产物；有证据时记录观测字节。长期执行仍受当前 Run 截止时间、子 Agent 并发与安全准入约束。旧有限记录和新模式并存，恢复必须按持久标记分流，不能凭当前配置推断历史授权。

验证覆盖 Kernel／Host 的额度升级、在途预留结算、截止时间及并发拒绝，Builtin 模型重试和恢复，Service 的 Shell 后停止／写入、旧容量等待者转换，以及正式 Runtime Server 的父子和 Shell 组合执行。对应入口见[执行手册](../../../../docs/handbook/features/execution.md)、[Host owner](../../../../packages/runtime-host/README.md)和[Service owner](../../../../apps/kite-service/docs/runtime-application.md)。

本次扩展回归覆盖超出旧阈值的指令、文件、Skill、schema、计划、Artifact 与完整审查内容，四次验证修复后通过、旧修复额度耗尽后的持久升级、压缩失败的同源去重与新增上下文重试、完整 Shell 游标续读及超过 256 个串行句柄；11,000 条后台目录分页、跨页版本变化和准确 Session 拒绝、背景目录整体读取期限、超过 128 KiB 的 MCP／reference 与完整网页提取另有聚焦回归。真实 SQLite 的 50,001 条、超过 40 MiB 源历史通过生产子进程 owner 完整读取 98 页；客户端另验证超旧大小门槛、1,041 个请求排队推进、拥塞重试、取消与总耗时超过单页期限的成功读取。未将受控测试结论外推为任意 Provider 容量或跨宿主崩溃后的临时输出恢复承诺。
